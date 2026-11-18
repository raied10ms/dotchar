#!/usr/bin/env python3
"""
Moustache / beard fix for an unpacked .char folder (then `npm run char -- pack`).

  python3 tools/facial_hair.py <char_folder> --master master.png [--mouthless mouthless.png] --lips x0,y0,x1,y1 [--dark-gap 14]

1. cover   -> only an ellipse over the DRAWN LIPS (from the mouthless image, or blended skin), so the moustache and beard
              on every pose image stay visible (a full mouthless patch often erases facial hair too).
2. overMouth -> moustache hair cut from the master, drawn AFTER the library mouth: the mouth opens behind the moustache.
              Nothing below the lips is occluded: a dropping jaw carries the lower lip down over the beard.
--lips = box of the drawn lips on the master (canvas px). --dark-gap = how much darker than the skin (L*) a pixel must be to count as hair.
"""
import argparse, json, os
import numpy as np
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument('folder'); ap.add_argument('--master', required=True); ap.add_argument('--mouthless')
ap.add_argument('--lips', required=True); ap.add_argument('--dark-gap', type=float, default=14, help='hair = this much darker (L*) than the skin')
ap.add_argument('--pad', type=float, default=0.06, help='cover ellipse padding, fraction of lip width')
ap.add_argument('--fill', type=float, default=0.85, help='rest mouth width as a fraction of the drawn lip width (0 = keep sizes)')
a = ap.parse_args()

x0, y0, x1, y1 = map(int, a.lips.split(','))
w, h = x1 - x0, y1 - y0
M = np.asarray(Image.open(a.master).convert('RGBA')).astype(np.float32)
H, W = M.shape[:2]


def lab(rgb):
    c = rgb / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    X = (0.4124 * lin[..., 0] + 0.3576 * lin[..., 1] + 0.1805 * lin[..., 2]) / 0.95047
    Y = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    Z = (0.0193 * lin[..., 0] + 0.1192 * lin[..., 1] + 0.9505 * lin[..., 2]) / 1.08883
    f = lambda t: np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)
    fx, fy, fz = f(X), f(Y), f(Z)
    return 116 * fy - 16, np.hypot(500 * (fx - fy), 200 * (fy - fz))


def feather(mask, r):
    return np.asarray(Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255


yy, xx = np.mgrid[0:H, 0:W]
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

# hair = darker than THIS character's skin, or dark and desaturated (skin is warm/saturated). Skin reference = saturated
# pixels in a wide band above the lips (cheeks / upper lip).
L, C = lab(M[..., :3])
ref = (yy > y0 - 0.6 * w) & (yy < y0) & (xx > x0 - 0.3 * w) & (xx < x1 + 0.3 * w) & (M[..., 3] > 200)
skinL = float(np.median(L[ref & (C > np.percentile(C[ref], 60))]))
skinC = float(np.median(C[ref & (C > np.percentile(C[ref], 60))]))
hair = np.maximum(np.clip((skinL - a.dark_gap - L) / 12, 0, 1),
                  np.clip((skinL - 6 - L) / 14, 0, 1) * np.clip((skinC * 0.75 - C) / 10, 0, 1))

# ---- 1. cover: lips ellipse only
pad = a.pad * w
rx, ry = w / 2 + pad, h / 2 + pad * 0.8
ell = (((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2) <= 1
if a.mouthless:
    src = np.asarray(Image.open(a.mouthless).convert('RGBA').resize((W, H))).astype(np.float32)
else:  # blend each column from the skin just above to just below the ellipse
    src = M.copy()
    top, bot = int(cy - ry) - 3, int(cy + ry) + 3
    for x in range(int(cx - rx), int(cx + rx) + 1):
        for y in range(top, bot + 1):
            t = (y - top) / (bot - top)
            src[y, x, :3] = M[top, x, :3] * (1 - t) + M[bot, x, :3] * t
keep = hair * ((yy < y0 - 2) | (yy > y1 + 2))            # facial hair just outside the lips stays visible
cov_a = feather(ell.astype(np.float32), 2.0) * (1 - keep) * (M[..., 3] / 255)
bx0, by0, bx1, by1 = int(cx - rx - 6), int(cy - ry - 6), int(cx + rx + 7), int(cy + ry + 7)
cover = src[by0:by1, bx0:bx1].copy(); cover[..., 3] = cov_a[by0:by1, bx0:bx1] * 255

# ---- 2. overMouth: moustache hair above the upper lip (and hanging down at the corners)
band = ((xx >= x0 - 0.35 * w) & (xx <= x1 + 0.35 * w) & (yy >= y0 - 0.32 * w) & (yy <= y0 + 0.2 * h))
corners = (((xx < x0 + 0.12 * w) & (xx >= x0 - 0.35 * w)) | ((xx > x1 - 0.12 * w) & (xx <= x1 + 0.35 * w))) & (yy > y0) & (yy <= y1)
region = feather((band | corners).astype(np.float32), 3)
occ_a = hair * region * (M[..., 3] / 255)
ys, xs = np.nonzero(occ_a > 0.02)
if len(xs):
    ox0, oy0, ox1, oy1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    occ = M[oy0:oy1, ox0:ox1].copy(); occ[..., 3] = occ_a[oy0:oy1, ox0:ox1] * 255

char_path = os.path.join(a.folder, 'char.json')
c = json.load(open(char_path))
F = c['face']
Image.fromarray(cover.astype(np.uint8)).save(os.path.join(a.folder, 'face/cover.png'))
F['cover'] = {'image': 'face/cover.png', 'at': [bx0, by0]}
for old in ('face/cover.webp',):
    p = os.path.join(a.folder, old)
    if os.path.exists(p): os.remove(p)
if len(xs):
    Image.fromarray(occ.astype(np.uint8)).save(os.path.join(a.folder, 'face/over-mouth.png'))
    F['overMouth'] = {'image': 'face/over-mouth.png', 'at': [int(ox0), int(oy0)]}
if a.fill > 0 and F.get('mouthSpec', {}).get('restWidthPx'):
    k = a.fill * w / F['mouthSpec']['restWidthPx']
    if abs(k - 1) > 0.02:  # scale every viseme about the mouth anchor (images are stretched at draw time)
        mx, my = F['mouthAnchor']
        for set_ in F['mouths'].values():
            for m in set_.values():
                m['at'] = [round(mx + (m['at'][0] - mx) * k, 1), round(my + (m['at'][1] - my) * k, 1)]
                m['size'] = [round(m['size'][0] * k, 1), round(m['size'][1] * k, 1)]
        F['mouthSpec']['restWidthPx'] = round(F['mouthSpec']['restWidthPx'] * k, 1)
        F['mouthSpec']['scale'] = round(F['mouthSpec']['scale'] * k, 4)
        print(f"mouths scaled x{k:.2f} to {a.fill:.0%} of the drawn lips")
F['facialHair'] = {'lips': [x0, y0, x1, y1], 'skinL': round(skinL, 1), 'darkGap': a.dark_gap}
json.dump(c, open(char_path, 'w'), indent=1, ensure_ascii=False)
print(f"{c['id']}: skin L*{skinL:.0f} C{skinC:.0f}; cover {cover.shape[1]}x{cover.shape[0]} at {bx0},{by0}; overMouth {'%dx%d' % (ox1-ox0, oy1-oy0) if len(xs) else 'none'} ({int((occ_a > 0.5).sum())} hair px)")
