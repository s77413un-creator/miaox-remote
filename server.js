
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;

let controller = null;
let toy = null;
let mcpStopTimer = null;

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

async function handleMcp(req, res) {
  if (!CONTROL_TOKEN) {
    res.writeHead(503);
    res.end('Server authentication is not configured');
    return;
  }

  if (!tokenMatches(req)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end('Method not allowed');
    return;
  }

  let body = '';

  try {
    for await (const chunk of req) {
      body += chunk;

      if (body.length > 1024 * 1024) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }
    }

    const parsedBody = JSON.parse(body);

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
        description: 'Check whether the BLE toy and controller are connected.',
        inputSchema: {}
      },
      async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            toy_connected: !!toy && toy.readyState === WebSocket.OPEN,
            controller_connected:
              !!controller && controller.readyState === WebSocket.OPEN
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
            text: `Command sent. Automatic stop in ${duration_seconds} seconds.`
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
      res.writeHead(500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({
        error: 'MCP request failed'
      }));
    }
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

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

  console.log('Server running on port', PORT);
});
