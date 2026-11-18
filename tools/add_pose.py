#!/usr/bin/env python3
"""
Add new body poses to an unpacked .char folder: registers the master's head onto each pose image (ECC affine on the
face box) and writes poses/<id>.webp + poses.<id> = {image, head, talkable, match} into char.json.

  python3 tools/add_pose.py <char_folder> --master master.png <id>=<pose.png> [<id>=<pose.png> ...] [--silent-below 0.86]

`head` maps MASTER canvas coordinates to POSE canvas coordinates (a master point p appears at
[a*px + c*py + e, b*px + d*py + f] in the pose). Identity = the head did not move.
`match` = normalised cross-correlation of the master's face box against the pose sampled through that transform.
Needs: pillow, numpy, opencv-python.
"""
import argparse, json, os
import numpy as np
import cv2
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('char'); ap.add_argument('--master', required=True)
ap.add_argument('poses', nargs='+', help='<pose_id>=<image.png>')
ap.add_argument('--silent-below', type=float, default=0.86)
ap.add_argument('--pad', type=int, default=30)
a = ap.parse_args()

cj = os.path.join(a.char, 'char.json')
C = json.load(open(cj)); W, H = C['canvas']
x0, y0, x1, y1 = C['face']['box']
x0, y0 = max(0, int(x0) - a.pad), max(0, int(y0) - a.pad); x1, y1 = min(W, int(x1) + a.pad), min(H, int(y1) + a.pad)


def load(p):
    im = Image.open(p).convert('RGBA')
    if im.size != (W, H): im = im.resize((W, H), Image.LANCZOS)
    return im


def gray(im):
    x = np.asarray(im).astype(np.float32); al = x[..., 3:4] / 255
    return ((x[..., :3] * al + 255 * (1 - al)) @ np.array([0.299, 0.587, 0.114], np.float32) / 255).astype(np.float32)


M = gray(load(a.master))


def ncc(u, v):
    u = u - u.mean(); v = v - v.mean()
    d = np.sqrt((u * u).sum() * (v * v).sum())
    return float((u * v).sum() / d) if d > 0 else 0.0


def register_face(P):
    mask = np.zeros(M.shape, np.uint8); mask[y0:y1, x0:x1] = 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(M, P, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-7), mask, 5)
    except cv2.error as e:
        print('  ECC failed, using identity:', str(e).splitlines()[0])
        warp = np.eye(2, 3, dtype=np.float32)
    return warp


os.makedirs(os.path.join(a.char, 'poses'), exist_ok=True)
for spec in a.poses:
    pid, path = spec.split('=', 1)
    im = load(path); P = gray(im)
    warp = register_face(P)   # template (master) point x  <->  pose point warp@x   (no WARP_INVERSE_MAP convention: input sampled at warp@x)
    # sample the pose at warp @ x for every master pixel x in the face box, compare with the master
    samp = cv2.warpAffine(P, warp, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    match = ncc(M[y0:y1, x0:x1], samp[y0:y1, x0:x1])
    head = [[float(warp[0, 0]), float(warp[0, 1]), float(warp[0, 2])], [float(warp[1, 0]), float(warp[1, 1]), float(warp[1, 2])]]
    fn = f'poses/{pid}.webp'
    im.save(os.path.join(a.char, fn), 'WEBP', quality=88, method=6, exact=True)
    entry = {'image': fn, 'head': [[round(v, 5) for v in r] for r in head], 'talkable': bool(match >= a.silent_below), 'match': round(match, 3)}
    C['poses'][pid] = entry
    print(f'{pid}: match {entry["match"]} talkable {entry["talkable"]} head {entry["head"]}')
json.dump(C, open(cj, 'w'), indent=2)
