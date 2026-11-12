# QR-код чека декодером WeChat из OpenCV (11.11.2026). Читает фото из stdin,
# печатает JSON-список текстов. Вызывает qr.js, когда zxing код не прочитал:
# на мятом, изогнутом чеке (прогон 33099) справляется только этот декодер.
import json
import sys

import cv2
import numpy as np

data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
found = []
if img is not None:
    # Кадр не крупнее 2000 px, потом половины кадра не крупнее 1600: полный 12 Мп кадр без находки
    # съедает у декодера ~500 МБ, а у relay на Render всего 512 (11.11.2026).
    det = cv2.wechat_qrcode_WeChatQRCode()
    h, w = img.shape[:2]

    def run(tile, limit):
        k = min(1.0, limit / max(tile.shape[:2]))
        if k < 1:
            tile = cv2.resize(tile, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        texts, _ = det.detectAndDecode(tile)
        for t in texts:
            if t and t not in found:
                found.append(t)

    run(img, 2000)
    if not found:
        if h >= w:
            halves = [img[0:int(h * 0.6)], img[int(h * 0.4):h]]
        else:
            halves = [img[:, 0:int(w * 0.6)], img[:, int(w * 0.4):w]]
        for part in halves:
            run(part, 1600)
print(json.dumps(found, ensure_ascii=False))
