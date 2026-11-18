#!/usr/bin/env python3
"""
Turn walk / run sheets into clean cycles inside an unpacked .char folder: every frame at the same character size, the
head held at one x so the body never jitters, and the sheet's own ground line kept, so standing feet stay on the ground
(a cycle whose frames are each fitted to their own bounding box looks like shaking on the spot).
Needs: pillow, numpy, opencv-python.

  python3 tools/cycle_fit.py <work> <char_folder> [--sheet cycles-qa.png] [--frames 4]

Reads <work>/cycle-walk.png and/or cycle-run.png (frames side by side, facing right; see tools/gen-cycles.mjs).
Writes <char_folder>/cycles/<kind>/<n>.webp and char.json cycles.<kind> = { facing, fps, stride, frames:[{image, at, size}] }.
  stride = canvas px travelled while the frames play once (one step); players move the character by it, so feet don't slide.
"""
import argparse, json, os, glob
import numpy as np
import cv2
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser(); ap.add_argument('work'); ap.add_argument('char'); ap.add_argument('--sheet'); ap.add_argument('--frames', type=int, default=4)
a = ap.parse_args()
C = json.load(open(os.path.join(a.char, 'char.json')))
rx, ry = C['root']; H = C['height']
FPS = {'walk': 8, 'run': 12}
strips = []


def split(sheet, n):
    """n figures by connected shape (a running figure's trailing leg overlaps its neighbour's columns, so column cuts slice limbs)"""
    al = (sheet[..., 3] > 40).astype(np.uint8)
    num, lab, stats, cent = cv2.connectedComponentsWithStats(cv2.dilate(al, np.ones((5, 5), np.uint8)))
    comps = sorted(range(1, num), key=lambda i: -stats[i][4])
    if len(comps) < n: raise SystemExit(f'found only {len(comps)} separate figures in the sheet (need {n}): the drawings touch each other, re-roll the sheet')
    main = sorted(comps[:n], key=lambda i: cent[i][0])
    owner = {m: m for m in main}
    for c in comps[n:]:                                          # loose bits (a detached hand, hair strand) join the nearest figure
        if stats[c][4] < 30: continue
        owner[c] = min(main, key=lambda m: abs(cent[m][0] - cent[c][0]))
    out = []
    for m in main:
        mask = np.isin(lab, [c for c, o in owner.items() if o == m]) & (al > 0)
        fr = sheet.copy(); fr[~mask] = 0
        xs = np.nonzero(mask.any(0))[0]; out.append(fr[:, max(0, xs.min() - 2):xs.max() + 3])
    return out


for kind in ('walk', 'run'):
    p = os.path.join(a.work, f'cycle-{kind}.png')
    if not os.path.exists(p): continue
    sheet = np.asarray(Image.open(p).convert('RGBA'))
    frames = split(sheet, a.frames)
    info = []
    for fr in frames:
        al = fr[..., 3] > 40; ys, xs = np.nonzero(al)
        top, bot, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        head = al[top:top + int(0.16 * (bot - top))]; hx = np.nonzero(head)[1].mean()
        feet = al[bot - max(3, int(0.035 * (bot - top))):bot]; fxs = np.nonzero(feet)[1]
        info.append(dict(top=top, bot=bot, left=left, right=right, hx=hx, foot_span=int(fxs.max() - fxs.min())))
    ground = max(i['bot'] for i in info)                       # the sheet's ground line
    tall = max(i['bot'] - i['top'] for i in info)
    k = H / tall if kind == 'walk' else 0.89 * H / tall        # walking: the tallest frame stands at full height; a runner leans and crouches (~89%)
    old = glob.glob(os.path.join(a.char, 'cycles', kind, '*'))
    for o in old: os.remove(o)
    os.makedirs(os.path.join(a.char, 'cycles', kind), exist_ok=True)
    out, lifts = [], []
    for n, (fr, i) in enumerate(zip(frames, info)):
        crop = Image.fromarray(fr[i['top']:i['bot'], i['left']:i['right']])
        fn = f'cycles/{kind}/{n}.webp'; crop.save(os.path.join(a.char, fn), 'WEBP', quality=90, method=6, exact=True)
        w, h = (i['right'] - i['left']) * k, (i['bot'] - i['top']) * k
        x = rx - (i['hx'] - i['left']) * k + 0.03 * H           # head over the root, leaning a little into the walk
        lift = (ground - i['bot']) * k
        y = ry - (ground - i['top']) * k + max(0, lift - 0.06 * H)   # keep the sheet's own height above the ground (a leap is capped at 6% of body height)
        out.append({'image': fn, 'at': [round(x, 1), round(y, 1)], 'size': [round(w, 1), round(h, 1)]})
        lifts.append(min(lift, 0.06 * H))
    span = max(i['foot_span'] for i in info) * k               # widest foot-to-foot distance (toe to heel)
    stride = round((span - 0.1 * H) if kind == 'walk' else max(1.9 * (span - 0.1 * H), 0.8 * H))   # heel-to-heel step; a run also covers ground in the air
    C.setdefault('cycles', {})[kind] = {'facing': 'R', 'fps': FPS[kind], 'stride': stride, 'frames': out}
    print(f"{kind}: {len(out)} frames, scale x{k:.2f}, stride {stride}px ({stride / H:.2f} body heights), feet above ground per frame: {[round(l) for l in lifts]}")
    grounded = [l for l in lifts if l < 0.03 * H]
    if kind == 'walk' and len(grounded) < len(lifts) - 1: print('  <-- several walk frames float above the ground line: re-roll the sheet')
    strips.append((kind, frames, info, ground, k))

json.dump(C, open(os.path.join(a.char, 'char.json'), 'w'), indent=1, ensure_ascii=False)
if a.sheet and strips:
    cw, ch = 300, 440; s = (ch - 40) / H
    img = Image.new('RGB', (cw * a.frames, ch * len(strips)), 'white'); d = ImageDraw.Draw(img)
    for r, (kind, frames, info, ground, k) in enumerate(strips):
        gy = r * ch + ch - 14; d.line([0, gy, img.width, gy], fill=(200, 200, 200), width=1)
        for n, (fr, i) in enumerate(zip(frames, info)):
            crop = Image.fromarray(fr[i['top']:i['bot'], i['left']:i['right']])
            crop = crop.resize((max(1, int(crop.width * k * s)), max(1, int(crop.height * k * s))), Image.LANCZOS)
            x = n * cw + cw // 2 - int((i['hx'] - i['left']) * k * s); y = gy - int((ground - i['top']) * k * s)
            img.paste(crop, (x, y), crop); d.text((n * cw + 6, r * ch + 4), f'{kind} {n + 1}', fill=(217, 72, 15))
    img.save(a.sheet); print(f'QA sheet -> {a.sheet}')
