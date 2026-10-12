const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────────────────────
// Настройки через переменные окружения Render
//   JWT_SECRET    — тот же секрет, что app_secrets.jwt_secret в базе (НОВОЕ, 12.10.2026)
//   RELAY_KEY     — общий секрет для вызовов из n8n (заголовок X-Relay-Key)
//   N8N_API_KEY   — ключ публичного API n8n (Settings → n8n API)
//   N8N_BASE_URL  — по умолчанию https://babchin.app.n8n.cloud
// ─────────────────────────────────────────────────────────────────────────
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'https://babchin.app.n8n.cloud').replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
const RELAY_KEY = process.env.RELAY_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

const WATCH_INTERVAL_MS = 30 * 1000;          // опрос n8n
const WATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // дольше суток не следим

// Ответы на вопросы relay пересылает только на адреса ожидания n8n — иначе
// любой мог бы подсунуть приложению вопрос с чужим callback_url.
const CALLBACK_PREFIX = `${N8N_BASE_URL}/webhook-waiting/`;

if (!JWT_SECRET) console.error('JWT_SECRET не задан — регистрация окон работать не будет');
if (!RELAY_KEY) console.error('RELAY_KEY не задан — вызовы из n8n будут отклонены');

// ─────────────────────────────────────────────────────────────────────────
// Сессии (12.10.2026). Каждое окно приложения — своя сессия, sid из токена.
// Окно регистрируется токеном; relay сам проверяет подпись и берёт из токена
// sid и uid. Подделать чужой адрес, просто назвав его, больше нельзя.
//
// sid -> { ws, sid, userId }
// ─────────────────────────────────────────────────────────────────────────
const sessions = new Map();

function verifyJwt(token) {
  if (!JWT_SECRET || typeof token !== 'string') return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  // Служебный токен очереди окном не бывает.
  if (payload.service || !payload.sid || payload.uid == null) return null;
  return { sid: String(payload.sid), userId: String(payload.uid) };
}

// В n8n «канала нет» обозначается -1; пустые значения тоже не адрес.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return (s === '' || s === '-1' || s === 'null' || s === 'undefined') ? null : s;
}

function sendTo(entry, payload) {
  if (entry && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(payload));
    return [{ sid: entry.sid, user_id: entry.userId }];
  }
  return [];
}

function sendToUserId(userId, payload) {
  let sent = [];
  sessions.forEach(entry => {
    if (entry.userId === String(userId)) sent = sent.concat(sendTo(entry, payload));
  });
  return sent;
}

// Куда доставить: сначала окно, из которого начато действие (sid), — но только
// если это окно того же пользователя. Окно закрыто или sid не указан — во все
// окна пользователя. Широковещательной рассылки нет: сообщение без адреса — ошибка.
function deliver(payload) {
  const sid = clean(payload.sid);
  const userId = clean(payload.user_id);
  if (sid) {
    const entry = sessions.get(sid);
    if (entry && (userId == null || entry.userId === userId)) {
      const sent = sendTo(entry, payload);
      if (sent.length) return sent;
    }
  }
  if (userId) return sendToUserId(userId, payload);
  return [];
}

function relayKeyOk(req) {
  return Boolean(RELAY_KEY) && req.headers['x-relay-key'] === RELAY_KEY;
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

// execution_id -> { user_id, sid, label, started }
const runs = new Map();

function trackExecution(body) {
  const id = clean(body.execution_id);
  if (!id) return false;
  runs.set(id, {
    user_id: clean(body.user_id),
    // client_id — прежнее имя поля; в нём теперь тоже sid.
    sid: clean(body.sid) || clean(body.client_id),
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

  const sent = deliver({
    type: 'notification',
    kind: 'execution_crashed',
    id: String(id),
    message: text,
    source: 'relay',
    sid: run.sid,
    user_id: run.user_id,
  });

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

function reply(res, code, obj) {
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { status: 'ok', sessions: sessions.size, watched_executions: runs.size });
    return;
  }

  // Всё остальное по HTTP вызывает только n8n — с ключом.
  if (req.method === 'POST' && !relayKeyOk(req)) {
    reply(res, 403, { error: 'forbidden' });
    return;
  }

  // Регистрация выполнения n8n для наблюдения
  if (req.method === 'POST' && req.url === '/exec/track') {
    readBody(req, body => {
      try {
        const ok = trackExecution(JSON.parse(body));
        if (!ok) { reply(res, 400, { error: 'execution_id is required' }); return; }
        reply(res, 200, { status: 'tracking', watching: runs.size });
      } catch (e) {
        reply(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Вопрос или уведомление в приложение.
  // Адрес: sid (окно) и/или user_id (все окна пользователя).
  if (req.method === 'POST' && (req.url === '/question' || req.url === '/notification')) {
    readBody(req, body => {
      try {
        const payload = JSON.parse(body);
        // Прежнее имя поля: n8n мог прислать sid под именем client_id.
        if (!clean(payload.sid) && clean(payload.client_id)) payload.sid = payload.client_id;
        delete payload.client_id;

        if (!clean(payload.sid) && !clean(payload.user_id)) {
          reply(res, 400, { error: 'sid or user_id is required' });
          return;
        }
        const sent = deliver(payload);
        console.log(`Sent to ${sent.length} window(s) [sid: ${payload.sid || '-'}, user: ${payload.user_id || '-'}]`);
        reply(res, 200, { status: 'sent', count: sent.length, sessions: sent });
      } catch (e) {
        reply(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Сессия завершена на сервере (выход, блокировка) — закрываем её окно.
  if (req.method === 'POST' && req.url === '/session/close') {
    readBody(req, body => {
      try {
        const { sid, user_id } = JSON.parse(body);
        let closed = 0;
        sessions.forEach((entry, key) => {
          if ((sid && key === String(sid)) || (user_id != null && entry.userId === String(user_id))) {
            sessions.delete(key);
            try { entry.ws.close(4001, 'session closed'); } catch (_) {}
            closed++;
          }
        });
        reply(res, 200, { status: 'closed', count: closed });
      } catch (e) {
        reply(res, 400, { error: e.message });
      }
    });
    return;
  }

  reply(res, 404, { error: 'Not found' });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  // Ключ этого соединения в sessions; null — окно ещё не зарегистрировалось.
  let currentSid = null;

  ws.send(JSON.stringify({ type: 'connected' }));

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());

      // Регистрация окна: { type: 'register', jwt }
      if (msg.type === 'register') {
        const who = verifyJwt(msg.jwt);
        if (!who) {
          ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'token is invalid or expired' }));
          return;
        }

        // Окно перерегистрировалось новым токеном (перелогин) — старую запись снимаем.
        if (currentSid && currentSid !== who.sid) {
          const old = sessions.get(currentSid);
          if (old && old.ws === ws) sessions.delete(currentSid);
        }

        // По этому sid уже есть другое живое соединение (окно переподключилось,
        // не дождавшись закрытия старого сокета) — старое закрываем.
        const stale = sessions.get(who.sid);
        if (stale && stale.ws !== ws && stale.ws.readyState === WebSocket.OPEN) {
          try { stale.ws.close(); } catch (_) {}
        }

        currentSid = who.sid;
        sessions.set(who.sid, { ws, sid: who.sid, userId: who.userId });
        console.log(`Registered: sid=${who.sid} user_id=${who.userId} (total: ${sessions.size})`);
        ws.send(JSON.stringify({ type: 'registered', sid: who.sid, user_id: Number(who.userId) }));
        return;
      }

      // Отмена регистрации (выход): снимаем только свою запись.
      if (msg.type === 'unregister') {
        const entry = currentSid && sessions.get(currentSid);
        if (entry && entry.ws === ws) sessions.delete(currentSid);
        ws.send(JSON.stringify({ type: 'unregistered', sid: currentSid }));
        console.log(`Unregistered: sid=${currentSid} (total: ${sessions.size})`);
        currentSid = null;
        return;
      }

      // Ответ на вопрос — только от зарегистрированного окна и только в n8n.
      if (msg.type === 'answer' && msg.callback_url) {
        if (!currentSid) {
          ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'register first' }));
          return;
        }
        if (!String(msg.callback_url).startsWith(CALLBACK_PREFIX)) {
          console.error(`Answer rejected: callback_url ${msg.callback_url} is not an n8n resume URL`);
          return;
        }
        console.log(`Answer "${msg.answer}" → ${msg.callback_url}`);
        try {
          // Пересылаем всё, кроме транспортных полей: у разных ответов разные
          // поля (answer, dt/kt, splits) — фиксированный список их терял.
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
    // иначе можно удалить более новую регистрацию того же окна.
    const entry = currentSid && sessions.get(currentSid);
    if (entry && entry.ws === ws) sessions.delete(currentSid);
    console.log(`Disconnected: ${currentSid || 'unregistered'} (total: ${sessions.size})`);
  });

  ws.on('error', err => console.error(`WS error ${currentSid || 'unregistered'}:`, err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay server running on port ${PORT}`));
