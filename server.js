const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;

const RESOURCE_METADATA_URL =
  'https://miaox-remote-production.up.railway.app/.well-known/oauth-protected-resource';

const AUTH0_ISSUER = AUTH0_DOMAIN
  ? `https://${AUTH0_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`
  : null;

const REQUIRED_SCOPES = {
  get_status: 'read:status',
  set_controls: 'control:device',
  stop: 'stop:device'
};

let controller = null;
let toy = null;
let mcpStopTimer = null;
let auth0ClientPromise = null;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function closeClient(ws, reason) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1008, reason);
  }
}

function notifyController(type) {
  send(controller, { type });
}

function stopToy() {
  if (mcpStopTimer) {
    clearTimeout(mcpStopTimer);
    mcpStopTimer = null;
  }

  if (toy && toy.readyState === WebSocket.OPEN) {
    send(toy, { type: 'cmd', suck: 0, vibe: 0 });
  }
}

// 原有 WebSocket 控制端认证继续使用 CONTROL_TOKEN
function tokenMatches(req) {
  if (!CONTROL_TOKEN) return false;

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : '';

  const supplied = req.headers['x-user-token'] || bearer;

  if (typeof supplied !== 'string') return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(CONTROL_TOKEN);

  return a.length === b.length &&
    crypto.timingSafeEqual(a, b);
}

// 初始化 Auth0 验证客户端
async function getAuth0Client() {
  if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
    throw new Error('Auth0 environment variables are missing');
  }

  if (!auth0ClientPromise) {
    auth0ClientPromise = import('@auth0/auth0-api-js').then(
      ({ ApiClient }) => new ApiClient({
        domain: AUTH0_DOMAIN,
        audience: AUTH0_AUDIENCE
      })
    );
  }

  return auth0ClientPromise;
}

// 从已验证的令牌中读取权限
function getTokenScopes(claims) {
  const scopes = new Set();

  if (typeof claims.scope === 'string') {
    claims.scope.split(' ').filter(Boolean).forEach(
      scope => scopes.add(scope)
    );
  }

  if (Array.isArray(claims.permissions)) {
    claims.permissions.forEach(scope => {
      if (typeof scope === 'string') scopes.add(scope);
    });
  }

  return scopes;
}

// 验证 Auth0 Bearer Token
async function verifyAuth0Token(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { ok: false, reason: 'missing_token' };
  }

  try {
    const client = await getAuth0Client();

    const claims = await client.verifyAccessToken({
      accessToken: match[1],
      requiredClaims: ['sub']
    });

    if (!claims || typeof claims.sub !== 'string') {
      return { ok: false, reason: 'invalid_token' };
    }

    return {
      ok: true,
      claims,
      scopes: getTokenScopes(claims)
    };
  } catch (err) {
    console.error('Auth0 token verification failed:', err.message);

    return { ok: false, reason: 'invalid_token' };
  }
}

// 返回 OAuth 认证挑战
function sendAuthChallenge(res, status, reason, requiredScope) {
  let challenge = 'Bearer';

  if (reason === 'invalid_token') {
    challenge += ' error="invalid_token"';
  }

  if (reason === 'insufficient_scope' && requiredScope) {
    challenge +=
      ` error="insufficient_scope", scope="${requiredScope}"`;
  }

  challenge += `, resource_metadata="${RESOURCE_METADATA_URL}"`;

  res.writeHead(status, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': challenge,
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify({
    error: reason
  }));
}

// OAuth Protected Resource Metadata
function handleResourceMetadata(res) {
  if (!AUTH0_ISSUER || !AUTH0_AUDIENCE) {
    res.writeHead(503, {
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({
      error: 'OAuth configuration is incomplete'
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600'
  });

  res.end(JSON.stringify({
    resource: AUTH0_AUDIENCE,
    authorization_servers: [AUTH0_ISSUER],
    scopes_supported: [
      'read:status',
      'control:device',
      'stop:device'
    ],
    bearer_methods_supported: ['header']
  }));
}

// 检查 JSON-RPC 请求中是否调用了需要权限的工具
function getRequiredScope(parsedBody) {
  const requests = Array.isArray(parsedBody)
    ? parsedBody
    : [parsedBody];

  for (const request of requests) {
    if (
      request &&
      request.method === 'tools/call' &&
      request.params &&
      typeof request.params.name === 'string'
    ) {
      const requiredScope =
        REQUIRED_SCOPES[request.params.name];

      if (requiredScope) return requiredScope;
    }
  }

  return null;
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end('Method not allowed');
    return;
  }

  if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
    res.writeHead(503);
    res.end('OAuth authentication is not configured');
    return;
  }

  // 先验证令牌，再处理 MCP 请求
  const auth = await verifyAuth0Token(req);

  if (!auth.ok) {
    const status = auth.reason === 'missing_token' ? 401 : 401;
    sendAuthChallenge(res, status, auth.reason);
    return;
  }

  let body = '';
  let bodyBytes = 0;

  try {
    for await (const chunk of req) {
      bodyBytes += Buffer.byteLength(chunk);

      if (bodyBytes > 1024 * 1024) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }

      body += chunk.toString();
    }

    const parsedBody = JSON.parse(body);

    // 根据工具名称检查对应权限
    const requiredScope = getRequiredScope(parsedBody);

    if (requiredScope && !auth.scopes.has(requiredScope)) {
      sendAuthChallenge(
        res,
        403,
        'insufficient_scope',
        requiredScope
      );
      return;
    }

    const { McpServer } = await import(
      '@modelcontextprotocol/sdk/server/mcp.js'
    );

    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );

    const z = await import('zod/v4');

    const mcpServer = new McpServer({
      name: 'miaox-remote',
      version: '1.0.0'
    });

    mcpServer.registerTool(
      'get_status',
      {
        description:
          'Check whether the BLE toy and controller are connected.',
        inputSchema: {}
      },
      async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            toy_connected:
              !!toy && toy.readyState === WebSocket.OPEN,
            controller_connected:
              !!controller &&
              controller.readyState === WebSocket.OPEN
          })
        }]
      })
    );

    mcpServer.registerTool(
      'set_controls',
      {
        description:
          'Set toy control levels for a short duration. ' +
          'Levels must be integers from 0 to 100. ' +
          'Duration must be 1 to 10 seconds. ' +
          'The toy automatically receives a stop command when time expires.',
        inputSchema: {
          suck: z.number().int().min(0).max(100),
          vibe: z.number().int().min(0).max(100),
          duration_seconds: z.number().int().min(1).max(10)
        }
      },
      async ({ suck, vibe, duration_seconds }) => {
        if (!toy || toy.readyState !== WebSocket.OPEN) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: 'Toy is not connected.'
            }]
          };
        }

        stopToy();

        send(toy, { type: 'cmd', suck, vibe });

        mcpStopTimer = setTimeout(() => {
          stopToy();
        }, duration_seconds * 1000);

        return {
          content: [{
            type: 'text',
            text:
              `Command sent. Automatic stop in ${duration_seconds} seconds.`
          }]
        };
      }
    );

    mcpServer.registerTool(
      'stop',
      {
        description: 'Immediately stop all toy output.',
        inputSchema: {}
      },
      async () => {
        stopToy();

        return {
          content: [{
            type: 'text',
            text: 'Stop command sent.'
          }]
        };
      }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close();
      mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);

  } catch (err) {
    console.error('MCP error:', err);

    if (!res.headersSent) {
      res.writeHead(400, {
        'Content-Type': 'application/json'
      });

      res.end(JSON.stringify({
        error: 'MCP request failed'
      }));
    }
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(
    req.url,
    'http://localhost'
  ).pathname;

  // OAuth 元数据发现：根路径和 /mcp 对应路径
  if (
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource/mcp'
  ) {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method not allowed');
      return;
    }

    handleResourceMetadata(res);
    return;
  }

  if (pathname === '/mcp') {
    handleMcp(req, res);
    return;
  }

  let filename;

  if (pathname === '/' || pathname === '/index.html') {
    filename = 'index.html';
  } else if (pathname === '/controller.html') {
    filename = 'controller.html';
  } else {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(path.join(__dirname, filename), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.role = null;
  ws.authenticated = false;

  const authTimer = setTimeout(() => {
    if (!ws.authenticated) {
      closeClient(ws, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (message) => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch {
      closeClient(ws, 'Invalid JSON');
      return;
    }

    if (!ws.authenticated) {
      if (
        data.type !== 'auth' ||
        !['controller', 'toy'].includes(data.role) ||
        !CONTROL_TOKEN ||
        typeof data.token !== 'string' ||
        data.token !== CONTROL_TOKEN
      ) {
        closeClient(ws, 'Unauthorized');
        return;
      }

      ws.authenticated = true;
      ws.role = data.role;
      clearTimeout(authTimer);

      if (data.role === 'controller') {
        if (controller && controller !== ws) {
          closeClient(controller, 'Replaced by new controller');
        }

        controller = ws;
        send(ws, { type: 'ready' });

        if (toy && toy.readyState === WebSocket.OPEN) {
          send(ws, { type: 'toy_connected' });
        }
      }

      if (data.role === 'toy') {
        if (toy && toy !== ws) {
          closeClient(toy, 'Replaced by new device');
        }

        toy = ws;
        send(ws, { type: 'ready' });

        if (controller && controller.readyState === WebSocket.OPEN) {
          notifyController('toy_connected');
        }
      }

      return;
    }

    if (data.type === 'cmd' && ws.role === 'controller') {
      const suck = Number(data.suck);
      const vibe = Number(data.vibe);

      if (
        !Number.isFinite(suck) ||
        !Number.isFinite(vibe) ||
        !Number.isInteger(suck) ||
        !Number.isInteger(vibe) ||
        suck < 0 || suck > 100 ||
        vibe < 0 || vibe > 100
      ) {
        send(ws, {
          type: 'error',
          message: 'Invalid command values'
        });
        return;
      }

      send(toy, { type: 'cmd', suck, vibe });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);

    if (ws === controller) {
      controller = null;
    }

    if (ws === toy) {
      toy = null;
      stopToy();
      notifyController('toy_disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  if (!CONTROL_TOKEN) {
    console.error('WARNING: CONTROL_TOKEN is not configured.');
  }

  if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
    console.error('WARNING: Auth0 environment variables are missing.');
  }

  console.log('Server running on port', PORT);
});
