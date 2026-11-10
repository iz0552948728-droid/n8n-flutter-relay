# QR-код кассового чека (11.11.2026)

`POST /qr/decode` (заголовок `X-Relay-Key`), тело `{ "data": "<фото в base64>" }`.
Ответ: `{ "qr": ["t=20261109T0904&s=562.00&fn=…&i=…&fp=…&n=1"], "engine": "zxing" | "wechat" | "" }`.

- Читаются JPEG и PNG; PDF и прочее — пустой список.
- Сначала zxing-wasm (быстро). Не прочитала — декодер WeChat из OpenCV
  (`scripts/qr_wechat.py`): читает мятые и изогнутые чеки, около секунды на фото,
  по одному фото за раз.
- OpenCV ставится при `npm install` (postinstall, `scripts/install-qr.js`) в `.pydeps`.
  Нет Python или pip — relay работает, QR читает только zxing. `GET /health` → `qr_wechat`.
- Фото никуда дальше relay не уходят, внешние сервисы не используются.

Вызывает Paul's 1 (ноды Receipt QR → Restore For Vision перед Yandex Vision). Build Document Id
берёт из QR ФН, ФД, ФП, дату-время и сумму, если QR не противоречит распознанному тексту.
