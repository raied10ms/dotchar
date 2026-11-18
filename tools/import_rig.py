#!/usr/bin/env python3
"""
Convert a legacy rig folder (pack.json + PNGs) into an unpacked .char folder (char.json + WebP), ready for `char pack`.

  python3 tools/import_rig.py <rig_dir> <out_dir> --name Bhasha [--meta meta.json]

Body images (poses, cycles) -> lossy WebP q88 (~7x smaller, invisible at video sizes).
Face layers + mouths -> lossless WebP (they are composited every frame; keep them exact).
Needs: Pillow with WebP (pip install pillow).
"""
import argparse, json, os, sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('rig'); ap.add_argument('out')
ap.add_argument('--name'); ap.add_argument('--id')
ap.add_argument('--meta', help='JSON file merged into char.json "meta"')
ap.add_argument('--quality', type=int, default=88)
a = ap.parse_args()

pack = json.load(open(os.path.join(a.rig, 'pack.json')))
os.makedirs(a.out, exist_ok=True)
DROP = {'stateMask', 'stateB6Rejects', 'stateHoleRejects', 'builtFrom', 'warnings'}
done = {}


def convert(rel):
    if rel in done: return done[rel]
    src = os.path.join(a.rig, rel)
    if not os.path.exists(src): sys.exit(f'missing image {src}')
    dst_rel = os.path.splitext(rel)[0] + '.webp'
    dst = os.path.join(a.out, dst_rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im = Image.open(src).convert('RGBA')
    if rel.startswith(('poses/', 'cycles/')): im.save(dst, 'WEBP', quality=a.quality, method=6, exact=True)
    else: im.save(dst, 'WEBP', lossless=True, method=6, exact=True)
    done[rel] = dst_rel
    return dst_rel


def walk(o):
    if isinstance(o, dict):
        return {k: (convert(v) if k == 'image' and isinstance(v, str) else walk(v)) for k, v in o.items() if k not in DROP}
    if isinstance(o, list): return [walk(v) for v in o]
    return o


body = walk({k: pack[k] for k in ('canvas', 'root', 'height', 'face', 'poses', 'cycles') if k in pack})
meta = json.load(open(a.meta)) if a.meta else {}
char = {
    'format': 'dotchar', 'formatVersion': 1,
    'id': a.id or pack['id'], 'name': a.name or pack.get('name') or pack['id'],
    'version': meta.pop('version', '1.0.0'),
    'meta': {'lips': (pack.get('face') or {}).get('mouthSpec', {}).get('lips'), **meta},
    **body,
}

# thumbnail: head and shoulders from the master pose
m = Image.open(os.path.join(a.rig, pack['poses']['master']['image'])).convert('RGBA')
if pack.get('face', {}).get('box'):
    x0, y0, x1, y1 = pack['face']['box']; s = (x1 - x0) * 0.8; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 + s * 0.25
    m = m.crop((int(cx - s), int(cy - s), int(cx + s), int(cy + s)))
m.thumbnail((256, 256)); m.save(os.path.join(a.out, 'thumb.webp'), 'WEBP', quality=90)
char['thumbnail'] = 'thumb.webp'

json.dump(char, open(os.path.join(a.out, 'char.json'), 'w'), indent=1, ensure_ascii=False)
talk = [k for k, p in char['poses'].items() if p.get('talkable')]
print(f"{char['id']}: {len(done)} images, {len(char['poses'])} poses ({len(talk)} talkable), cycles {list(char.get('cycles', {}))}")
