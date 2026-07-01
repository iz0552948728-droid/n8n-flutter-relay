const http = require('http');
const WebSocket = require('ws');

// clientId -> { ws, clientId, userId }
const clients = new Map();

function sendToAll(payload) {
  let sent = 0;
  clients.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      sent++;
    }
  });
  return sent;
}

function sendToClientId(clientId, payload) {
  const entry = clients.get(clientId);
  if (entry && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(payload));
    return 1;
  }
  return 0;
}

function sendToUserId(userId, payload) {
  let sent = 0;
  clients.forEach(({ ws, userId: uid }) => {
    if (uid == userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      sent++;
    }
  });
  return sent;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', connected_clients: clients.size }));
    return;
  }

  // n8n отправляет сюда вопросы и уведомления
  if (req.method === 'POST' && (req.url === '/question' || req.url === '/notification')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let sent = 0;

        if (payload.client_id) {
          // → конкретному устройству
          sent = sendToClientId(payload.client_id, payload);
        } else if (payload.user_id != null) {
          // → всем устройствам одного юзера
          sent = sendToUserId(payload.user_id, payload);
        } else {
          // → broadcast всем
          sent = sendToAll(payload);
        }

        console.log(`Sent to ${sent} client(s) [target: ${payload.client_id || payload.user_id || 'broadcast'}]`);
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
  // Временный ID до получения register
  const tempId = `tmp-${Date.now()}`;
  clients.set(tempId, { ws, clientId: null, userId: null });
  let currentKey = tempId;

  ws.send(JSON.stringify({ type: 'connected' }));

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'register') {
        const clientId = msg.client_id;
        const userId   = msg.user_id ?? null;

        // Удаляем старый ключ
        clients.delete(currentKey);
        currentKey = clientId;
        clients.set(clientId, { ws, clientId, userId });

        console.log(`Registered: client_id=${clientId} user_id=${userId} (total: ${clients.size})`);
        ws.send(JSON.stringify({ type: 'registered', client_id: clientId, user_id: userId }));
        return;
      }

      if (msg.type === 'answer' && msg.callback_url) {
        console.log(`Answer "${msg.answer}" → ${msg.callback_url}`);
        try {
          const r = await fetch(msg.callback_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: msg.id, answer: msg.answer, dt: msg.dt, kt: msg.kt }),
          });
          const text = await r.text();
          console.log(`n8n response: ${r.status} — ${text}`);
          ws.send(JSON.stringify({ type: 'ack', id: msg.id, status: r.status, body: text }));
        } catch (fetchErr) {
          console.error(`Fetch error: ${fetchErr.message}`);
          ws.send(JSON.stringify({ type: 'ack', id: msg.id, error: fetchErr.message }));
        }
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(currentKey);
    console.log(`Disconnected: ${currentKey} (total: ${clients.size})`);
  });

  ws.on('error', err => console.error(`WS error ${currentKey}:`, err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay server listening on :${PORT}`));
