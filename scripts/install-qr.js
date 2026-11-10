// postinstall (11.11.2026): ставит OpenCV для чтения QR-кодов чеков в .pydeps.
// Нет Python или pip — не ошибка: relay работает, QR читает только zxing.
const { spawnSync } = require('child_process');
const path = require('path');

if (process.env.SKIP_QR_PYDEPS) process.exit(0);
const target = path.join(__dirname, '..', '.pydeps');
const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet',
  '--target', target, 'opencv-contrib-python-headless==4.10.0.84'];
// Debian 12 (Render) без --break-system-packages может отказать (PEP 668); в
// .pydeps ставим отдельно от системного Python, так что флаг безопасен.
for (const extra of [[], ['--break-system-packages']]) {
  const r = spawnSync('python3', [...args, ...extra], { stdio: 'inherit' });
  if (r.status === 0) { console.log('QR: OpenCV установлен'); process.exit(0); }
}
console.warn('QR: OpenCV не установлен — QR-коды читает только zxing');
