#!/usr/bin/env python3
"""
Eye states: ONE patch per (expression x eyes open/closed), covering the eyes AND eyebrows together, cut from that
state's own full drawing and registered to the master. Replaces stacked eye / brow / blink layers, which leave the
neutral eyebrows visible under the expression's eyebrows ("double eyebrows") and can change one eye but not the other.

  python3 tools/eye_states.py <char_folder> --master master.png --dir <images> [--sheet qa.png]

<images> holds full-canvas edits of the master (same size and framing):
   eyes-closed.png (or blink.png)      neutral blink                      required
   expr-<mood>.png                     eyes + brows of each expression
   blink-<mood>.png                    that expression with the eyes closed (optional; without it the blink of an
                                       expression = its own brows + the neutral closed lids)
Writes <char_folder>/face/states/*.webp and switches char.json to the "states" eye system (SPEC.md).
Needs: pillow, numpy, opencv-python.
"""
import argparse, json, os, glob, sys
import numpy as np
import cv2
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument('char'); ap.add_argument('--master', required=True); ap.add_argument('--dir', required=True); ap.add_argument('--sheet')
ap.add_argument('--feather', type=float, default=5.0)
ap.add_argument('--keep-visor', action='store_true', help='keep the old glasses overlay layer (only if a state drawing damaged the glasses)')
ap.add_argument('--eyes', help='box around both eye openings on the master, if auto-detection picks the wrong thing')
a = ap.parse_args()

C = json.load(open(os.path.join(a.char, 'char.json'))); F = C['face']
M = np.asarray(Image.open(a.master).convert('RGBA')).astype(np.float32)
H, W = M.shape[:2]
load = lambda p: np.asarray(Image.open(p).convert('RGBA').resize((W, H), Image.LANCZOS)).astype(np.float32)
D = lambda f: os.path.join(a.dir, f)
closed_p = next((D(f) for f in ('eyes-closed.png', 'blink.png') if os.path.exists(D(f))), None)
if not closed_p: sys.exit('need eyes-closed.png (or blink.png) in --dir')
exprs = {os.path.basename(f)[5:-4]: f for f in sorted(glob.glob(D('expr-*.png')))}
blinks = {os.path.basename(f)[6:-4]: f for f in sorted(glob.glob(D('blink-*.png')))}


def gray(x):
    al = x[..., 3:4] / 255
    return ((x[..., :3] * al + 255 * (1 - al)) @ np.array([0.299, 0.587, 0.114], np.float32) / 255).astype(np.float32)


bx0, by0, bx1, by1 = F['box']; ay = F['mouthAnchor'][1]
upper = np.zeros((H, W), bool); upper[max(0, int(by0)):int(ay - 0.12 * (by1 - by0)), max(0, int(bx0)):int(bx1)] = True   # where eyes + brows can be


def register(img):
    """affine img -> master, using everything except the upper face (which is what changes)"""
    mask = ((~upper) & (M[..., 3] > 128)).astype(np.uint8) * 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        s = 0.5  # half resolution is plenty for the estimate and 4x faster
        g0 = cv2.resize(gray(M), None, fx=s, fy=s, interpolation=cv2.INTER_AREA); g1 = cv2.resize(gray(img), None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        mk = cv2.resize(mask, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
        cc, warp = cv2.findTransformECC(g0, g1, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 120, 1e-6), mk, 5)
        warp[:, 2] /= s
    except cv2.error:
        cc = 0.0; warp = np.eye(2, 3, dtype=np.float32)
    return cv2.warpAffine(img, warp, (W, H), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE), float(cc)


imgs = {'neutral:closed': register(load(closed_p))}
for e, p in exprs.items(): imgs[f'{e}:camera'] = register(load(p))
for e, p in blinks.items():
    if e in exprs: imgs[f'{e}:closed'] = register(load(p))

# ---- the zone: eye openings (from master vs closed) grown to hold every expression's brows
diff = lambda x: np.abs(M[..., :3] - x[..., :3]).mean(-1)
bw_, bh_ = bx1 - bx0, by1 - by0
eyeband = np.zeros((H, W), bool); eyeband[int(by0 + 0.22 * bh_):int(ay - 0.16 * bh_), int(bx0 + 0.16 * bw_):int(bx1 - 0.16 * bw_)] = True   # eyes sit in the middle of the face, not at the temples
m = ((diff(imgs['neutral:closed'][0]) > 36) & eyeband).astype(np.uint8)
m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
cand = [c for c in sorted(stats[1:], key=lambda s: -s[4])[:8] if c[4] >= 0.0008 * bw_ * bh_ and c[2] >= 0.05 * bw_]   # real eye openings, not specks or thin slivers
fcx = (bx0 + bx1) / 2
def pair_cost(p, q):  # two eyes: level, mirrored about the face centre, similar size, both wider than tall-ish
    (x, y, w, h, n1), (X, Y, Wd, Hh, n2) = p, q
    return (abs((y + h / 2) - (Y + Hh / 2)) / bh_ * 6 + abs(((x + w / 2) + (X + Wd / 2)) / 2 - fcx) / bw_ * 6
            + abs(np.log((n1 + 1) / (n2 + 1))) + (h > 1.6 * w) + (Hh > 1.6 * Wd) + (abs((x + w / 2) - (X + Wd / 2)) < 0.15 * bw_) * 5)
pairs = [(pair_cost(p, q), p, q) for i, p in enumerate(cand) for q in cand[i + 1:]]
if a.eyes: ox0, oy0, ox1, oy1 = [int(v) for v in a.eyes.split(',')]; comps = []
else:
    if not pairs: sys.exit('could not find two eye openings from master vs eyes-closed: pass --eyes x0,y0,x1,y1 (box around both eye openings)')
    comps = list(min(pairs, key=lambda t: t[0])[1:])
    ox0 = min(c[0] for c in comps); oy0 = min(c[1] for c in comps); ox1 = max(c[0] + c[2] for c in comps); oy1 = max(c[1] + c[3] for c in comps)
ow, oh = ox1 - ox0, max(10, oy1 - oy0)
print(f'  eye openings: x {ox0}-{ox1}, y {oy0}-{oy1} (components {[tuple(int(v) for v in c) for c in comps]})')
lim = [max(bx0, ox0 - 0.3 * ow), max(by0, oy0 - 3.4 * oh), min(bx1, ox1 + 0.3 * ow), min(ay - 0.12 * (by1 - by0), oy1 + 0.9 * oh)]   # the most the zone may grow
search = np.zeros((H, W), bool); search[int(lim[1]):int(lim[3]), int(lim[0]):int(lim[2])] = True
zx0, zy0, zx1, zy1 = ox0 - 0.22 * ow, oy0 - 1.6 * oh, ox1 + 0.22 * ow, oy1 + 0.55 * oh      # default: openings + resting brows
for k, (im, cc) in imgs.items():
    if cc < 0.96: continue                                                 # a drawing that does not line up must not size the zone
    d = cv2.morphologyEx(((diff(im) > 48) & search).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    ys, xs = np.nonzero(d)
    if len(xs) > 30:
        zx0 = min(zx0, np.percentile(xs, 3) - 8); zx1 = max(zx1, np.percentile(xs, 97) + 8)
        zy0 = min(zy0, np.percentile(ys, 3) - 10); zy1 = max(zy1, np.percentile(ys, 97) + 8)
zx0, zy0, zx1, zy1 = [int(round(v)) for v in (max(lim[0], zx0), max(lim[1], zy0), min(lim[2], zx1), min(lim[3], zy1))]
f = a.feather
zone = np.zeros((H, W), np.float32); cv2.rectangle(zone, (int(zx0 + 2 * f), int(zy0 + 2 * f)), (int(zx1 - 2 * f), int(zy1 - 2 * f)), 1.0, -1)
alpha = np.clip(cv2.GaussianBlur(cv2.dilate(zone, np.ones((int(2 * f) | 1, int(2 * f) | 1))), (0, 0), f) * 1.0, 0, 1) * (M[..., 3] / 255)
ring = np.zeros((H, W), bool); ring[max(0, zy0 - 14):zy1 + 14, max(0, zx0 - 14):zx1 + 14] = True; ring[zy0:zy1, zx0:zx1] = False; ring &= M[..., 3] > 200
px0, py0, px1, py1 = max(0, zx0 - int(3 * f)), max(0, zy0 - int(3 * f)), min(W, zx1 + int(3 * f)), min(H, zy1 + int(3 * f))
lids = np.zeros((H, W), np.float32)                                         # just the eye openings (for blinks without their own drawing)
cv2.rectangle(lids, (int(ox0 - 0.12 * ow), int(oy0 - 0.35 * oh)), (int(ox1 + 0.12 * ow), int(oy1 + 0.35 * oh)), 1.0, -1); lids = cv2.GaussianBlur(lids, (0, 0), 3)[..., None]

for old in glob.glob(os.path.join(a.char, 'face', 'states', '*')): os.remove(old)
os.makedirs(os.path.join(a.char, 'face', 'states'), exist_ok=True)
states, shown = {}, []


def put(expr, eye, img, note=''):
    d = np.clip(np.median(M[..., :3][ring] - img[..., :3][ring], 0), -10, 10)  # gentle tone match at the patch edge (median: hair and rims in the ring don't skew it)
    img = img.copy(); img[..., :3] = np.clip(img[..., :3] + d, 0, 255)
    edge = float(np.median(np.abs(M[..., :3][ring] - img[..., :3][ring])))
    tile = img[py0:py1, px0:px1].copy(); tile[..., 3] = alpha[py0:py1, px0:px1] * 255
    fn = f'face/states/{expr}-{eye}.webp'
    Image.fromarray(tile.astype(np.uint8)).save(os.path.join(a.char, fn), 'WEBP', quality=95, method=6, exact=True)
    states.setdefault(expr, {})[eye] = {'image': fn, 'at': [px0, py0]}
    shown.append((f'{expr} {eye}', img))
    print(f'  {expr}:{eye}  edge difference {edge:.1f}/255{note}' + ('  <-- check for a seam (> 10)' if edge > 10 else ''))
    return img


put('neutral', 'camera', M)
closed0 = put('neutral', 'closed', imgs['neutral:closed'][0], f"  registration {imgs['neutral:closed'][1]:.3f}")
for e in exprs:
    cam = put(e, 'camera', imgs[f'{e}:camera'][0], f"  registration {imgs[f'{e}:camera'][1]:.3f}")
    if f'{e}:closed' in imgs and imgs[f'{e}:closed'][1] >= 0.96: put(e, 'closed', imgs[f'{e}:closed'][0], f"  registration {imgs[f'{e}:closed'][1]:.3f}")
    else:                                                                    # this expression's brows + the neutral closed lids
        mix = cam.copy(); mix[..., :3] = closed0[..., :3] * lids + cam[..., :3] * (1 - lids)
        put(e, 'closed', mix, '  (brows of the expression + neutral lids)')

# ---- switch char.json to the states eye system
for k in ('eyesBase', 'blink', 'gaze', 'hairLock') + (() if a.keep_visor else ('visor',)):   # visor = neutral glasses pasted over every state: each state's own drawing carries its glasses
    t = F.pop(k, None)
    if isinstance(t, dict) and t.get('image') and os.path.exists(os.path.join(a.char, t['image'])): os.remove(os.path.join(a.char, t['image']))
newx = {}
for e, x in (F.get('expressions') or {}).items():
    for sub in [x, x.get('brows'), x.get('blink'), *(x.get('gaze') or {}).values()]:
        if isinstance(sub, dict) and sub.get('image') and os.path.exists(os.path.join(a.char, sub['image'])): os.remove(os.path.join(a.char, sub['image']))
    newx[e] = {'mouths': x.get('mouths', e)}
for e in exprs: newx.setdefault(e, {'mouths': e if e in F['mouths'] else 'neutral'})
F['expressions'] = newx; F['states'] = states; F['eyeZone'] = [zx0, zy0, zx1, zy1]
json.dump(C, open(os.path.join(a.char, 'char.json'), 'w'), indent=1, ensure_ascii=False)

if a.sheet:
    pad = int(0.25 * (zx1 - zx0)); cx0, cy0, cx1, cy1 = max(0, zx0 - pad), max(0, zy0 - pad), min(W, zx1 + pad), min(H, zy1 + int(1.2 * pad))
    cw, ch = cx1 - cx0, cy1 - cy0; s = 300 / cw; cols = 4
    sheet = Image.new('RGB', (300 * cols, int(ch * s + 1) * ((len(shown) + cols - 1) // cols)), 'white')
    for i, (lab_, img) in enumerate(shown):
        o = M.copy(); al = alpha[..., None]; o[..., :3] = img[..., :3] * al + M[..., :3] * (1 - al)
        bg = Image.new('RGBA', (W, H), 'white'); bg.alpha_composite(Image.fromarray(o.astype(np.uint8)))
        if a.keep_visor and F.get('visor', {}).get('image'): v = Image.open(os.path.join(a.char, F['visor']['image'])).convert('RGBA'); bg.alpha_composite(v, tuple(int(q) for q in F['visor']['at']))
        t = bg.crop((cx0, cy0, cx1, cy1)).resize((300, int(ch * s + 1)), Image.LANCZOS).convert('RGB'); ImageDraw.Draw(t).text((6, 4), lab_, fill=(217, 72, 15))
        sheet.paste(t, ((i % cols) * 300, (i // cols) * int(ch * s + 1)))
    sheet.save(a.sheet); print(f'QA sheet -> {a.sheet}')
print(f"{C['id']}: {len(shown)} eye states, zone {zx1 - zx0}x{zy1 - zy0} px at {zx0},{zy0}")
