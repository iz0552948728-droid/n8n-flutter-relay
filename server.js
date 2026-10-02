const http = require('http');
const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────────────────────
// Настройки через переменные окружения Render
//   N8N_API_KEY        — ключ публичного API n8n (Settings → n8n API)
//   N8N_BASE_URL       — по умолчанию https://babchin.app.n8n.cloud
//   RELAY_KEY          — общий секрет для /exec/track (тот же в HTTP-ноде n8n)
// ─────────────────────────────────────────────────────────────────────────
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'https://babchin.app.n8n.cloud').replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
const RELAY_KEY = process.env.RELAY_KEY;

const WATCH_INTERVAL_MS = 30 * 1000;          // опрос n8n
const WATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // дольше суток не следим

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

// ─────────────────────────────────────────────────────────────────────────
// Сторож выполнений n8n.
// Воркфлоу при старте сообщает о себе через POST /exec/track. Relay держит
// такие записи в памяти и раз в 30 секунд спрашивает у n8n их статус.
// Завершённые удаляет. Упавшие процессом (crashed — обычно нехватка памяти)
// удаляет, предварительно уведомив того, кто запускал. Обычные ошибки
// (error) не трогаем: их уже обрабатывает Error Workflow в самом n8n.
//
// Записи живут только в памяти: при перезапуске relay они пропадают.
// ─────────────────────────────────────────────────────────────────────────

// execution_id -> { user_id, client_id, label, started }
const runs = new Map();

// В n8n «канал не используется» обозначается -1; пустые значения тоже не адрес.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return (s === '' || s === '-1' || s === 'null' || s === 'undefined') ? null : s;
}

function trackExecution(body) {
  const id = clean(body.execution_id);
  if (!id) return false;
  runs.set(id, {
    user_id: clean(body.user_id),
    client_id: clean(body.client_id),
    label: body.label || 'выписки',
    started: Date.now(),
  });
  console.log(`Tracking execution ${id} (watching: ${runs.size})`);
  return true;
}

function notifyCrash(id, run) {
  const time = new Date(run.started).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
  });
  const text = `Обработка ${run.label}, запущенная в ${time}, прервалась из-за нехватки ресурсов сервера. ` +
               `Запустите её повторно — уже записанные операции не продублируются.`;

  // Приложение: по конкретному устройству, иначе по пользователю.
  // Широковещательной рассылки здесь нет намеренно: сообщение не должно
  // уйти всем подключённым.
  let sent = [];
  if (run.client_id || run.user_id) {
    const payload = {
      type: 'notification',
      kind: 'execution_crashed',
      id: String(id),
      message: text,
      source: 'relay',
    };
    if (run.client_id) sent = sendToClientId(run.client_id, payload);
    if (!sent.length && run.user_id) sent = sendToUserId(run.user_id, payload);
  }

  console.log(`Execution ${id} crashed → app: ${sent.length}`);
  if (!sent.length) {
    console.error(`Execution ${id}: уведомление о падении никому не доставлено`, run);
  }
}

async function checkExecutions() {
  if (!runs.size) return;
  if (!N8N_API_KEY) {
    console.error('N8N_API_KEY не задан — сторож выполнений не работает');
    return;
  }

  for (const [id, run] of runs) {
    if (Date.now() - run.started > WATCH_MAX_AGE_MS) { runs.delete(id); continue; }

    let status;
    try {
      const r = await fetch(`${N8N_BASE_URL}/api/v1/executions/${encodeURIComponent(id)}`, {
        headers: { 'X-N8N-API-KEY': N8N_API_KEY, Accept: 'application/json' },
      });
      if (r.status === 404) { runs.delete(id); continue; } // выполнение удалено из истории
      if (!r.ok) { console.error(`n8n API ${r.status} for ${id}`); continue; } // проверим в следующий раз
      status = (await r.json()).status;
    } catch (e) {
      console.error(`n8n API error for ${id}:`, e.message);
      continue;
    }

    if (['running', 'waiting', 'new'].includes(status)) continue; // ещё исполняется

    if (status === 'crashed') {
      try { notifyCrash(id, run); } catch (e) { console.error(`notify ${id}:`, e.message); }
    }
    runs.delete(id); // success, error, canceled, crashed — дальше не следим
  }
}

let watchBusy = false;
setInterval(async () => {
  if (watchBusy) return; // предыдущий проход ещё идёт — не накладываемся
  watchBusy = true;
  try { await checkExecutions(); } finally { watchBusy = false; }
}, WATCH_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────
function readBody(req, cb) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', connected_clients: clients.size, watched_executions: runs.size }));
    return;
  }

  // Регистрация выполнения n8n для наблюдения
  if (req.method === 'POST' && req.url === '/exec/track') {
    if (!RELAY_KEY || req.headers['x-relay-key'] !== RELAY_KEY) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return;
    }
    readBody(req, body => {
      try {
        const ok = trackExecution(JSON.parse(body));
        if (!ok) { res.writeHead(400); res.end(JSON.stringify({ error: 'execution_id is required' })); return; }
        res.end(JSON.stringify({ status: 'tracking', watching: runs.size }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // HTTP unregister — приложение сообщает о выходе
  if (req.method === 'POST' && req.url === '/unregister') {
    readBody(req, body => {
      try {
        const { client_id } = JSON.parse(body);
        if (client_id && clients.has(client_id)) {
          clients.delete(client_id);
          console.log(`Unregistered (HTTP): ${client_id} (total: ${clients.size})`);
          res.end(JSON.stringify({ status: 'unregistered', client_id }));
        } else {
          res.end(JSON.stringify({ status: 'not_found', client_id }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && (req.url === '/question' || req.url === '/notification')) {
    readBody(req, body => {
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

        // Если по этому client_id уже есть другое живое соединение (например,
        // клиент переподключился, не дождавшись закрытия старого сокета) —
        // закрываем старое, чтобы оно не "осиротело" и не удалило потом
        // из clients запись уже нового, актуального соединения.
        const stale = clients.get(clientId);
        if (stale && stale.ws !== ws && stale.ws.readyState === WebSocket.OPEN) {
          try { stale.ws.close(); } catch (_) {}
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
        const entry = clients.get(clientId);
        // Снимаем регистрацию, только если это делает то же соединение,
        // которое её создало — иначе можно случайно "разлогинить" чужую,
        // более новую регистрацию по тому же client_id.
        if (entry && entry.ws === ws) {
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
          // Пересылаем всё, кроме транспортных полей. Раньше здесь был
          // фиксированный список (id, answer, dt, kt), и любой новый формат
          // ответа молча терял свои поля по дороге — так пропал бы splits
          // у разнесения кредитного платежа.
          const { type, callback_url, ...answerPayload } = msg;
          const r = await fetch(msg.callback_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(answerPayload),
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
    // Удаляем запись, только если она всё ещё указывает на это соединение —
    // иначе можно случайно удалить более новую регистрацию с тем же ключом
    // (см. комментарий в обработчике 'register').
    const entry = clients.get(currentKey);
    if (entry && entry.ws === ws) {
      clients.delete(currentKey);
    }
    console.log(`Disconnected: ${currentKey} (total: ${clients.size})`);
  });

  ws.on('error', err => console.error(`WS error ${currentKey}:`, err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay server running on port ${PORT}`));
