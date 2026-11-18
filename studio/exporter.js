/**
 * Single-file export: a slimmed copy of a character (chosen poses, smaller images) + the embed player, as ONE HTML file
 * with no outside requests. For Claude artifacts and anywhere else that cannot load files from a server.
 */
const dataUrl = (c, q) => c.toDataURL('image/webp', q);

/** puppet -> { pack, images: { path: dataURL } }. poses = ids to keep; maxH = body image height in px */
export function slim(puppet, { poses, maxH = 512, quality = 0.82 } = {}) {
  const P = structuredClone(puppet.pack), I = puppet.images, k = Math.min(1, maxH / P.canvas[1]);
  const keep = poses?.length ? poses.filter((p) => P.poses[p]) : Object.keys(P.poses).slice(0, 3);
  P.poses = Object.fromEntries(keep.map((p) => { const { tween, ...rest } = P.poses[p]; return [p, rest]; }));
  P.cycles = {}; delete P.thumbnail;
  const images = {};
  const enc = (path, w, h, q = quality) => {
    if (images[path]) return;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(I[path], 0, 0, c.width, c.height);
    images[path] = dataUrl(c, q);
  };
  for (const p of Object.values(P.poses)) enc(p.image, P.canvas[0] * k, P.canvas[1] * k);
  // face tiles: keep their place and size in master px (the player draws with `size`), store 1.5x the on-screen pixels for crisp close-ups
  const tile = (t) => { if (!t?.image) return; const im = I[t.image]; t.size ||= [im.width, im.height]; enc(t.image, Math.min(im.width, t.size[0] * k * 1.5), Math.min(im.height, t.size[1] * k * 1.5), 0.9); };
  const F = P.face;
  if (F) {
    for (const key of ['cover', 'overMouth', 'eyesBase', 'blink', 'visor', 'marks', 'hairLock']) tile(F[key]);
    for (const e of Object.values(F.expressions || {})) { if (e.image) tile(e); tile(e.brows); tile(e.blink); delete e.gaze; }
    delete F.gaze;
    if (F.states) for (const [e, set] of Object.entries(F.states)) { F.states[e] = { camera: set.camera, ...(set.closed ? { closed: set.closed } : {}) }; tile(set.camera); tile(set.closed); }
    for (const set of Object.values(F.mouths)) for (const m of Object.values(set)) tile(m);
  }
  return { pack: P, images };
}

let playerSrc = null;
export async function embedHtml(data, { pose, expression = 'neutral', fit = 'bust', sample = null } = {}) {
  playerSrc ||= await (await fetch('../runtime/embed.js')).text();
  const P = data.pack, info = Object.keys(P.poses);
  const exprs = [...new Set(['neutral', ...Object.keys(P.face?.expressions || {}), ...Object.keys(P.face?.states || {})])];
  const esc = (s) => String(s).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${P.name} (.char)</title>
<!--
  ${P.name}: a self-contained talking character. No outside files, works offline and inside Claude artifacts.
  USE IT IN YOUR OWN PAGE / ARTIFACT: keep the two <script> blocks marked CHAR_DATA and PLAYER, then:
      const who = await DotChar.mount(canvasElement, CHAR_DATA, { pose: '${pose || info[0]}', expression: 'neutral', fit: 'bust' });
      who.say('Hello!');                 // browser voice + mouth movement from the text
      who.setPose('${info[info.length - 1]}'); who.setExpression('happy'); who.setFit('face');   // fit: face | bust | body
      who.play(track, audioUrl);         // a real voice line + its lipsync.json track
  Poses: ${info.join(', ')}
  Expressions: ${exprs.join(', ')}
  (c) 10 Minute School. Internal use only.
-->
<style>
  body { margin: 0; font: 15px system-ui, sans-serif; background: #f6f4ef; color: #1d1b18; display: grid; place-items: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 14px; padding: 16px; box-shadow: 0 2px 14px rgba(0,0,0,.08); width: min(92vw, 420px); }
  canvas { width: 100%; aspect-ratio: 3/4; display: block; border-radius: 10px; background: #fbf8f2; }
  .row { display: flex; gap: 8px; margin-top: 10px; } .row > * { flex: 1; min-width: 0; }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #ddd6c8; background: #fff; }
  button { background: #d9480f; color: #fff; border-color: #d9480f; cursor: pointer; flex: 0 0 auto; }
</style>
</head>
<body>
<div class="card">
  <canvas id="stage" width="600" height="800"></canvas>
  <div class="row"><input id="text" value="Hello! I am ${P.name}. What shall we learn today?"><button id="say">Say</button></div>
  <div class="row">
    <select id="pose">${info.map((p) => `<option${p === pose ? ' selected' : ''}>${p}</option>`).join('')}</select>
    <select id="expr">${exprs.map((e) => `<option${e === expression ? ' selected' : ''}>${e}</option>`).join('')}</select>
    <select id="fit">${['bust', 'face', 'body'].map((f) => `<option${f === fit ? ' selected' : ''}>${f}</option>`).join('')}</select>
  </div>${sample ? '\n  <div class="row"><button id="line" style="flex:1">▶ Play voice line</button></div>' : ''}
</div>
<script>/* CHAR_DATA */ const CHAR_DATA = ${esc(JSON.stringify(data))};${sample ? `\nconst SAMPLE = ${esc(JSON.stringify(sample))};` : ''}</script>
<script>/* PLAYER */ ${playerSrc.replace(/<\/script/g, '<\\/script')}</script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const who = await DotChar.mount($('stage'), CHAR_DATA, { pose: $('pose').value, expression: $('expr').value, fit: $('fit').value });
  $('say').onclick = () => who.say($('text').value);
  $('text').onkeydown = (e) => { if (e.key === 'Enter') who.say($('text').value); };
  $('pose').onchange = (e) => who.setPose(e.target.value);
  $('expr').onchange = (e) => who.setExpression(e.target.value);
  $('fit').onchange = (e) => who.setFit(e.target.value);
  if ($('line')) $('line').onclick = () => who.play(SAMPLE.track, SAMPLE.audio);
  window.who = who;
})();
</script>
</body>
</html>
`;
}
