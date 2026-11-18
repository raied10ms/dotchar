/**
 * Character builder: images in -> .char out, entirely in the browser.
 * The same method as the production rigs (see SPEC.md / skill): body images + a separate face layer stack
 *   cover (hides the drawn mouth) -> eye tile (expression / blink) -> shared library mouth (9 visemes x 7 moods),
 * drawn through each pose's head affine (master -> pose) so one face rig talks on every pose.
 */
import { writeZip } from '../runtime/zip.js';
import { Puppet } from '../runtime/puppet.js';

export const EXPRS = ['happy', 'sad', 'surprised', 'angry', 'worried', 'excited'];
export const VISEMES = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MOUTH_SETS = ['neutral', ...EXPRS];

// ---------------------------------------------------------------- canvas helpers
export const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
export async function fileToCanvas(file, fitTo) {
  const bmp = await createImageBitmap(file);
  if (!fitTo || (bmp.width === fitTo[0] && bmp.height === fitTo[1])) { const c = canvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); c.resized = false; return c; }
  // different size: fit into the master canvas, bottom-centred (same framing rule as the generator)
  const c = canvas(fitTo[0], fitTo[1]), k = Math.min(fitTo[0] / bmp.width, fitTo[1] / bmp.height);
  c.getContext('2d').drawImage(bmp, (fitTo[0] - bmp.width * k) / 2, fitTo[1] - bmp.height * k, bmp.width * k, bmp.height * k);
  c.resized = true;
  return c;
}
export const urlToImage = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => err(new Error('missing ' + src)); i.src = src; });
const px = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

export function alphaBBox(c) {
  const { data, width: w, height: h } = px(c);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, transparent = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = data[(y * w + x) * 4 + 3];
    if (a < 250) transparent++;
    if (a > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { box: x1 < 0 ? [0, 0, w, h] : [x0, y0, x1 + 1, y1 + 1], hasAlpha: transparent > w * h * 0.05 };
}

// ---------------------------------------------------------------- colour (sRGB <-> CIE Lab, D65)
const lin = (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const gam = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
export function toLab(r, g, b) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function toRgb(L, a, b) {
  const fy = (L + 16) / 116, X = 0.95047 * fi(fy + a / 500), Y = fi(fy), Z = 1.08883 * fi(fy - b / 200);
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [R, G, B].map((u) => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, u)) * 255))));
}
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const median = (arr) => { const s = [...arr].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const medianLab = (labs) => [0, 1, 2].map((k) => median(labs.map((l) => l[k])));
const chroma = (l) => Math.hypot(l[1], l[2]);

/** lip colour of the drawn mouth on the master (median of coloured pixels around the anchor), or null */
export function sampleLipColour(master, [ax, ay], w) {
  const x0 = Math.max(0, Math.round(ax - w / 2)), y0 = Math.max(0, Math.round(ay - w * 0.2)), ww = Math.round(w), hh = Math.round(w * 0.4);
  const d = master.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, ww, hh).data;
  const labs = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const l = toLab(d[i], d[i + 1], d[i + 2]);
    if (chroma(l) > 18 && l[0] > 27 && l[0] < 88) labs.push(l);
  }
  if (labs.length < 20) return null;
  const red = labs.sort((p, q) => q[1] - p[1]).slice(0, Math.max(20, Math.floor(labs.length / 4))); // lips = the reddest quarter (skin is warm too)
  return rgbToHex(toRgb(...medianLab(red)));
}

// ---------------------------------------------------------------- mouths: shared library -> this face
/** lib = { json: mouthlib.json, images: { 'female/happy/X.png': Image } } */
const mouthCache = new Map();
export function buildMouths(lib, opts) {
  const key = JSON.stringify(opts);
  if (!mouthCache.has(key)) { if (mouthCache.size > 8) mouthCache.clear(); mouthCache.set(key, buildMouthsNow(lib, opts)); }
  return mouthCache.get(key);
}
function buildMouthsNow(lib, { lips = 'female', anchor, width, lipColour }) {
  const L = lib.json[lips], [restW, restH] = L._rest;
  const s = width / restW;
  // source lip colour = median coloured pixel of the neutral rest mouth; target = character's lips (+ a touch redder for female)
  const srcLab = (() => { const c = imgCanvas(lib.images[L.neutral.X.image]), d = px(c).data, labs = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { const l = toLab(d[i], d[i + 1], d[i + 2]); if (chroma(l) > 18) labs.push(l); }
    return medianLab(labs); })();
  let dst = lipColour ? toLab(...hexToRgb(lipColour)) : null;
  if (dst && lips === 'female') dst = [dst[0] - 3, dst[1] + 12, dst[2] - 3];
  const out = {}, images = {};
  for (const e of MOUTH_SETS) {
    out[e] = {};
    for (const v of VISEMES) {
      const meta = L[e][v], im = lib.images[meta.image];
      const w = Math.max(1, Math.round(im.width * s)), h = Math.max(1, Math.round(im.height * s));
      const c = canvas(w, h), ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(dst ? recolour(imgCanvas(im), srcLab, dst) : im, 0, 0, w, h);
      const at = [Math.round(anchor[0] - w / 2), Math.round(anchor[1] - (restH * s) / 2 - 0.18 * (h - restH * s))]; // upper lip fixed, jaw drops
      const p = `mouths/${e}/${v}.png`;
      images[p] = c; out[e][v] = { image: p, at, size: [w, h] };
    }
  }
  return { mouths: out, images, spec: { lips, scale: +s.toFixed(4), restWidthPx: +(restW * s).toFixed(1) } };
}
const imgCanvas = (im) => { const c = canvas(im.width, im.height); c.getContext('2d').drawImage(im, 0, 0); return c; };
function recolour(c, src, dst) {
  const id = px(c), d = id.data;
  const sh = [0.6 * (dst[0] - src[0]), dst[1] - src[1], dst[2] - src[2]];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const l = toLab(d[i], d[i + 1], d[i + 2]);
    if (chroma(l) <= 14 || l[0] <= 23.5) continue; // teeth, outline, mouth cavity untouched
    const [r, g, b] = toRgb(l[0] + sh[0], l[1] + sh[1], l[2] + sh[2]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

// ---------------------------------------------------------------- cover: hides the mouth drawn on the body images
/**
 * from = mouthless master (best: an AI edit of the master with the lips painted over) or the master itself, in which
 * case each column of the cover is blended from the skin just above to the skin just below the mouth.
 */
export function makeCover(from, isMouthless, [ax, ay], mw, kx = 1.35, ky = 0.55) {
  const w = Math.round(mw * kx), h = Math.round(mw * ky), x0 = Math.round(ax - w / 2), y0 = Math.round(ay - h / 2);
  const c = canvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  if (isMouthless) ctx.drawImage(from, x0, y0, w, h, 0, 0, w, h);
  else {
    const src = from.getContext('2d', { willReadFrequently: true });
    const top = src.getImageData(x0, Math.max(0, y0 - 4), w, 3).data, bot = src.getImageData(x0, y0 + h + 1, w, 3).data;
    const id = ctx.createImageData(w, h), d = id.data;
    const avg = (arr, x, k) => (arr[x * 4 + k] + arr[(w + x) * 4 + k] + arr[(2 * w + x) * 4 + k]) / 3;
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const t = y / (h - 1), i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = avg(top, x, k) * (1 - t) + avg(bot, x, k) * t;
      d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    ctx.filter = 'blur(1.5px)'; ctx.drawImage(c, 0, 0); ctx.filter = 'none';
  }
  // feathered ellipse
  const m = canvas(w, h), mc = m.getContext('2d');
  mc.filter = `blur(${Math.max(1, h * 0.1)}px)`; mc.fillStyle = '#000';
  mc.beginPath(); mc.ellipse(w / 2, h / 2, w * 0.42, h * 0.38, 0, 0, Math.PI * 2); mc.fill();
  ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(m, 0, 0); ctx.globalCompositeOperation = 'source-over';
  return { canvas: c, at: [x0, y0] };
}

/**
 * Moustache / beard: the cover becomes a lips-only ellipse that keeps facial hair above and below the lips, and the
 * moustache is cut from the master into an `overMouth` layer drawn after the mouth (the mouth opens behind it).
 * Same method as tools/facial_hair.py. lips = drawn lip box on the master.
 */
export function facialHair(master, mouthless, [x0, y0, x1, y1], { gap = 14, pad = 0.06 } = {}) {
  const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const R = [Math.max(0, Math.floor(x0 - 0.45 * w)), Math.max(0, Math.floor(y0 - 0.65 * w)), Math.min(master.width, Math.ceil(x1 + 0.45 * w)), Math.min(master.height, Math.ceil(y1 + 0.35 * w))];
  const RW = R[2] - R[0], RH = R[3] - R[1];
  const M = master.getContext('2d', { willReadFrequently: true }).getImageData(R[0], R[1], RW, RH).data;
  const L = new Float32Array(RW * RH), C = new Float32Array(RW * RH);
  for (let i = 0; i < L.length; i++) { const l = toLab(M[i * 4], M[i * 4 + 1], M[i * 4 + 2]); L[i] = l[0]; C[i] = chroma(l); }
  // skin reference: the more saturated 40% of pixels in a band above the lips
  const ref = [];
  for (let y = Math.max(R[1], Math.round(y0 - 0.6 * w)); y < y0; y++) for (let x = Math.round(x0 - 0.3 * w); x < x1 + 0.3 * w; x++) {
    const i = (y - R[1]) * RW + (x - R[0]); if (i >= 0 && i < L.length && M[i * 4 + 3] > 200) ref.push(i);
  }
  const cs = ref.map((i) => C[i]).sort((p, q) => p - q), cut = cs[Math.floor(cs.length * 0.6)] ?? 0;
  const sk = ref.filter((i) => C[i] > cut), skinL = median(sk.map((i) => L[i])), skinC = median(sk.map((i) => C[i]));
  const cl = (v) => Math.max(0, Math.min(1, v));
  const hair = (i) => Math.max(cl((skinL - gap - L[i]) / 12), cl((skinL - 6 - L[i]) / 14) * cl((skinC * 0.75 - C[i]) / 10));
  // cover: lips ellipse from the mouthless image (or skin blend), minus facial hair just outside the lips
  const rx = w / 2 + pad * w, ry = h / 2 + pad * w * 0.8;
  const cx0 = Math.floor(cx - rx - 6), cy0 = Math.floor(cy - ry - 6), cw = Math.ceil(2 * rx + 13), ch = Math.ceil(2 * ry + 13);
  const cov = canvas(cw, ch), cc = cov.getContext('2d', { willReadFrequently: true });
  if (mouthless) cc.drawImage(mouthless, cx0, cy0, cw, ch, 0, 0, cw, ch);
  else { const b = makeCover(master, false, [cx, cy], w, (2 * rx + 13) / w, (2 * ry + 13) / w); cc.drawImage(b.canvas, b.at[0] - cx0, b.at[1] - cy0); }
  const cd = cc.getImageData(0, 0, cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const gx = cx0 + x, gy = cy0 + y, e = ((gx - cx) / rx) ** 2 + ((gy - cy) / ry) ** 2;
    const inEll = cl((1.08 - e) / 0.16); // soft edge
    const i = (gy - R[1]) * RW + (gx - R[0]);
    const keep = (gy < y0 - 2 || gy > y1 + 2) && i >= 0 && i < L.length ? hair(i) : 0;
    cd.data[(y * cw + x) * 4 + 3] = 255 * inEll * (1 - keep);
  }
  cc.putImageData(cd, 0, 0);
  // overMouth: moustache band above the upper lip + hanging corners
  const over = canvas(RW, RH), oc = over.getContext('2d'), od = oc.createImageData(RW, RH);
  let n = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const gx = R[0] + x, gy = R[1] + y, i = y * RW + x;
    const inX = gx >= x0 - 0.35 * w && gx <= x1 + 0.35 * w;
    const band = inX && gy >= y0 - 0.32 * w && gy <= y0 + 0.2 * h;
    const corner = inX && (gx < x0 + 0.12 * w || gx > x1 - 0.12 * w) && gy > y0 && gy <= y1;
    if (!band && !corner) continue;
    const a = hair(i) * (M[i * 4 + 3] / 255);
    if (a > 0.02) n++;
    od.data.set([M[i * 4], M[i * 4 + 1], M[i * 4 + 2], 255 * a], i * 4);
  }
  oc.putImageData(od, 0, 0);
  return { cover: { canvas: cov, at: [cx0, cy0] }, over: n > 20 ? { canvas: over, at: [R[0], R[1]] } : null, skinL };
}

/** eye tile: crop of an (expression / closed-eyes) image inside the eye box, edges feathered so it blends */
export function cropTile(img, [x0, y0, x1, y1], feather = 6) {
  const w = Math.round(x1 - x0), h = Math.round(y1 - y0), c = canvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(img, Math.round(x0), Math.round(y0), w, h, 0, 0, w, h);
  const m = canvas(w, h), mc = m.getContext('2d');
  mc.filter = `blur(${feather / 2}px)`; mc.fillStyle = '#000'; mc.fillRect(feather, feather, w - feather * 2, h - feather * 2);
  ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(m, 0, 0);
  return { canvas: c, at: [Math.round(x0), Math.round(y0)] };
}

// ---------------------------------------------------------------- head registration (master -> pose)
const grayOnWhite = (c, k) => { // downsample by k, composite on white, luminance 0..1
  const w = Math.floor(c.width / k), h = Math.floor(c.height / k), s = canvas(w, h), sc = s.getContext('2d', { willReadFrequently: true });
  sc.fillStyle = '#fff'; sc.fillRect(0, 0, w, h); sc.drawImage(c, 0, 0, w, h);
  const d = sc.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  return { g, w, h };
};
function ncc(M, P, box, s, dx, dy) { // master box pixels vs pose sampled at s*(p - c) + c + d
  const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let n = 0, sm = 0, sp = 0, smm = 0, spp = 0, smp = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const px_ = Math.round(s * (x - cx) + cx + dx), py = Math.round(s * (y - cy) + cy + dy);
    if (px_ < 0 || py < 0 || px_ >= P.w || py >= P.h) continue;
    const a = M.g[y * M.w + x], b = P.g[py * P.w + px_];
    n++; sm += a; sp += b; smm += a * a; spp += b * b; smp += a * b;
  }
  if (n < 50) return -1;
  const cov = smp - (sm * sp) / n, va = smm - (sm * sm) / n, vb = spp - (sp * sp) / n;
  return cov / Math.sqrt(va * vb + 1e-9);
}
/** returns { head: [[a,c,e],[b,d,f]], match } — uniform scale + translation about the head box centre */
export function alignHead(master, pose, headBox) {
  const k = 4, M = grayOnWhite(master, k), P = grayOnWhite(pose, k);
  const b4 = headBox.map((v) => Math.round(v / k));
  let best = { score: -2, s: 1, dx: 0, dy: 0 };
  for (let s = 0.9; s <= 1.101; s += 0.02) for (let dy = -24; dy <= 24; dy++) for (let dx = -24; dx <= 24; dx++) {
    const sc = ncc(M, P, b4, s, dx, dy); if (sc > best.score) best = { score: sc, s, dx, dy };
  }
  const M1 = grayOnWhite(master, 1), P1 = grayOnWhite(pose, 1);
  const b1 = headBox.map(Math.round);
  // full-res refinement (sparse: every 2nd pixel via a shrunken box is plenty)
  let ref = { score: -2, s: best.s, dx: best.dx * k, dy: best.dy * k };
  for (let s = best.s - 0.02; s <= best.s + 0.0201; s += 0.005) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
    const sc = ncc(M1, P1, b1, s, best.dx * k + dx, best.dy * k + dy); if (sc > ref.score) ref = { score: sc, s, dx: best.dx * k + dx, dy: best.dy * k + dy };
  }
  return { ...headAffine(headBox, ref.s, ref.dx, ref.dy), s: ref.s, dx: ref.dx, dy: ref.dy };
}
export function headAffine(box, s, dx, dy) {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return { head: [[s, 0, cx - s * cx + dx], [0, s, cy - s * cy + dy]] };
}
export const matchScore = (master, pose, box, s, dx, dy) => ncc(grayOnWhite(master, 1), grayOnWhite(pose, 1), box.map(Math.round), s, dx, dy);

// ---------------------------------------------------------------- cycles: frames placed feet-on-root, same body height
export function placeCycleFrame(frame, root, height) {
  const { box } = alphaBBox(frame);
  const tw = box[2] - box[0], th = box[3] - box[1];
  const trimmed = canvas(tw, th); trimmed.getContext('2d').drawImage(frame, box[0], box[1], tw, th, 0, 0, tw, th);
  const k = height / th, w = tw * k, h = th * k;
  return { canvas: trimmed, at: [+(root[0] - w / 2).toFixed(1), +(root[1] - h).toFixed(1)], size: [Math.round(w), Math.round(h)] };
}

/** one generated sheet (frames side by side) -> n frame canvases, cut at the emptiest column near each boundary */
export function splitSheet(sheet, n = 4) {
  const { data, width: w, height: hgt } = px(sheet);
  const dens = new Float32Array(w);
  for (let x = 0; x < w; x++) for (let y = 0; y < hgt; y++) if (data[(y * w + x) * 4 + 3] > 40) dens[x]++;
  let c0 = 0, c1 = w; while (c0 < w && !dens[c0]) c0++; while (c1 > c0 && !dens[c1 - 1]) c1--;
  const span = (c1 - c0) / n, cuts = [c0];
  for (let k = 1; k < n; k++) {
    const e = Math.round(c0 + k * span), r = Math.round(0.15 * span);
    let best = e; for (let x = e - r; x <= e + r; x++) if (dens[x] < dens[best]) best = x;
    cuts.push(best);
  }
  cuts.push(c1);
  return cuts.slice(0, -1).map((x0, i) => { const fw = cuts[i + 1] - x0, c = canvas(fw, hgt); c.getContext('2d').drawImage(sheet, x0, 0, fw, hgt, 0, 0, fw, hgt); return c; });
}

// ---------------------------------------------------------------- assemble + export
/**
 * st = { id, name, lips, description, license, master, mouthless, anchor, mouthW, lipColour, coverKx, coverKy, eyeBox,
 *        closed, expr: {happy: canvas}, poses: [{id, canvas, talkable, s, dx, dy, match}], cycles: {walk: [canvas]} , lib }
 * -> { pack, images } (images: path -> canvas; pack is a valid char.json)
 */
export function assemble(st) {
  const M = st.master, images = {};
  const { box } = alphaBBox(M);
  const root = [Math.round((box[0] + box[2]) / 2), box[3]], height = box[3] - box[1];
  const pack = { format: 'dotchar', formatVersion: 1, id: st.id, name: st.name, version: st.version || '1.0.0',
    meta: { lips: st.lips, description: st.description || '', tags: st.tags || [], voice: st.voice || null, license: st.license || '', createdWith: 'dotchar studio' },
    canvas: [M.width, M.height], root, height, poses: {}, cycles: {} };
  images['poses/master.webp'] = M;
  pack.poses.master = { image: 'poses/master.webp', head: [[1, 0, 0], [0, 1, 0]], talkable: !!st.anchor, match: 1 };
  if (st.anchor) {
    const hb = headBox(st);
    const mo = buildMouths(st.lib, { lips: st.lips, anchor: st.anchor, width: st.mouthW, lipColour: st.lipColour });
    Object.assign(images, mo.images);
    let cover, over = null;
    if (st.facialHair) { // beard / moustache: lips-only cover + moustache drawn over the mouth
      const [ax, ay] = st.anchor, lw = st.lipsWidth || st.mouthW / 0.85;
      const fh = facialHair(M, st.mouthless, [ax - lw / 2, ay - 0.13 * lw, ax + lw / 2, ay + 0.13 * lw]);
      cover = fh.cover; over = fh.over;
    } else cover = makeCover(st.mouthless || M, !!st.mouthless, st.anchor, st.mouthW, st.coverKx, st.coverKy);
    images['face/cover.png'] = cover.canvas;
    if (over) images['face/over-mouth.png'] = over.canvas;
    const F = pack.face = { mouthAnchor: st.anchor, box: hb.map(Math.round), cover: { image: 'face/cover.png', at: cover.at }, mouths: mo.mouths,
      ...(over ? { overMouth: { image: 'face/over-mouth.png', at: over.at } } : {}),
      mouthSpec: { ...mo.spec, faceWidthPx: null }, expressions: Object.fromEntries(EXPRS.map((e) => [e, { mouths: e }])) };
    const eyeImgs = Object.entries(st.expr || {}).filter(([, c]) => c);
    if (st.eyeBox && (st.closed || eyeImgs.length)) {
      const tile = (name, img) => { const t = cropTile(img, st.eyeBox); images[`face/states/${name}.png`] = t.canvas; return { image: `face/states/${name}.png`, at: t.at }; };
      F.states = { neutral: { camera: tile('neutral-camera', M) } };
      if (st.closed) F.states.neutral.closed = tile('neutral-closed', st.closed);
      for (const [e, img] of eyeImgs) F.states[e] = { camera: tile(`${e}-camera`, img), ...(st.closed ? { closed: F.states.neutral.closed } : {}) };
    }
  }
  for (const p of st.poses || []) {
    if (!p.id || p.id === 'master') continue;
    const path = `poses/${p.id}.webp`; images[path] = p.canvas;
    const entry = { image: path, talkable: !!(p.talkable && st.anchor) };
    if (entry.talkable) { entry.head = headAffine(headBox(st), p.s ?? 1, p.dx ?? 0, p.dy ?? 0).head; entry.match = p.match != null ? +p.match.toFixed(3) : null; }
    pack.poses[p.id] = entry;
  }
  for (const [cid, frames] of Object.entries(st.cycles || {})) {
    if (!frames?.length) continue;
    pack.cycles[cid] = { facing: 'R', frames: frames.map((fr, i) => { const pl = placeCycleFrame(fr, root, height); const path = `cycles/${cid}/${i}.webp`; images[path] = pl.canvas; return { image: path, at: pl.at, size: pl.size }; }) };
  }
  const hb = st.anchor ? headBox(st) : [box[0], box[1], box[2], box[1] + (box[2] - box[0])];
  const s = Math.max(hb[2] - hb[0], hb[3] - hb[1]), th = canvas(256, 256);
  th.getContext('2d').drawImage(M, (hb[0] + hb[2]) / 2 - s * 0.6, (hb[1] + hb[3]) / 2 - s * 0.5, s * 1.2, s * 1.2, 0, 0, 256, 256);
  images['thumb.webp'] = th; pack.thumbnail = 'thumb.webp';
  return { pack, images };
}

/** head box: the face region used for registration, framing and thumbnails */
export function headBox(st) {
  const [ax, ay] = st.anchor, w = st.mouthW, M = st.master;
  let b = [ax - 1.7 * w, ay - 2.6 * w, ax + 1.7 * w, ay + 0.9 * w];
  if (st.eyeBox) { const e = st.eyeBox, eh = e[3] - e[1]; b = [Math.min(b[0], e[0] - 0.3 * w), Math.min(e[1] - eh, b[1]), Math.max(b[2], e[2] + 0.3 * w), ay + 0.9 * w]; }
  return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(M.width, b[2]), Math.min(M.height, b[3])];
}

export const puppetFrom = ({ pack, images }) => new Puppet(pack, images);

export async function exportChar({ pack, images }) {
  const blob = (c, type, q) => new Promise((ok) => c.toBlob(ok, type, q));
  const files = [{ name: 'char.json', data: JSON.stringify(pack, null, 1) }];
  for (const [p, c] of Object.entries(images)) {
    const b = p.endsWith('.png') ? await blob(c, 'image/png') : await blob(c, 'image/webp', 0.9);
    files.push({ name: p, data: new Uint8Array(await b.arrayBuffer()) });
  }
  return new Blob([writeZip(files)], { type: 'application/zip' });
}
