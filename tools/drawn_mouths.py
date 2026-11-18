#!/usr/bin/env python3
"""
Drawn mouths: per-character mouth shapes painted in the character's own style (for painterly / realistic / bearded
faces, where the shared flat cartoon mouths look pasted on). Each viseme is an AI edit of the master's head crop;
only a feathered patch around the mouth is kept, registered to the master, so the rest of the face never changes.

  1. python3 tools/drawn_mouths.py prep  <work> --master master.png --lips x0,y0,x1,y1
        -> <work>/crop.png (head crop, 1024 px) + crop.json
  2. node tools/gen-mouths.mjs <work>                      (8 image calls: viseme-A.png ... viseme-H.png)
  3. python3 tools/drawn_mouths.py apply <work> <char_folder> [--sheet qa.png]
        -> <char_folder>/mouths/neutral/<V>.webp + char.json updated (cover / overMouth removed, mouthStyle "drawn")
  4. node tools/judge.mjs --guide <work>/crop.png --render qa.png      (GPT vision judge; fix what it flags)
     npm run char -- pack <char_folder> -o characters/<id>.char

--lips = box of the drawn lips on the master (canvas px). Needs: pillow, numpy, opencv-python.
"""
import argparse, json, os, sys, glob
import numpy as np
import cv2
from PIL import Image

V = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
OUT = 1024


def rgba(p, size=None):
    im = Image.open(p).convert('RGBA')
    if size and im.size != size: im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def gray(a):  # on white, 0..1
    al = a[..., 3:4] / 255
    rgb = a[..., :3] * al + 255 * (1 - al)
    return (rgb @ np.array([0.299, 0.587, 0.114], np.float32) / 255).astype(np.float32)


def ellipse(shape, c, rx, ry):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return (((xx - c[0]) / rx) ** 2 + ((yy - c[1]) / ry) ** 2) <= 1


def prep(a):
    os.makedirs(a.work, exist_ok=True)
    x0, y0, x1, y1 = map(int, a.lips.split(','))
    w = x1 - x0
    M = Image.open(a.master).convert('RGBA')
    S = int(round(a.span * w))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bx, by = int(round(cx - S / 2)), int(round(cy - S * 0.56))  # mouth a little below centre: eyes/nose above anchor the edit
    bx, by = max(0, min(M.width - S, bx)), max(0, min(M.height - S, by))
    M.crop((bx, by, bx + S, by + S)).resize((OUT, OUT), Image.LANCZOS).save(os.path.join(a.work, 'crop.png'))
    json.dump({'box': [bx, by, S], 'lips': [x0, y0, x1, y1], 'scale': OUT / S, 'master': os.path.abspath(a.master)},
              open(os.path.join(a.work, 'crop.json'), 'w'), indent=1)
    print(f'crop {S}px at {bx},{by} -> {a.work}/crop.png (x{OUT / S:.2f}). Next: node tools/gen-mouths.mjs {a.work}')


def register(ref, img, free):
    """affine that maps img onto ref using everything EXCEPT the mouth zone (free)"""
    g0, g1 = gray(ref), gray(img)
    mask = ((~free) & (ref[..., 3] > 128)).astype(np.uint8) * 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        cc, warp = cv2.findTransformECC(g0, g1, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), mask, 5)
    except cv2.error:
        cc = 0.0
    out = cv2.warpAffine(img, warp, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return out, float(cc), warp


def apply(a):
    cj = json.load(open(os.path.join(a.work, 'crop.json')))
    bx, by, S = cj['box']; k = cj['scale']
    x0, y0, x1, y1 = cj['lips']; w = (x1 - x0) * k
    ref = rgba(os.path.join(a.work, 'crop.png'))
    c = (((x0 + x1) / 2 - bx) * k, ((y0 + y1) / 2 - by) * k + a.drop * w)
    rx, ry = a.rx * w, a.ry * w
    zone = ellipse(ref.shape, c, rx, ry)
    free = ellipse(ref.shape, c, rx * 1.12, ry * 1.12)                       # ignored by registration
    ring = ellipse(ref.shape, c, rx * 1.2, ry * 1.2) & ~ellipse(ref.shape, c, rx * 1.02, ry * 1.02) & (ref[..., 3] > 200)
    alpha = cv2.GaussianBlur(zone.astype(np.float32), (0, 0), a.feather * w)
    alpha = np.clip((alpha - 0.08) / 0.84, 0, 1) * (ref[..., 3] / 255)
    ys, xs = np.nonzero(alpha > 0.004)
    px0, py0, px1, py1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    char_path = os.path.join(a.char, 'char.json')
    C = json.load(open(char_path)); F = C['face']
    for old in glob.glob(os.path.join(a.char, 'mouths', '*', '*')): os.remove(old)
    os.makedirs(os.path.join(a.char, 'mouths', 'neutral'), exist_ok=True)
    mouths, tiles, report = {}, {}, {}
    for v in V:
        src = os.path.join(a.work, f'viseme-{v}.png')
        if v == 'X' and not os.path.exists(src): img, cc, drift = ref.copy(), 1.0, 0.0   # rest = the approved master mouth
        elif not os.path.exists(src): sys.exit(f'missing {src}: run node tools/gen-mouths.mjs {a.work}')
        else:
            img, cc, _ = register(ref, rgba(src, (OUT, OUT)), free)
            # tone match on the ring just outside the patch, then report what difference is left there
            d = (ref[..., :3][ring] - img[..., :3][ring]).mean(0)
            img[..., :3] = np.clip(img[..., :3] + d, 0, 255)
            drift = float(np.abs(ref[..., :3][ring] - img[..., :3][ring]).mean())
        tile = img[py0:py1, px0:px1].copy(); tile[..., 3] = alpha[py0:py1, px0:px1] * 255
        fn = f'mouths/neutral/{v}.webp'
        Image.fromarray(tile.astype(np.uint8)).save(os.path.join(a.char, fn), 'WEBP', quality=93, method=6, exact=True)
        mouths[v] = {'image': fn, 'at': [round(bx + px0 / k, 2), round(by + py0 / k, 2)], 'size': [round((px1 - px0) / k, 2), round((py1 - py0) / k, 2)]}
        tiles[v] = img; report[v] = (cc, drift)
        print(f'  {v}: registration {cc:.3f}, edge difference {drift:.1f}/255' + ('  <-- check this one for a seam or a shifted jaw (> 18)' if drift > 18 else ''))
    F['mouths'] = {'neutral': mouths}
    F['expressions'] = {e: {**x, 'mouths': 'neutral'} for e, x in (F.get('expressions') or {}).items()}
    for kdel, fdel in (('cover', None), ('overMouth', None)):
        t = F.pop(kdel, None)
        if t and os.path.exists(os.path.join(a.char, t['image'])): os.remove(os.path.join(a.char, t['image']))
    F['mouthStyle'] = 'drawn'; F['mouthStretch'] = False
    F['mouthSpec'] = {'lips': 'drawn', 'restWidthPx': round((x1 - x0), 1), 'patch': [round(2 * rx / k), round(2 * ry / k)]}
    F.pop('facialHair', None)
    json.dump(C, open(char_path, 'w'), indent=1, ensure_ascii=False)
    if a.sheet:  # master + 9 visemes composited exactly as the player will (patch over master)
        cell = 400; sheet = Image.new('RGB', (cell * 5, cell * 2), 'white')
        def comp(img):
            o = ref.copy(); al = alpha[..., None]
            o[..., :3] = img[..., :3] * al + ref[..., :3] * (1 - al)
            bg = Image.new('RGBA', (OUT, OUT), 'white'); bg.alpha_composite(Image.fromarray(o.astype(np.uint8)))
            m = int(OUT * 0.14); return bg.crop((m, int(OUT * 0.2), OUT - m, int(OUT * 0.2) + OUT - 2 * m)).resize((cell, cell), Image.LANCZOS).convert('RGB')
        from PIL import ImageDraw
        cells = [('MASTER', ref)] + [(v, tiles[v]) for v in V]
        for i, (lab, img) in enumerate(cells):
            im = comp(img); ImageDraw.Draw(im).text((8, 6), lab, fill=(217, 72, 15))
            sheet.paste(im, ((i % 5) * cell, (i // 5) * cell))
        sheet.save(a.sheet); print(f'QA sheet -> {a.sheet}')
    print(f"{C['id']}: drawn mouths applied ({len(V)} shapes, patch {round(2 * rx / k)}x{round(2 * ry / k)} px). Next: judge the sheet, then npm run char -- pack")


ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
p = sub.add_parser('prep'); p.add_argument('work'); p.add_argument('--master', required=True); p.add_argument('--lips', required=True)
p.add_argument('--span', type=float, default=3.6, help='crop side in lip widths')
q = sub.add_parser('apply'); q.add_argument('work'); q.add_argument('char'); q.add_argument('--sheet')
q.add_argument('--rx', type=float, default=0.82, help='patch half-width in lip widths'); q.add_argument('--ry', type=float, default=0.66)
q.add_argument('--drop', type=float, default=0.14, help='patch centre below the lip centre, in lip widths (room for the jaw)')
q.add_argument('--feather', type=float, default=0.07)
a = ap.parse_args()
prep(a) if a.cmd == 'prep' else apply(a)
