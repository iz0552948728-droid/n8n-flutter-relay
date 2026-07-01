const http = require('http');
const WebSocket = require('ws');

// client_id -> { ws, clientId, userId }
const clients = new Map();

function sendToAll(payload) {
  let sentClients = [];
  clients.forEach(({ ws, clientId, userId }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      sentClients.push({ client_id: clientId, user_id: userId });
    }
  });
  return sentClients;
}

function sendToClientId(clientId, payload) {
  const entry = clients.get(clientId);
  if (entry && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(payload));
    return [{ client_id: entry.clientId, user_id: entry.userId }];
  }
  return [];
}

function sendToUserId(userId, payload) {
  let sentClients = [];
  clients.forEach(({ ws, clientId, userId: uid }) => {
    if (uid == userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      sentClients.push({ client_id: clientId, user_id: uid });
    }
  });
  return sentClients;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', connected_clients: clients.size }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/question' || req.url === '/notification')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let sentClients = [];

        if (payload.client_id) {
          sentClients = sendToClientId(payload.client_id, payload);
        } else if (payload.user_id != null) {
          sentClients = sendToUserId(payload.user_id, payload);
        } else {
          sentClients = sendToAll(payload);
        }

        console.log(`Sent to ${sentClients.length} client(s) [target: ${payload.client_id || payload.user_id || 'broadcast'}]`);
        res.end(JSON.stringify({
          status: 'sent',
          count: sentClients.length,
          clients: sentClients
        }));
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
  const tempId = `tmp-${Date.now()}`;
  clients.set(tempId, { ws, clientId: null, userId: null });
  let currentKey = tempId;

  ws.send(JSON.stringify({ type: 'connected' }));

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());

      // Регистрация устройства
      if (msg.type === 'register') {
        const clientId = msg.client_id;
        const userId   = msg.user_id ?? null;
      
        // Проверка на null/undefined
        if (!clientId) {
          console.error('Register failed: client_id is missing');
          ws.send(JSON.stringify({ type: 'error', message: 'client_id is required' }));
          return;
        }
      
        clients.delete(currentKey);
        currentKey = clientId;
        clients.set(clientId, { ws, clientId, userId });
      
        console.log(`Registered: client_id=${clientId} user_id=${userId} (total: ${clients.size})`);
        ws.send(JSON.stringify({ type: 'registered', client_id: clientId, user_id: userId }));
        return;
      }

      // Отмена регистрации
      if (msg.type === 'unregister') {
        const clientId = msg.client_id;
        if (clients.has(clientId)) {
          clients.delete(clientId);
          currentKey = `tmp-${Date.now()}`;
          clients.set(currentKey, { ws, clientId: null, userId: null });
          console.log(`Unregistered: client_id=${clientId} (total: ${clients.size})`);
          ws.send(JSON.stringify({ type: 'unregistered', client_id: clientId }));
        }
        return;
      }

      // Ответ на вопрос
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
        } catch (err) {
          console.error('Fetch error:', err.message);
        }
        return;
      }

    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(currentKey);
    console.log(`Disconnected: ${currentKey} (total: ${clients.size})`);
  });

  ws.on('error', err => console.error(`WS error ${currentKey}:`, err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay server running on port ${PORT}`));
