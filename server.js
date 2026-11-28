
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

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

let controller = null;
let toy = null;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function closeClient(ws, reason) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1008, reason);
  }
}

function notifyController(type) {
  send(controller, { type });
}

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

    // 必须先验证身份
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

        if (controller && controller.readyState === WebSocket.OPEN) {
          notifyController('toy_connected');
        }
      }

      return;
    }

    // 只有控制端可以发送控制指令
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
        send(ws, { type: 'error', message: 'Invalid command values' });
        return;
      }

      send(toy, {
        type: 'cmd',
        suck,
        vibe
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);

    if (ws === controller) {
      controller = null;
    }

    if (ws === toy) {
      toy = null;
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
