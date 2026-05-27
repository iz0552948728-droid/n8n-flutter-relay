const http = require('http');
const WebSocket = require('ws');

const clients = new Map(); // id -> WebSocket

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  // Health check — n8n or monitoring can ping this
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', connected_clients: clients.size }));
    return;
  }

  // n8n sends a question here
  if (req.method === 'POST' && req.url === '/question') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const question = JSON.parse(body);
        let sent = 0;
        clients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'question', ...question }));
            sent++;
          }
        });
        res.end(JSON.stringify({ status: 'sent', clients: sent }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  const id = `client-${Date.now()}`;
  clients.set(id, ws);
  console.log(`Flutter connected: ${id} (total: ${clients.size})`);

  ws.send(JSON.stringify({ type: 'connected', clientId: id }));

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'answer' && msg.callback_url) {
        console.log(`Answer received for ${msg.id}, forwarding to n8n...`);
        await fetch(msg.callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: msg.id, answer: msg.answer }),
        });
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    console.log(`Flutter disconnected: ${id} (total: ${clients.size})`);
  });

  ws.on('error', err => console.error(`WS error ${id}:`, err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay server listening on :${PORT}`));
