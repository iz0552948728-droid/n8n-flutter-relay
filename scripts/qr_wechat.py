# QR-код чека декодером WeChat из OpenCV (11.11.2026). Читает фото из stdin,
# печатает JSON-список текстов. Вызывает qr.js, когда zxing код не прочитал:
# на мятом, изогнутом чеке (прогон 33099) справляется только этот декодер.
import json
import sys

import cv2
import numpy as np

data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
img = cv2.imdecode(data, cv2.IMREAD_COLOR)
found = []
if img is not None:
    texts, _ = cv2.wechat_qrcode_WeChatQRCode().detectAndDecode(img)
    found = [t for t in texts if t]
print(json.dumps(found, ensure_ascii=False))
