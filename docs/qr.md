# QR-код кассового чека (11.11.2026)

`POST /qr/decode` (заголовок `X-Relay-Key`), тело — сам файл фото (`Content-Type: image/jpeg`
или любой не-JSON) либо JSON `{ "data": "<фото в base64>" }`.
Ответ: `{ "qr": ["t=20261109T0904&s=562.00&fn=…&i=…&fp=…&n=1"], "engine": "zxing" | "wechat" | "" }`.

- Читаются JPEG и PNG; PDF и прочее — пустой список.
- Сначала zxing-wasm (быстро). Не прочитала — декодер WeChat из OpenCV
  (`scripts/qr_wechat.py`): читает мятые и изогнутые чеки, около секунды на фото,
  по одному фото за раз.
- OpenCV ставится при `npm install` (postinstall, `scripts/install-qr.js`) в `.pydeps`.
  Нет Python или pip — relay работает, QR читает только zxing. `GET /health` → `qr_wechat`.
- Фото никуда дальше relay не уходят, внешние сервисы не используются.

Вызывает Paul's 1 — только для чеков, когда тип документа уже определён (после Prepare Result JSON:
If Receipt QR → Receipt QR Pages → Download QR Page → Receipt QR → Apply Receipt QR → MAIN INPUT DATA).
Прочитанный QR заменяет распознанные дату, сумму, ФН, ФД и ФП: в QR они без ошибок распознавания.
