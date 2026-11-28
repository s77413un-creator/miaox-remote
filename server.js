const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(200);
    res.end('ok');
  }
});

const wss = new WebSocket.Server({ server });

let controller = null;
let toy = null;

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.role === 'controller') {
      controller = ws;
      ws.send(JSON.stringify({ type: 'ready' }));
      if (toy && toy.readyState === WebSocket.OPEN) {
        controller.send(JSON.stringify({ type: 'toy_connected' }));
      }
    }
    if (data.role === 'toy') {
      toy = ws;
      if (controller && controller.readyState === WebSocket.OPEN) {
        controller.send(JSON.stringify({ type: 'toy_connected' }));
      }
    }
    if (data.type === 'cmd' && toy && toy.readyState === WebSocket.OPEN) {
      toy.send(JSON.stringify(data));
    }
  });
  ws.on('close', () => {
    if (ws === controller) controller = null;
    if (ws === toy) {
      toy = null;
      if (controller && controller.readyState === WebSocket.OPEN) {
        controller.send(JSON.stringify({ type: 'toy_disconnected' }));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('running on', PORT));
