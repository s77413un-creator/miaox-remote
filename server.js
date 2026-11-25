const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200);
  res.end('ok');
});

const wss = new WebSocket.Server({ server });

let controller = null;
let toy = null;

wss.on('connection', (ws, req) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    
    if (data.role === 'controller') {
      controller = ws;
      ws.send(JSON.stringify({ type: 'ready' }));
    }
    
    if (data.role === 'toy') {
      toy = ws;
      if (controller) {
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
      if (controller) controller.send(JSON.stringify({ type: 'toy_disconnected' }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('running on', PORT));
