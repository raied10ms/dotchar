#!/usr/bin/env python3
"""
Find the mouth and the eyes on a master image and write build.json, with no clicking (used by cli/auto.mjs).

  python3 tools/auto_rig.py <work> --name "Tuhin" [--lips-set female|male]

Reads <work>/master.png, <work>/locate.json (boxes from a vision model: tools/locate.mjs), and if present
<work>/eyes-closed.png (the eye openings are measured from what changed between master and eyes-closed, which is far
more exact than a vision model's guess). Writes <work>/build.json and <work>/locate-check.png (boxes drawn on the face).
"""
import argparse, json, os, glob
import numpy as np
import cv2
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser(); ap.add_argument('work'); ap.add_argument('--name', required=True); ap.add_argument('--lips-set', default='female')
a = ap.parse_args()
W = lambda f: os.path.join(a.work, f)
M = np.asarray(Image.open(W('master.png')).convert('RGBA')).astype(np.float32)
H_, W_ = M.shape[:2]
loc = json.load(open(W('locate.json')))
lips = [float(v) for v in loc['lips']]; eyes = [float(v) for v in loc['eyes']]
_c = (lips[0] + lips[2]) / 2; _w = (lips[2] - lips[0]) * 1.2; lips = [_c - _w / 2, lips[1], _c + _w / 2, lips[3]]   # vision models box the lips ~20% narrow
notes = []; openings = None

# ---- eyes: measure the openings from master vs eyes-closed
if os.path.exists(W('eyes-closed.png')):
    C = np.asarray(Image.open(W('eyes-closed.png')).convert('RGBA').resize((W_, H_))).astype(np.float32)
    diff = np.abs(M[..., :3] - C[..., :3]).mean(-1)
    ew, eh = eyes[2] - eyes[0], eyes[3] - eyes[1]
    x0, y0, x1, y1 = [int(v) for v in (max(0, eyes[0] - 0.3 * ew), max(0, eyes[1] - 0.3 * eh), min(W_, eyes[2] + 0.3 * ew), min(H_, eyes[3] + 0.5 * eh))]
    m = (diff[y0:y1, x0:x1] > 38).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    comps = sorted([s for s in stats[1:] if s[4] > 0.0015 * ew * eh], key=lambda s: -s[4])[:2]   # the two eye openings
    if len(comps) == 2:
        ox0 = x0 + min(c[0] for c in comps); oy0 = y0 + min(c[1] for c in comps)
        ox1 = x0 + max(c[0] + c[2] for c in comps); oy1 = y0 + max(c[1] + c[3] for c in comps)
        ow, oh = ox1 - ox0, max(8, oy1 - oy0)
        eyes = [ox0 - 0.2 * ow, oy0 - 1.5 * oh, ox1 + 0.2 * ow, oy1 + 0.5 * oh]      # + brows above, a little cheek below
        openings = [int(ox0), int(oy0), int(ox1), int(oy1)]
        cx = (ox0 + ox1) / 2
        lw = lips[2] - lips[0]
        if abs((lips[0] + lips[2]) / 2 - cx) < 0.2 * lw:                               # front-facing: mouth centred under the eyes
            lips = [cx - lw / 2, lips[1], cx + lw / 2, lips[3]]
        notes.append('eyes measured from the eyes-closed image')
    else:
        notes.append('eyes: could not measure from eyes-closed (using the vision estimate)')
eyes[3] = min(eyes[3], lips[1] - 0.25 * (lips[3] - lips[1]))                            # never reach the mouth
eyes = [max(0, eyes[0]), max(0, eyes[1]), min(W_, eyes[2]), eyes[3]]
lips = [round(v) for v in lips]; eyes = [round(v) for v in eyes]
lw = lips[2] - lips[0]

build = {'name': a.name, 'lips': a.lips_set, 'master': 'master.png',
         'mouth': {'anchor': [round((lips[0] + lips[2]) / 2), round((lips[1] + lips[3]) / 2)], 'width': round(lw * 0.85), 'lipColour': 'auto'},
         'lipsBox': lips, 'poses': {}}
exprs = {os.path.basename(f)[5:-4]: os.path.basename(f) for f in sorted(glob.glob(W('expr-*.png')))}
if os.path.exists(W('eyes-closed.png')) or exprs:
    build['eyes'] = {'box': eyes, **({'openings': openings} if openings else {}), **({'closed': 'eyes-closed.png'} if os.path.exists(W('eyes-closed.png')) else {}), **exprs}
for f in sorted(glob.glob(W('pose-*.png'))): build['poses'][os.path.basename(f)[5:-4]] = os.path.basename(f)
# walk / run sheets are fitted by tools/cycle_fit.py (same size, one ground line), not by the builder
json.dump(build, open(W('build.json'), 'w'), indent=1)

im = Image.open(W('master.png')).convert('RGBA'); bg = Image.new('RGBA', im.size, 'white'); bg.alpha_composite(im); d = ImageDraw.Draw(bg)
d.rectangle(lips, outline=(217, 72, 15), width=3); d.rectangle(eyes, outline=(24, 100, 171), width=3)
pad = lw * 2.2; cx, cy = (lips[0] + lips[2]) / 2, (eyes[1] + lips[3]) / 2
bg.crop((int(max(0, cx - pad)), int(max(0, cy - pad)), int(min(W_, cx + pad)), int(min(H_, cy + pad)))).convert('RGB').save(W('locate-check.png'))
print(f"lips {lips} · eyes {eyes} · {len(build['poses'])} poses · {len(exprs)} expressions" + ''.join(f' · {n}' for n in notes))
