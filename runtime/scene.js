/**
 * Scene = cast + props + voice lines + one flat timeline. Episodes are DATA (writers author JSON, not code).
 *   { size:[w,h], fps, background, cast:{name:{char (.char file or char.json folder),x,y,height|scale,face}}, lines:{id:{audio,track}},
 *     timeline:[{at|on+offset, who, pose|point|expression|say|walk|run|face}, {at, camera:{...}}, {at, background:'#hex'}, {at, fade:{to,dur}}],
 *     music:{audio, at?}  (mixed once; lines may omit `audio` to just mouth), floor:{y, color}, gaze:false }
 * A `say` without `at` is placed right after the previous say ends (+gap): dialogue packs itself.
 */
import { loadChar } from './char.js';
import { Actor } from './actor.js';

export async function loadScene(src, baseHref = location.href) {
  let S, base = baseHref;
  if (typeof src === 'string') { base = new URL(src, baseHref).href; S = await (await fetch(base)).json(); } else S = structuredClone(src);
  const abs = (p) => new URL(p, base).href;
  const img = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
  const tracks = {}, audio = {};
  await Promise.all(Object.entries(S.lines || {}).map(async ([id, l]) => {
    tracks[id] = await (await fetch(abs(l.track))).json();
    if (l.audio) audio[id] = abs(l.audio);   // a line with a track but no audio only moves mouths (the sound comes from `music` or another line)
  }));
  const fxImages = {};
  await Promise.all(Object.entries(S.images || {}).map(async ([id, p]) => (fxImages[id] = await img(abs(p)))));
  // background cues { at, background: '#hex' | 'bg/name.png' }: images preloaded once (a missing file just falls back to the previous colour)
  const bgImages = {};
  await Promise.all((S.timeline || []).filter((a) => a.background && !a.background.startsWith('#')).map(async (a) => {
    if (!(a.background in bgImages)) bgImages[a.background] = await img(abs(a.background)).catch(() => null);
  }));
  const props = {};
  await Promise.all(Object.entries(S.props || {}).map(async ([id, p]) => (props[id] = { image: await img(abs(p.image)), handle: p.handle, scale: p.scale ?? 1, rot: p.rot ?? 0 })));
  // auto-place unscheduled says, then resolve actions anchored to a line: { on: 'n2', offset: 0.4 }
  let cursor = S.start ?? 0;
  const sayAt = {};
  const timeline = (S.timeline || []).map((a) => ({ ...a }));
  for (const a of timeline) if (a.say) {
    if (a.at == null) a.at = cursor + (a.gap ?? 0.35);
    sayAt[a.say] = a.at; cursor = a.at + tracks[a.say].duration;
    if (a.look != null && a.dur == null) a.dur = tracks[a.say].duration;  // look on a line lasts for that line
  }
  for (const a of timeline) if (!a.say) {
    if (a.after) a.at = sayAt[a.after] + tracks[a.after].duration + (a.offset ?? 0); // e.g. run off after a line
    else if (a.on) {
      a.at = sayAt[a.on] + (a.offset ?? 0);
      // pose / expression anchored to a line lasts for the line unless told otherwise
      if (a.dur == null && (a.pose || a.expression || a.point != null || a.overlay || a.bubble)) a.dur = sayAt[a.on] + tracks[a.on].duration + (a.tail ?? 0.5) - a.at;
    }
    else if (a.at == null) a.at = 0;
  }
  timeline.sort((p, q) => p.at - q.at);
  const actors = {};
  for (const [name, c] of Object.entries(S.cast)) {
    const puppet = await loadChar(abs(c.char || c.rig));
    // `height` = on-screen body height in px: every character the same size no matter how big their master was drawn
    const scale = c.height ? c.height / puppet.pack.height : c.scale;
    actors[name] = new Actor(name, puppet, { ...c, scale, actions: timeline.filter((a) => a.who === name) });
  }
  // who is talking at t (or talked last): drives the automatic gaze rule
  const saysSorted = timeline.filter((a) => a.say && tracks[a.say]).map((a) => ({ name: a.who, start: a.at, end: a.at + tracks[a.say].duration, camera: a.look === 'camera' })).sort((p, q) => p.start - q.start);
  function speakerAt(t) { let last = null; for (const s_ of saysSorted) { if (s_.start > t) break; last = s_; } return last; }
  const duration = S.duration ?? Math.max(cursor, ...timeline.map((a) => a.at + (a.walk ? 0 : 0))) + 1.5;
  const bg = S.background && !S.background.startsWith('#') ? await img(abs(S.background)) : null;
  const says = timeline.filter((a) => a.say && audio[a.say]).map((a) => ({ at: a.at, src: audio[a.say], id: a.say }));
  if (S.music && S.music.audio) says.unshift({ at: S.music.at ?? 0, src: abs(S.music.audio), id: 'music' });  // music bed: mixed once
  return {
    ...S, duration, actors, tracks, props, says, timeline,
    camera(t) { return cameraAt(timeline, actors, S.size, t); },
    draw(ctx, t, { bones = false, camera = null } = {}) {
      const [w, h] = S.size;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      const cam = camera ? cameraAt([{ at: 0, camera: { cut: true, ...camera } }], actors, S.size, t) : cameraAt(timeline, actors, S.size, t);
      const base = new DOMMatrix().translate(w / 2, h / 2).scale(cam.zoom).translate(-cam.x, -cam.y);
      const _set = ctx.setTransform.bind(ctx);
      ctx.setTransform = (...m) => _set(base.multiply(m.length === 6 ? new DOMMatrix(m) : m[0] ?? new DOMMatrix()));
      try { this._draw(ctx, t, bones); } finally { ctx.setTransform = _set; _set(1, 0, 0, 1, 0, 0); }
      drawScreenFx(ctx, timeline, fxImages, t, S.size);   // captions + flying props: screen space, ignore the camera
      const f = fadeAt(timeline, t);   // { at, fade: { to: '#000', dur } }: whole picture fades to a colour, screen space
      if (f) { ctx.globalAlpha = f.alpha; ctx.fillStyle = f.to; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = 1; }
    },
    _draw(ctx, t, bones) {
      const [w, h] = S.size;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (bg) ctx.drawImage(bg, 0, 0, w, h); else { const b = backgroundAt(S, timeline, t); const im = bgImages[b]; if (im) { const k = Math.max(w / im.width, h / im.height); ctx.drawImage(im, (w - im.width * k) / 2, (h - im.height * k) / 2, im.width * k, im.height * k); } else { ctx.fillStyle = im === null ? '#f4efe6' : b; ctx.fillRect(0, 0, w, h); } }
      if (S.floor && !bgImages[backgroundAt(S, timeline, t)]) { ctx.fillStyle = S.floor.color || 'rgba(0,0,0,0.18)'; ctx.fillRect(0, S.floor.y, w, h - S.floor.y); }
      const c = { tracks, actors, props, speakerAt, gazeOff: S.gaze === false || globalThis.GAZE_OFF === true };
      const list = Object.values(actors).filter((a) => a.visibleAt(t)).map((a) => ({ a, ...a.poseAt(t, c) })).sort((p, q) => p.place.y - q.place.y);
      drawFx(ctx, timeline, actors, fxImages, t, S.size, true); // overlay.under: set dressing drawn behind the cast
      for (const { a, state, place } of list) {
        shadow(ctx, place, a);
        a.puppet.draw(ctx, state, place);
      }
      drawFx(ctx, timeline, actors, fxImages, t, S.size);
    },
  };
}

/** { at, background: '#hex' } cues: the latest one at or before t wins (else the scene background) */
function backgroundAt(S, timeline, t) {
  let c = S.background || '#f4efe6';
  for (const a of timeline) { if (a.at > t) break; if (a.background) c = a.background; }
  return c;
}

/**
 * Screen-space FX (not moved by the camera):
 *   { at, dur, caption: { text, size=52, pos:'top'|'top-left'|'bottom', tilt=deg, color } }  comic caption: white rounded box, 120 ms scale-pop, one at a time
 *   { at, dur, prop: { image, from:[x,y], to:[x,y], arc, spin, w } }               image flies from -> to along an arc (px) spinning `spin` degrees
 */
function drawScreenFx(ctx, timeline, images, t, [W, H]) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const a of timeline) {
    if (!a.prop || t < a.at || t > a.at + (a.dur ?? 1)) continue;
    const p = a.prop, im = images[p.image]; if (!im) continue;
    const k = (t - a.at) / (a.dur ?? 1), w = p.w || 300, h = w * im.height / im.width;
    ctx.save();
    ctx.translate(p.from[0] + (p.to[0] - p.from[0]) * k, p.from[1] + (p.to[1] - p.from[1]) * k - (p.arc || 0) * 4 * k * (1 - k));
    ctx.rotate((p.spin || 0) * k * Math.PI / 180);
    ctx.drawImage(im, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  let cap = null;
  for (const a of timeline) if (a.caption && t >= a.at && t < a.at + (a.dur ?? 1.4)) cap = a;
  if (!cap) return;
  const c = cap.caption, fs = c.size || 52, lt = t - cap.at;
  const pop = Math.min(1, lt / 0.12), sc = 0.5 + 0.5 * pop + 0.12 * Math.sin(Math.PI * pop);   // quick scale-pop with a little overshoot
  ctx.save();
  ctx.font = `900 ${fs}px "Baloo 2", Impact, "Arial Black", "Comic Sans MS", sans-serif`;
  let tw = ctx.measureText(c.text).width, pad = fs * 0.45, bw = tw + pad * 2;
  if (bw > W * 0.94) { fs *= (W * 0.94) / bw; ctx.font = ctx.font.replace(/\d+(\.\d+)?px/, `${fs}px`); tw = ctx.measureText(c.text).width; pad = fs * 0.45; bw = tw + pad * 2; }   // long text shrinks to fit the frame
  const bh = fs * 1.45;
  const cy = c.pos === 'bottom' ? H - bh / 2 - 22 : bh / 2 + 16;
  const cx = c.pos === 'top-left' ? Math.max(W / 6, bw / 2 + 24) : W / 2;   // top-left third: keeps clear of things at top-centre
  ctx.translate(cx, cy); ctx.rotate((c.tilt ?? -2.5) * Math.PI / 180); ctx.scale(sc, sc);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = Math.max(4, fs * 0.09);
  ctx.beginPath(); ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bh * 0.28); ctx.fill(); ctx.stroke();
  ctx.fillStyle = c.color || '#1b1b1b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.text, 0, fs * 0.04);
  ctx.restore();
}

/** { at, fade: { to: 'black', dur } } cues: linear fade of the whole picture to a colour */
function fadeAt(timeline, t) {
  let r = null;
  for (const a of timeline) {
    if (a.at > t) break;
    if (a.fade) r = { to: a.fade.to === 'black' ? '#000' : a.fade.to || '#000', alpha: Math.min(1, (t - a.at) / (a.fade.dur || 1)) };
  }
  return r && r.alpha > 0 ? r : null;
}

/**
 * FX on top of the cast (inside the camera):
 *   { at|on, dur, overlay: { image, who, dx, dy, w, glow } }  image pinned to an actor: dx/dy/w in body heights from
 *                                                               the feet (dy up); pops in, floats, flickers if glow
 *   { at|on, dur, bubble: { text, who, side: 'L'|'R' } }        comic speech bubble beside the head
 *   overlay.still: no pop/float/flicker, hard in/out (or overlay.fade seconds) - for frame-swapped set pieces
 *   overlay.under: drawn after the background, before the cast
 */
function drawFx(ctx, timeline, actors, images, t, [W] = [1920], under = false) {
  for (const a of timeline) {
    const fx = a.overlay || a.bubble;
    if (!fx || t < a.at || t > a.at + (a.dur ?? 2)) continue;
    if (!!(a.overlay && a.overlay.under) !== under) continue;
    const actor = actors[fx.who]; if (!actor) continue;
    const lt = t - a.at, end = a.at + (a.dur ?? 2) - t;
    const still = a.overlay && a.overlay.still, fd = (a.overlay && a.overlay.fade) || 0;
    const pop = still ? (fd ? Math.min(1, lt / fd) : 1) : Math.min(1, lt / 0.22), out = still ? (fd ? Math.min(1, end / fd) : 1) : Math.min(1, end / 0.2);
    const sc = still ? 1 : (0.6 + 0.4 * (1 - (1 - pop) ** 3)) * (0.8 + 0.2 * out);
    const H = actor.puppet.pack.height * actor.scale;
    const { x } = actor.xAt(t);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = pop * out;
    if (a.overlay) {
      const im = images[fx.image]; if (!im) { ctx.restore(); continue; }
      const w = fx.w * H, h = (w * im.height) / im.width;
      const cx = x + fx.dx * H, cy = actor.y - fx.dy * H + (still ? 0 : Math.sin(lt * Math.PI) * 0.012 * H);
      if (fx.glow && !still) { ctx.globalAlpha *= 0.82 + 0.12 * Math.sin(lt * 23) * Math.sin(lt * 7); ctx.shadowColor = 'rgba(80,220,255,0.9)'; ctx.shadowBlur = 28; }
      ctx.translate(cx, cy); ctx.scale(sc, sc);
      ctx.drawImage(im, -w / 2, -h / 2, w, h);
    } else {
      const head = actor.anchor(t, 'head'), side = fx.side === 'L' ? -1 : 1;
      const fs = Math.round(H * 0.06), pad = fs * 0.6;
      ctx.font = `800 ${fs}px "Baloo 2", "Comic Sans MS", "Hiragino Maru Gothic ProN", "Noto Sans Bengali", sans-serif`;
      const tw = ctx.measureText(fx.text).width, bw = tw + pad * 2, bh = fs * 1.6;
      const m = W * 0.03;  // keep the whole bubble on the stage
      const bx = Math.min(W - m - bw, Math.max(m, head[0] + side * (H * 0.12) - (side < 0 ? bw : 0))), by = head[1] - H * 0.22 - bh;
      ctx.translate(bx + bw / 2, by + bh / 2); ctx.scale(sc, sc); ctx.translate(-(bx + bw / 2), -(by + bh / 2));
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2b1d14'; ctx.lineWidth = Math.max(3, fs * 0.09);
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, bh / 2);
      const tx = head[0] + side * H * 0.08;
      ctx.moveTo(bx + bw / 2 - side * bw * 0.25, by + bh - 2); ctx.lineTo(tx, by + bh + fs * 0.9); ctx.lineTo(bx + bw / 2 - side * bw * 0.05, by + bh - 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e4572e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(fx.text, bx + bw / 2, by + bh / 2 + fs * 0.05);
    }
    ctx.restore();
  }
}

function shadow(ctx, place, a) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.ellipse(place.x, place.y + 4, 150 * place.scale * 1.4, 22 * place.scale * 1.4, 0, 0, Math.PI * 2); ctx.fill();
}

/** Camera cues: { at, camera: { zoom=1, center:[x,y] | follow: actor | 'speakers', dur=0.8 } } eased; zoom never < 1. */
function cameraAt(timeline, actors, [w, h], t) {
  let cur = { x: w / 2, y: h / 2, zoom: 1 };
  const target = (c) => {
    const zoom = Math.max(1, c.zoom ?? 1);
    let [x, y] = c.center || [w / 2, h / 2];
    if (c.follow && actors[c.follow]) { const a = actors[c.follow].anchor(t, 'head'); x = a[0]; y = a[1] + (c.headroom ?? 0.18) * h / zoom; }
    // keep the frame inside the stage (no black borders)
    x = Math.min(w - w / 2 / zoom, Math.max(w / 2 / zoom, x)); y = Math.min(h - h / 2 / zoom, Math.max(h / 2 / zoom, y));
    return { x, y, zoom };
  };
  for (const a of timeline) {
    if (!a.camera || a.at > t) continue;
    const to = target(a.camera), k = a.camera.cut ? 1 : Math.min(1, (t - a.at) / (a.camera.dur ?? 0.8));
    const e = k * k * (3 - 2 * k);
    cur = { x: cur.x + (to.x - cur.x) * e, y: cur.y + (to.y - cur.y) * e, zoom: cur.zoom + (to.zoom - cur.zoom) * e };
  }
  return cur;
}
