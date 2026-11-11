// Чтение QR-кода кассового чека с фото (11.11.2026).
//
// n8n (Paul's 1) присылает фото, на котором распознаётся текст чека; relay
// ищет на нём QR-коды и возвращает их текст. В QR российского чека — дата и
// время, сумма, ФН, ФД и ФП: «t=20261109T0904&s=562.00&fn=…&i=…&fp=…&n=1».
// Читаем прямо здесь, фото чеков никуда дальше не уходят: сначала быстрая
// zxing-wasm, не прочитала — декодер WeChat из OpenCV (scripts/qr_wechat.py,
// ставится в .pydeps при npm install). Он медленнее, но читает и мятый,
// изогнутый чек, на котором zxing ошибается в контрольной сумме (прогон 33099).
// Не прочитался код — пустой список, и n8n работает как раньше, по тексту.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareZXingModule, readBarcodes } = require('zxing-wasm/reader');

// Без этого zxing-wasm скачивает свой wasm с CDN при первом вызове.
prepareZXingModule({
  overrides: {
    wasmBinary: fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')),
  },
});

// JPEG и PNG по первым байтам (тип из n8n бывает «JPEG», «image/png», а бывает
// и неверным). PDF и прочее не читаем: в электронном чеке реквизиты есть текстом.
function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  return '';
}

const PYDEPS = path.join(__dirname, '.pydeps');
const WECHAT_SCRIPT = path.join(__dirname, 'scripts', 'qr_wechat.py');
const WECHAT_TIMEOUT_MS = 30 * 1000;

// Есть ли OpenCV: проверяем один раз (для /health и чтобы не запускать зря).
let wechatReady = null;
function wechatAvailable() {
  if (wechatReady === null) wechatReady = fs.existsSync(path.join(PYDEPS, 'cv2'));
  return wechatReady;
}

// По одному: OpenCV занимает ~150 МБ, а у Render всего 512 МБ, n8n же
// может прислать сразу пачку фото.
let wechatQueue = Promise.resolve();
function decodeWechat(buf) {
  const run = wechatQueue.then(() => decodeWechatNow(buf));
  wechatQueue = run.catch(() => {});
  return run;
}

function decodeWechatNow(buf) {
  return runPython(WECHAT_SCRIPT, buf).then(list =>
    (Array.isArray(list) ? list.map(String).filter(Boolean) : []));
}

// Фото → JSON от скрипта на Python (OpenCV); ошибка или таймаут — null.
function runPython(script, buf) {
  return new Promise(resolve => {
    let out = '';
    let err = '';
    const py = spawn('python3', [script], {
      env: { ...process.env, PYTHONPATH: PYDEPS },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => py.kill('SIGKILL'), WECHAT_TIMEOUT_MS);
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('error', e => { clearTimeout(timer); console.error('QR python:', e.message); resolve(null); });
    py.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { console.error(`QR python exit ${code}: ${err.slice(-500)}`); resolve(null); return; }
      try {
        resolve(JSON.parse(out));
      } catch (_) {
        resolve(null);
      }
    });
    py.stdin.on('error', () => {});
    py.stdin.end(buf);
  });
}

async function decodeZxing(buf) {
  const found = await readBarcodes(new Uint8Array(buf), {
    formats: ['QRCode'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: true,
    maxNumberOfSymbols: 8,
  });
  return found.filter(r => r.isValid && r.text).map(r => r.text);
}

// Тексты всех прочитанных QR-кодов на фото, без повторов, и чем прочитаны.
async function decodeQr(buf) {
  if (!imageKind(buf)) return { qr: [], engine: '' };
  let qr = [];
  try { qr = await decodeZxing(buf); } catch (e) { console.error('QR zxing:', e.message); }
  if (qr.length) return { qr: [...new Set(qr)], engine: 'zxing' };
  if (!wechatAvailable()) return { qr: [], engine: '' };
  qr = await decodeWechat(buf);
  return { qr: [...new Set(qr)], engine: qr.length ? 'wechat' : '' };
}

const SPLIT_SCRIPT = path.join(__dirname, 'scripts', 'qr_split.py');

// Фото с несколькими чеками → части по QR-кодам (11.11.2026, scripts/qr_split.py):
// { qr: [{text, x, y, size}], axis, parts: [{jpeg: base64, box, qr}], reason }. Без OpenCV — не делим.
async function splitByQr(buf) {
  const none = (reason) => ({ qr: [], axis: '', parts: [], reason });
  if (!imageKind(buf)) return none('не фото');
  if (!wechatAvailable()) return none('нет OpenCV');
  const run = wechatQueue.then(() => runPython(SPLIT_SCRIPT, buf));
  wechatQueue = run.catch(() => {});
  const r = await run;
  return r && Array.isArray(r.parts) ? r : none('не удалось разобрать фото');
}

module.exports = { decodeQr, imageKind, wechatAvailable, splitByQr };
