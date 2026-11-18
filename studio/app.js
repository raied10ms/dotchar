import { loadChar } from '../runtime/char.js';
import { Performance } from '../runtime/player.js';
import * as B from './builder.js';
import * as X from './exporter.js';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'class' ? (e.className = v) : e.setAttribute(k, v); e.append(...kids.filter((k) => k != null)); return e; };
const OPEN = { X: 0, A: 0, B: 0.25, C: 0.6, D: 1, E: 0.6, F: 0.3, G: 0.2, H: 0.45 };
let server = false;
fetch('/api/ping').then((r) => { server = r.ok; $('#srv').textContent = r.ok ? 'local server: lip-sync for new audio is on' : ''; }).catch(() => {});

// ------------------------------------------------------------------------------------------------ tabs
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.tab));
  if (b.dataset.tab === 'use') snippets();
}));

// ------------------------------------------------------------------------------------------------ preview (shared)
class Preview {
  /** el = controls host; view = canvas host (defaults to el: one column) */
  constructor(el, view = el) {
    this.el = el;
    this.cv = h('canvas', { width: 600, height: 800 });
    const sel = (opts) => h('select', {}, ...opts.map((o) => h('option', { value: o }, o)));
    this.pose = h('select'); this.expr = h('select'); this.gaze = sel(['camera', 'left', 'right', 'down']); this.fit = sel(['body', 'bust', 'face']);
    this.flip = h('input', { type: 'checkbox' });
    this.line = h('select');
    this.audioIn = h('input', { type: 'file', accept: 'audio/*' });
    this.stt = sel(['none', 'deepgram', 'openai']);
    this.status = h('div', { class: 'status' });
    this.title = h('h3', { style: 'margin:0 0 8px' }, 'Preview');
    const lab = (t, e) => h('div', {}, h('label', {}, t), e);
    view.append(this.title, this.cv);
    el.append(
      h('div', { class: 'ctl' }, lab('Pose', this.pose), lab('Expression', this.expr), lab('Eyes look', this.gaze), lab('Framing', this.fit)),
      h('div', { class: 'bar' }, h('label', { class: 'hint' }, this.flip, ' mirror'), h('button', { class: 'b', onclick: () => this.visemes() }, 'Mouth test'), h('button', { class: 'b', onclick: () => this.stop() }, 'Stop')),
      h('div', { class: 'bar' }, h('button', { class: 'b p', onclick: () => this.showcase('all') }, '▶ Play all movements'),
        h('button', { class: 'b', onclick: () => this.showcase('poses') }, 'Poses'), h('button', { class: 'b', onclick: () => this.showcase('exprs') }, 'Expressions'),
        h('button', { class: 'b', onclick: () => this.showcase('cycles') }, 'Walk / run')),
      h('div', { class: 'ctl' }, lab('Voice line', this.line), lab('STT for new audio', this.stt)),
      h('div', { class: 'bar' }, h('button', { class: 'b p', onclick: () => this.talk() }, '▶ Talk'), h('label', { class: 'b' }, 'Lip-sync my audio…', this.audioIn)),
      this.status);
    for (const c of [this.pose, this.expr, this.gaze, this.fit, this.flip]) c.addEventListener('change', () => this.#perf());
    this.audioIn.addEventListener('change', () => this.ownAudio(this.audioIn.files[0]));
    fetch('../examples/audio/samples.json').then((r) => r.json()).then((list) => { this.samples = list; this.#lines(); }).catch(() => (this.samples = []));
    this.#loop();
  }
  #lines() {
    const id = this.puppet?.pack.id;
    const list = [...(this.samples || [])].sort((a, b) => (b.char === id) - (a.char === id));
    this.line.replaceChildren(...list.map((s, i) => h('option', { value: i }, s.label)));
    this.sorted = list;
  }
  set(puppet, { keep = false } = {}) {
    const prev = keep && this.puppet ? { pose: this.pose.value, expr: this.expr.value } : null;
    this.puppet = puppet; if (!keep) this.show = null;
    const info = puppet.info();
    this.title.textContent = `${puppet.pack.name}`;
    const opt = (v, t) => h('option', { value: v }, t || v);
    this.pose.replaceChildren(...info.talkable.map((p) => opt(p)), ...info.silent.map((p) => opt(p, `${p} (silent)`)), ...info.cycles.map((c) => opt(`cycle:${c}`, `${c} cycle`)));
    this.expr.replaceChildren(...info.expressions.map((e) => opt(e)));
    if (prev && info.talkable.concat(info.silent).includes(prev.pose)) this.pose.value = prev.pose;
    else this.pose.value = info.talkable.includes('explain') ? 'explain' : info.talkable.includes('idle') ? 'idle' : 'master';
    if (prev && info.expressions.includes(prev.expr)) this.expr.value = prev.expr;
    this.#lines(); this.#perf();
    if (!keep) this.say(`${info.talkable.length} talkable poses, ${info.silent.length} silent, ${info.expressions.length} expressions, cycles: ${info.cycles.join(', ') || 'none'}`);
  }
  say(t) { this.status.textContent = t; }
  #perf() {
    if (!this.puppet) return;
    this.perfObj = new Performance(this.puppet, { track: this.track, pose: this.pose.value, expression: this.expr.value, gaze: this.gaze.value, flip: this.flip.checked });
  }
  play(track, audioUrl) {
    const keep = this.show; this.stop(); this.show = keep;
    this.track = track; this.#perf();
    this.audio = audioUrl ? new Audio(audioUrl) : null;
    this.t0 = performance.now() / 1000; this.playing = true;
    this.audio?.play();
  }
  /** showcase: step through every pose (with its in-between), expression and walk/run cycle, labelled, looping until Stop */
  showcase(what = 'all') {
    if (!this.puppet) return;
    const i = this.puppet.info(), items = [];
    if (what === 'all' || what === 'poses') for (const p of [...i.talkable, ...i.silent]) items.push({ kind: 'pose', id: p, dur: 1.3, silent: i.silent.includes(p) });
    if (what === 'all' || what === 'exprs') for (const e of i.expressions) items.push({ kind: 'expression', id: e, dur: 1.3 });
    if (what === 'all' || what === 'cycles') for (const c of i.cycles) items.push({ kind: 'cycle', id: c, dur: 2.4 });
    if (!items.length) return this.say('Nothing to show for that.');
    let t = 0; for (const it of items) { it.at = t; t += it.dur; }
    this.show = { items, total: t, t0: performance.now() / 1000 };
    this.say(`Showing ${items.length} movements on a loop. Stop ends it; Talk or Mouth test plays over it.`);
  }
  stop() { this.show = null; this.playing = false; this.audio?.pause(); this.audio = null; this.track = null; this.#perf(); }
  visemes() {
    const seq = 'XABCDEFGHX', fps = 30, frames = [...seq].map((v) => v.repeat(14)).join('');
    this.play({ fps, duration: frames.length / fps, frames, open: [...frames].map((v) => OPEN[v]) });
    this.say('Mouth test: X rest · A M/B/P · B teeth · C open · D wide · E round · F pucker · G F/V · H tongue');
  }
  async talk() {
    const s = this.sorted?.[+this.line.value];
    if (!s) return this.say('No voice line: upload audio with "Lip-sync my audio…"');
    const track = await (await fetch(`../examples/audio/${s.track}`)).json();
    this.play(track, `../examples/audio/${s.audio}`);
    this.say(`${s.label} · lip-sync ${track.mode}`);
  }
  async ownAudio(file) {
    if (!file) return;
    if (!server) return this.say('Lip-sync needs the local server: run `npm run studio` and open the URL it prints.');
    this.say('Lip-syncing…');
    const ext = file.name.split('.').pop();
    const r = await fetch(`/api/lipsync?ext=${ext}&stt=${this.stt.value}`, { method: 'POST', body: file });
    if (!r.ok) return this.say(`Lip-sync failed: ${await r.text()}`);
    const track = await r.json();
    this.lastTrack = { track, name: file.name };
    this.play(track, URL.createObjectURL(file));
    this.say(`${file.name}: ${track.mode}, ${track.cues.length} mouth changes ${track.note || ''}`);
  }
  #loop() {
    const ctx = this.cv.getContext('2d');
    const tick = () => {
      requestAnimationFrame(tick);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 600, 800);
      if (!this.perfObj) return;
      const now = performance.now() / 1000;
      let t = this.playing ? (this.audio ? this.audio.currentTime : now - this.t0) : 0;
      if (this.playing && this.track && t > this.track.duration + 0.3 && (!this.audio || this.audio.ended)) { this.playing = false; t = 0; }
      const st = this.perfObj.stateAt(t);
      const life = this.perfObj.stateAt(now + 100);
      st.eyes = life.eyes; st.breathe = life.breathe;
      if (!this.playing) { st.mouth = 'X'; st.open = 0; }
      const pose = this.pose.value;
      if (pose.startsWith('cycle:')) { const id = pose.slice(6); st.cycle = { id, frame: Math.floor(now * (id === 'run' ? 15 : 12)) }; }
      let label = null, fit = this.fit.value;
      if (this.show) {
        const S = this.show, lt = (now - S.t0) % S.total, k = S.items.findIndex((it) => lt >= it.at && lt < it.at + it.dur), it = S.items[k];
        delete st.cycle; delete st.tweenOf;
        if (it.kind === 'pose') { st.pose = it.id; if (lt - it.at < 0.1 && this.puppet.pack.poses[it.id]?.tween) st.tweenOf = it.id; }
        else if (it.kind === 'expression') { st.pose = this.puppet.has('idle') ? 'idle' : 'master'; st.expr = it.id; fit = fit === 'body' ? 'bust' : fit; }
        else { st.cycle = { id: it.id, frame: Math.floor((lt - it.at) * (it.id === 'run' ? 15 : 12)) }; fit = 'body'; }
        label = `${it.kind}: ${it.id}${it.silent ? ' (silent)' : ''}   ${k + 1}/${S.items.length}`;
      }
      const place = this.perfObj.fit(600, 800, fit);
      try { this.puppet.draw(ctx, st, place); } catch (e) { this.say(String(e.message || e)); }
      if (label) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
        const w = ctx.measureText(label).width + 28;
        ctx.fillStyle = 'rgba(29,27,24,.82)'; ctx.beginPath(); ctx.roundRect(14, 14, w, 40, 10); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, 28, 35);
      }
    };
    tick();
  }
}

// ------------------------------------------------------------------------------------------------ library
const pvLib = new Preview($('#pvLibCtl'), $('#pvLibView'));
let current = null; // { file, name, id }
async function library() {
  let idx = { characters: [] };
  try { idx = await (await fetch('../characters/index.json')).json(); } catch {}
  const grid = $('#grid');
  grid.replaceChildren(...idx.characters.map((c) => h('div', { class: 'card char', onclick: (e) => pick(c, e.currentTarget) },
    h('img', { src: `../characters/thumbs/${c.id}.webp`, alt: c.name }),
    h('div', {}, h('b', {}, c.name), h('span', {}, `${c.talkable.length} poses · ${(c.bytes / 1e6).toFixed(0)} MB`)))));
  if (idx.characters[0]) pick(idx.characters[0], grid.firstChild);
}
async function pick(c, el) {
  document.querySelectorAll('.char').forEach((x) => x.classList.toggle('sel', x === el));
  pvLib.say(`Loading ${c.name}…`);
  const p = await loadChar(`../characters/${c.file}`);
  current = { file: `characters/${c.file}`, name: c.name, id: c.id, talkable: c.talkable, inRepo: true };
  pvLib.set(p); exportPanel();
}
async function openFile(file) {
  pvLib.say(`Opening ${file.name}…`);
  try { const p = await loadChar(file); current = { file: `characters/${file.name}`, name: p.pack.name, id: p.pack.id, talkable: p.info().talkable, blob: file }; pvLib.set(p); exportPanel(); document.querySelectorAll('.char').forEach((x) => x.classList.remove('sel')); }
  catch (e) { pvLib.say(`Not a valid .char: ${e.message}`); }
}
$('#openChar').addEventListener('change', (e) => openFile(e.target.files[0]));
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
document.addEventListener('dragleave', () => document.body.classList.remove('drop'));
document.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('drop');
  const f = e.dataTransfer.files[0];
  if (f && /\.(char|zip)$/i.test(f.name)) { document.querySelector('nav button[data-tab=library]').click(); openFile(f); }
});
library();

// ------------------------------------------------------------------------------------------------ export (single file / .char)
const CDN = 'https://cdn.jsdelivr.net/gh/raied10ms/dotchar@main';
function exportPanel() {
  const p = pvLib.puppet; if (!p) return;
  const info = p.info(), all = [...info.talkable, ...info.silent];
  const pref = ['explain', 'idle', 'wave', 'point', 'thumbs-up', 'happy'].filter((x) => info.talkable.includes(x)).slice(0, 4);
  const on = new Set(pref.length ? pref : all.slice(0, 3));
  $('#expName').textContent = p.pack.name;
  $('#expPoses').replaceChildren(...all.map((id) => { const i = h('input', { type: 'checkbox', value: id }); i.checked = on.has(id); i.addEventListener('change', () => ($('#expSizeInfo').textContent = '')); return h('label', {}, i, id); }));
  const a = $('#expChar');
  if (current.blob) a.href = URL.createObjectURL(current.blob); else a.href = `../${current.file}`;
  a.download = `${current.id}.char`;
  $('#expSizeInfo').textContent = ''; $('#expInfo').textContent = '';
}
async function buildExport() {
  const p = pvLib.puppet; if (!p) return null;
  const poses = [...document.querySelectorAll('#expPoses input:checked')].map((i) => i.value);
  if (!poses.length) { $('#expInfo').textContent = 'Pick at least one pose.'; return null; }
  $('#expInfo').textContent = 'Packing…';
  const data = X.slim(p, { poses, maxH: +$('#expSize').value });
  let sample = null;
  const s = (pvLib.samples || []).find((x) => x.char === p.pack.id);
  if ($('#expLine').value === '1' && s) {
    const track = await (await fetch(`../examples/audio/${s.track}`)).json();
    const blob = await (await fetch(`../examples/audio/${s.audio}`)).blob();
    const audio = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    sample = { track: { fps: track.fps, duration: track.duration, frames: track.frames, open: track.open }, audio };
  }
  const html = await X.embedHtml(data, { pose: pvLib.pose.value.startsWith('cycle:') ? poses[0] : (poses.includes(pvLib.pose.value) ? pvLib.pose.value : poses[0]), expression: pvLib.expr.value, sample });
  $('#expSizeInfo').textContent = `${Math.round(html.length / 1024)} KB · ${poses.length} pose${poses.length > 1 ? 's' : ''}`;
  return html;
}
$('#expCopy').addEventListener('click', async () => {
  const html = await buildExport(); if (!html) return;
  try { await navigator.clipboard.writeText(html); $('#expInfo').textContent = 'Copied. Paste it into Claude and say: "make this an artifact" (or "use this character in my artifact").'; }
  catch { $('#expInfo').textContent = 'Clipboard blocked by the browser: use Download .html and attach the file instead.'; }
});
$('#expHtml').addEventListener('click', async () => {
  const html = await buildExport(); if (!html) return;
  h('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `${current.id}-char.html` }).click();
  $('#expInfo').textContent = `Saved ${current.id}-char.html. Open it in a browser, or attach it to a Claude chat.`;
});
$('#expTag').addEventListener('click', async () => {
  const pose = pvLib.pose.value.startsWith('cycle:') ? 'master' : pvLib.pose.value;
  const tag = `<script type="module" src="${CDN}/runtime/char-player.js"></script>\n<char-player src="${CDN}/${current.file}" audio="line.mp3" track="line.lipsync.json"\n             pose="${pose}" expression="${pvLib.expr.value}" fit="${pvLib.fit.value}" width="540" height="720"></char-player>`.replace(/\\n/g, '\n');
  try { await navigator.clipboard.writeText(tag); $('#expInfo').textContent = current.inRepo ? 'Copied. Works on any normal web page (loads the character from the public repo). Not for Claude artifacts: use the single-file code there.' : 'Copied, but this character is not in the repo yet: add it to characters/ and push first.'; }
  catch { $('#expInfo').textContent = tag; }
});

// ------------------------------------------------------------------------------------------------ create
const pvCreate = new Preview($('#pvCreate'));
$('#pvCreate').prepend(pvCreate.cv); $('#pvCreate').prepend(pvCreate.title);
const S = { lips: 'female', mouthW: 90, coverKx: 1.35, coverKy: 0.55, expr: {}, poses: [], cycles: {}, lipAuto: true, files: { eyes: {}, cycles: {} } };
const lib = { json: null, images: {} };
async function loadLib() {
  if (lib.json) return;
  lib.json = await (await fetch('../mouthlib/mouthlib.json')).json();
  const paths = [];
  for (const L of Object.values(lib.json)) for (const [e, set] of Object.entries(L)) if (!e.startsWith('_')) for (const m of Object.values(set)) paths.push(m.image);
  await Promise.all(paths.map(async (p) => (lib.images[p] = await B.urlToImage(`../mouthlib/${p}`))));
}
S.lib = lib;
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';
const setupCv = $('#setup'), sctx = setupCv.getContext('2d');
let view = { s: 1, ox: 0, oy: 0 }, mode = 'mouth', drag = null;

function fitView(r) {
  const [x0, y0, x1, y1] = r, s = Math.min(setupCv.width / (x1 - x0), setupCv.height / (y1 - y0)) * 0.94;
  view = { s, ox: (x0 + x1) / 2 - setupCv.width / 2 / s, oy: (y0 + y1) / 2 - setupCv.height / 2 / s };
  drawSetup();
}
const toRig = (e) => { const r = setupCv.getBoundingClientRect(); const k = setupCv.width / r.width; return [(e.clientX - r.left) * k / view.s + view.ox, (e.clientY - r.top) * k / view.s + view.oy]; };
function drawSetup() {
  sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, setupCv.width, setupCv.height);
  if (!S.master) return;
  sctx.setTransform(view.s, 0, 0, view.s, -view.ox * view.s, -view.oy * view.s);
  sctx.drawImage(S.master, 0, 0);
  const lw = 1.5 / view.s;
  if (S.anchor) {
    const [ax, ay] = S.anchor, w = S.mouthW;
    sctx.strokeStyle = '#d9480f'; sctx.lineWidth = lw * 1.5;
    sctx.beginPath(); sctx.moveTo(ax - w / 2, ay); sctx.lineTo(ax + w / 2, ay); sctx.moveTo(ax, ay - 6 / view.s); sctx.lineTo(ax, ay + 6 / view.s); sctx.stroke();
    sctx.setLineDash([4 / view.s, 3 / view.s]); sctx.lineWidth = lw;
    sctx.beginPath(); sctx.ellipse(ax, ay, w * S.coverKx * 0.42, w * S.coverKy * 0.38, 0, 0, Math.PI * 2); sctx.stroke();
    const hb = B.headBox(S); sctx.strokeStyle = '#868e96'; sctx.strokeRect(hb[0], hb[1], hb[2] - hb[0], hb[3] - hb[1]);
    sctx.setLineDash([]);
  }
  const eb = drag?.box || S.eyeBox;
  if (eb) { sctx.strokeStyle = '#1864ab'; sctx.lineWidth = lw * 1.5; sctx.strokeRect(eb[0], eb[1], eb[2] - eb[0], eb[3] - eb[1]); }
}
document.querySelectorAll('.mode [data-mode]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode; document.querySelectorAll('.mode [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  $('#setupHint').textContent = mode === 'mouth' ? 'Click the centre of the lips.' : 'Drag a box around both eyes and eyebrows.';
}));
$('#zoomFace').addEventListener('click', () => S.anchor && fitView(B.headBox(S)));
$('#zoomAll').addEventListener('click', () => S.master && fitView([0, 0, S.master.width, S.master.height]));
setupCv.addEventListener('mousedown', (e) => {
  if (!S.master) return;
  const p = toRig(e);
  if (mode === 'mouth') {
    S.anchor = p.map(Math.round);
    if (S.lipAuto) { const c = B.sampleLipColour(S.master, S.anchor, S.mouthW); if (c) $('#lipC').value = S.lipColour = c; }
    drawSetup(); rebuild();
  } else drag = { from: p, box: [...p, ...p] };
});
setupCv.addEventListener('mousemove', (e) => { if (!drag) return; const p = toRig(e); drag.box = [Math.min(drag.from[0], p[0]), Math.min(drag.from[1], p[1]), Math.max(drag.from[0], p[0]), Math.max(drag.from[1], p[1])]; drawSetup(); });
addEventListener('mouseup', () => {
  if (!drag) return;
  const b = drag.box.map(Math.round); drag = null;
  if (b[2] - b[0] > 8 && b[3] - b[1] > 8) { S.eyeBox = b; rebuild(); }
  drawSetup();
});
setupCv.addEventListener('wheel', (e) => { if (!S.master) return; e.preventDefault(); const p = toRig(e), k = e.deltaY < 0 ? 1.15 : 1 / 1.15; view.s *= k; view.ox = p[0] - (p[0] - view.ox) / k; view.oy = p[1] - (p[1] - view.oy) / k; drawSetup(); }, { passive: false });

const bind = (id, key, fmt = (v) => v, out) => { const el = $(id); const upd = () => { S[key] = +el.value; if (out) $(out).textContent = fmt(+el.value); drawSetup(); rebuild(); }; el.addEventListener('input', upd); if (out) $(out).textContent = fmt(+el.value); };
bind('#mw', 'mouthW', (v) => v, '#mwV'); bind('#coverKx', 'coverKx', (v) => v.toFixed(2), '#cxV'); bind('#coverKy', 'coverKy', (v) => v.toFixed(2), '#cyV');
$('#lipC').addEventListener('input', (e) => { S.lipColour = e.target.value; S.lipAuto = false; rebuild(); });
$('#lipAuto').addEventListener('click', () => { if (!S.anchor) return; const c = B.sampleLipColour(S.master, S.anchor, S.mouthW); if (c) { $('#lipC').value = S.lipColour = c; S.lipAuto = true; rebuild(); } else pvCreate.say('No clear lip colour found there; pick one.'); });
$('#beard').addEventListener('change', (e) => { S.facialHair = e.target.checked; rebuild(); });
$('#cLips').addEventListener('change', (e) => { S.lips = e.target.value; rebuild(); });
$('#cName').addEventListener('input', (e) => { S.name = e.target.value; S.id = slug(e.target.value); updateExport(); });

$('#fMaster').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await loadLib();
  S.master = await B.fileToCanvas(f); S.files.master = f.name;
  const { box, hasAlpha } = B.alphaBBox(S.master);
  $('#masterWarn').textContent = hasAlpha ? '' : 'No transparent background: the character will carry its background into every video. Remove the background first if you can.';
  if (!S.name) { S.name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); $('#cName').value = S.name; S.id = slug(S.name); }
  // a starting mouth width ~ 9% of the body width works for most full-body cartoons
  S.mouthW = Math.round(Math.max(30, (box[2] - box[0]) * 0.09)); $('#mw').value = S.mouthW; $('#mwV').textContent = S.mouthW;
  fitView([0, 0, S.master.width, S.master.height]);
  $('#setupHint').textContent = 'Click the centre of the lips.';
  rebuild();
});
$('#fMouthless').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f || !S.master) return; S.mouthless = await B.fileToCanvas(f, [S.master.width, S.master.height]); S.files.mouthless = f.name; $('#mlName').textContent = f.name; rebuild(); });

const slots = $('#eyeSlots');
for (const k of ['closed', ...B.EXPRS]) {
  const inp = h('input', { type: 'file', accept: 'image/*' });
  const slot = h('label', { class: 'slot' }, k === 'closed' ? 'eyes closed' : k, inp);
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f || !S.master) return;
    const c = await B.fileToCanvas(f, [S.master.width, S.master.height]);
    if (k === 'closed') S.closed = c; else S.expr[k] = c;
    S.files.eyes[k] = f.name;
    slot.classList.add('has');
    slot.replaceChildren(h('img', { src: c.toDataURL('image/webp', 0.6) }), k === 'closed' ? 'eyes closed' : k, inp);
    if (!S.eyeBox) pvCreate.say('Now drag the eye box (Eyes mode) so these images can be used.');
    rebuild();
  });
  slots.append(slot);
}

$('#fPoses').addEventListener('change', async (e) => {
  if (!S.master) return pvCreate.say('Load the master first.');
  for (const f of e.target.files) {
    const c = await B.fileToCanvas(f, [S.master.width, S.master.height]);
    const p = { file: f.name, id: slug(f.name.replace(/\.[^.]+$/, '').replace(/^pose[-_]/, '')), canvas: c, talkable: true, s: 1, dx: 0, dy: 0, match: null };
    S.poses.push(p);
    if (S.anchor) align(p);
  }
  e.target.value = '';
  poseRows(); rebuild();
});
function align(p) {
  const r = B.alignHead(S.master, p.canvas, B.headBox(S));
  Object.assign(p, { s: r.s, dx: r.dx, dy: r.dy });
  p.match = B.matchScore(S.master, p.canvas, B.headBox(S), p.s, p.dx, p.dy);
  p.talkable = p.match >= 0.86;
}
function poseRows() {
  $('#poseList').replaceChildren(...S.poses.map((p, i) => {
    const score = h('span', { class: `score ${p.match == null ? '' : p.match >= 0.86 ? 'good' : 'bad'}` }, p.match == null ? 'not aligned' : `match ${p.match.toFixed(3)}`);
    const nudge = (k, d) => () => { p[k] += d; p.match = S.anchor ? B.matchScore(S.master, p.canvas, B.headBox(S), p.s, p.dx, p.dy) : null; poseRows(); rebuild(); show(); };
    const show = () => { pvCreate.pose.value = p.id; pvCreate.fit.value = 'face'; pvCreate.pose.dispatchEvent(new Event('change')); };
    const id = h('input', { type: 'text', value: p.id }); id.addEventListener('change', () => { p.id = slug(id.value); rebuild(); });
    const tk = h('input', { type: 'checkbox' }); tk.checked = p.talkable; tk.addEventListener('change', () => { p.talkable = tk.checked; rebuild(); });
    return h('div', { class: 'pose' }, h('img', { src: p.canvas.toDataURL('image/webp', 0.5) }),
      h('div', {}, id, h('div', { class: 'bar', style: 'margin-top:4px' }, h('label', { class: 'hint' }, tk, ' talkable'), score),
        h('div', { class: 'bar nudge', style: 'margin-top:4px' },
          h('button', { class: 'b', onclick: () => { if (!S.anchor) return pvCreate.say('Set the mouth first.'); align(p); poseRows(); rebuild(); show(); } }, 'Auto-align'),
          h('button', { class: 'b', title: 'left', onclick: nudge('dx', -1) }, '←'), h('button', { class: 'b', title: 'right', onclick: nudge('dx', 1) }, '→'),
          h('button', { class: 'b', title: 'up', onclick: nudge('dy', -1) }, '↑'), h('button', { class: 'b', title: 'down', onclick: nudge('dy', 1) }, '↓'),
          h('button', { class: 'b', title: 'smaller', onclick: nudge('s', -0.005) }, '−'), h('button', { class: 'b', title: 'bigger', onclick: nudge('s', 0.005) }, '+'),
          h('button', { class: 'b', onclick: show }, 'View'), h('button', { class: 'b', onclick: () => { S.poses.splice(i, 1); poseRows(); rebuild(); } }, '✕'))));
  }));
}
for (const [id, key] of [['#fWalk', 'walk'], ['#fRun', 'run']]) $(id).addEventListener('change', async (e) => {
  if (!S.master) return;
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let frames = await Promise.all(files.map((f) => B.fileToCanvas(f)));
  if (frames.length === 1) frames = B.splitSheet(frames[0], +(prompt('One image: a sheet of frames side by side. How many frames?', '4') || 4)); // generated cycle sheet
  S.cycles[key] = frames; S.files.cycles[key] = files.length === 1 ? files[0].name : files.map((f) => f.name);
  $('#cycInfo').textContent = Object.entries(S.cycles).map(([k, v]) => `${k}: ${v.length} frames`).join(' · ');
  rebuild();
});

let built = null, timer = null;
function rebuild() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!S.master) return;
    S.id ||= slug(S.name || 'character'); S.name ||= 'Character';
    S.description = $('#cDesc').value;
    try {
      built = B.assemble(S);
      pvCreate.set(B.puppetFrom(built), { keep: true });
      pvCreate.say(S.anchor ? 'Talking rig ready: try Mouth test or Talk.' : 'Body only so far. Set the mouth (step 3) to make it talk.');
    } catch (e) { pvCreate.say(`Build error: ${e.message}`); console.error(e); }
    updateExport();
  }, 120);
}
function updateExport() {
  $('#export').disabled = !built;
  if (!built) return;
  const p = built.pack, talk = Object.values(p.poses).filter((x) => x.talkable).length;
  const weak = S.poses.filter((x) => x.talkable && x.match != null && x.match < 0.86).map((x) => x.id);
  $('#exportInfo').innerHTML = `${S.id}.char · ${Object.keys(p.poses).length} poses (${talk} talkable) · face: ${p.face ? (p.face.states ? 'mouth + eyes' : 'mouth only') : 'none'} · cycles: ${Object.keys(p.cycles).join(', ') || 'none'}`
    + (weak.length ? `<div class="warn">Low head match: ${weak.join(', ')}. Nudge or untick talkable.</div>` : '')
    + (p.face && !p.face.states ? '<div class="hint">No eye images: the character will not blink.</div>' : '');
}
$('#saveBuild').addEventListener('click', () => {
  if (!S.master) return;
  const j = { name: S.name, id: S.id, lips: S.lips, description: $('#cDesc').value, master: S.files.master };
  if (S.files.mouthless) j.mouthless = S.files.mouthless;
  if (S.anchor) j.mouth = { anchor: S.anchor, width: S.mouthW, lipColour: S.lipAuto ? 'auto' : S.lipColour, cover: [S.coverKx, S.coverKy], ...(S.facialHair ? { facialHair: true } : {}) };
  if (S.eyeBox) j.eyes = { box: S.eyeBox, ...S.files.eyes };
  j.poses = Object.fromEntries(S.poses.map((p) => [p.id, { image: p.file, talkable: p.talkable, head: [p.dx, p.dy, +p.s.toFixed(4)] }]));
  if (Object.keys(S.files.cycles).length) j.cycles = S.files.cycles;
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' })), download: 'build.json' }); a.click();
  $('#exportInfo').append(h('div', { class: 'hint' }, 'build.json saved. Keep it next to the images: npm run char -- build <that folder> rebuilds the same .char.'));
});
$('#export').addEventListener('click', async () => {
  rebuild(); await new Promise((r) => setTimeout(r, 200));
  built.pack.id = S.id; built.pack.name = S.name; built.pack.meta.description = $('#cDesc').value;
  $('#exportInfo').textContent = 'Packing…';
  const blob = await B.exportChar(built);
  const a = h('a', { href: URL.createObjectURL(blob), download: `${S.id}.char` }); a.click();
  updateExport();
  $('#exportInfo').append(h('div', { class: 'hint' }, `Saved ${(blob.size / 1e6).toFixed(1)} MB. Put it in characters/ and run: npm run char -- list`));
});

// ------------------------------------------------------------------------------------------------ use it
function snippets() {
  const c = current || { file: 'characters/bhasha.char', name: 'Bhasha', id: 'bhasha', talkable: ['explain'] };
  const pose = c.talkable?.includes('explain') ? 'explain' : c.talkable?.[0] || 'master';
  $('#useName').textContent = c.name;
  $('#snipWeb').textContent = `<script type="module" src="https://YOUR-HOST/dotchar/runtime/char-player.js"></script>

<char-player src="${c.file}" audio="line.mp3" track="line.lipsync.json"
             pose="${pose}" expression="happy" fit="bust" width="540" height="720"></char-player>`;
  $('#snipCli').textContent = `npm run char -- lipsync line.mp3 --stt deepgram          # -> line.lipsync.json
npm run char -- render --char ${c.file} --audio line.mp3 --pose ${pose} --expr happy \\
     --fit bust --size 1080x1920 -o ${c.id}-line.mp4
# transparent overlay for video editors:
npm run char -- render --char ${c.file} --audio line.mp3 --bg transparent -o ${c.id}-line.webm`;
  $('#snipJs').textContent = `import { loadChar } from './runtime/char.js';
import { Performance } from './runtime/player.js';

const ${c.id.replace(/-/g, '_')} = await loadChar('${c.file}');
const track = await (await fetch('line.lipsync.json')).json();
const perf = new Performance(${c.id.replace(/-/g, '_')}, { track, pose: '${pose}', expression: 'happy',
  cues: [{ at: 1.2, pose: 'point', dur: 1.5 }, { at: 2.0, expr: 'surprised' }] });
// every frame (t = audio.currentTime, or frame / fps in Remotion):
perf.draw(ctx, t, perf.fit(canvas.width, canvas.height, 'bust'));`;
}

// scripting / automated tests: window.studio.S is the whole build state
window.studio = { S, get view() { return view; }, rebuild, align, poseRows, get built() { return built; }, pvCreate, pvLib };
