# Разделение фото с несколькими чеками по QR-кодам (11.11.2026).
# stdin — фото (JPEG/PNG), stdout — JSON:
#   { "qr": [{"text", "x", "y", "size"}], "axis": "x"|"y"|"", "parts": [{"jpeg": base64, "box": [x0,y0,x1,y1], "qr": text}], "reason": "" }
# QR ищем декодером WeChat (OpenCV) на всём фото, а не нашли двух — ещё и по частям кадра: мелкий QR
# второго чека на целом фото не находится (фото 11.11.2026, два чека рядом). Чеков — по числу разных
# фискальных QR (fn, i, fp). Делим по полосе без текста между соседними QR: чеки лежат рядом (по x)
# или друг под другом (по y). Полосы нет — не делим: parts пустой, reason — почему.
import base64
import json
import sys

import cv2
import numpy as np


def fiscal(text):
    q = {}
    for part in text.strip().split('&'):
        if '=' in part:
            k, v = part.split('=', 1)
            q[k.lower()] = v
    if q.get('fn', '').isdigit() and len(q['fn']) == 16 and q.get('i', '').isdigit() and q.get('fp', '').isdigit():
        return (q['fn'], str(int(q['i'])))
    return None


def detect(img):
    det = cv2.wechat_qrcode_WeChatQRCode()
    h, w = img.shape[:2]
    found = {}

    def run(x0, y0, tw, th, limit=0):
        tile = img[y0:y0 + th, x0:x0 + tw]
        k = 1.0
        # Части кадра — не крупнее limit: так в разы быстрее, а QR чека на фото и после этого достаточно крупный.
        if limit and max(tw, th) > limit:
            k = limit / max(tw, th)
            tile = cv2.resize(tile, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        texts, points = det.detectAndDecode(tile)
        for t, p in zip(texts, points):
            if not t or t in found:
                continue
            p = p / k
            c = p.mean(axis=0)
            size = float(max(np.ptp(p[:, 0]), np.ptp(p[:, 1])))
            found[t] = {'text': t, 'x': int(c[0] + x0), 'y': int(c[1] + y0), 'size': int(size)}

    def receipts():
        return len({fiscal(t) for t in found if fiscal(t)})

    # Целый кадр — не крупнее 2000 px: на полном 12 Мп декодер без находки съедает ~500 МБ (11.11.2026).
    run(0, 0, w, h, 2000)
    # Сетки от крупной к мелкой; нашлось два чека и больше — дальше не ищем (каждый проход ~1 с на тайл).
    for nx, ny in [(2, 1), (1, 2), (2, 2), (3, 2), (2, 3)]:
        if receipts() >= 2:
            break
        tw, th = min(w, int(w / nx * 1.3)), min(h, int(h / ny * 1.3))
        for i in range(nx):
            for j in range(ny):
                x0 = max(0, min(w - tw, int(i * w / nx - 0.15 * w / nx)))
                y0 = max(0, min(h - th, int(j * h / ny - 0.15 * h / ny)))
                run(x0, y0, tw, th, 1600)
    return list(found.values())


def split(img, codes):
    """Границы между чеками: середина самой «пустой» полосы между соседними QR."""
    h, w = img.shape[:2]
    xs = [c['x'] for c in codes]
    ys = [c['y'] for c in codes]
    axis = 'x' if np.ptp(xs) >= np.ptp(ys) else 'y'
    codes = sorted(codes, key=lambda c: c[axis])
    ink = cv2.adaptiveThreshold(img, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    prof = ink.mean(axis=0 if axis == 'x' else 1).astype(float)
    win = max(5, int(len(prof) * 0.01))
    prof = np.convolve(prof, np.ones(win) / win, mode='same')
    cuts = []
    for a, b in zip(codes, codes[1:]):
        # Не режем по самим QR: от края кода до края соседнего.
        lo = int(a[axis] + a['size'] * 0.6)
        hi = int(b[axis] - b['size'] * 0.6)
        if hi - lo < win * 2:
            return axis, [], 'QR слишком близко друг к другу'
        seg = prof[lo:hi]
        k = int(np.argmin(seg))
        busy = float(np.median(prof[int(min(a[axis], b[axis])):int(max(a[axis], b[axis]))]))
        if seg[k] > 0.35 * busy:
            return axis, [], 'между чеками нет пустой полосы'
        # Середина пустой полосы вокруг минимума.
        thr = seg[k] + 0.1 * (busy - seg[k])
        l = k
        while l > 0 and seg[l - 1] <= thr:
            l -= 1
        r = k
        while r < len(seg) - 1 and seg[r + 1] <= thr:
            r += 1
        cuts.append(lo + (l + r) // 2)
    edges = [0] + cuts + [w if axis == 'x' else h]
    boxes = []
    for i, c in enumerate(codes):
        a0, a1 = edges[i], edges[i + 1]
        boxes.append(([a0, 0, a1, h] if axis == 'x' else [0, a0, w, a1], c['text']))
    return axis, boxes, ''


def encode_parts(img, boxes):
    parts = []
    for box, text in boxes:
        crop = img[box[1]:box[3], box[0]:box[2]]
        ok, buf = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if ok:
            parts.append({'jpeg': base64.b64encode(buf.tobytes()).decode(), 'box': box, 'qr': text})
    return parts if len(parts) == len(boxes) else []


def main():
    data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
    # Ищем по серому кадру: втрое меньше памяти, чем цветной (у relay на Render 512 МБ, цветной 12 Мп
    # с частями кадра доходил до 600 МБ — relay падал, n8n получал 502). Цветной — только чтобы вырезать чеки.
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)  # с учётом поворота из EXIF
    out = {'qr': [], 'axis': '', 'parts': [], 'reason': ''}
    if img is None:
        out['reason'] = 'не фото'
    else:
        codes = detect(img)
        out['qr'] = codes
        receipts = {}
        for c in codes:
            f = fiscal(c['text'])
            if f and f not in receipts:
                receipts[f] = c
        if len(receipts) < 2:
            out['reason'] = 'чеков по QR меньше двух'
        else:
            out['axis'], cuts, out['reason'] = split(img, list(receipts.values()))
            if cuts:
                del img
                color = cv2.imdecode(data, cv2.IMREAD_COLOR)
                out['parts'] = encode_parts(color, cuts)
    print(json.dumps(out, ensure_ascii=False))


main()
