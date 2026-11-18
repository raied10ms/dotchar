#!/usr/bin/env node
/**
 * .char command line.  npm run char -- <command>   (or: node cli/char.mjs <command>)
 *
 *   build <folder> [-o out.char] [--sheet qa.png]   folder with build.json + images -> .char (same builder as the studio)
 *   pack <folder> [-o out.char]          folder with char.json + images -> one .char file (validated first)
 *   unpack <file.char> [folder]          .char -> folder (edit, then pack again)
 *   validate <file.char|folder>          check against SPEC.md, print what the character can do
 *   sheet <file.char> [-o sheet.png] [--pose master] [--fit face]   QA sheet: every expression, every blink, every mouth
 *   list                                 characters/*.char, and rewrite characters/index.json (used by the studio)
 *   lipsync <audio> [--stt deepgram|openai] [--words w.json] [--lang en|bn] [-o track.json]
 *   render --char x.char --audio line.mp3 [--track t.json | --stt deepgram] [--pose explain] [--expr happy]
 *          [--cues cues.json] [--fit body|bust|face] [--size 1080x1920] [--bg '#fff'|bg.png|transparent]
 *          [--flip] [-o out.mp4|out.webm|out.mov]       transparent -> .webm (VP9 alpha) or .mov (ProRes 4444)
 *   render --scene scene.json [-o out.mp4]              multi-character scene (see examples/scene)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeZip, readZip } from '../runtime/zip.js';
import { validate } from './validate.mjs';
import { ROOT, startServer, fsUrl } from './serve.mjs';

const [cmd, ...argv] = process.argv.slice(2);
const opt = (k, d) => { const i = argv.findIndex((x) => x === k); return i > -1 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const pos = argv.filter((x, i) => !x.startsWith('-') && !(i > 0 && argv[i - 1].startsWith('-') && !['--flip', '--transparent', '--relipsync'].includes(argv[i - 1])));
const die = (m) => { console.error(m); process.exit(1); };

const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.name.startsWith('.')) return [];
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
});

async function open(src) {
  if (fs.statSync(src).isDirectory()) {
    const c = JSON.parse(fs.readFileSync(path.join(src, 'char.json'), 'utf8'));
    return { c, has: (p) => fs.existsSync(path.join(src, p)), files: null };
  }
  const files = await readZip(fs.readFileSync(src));
  if (!files.has('char.json')) die(`${src}: no char.json inside`);
  return { c: JSON.parse(new TextDecoder().decode(files.get('char.json'))), has: (p) => files.has(p), files };
}

function report(src, v) {
  const i = v.info;
  console.log(`${src}: ${i.name} (${i.id} v${i.version || '?'}) · lips ${i.lips || '-'} · face ${i.faceFlavour}`);
  console.log(`  talkable poses (${i.talkable.length}): ${i.talkable.join(' ')}`);
  if (i.silent.length) console.log(`  silent poses (${i.silent.length}): ${i.silent.join(' ')}`);
  console.log(`  expressions: ${i.expressions.join(' ')} · cycles: ${i.cycles.join(' ') || '-'}`);
  for (const w of v.warnings) console.log(`  warning: ${w}`);
  for (const e of v.errors) console.log(`  ERROR: ${e}`);
}

if (cmd === 'pack') {
  const dir = pos[0] || die('usage: pack <folder> [-o out.char]');
  const { c, has } = await open(dir);
  const v = validate(c, has);
  report(dir, v);
  if (v.errors.length) die(`not packed: ${v.errors.length} errors`);
  const names = walk(dir).filter((n) => n !== 'char.json');
  const out = opt('-o', path.join(path.dirname(path.resolve(dir)), `${c.id}.char`));
  const zip = writeZip([{ name: 'char.json', data: JSON.stringify(c, null, 1) }, ...names.map((n) => ({ name: n, data: fs.readFileSync(path.join(dir, n)) }))]);
  fs.writeFileSync(out, zip);
  console.log(`-> ${out} (${(zip.length / 1e6).toFixed(1)} MB, ${names.length + 1} files)`);
} else if (cmd === 'unpack') {
  const src = pos[0] || die('usage: unpack <file.char> [folder]');
  const files = await readZip(fs.readFileSync(src));
  const out = pos[1] || src.replace(/\.char$/, '');
  for (const [n, d] of files) { const p = path.join(out, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); }
  console.log(`-> ${out}/ (${files.size} files)`);
} else if (cmd === 'validate' || cmd === 'info') {
  const src = pos[0] || die('usage: validate <file.char|folder>');
  const { c, has } = await open(src);
  const v = validate(c, has);
  report(src, v);
  process.exit(v.errors.length ? 1 : 0);
} else if (cmd === 'list') {
  const dir = path.join(ROOT, 'characters');
  const list = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.char')).sort()) {
    const { c, has } = await open(path.join(dir, f));
    const v = validate(c, has);
    report(`characters/${f}`, v);
    const { files } = await open(path.join(dir, f));
    if (c.thumbnail && files?.has(c.thumbnail)) { fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'thumbs', `${c.id}.webp`), files.get(c.thumbnail)); }
    list.push({ file: f, id: c.id, name: c.name, version: c.version, description: c.meta?.description || '', tags: c.meta?.tags || [],
      lips: c.meta?.lips, voice: c.meta?.voice || null, talkable: v.info.talkable, silent: v.info.silent, expressions: v.info.expressions,
      cycles: v.info.cycles, bytes: fs.statSync(path.join(dir, f)).size, ok: !v.errors.length });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), characters: list }, null, 1));
  console.log(`-> characters/index.json (${list.length} characters)`);
} else if (cmd === 'lipsync') {
  const audio = pos[0] || die('usage: lipsync <audio> [--stt deepgram|openai] [--words w.json] [--lang en] [-o track.json]');
  const { lipsync } = await import('../lipsync/lipsync.mjs');
  const lang = opt('--lang', 'en');
  let words = opt('--words') ? JSON.parse(fs.readFileSync(opt('--words'), 'utf8')) : null;
  if (!words && opt('--stt')) words = await (await import('../lipsync/stt.mjs')).transcribe(audio, { provider: opt('--stt'), lang });
  if (!words) console.warn('no --words/--stt: acoustic timing only (add --stt deepgram for better shapes)');
  const track = await lipsync({ audio, words, lang, fps: +opt('--fps', 30) });
  const out = opt('-o', audio.replace(/\.[^.]+$/, '.lipsync.json'));
  fs.writeFileSync(out, JSON.stringify(track));
  console.log(`-> ${out}: ${track.mode}, ${track.cues.length} mouth changes, ${track.duration}s${track.warnings.length ? `, ${track.warnings.length} held-mouth warnings` : ''}`);
} else if (cmd === 'render') {
  await render();
} else if (cmd === 'sheet') {
  const src = pos[0] || die('usage: sheet <file.char> [-o sheet.png] [--pose master] [--fit face]');
  const jobFile = path.join(ROOT, 'render', `.job-${process.pid}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ char: fsUrl(src), pose: opt('--pose'), fit: opt('--fit'), cell: +opt('--cell', 260) }));
  const { page, close } = await browserPage(jobFile, 'sheet.html');
  try { const out = opt('-o', src.replace(/\.char$/, '') + '-sheet.png'); fs.writeFileSync(out, Buffer.from(await page.evaluate(() => window.sheet), 'base64')); console.log(`-> ${out}`); } finally { await close(); }
} else if (cmd === 'build') {
  await build();
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}

async function browserPage(jobFile, html) {
  const { chromium } = await import('playwright-core').catch(() => die('run `npm install` first (playwright-core)'));
  const srv = await startServer(0, '127.0.0.1', { localFiles: true });
  const exe = process.env.CHROME_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' }).catch(() => chromium.launch())
    .catch((e) => die(`no Chrome found (${e.message.split('\n')[0]}). Install Google Chrome or set CHROME_PATH.`));
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page:', e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/render/${html}?job=/render/${path.basename(jobFile)}`);
  await page.waitForFunction(() => window.ready || window.failed, null, { timeout: 120000 });
  const failed = await page.evaluate(() => window.failed);
  const close = async () => { await browser.close(); srv.close(); fs.rmSync(jobFile, { force: true }); };
  if (failed) { await close(); die(`page failed: ${failed}`); }
  return { page, close };
}

async function build() {
  const dir = path.resolve(pos[0] || die('usage: build <folder with build.json> [-o out.char] [--sheet qa.png]'));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  if (!cfg.master) die('build.json: "master" (image file) is required');
  cfg.name ||= path.basename(dir);
  cfg.id ||= cfg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const jobFile = path.join(ROOT, 'render', `.job-${process.pid}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ cfg, base: fsUrl(dir) + '/', sheet: !!opt('--sheet') }));
  const { page, close } = await browserPage(jobFile, 'build.html');
  try {
    const r = await page.evaluate(() => window.run());
    const out = path.resolve(opt('-o', path.join(dir, `${cfg.id}.char`)));
    fs.writeFileSync(out, Buffer.from(r.char, 'base64'));
    if (r.sheet) fs.writeFileSync(path.resolve(opt('--sheet')), Buffer.from(r.sheet, 'base64'));
    for (const [id, p] of Object.entries(r.report.poses)) console.log(`  pose ${id}: ${p.talkable ? 'talkable' : 'silent'}${p.match != null ? ` match ${p.match}` : ''} head [dx ${p.head[0]}, dy ${p.head[1]}, scale ${p.head[2]}]`);
    for (const w of r.report.warnings) console.log(`  warning: ${w}`);
    console.log(`  lip colour ${r.report.lipColour || 'library default'} · face ${r.info.face}`);
    const { c, has } = await open(out);
    const v = validate(c, has);
    report(out, v);
    if (r.sheet) console.log(`QA sheet -> ${opt('--sheet')}`);
  } finally { await close(); }
}

async function render() {
  const sceneFile = opt('--scene');
  const out = path.resolve(opt('-o', sceneFile ? path.join(path.dirname(sceneFile), 'out.mp4') : 'out.mp4'));
  const ext = path.extname(out).toLowerCase();
  const transparent = opt('--bg') === 'transparent' || flag('--transparent');
  if (transparent && !['.webm', '.mov'].includes(ext)) die('transparent output needs -o something.webm or .mov');
  let job;
  if (sceneFile) job = { scene: fsUrl(sceneFile), transparent };
  else {
    const char = opt('--char') || die('render needs --char x.char (or --scene scene.json)');
    const audio = opt('--audio');
    let track = opt('--track');
    if (audio && !track) {
      track = audio.replace(/\.[^.]+$/, '.lipsync.json');
      if (!fs.existsSync(track) || flag('--relipsync')) {
        const { lipsync } = await import('../lipsync/lipsync.mjs');
        const lang = opt('--lang', 'en');
        const wf = audio.replace(/\.[^.]+$/, '.words.json');
        let words = opt('--words') ? JSON.parse(fs.readFileSync(opt('--words'), 'utf8')) : fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : null;
        if (!words && opt('--stt')) { words = await (await import('../lipsync/stt.mjs')).transcribe(audio, { provider: opt('--stt'), lang }); fs.writeFileSync(wf, JSON.stringify(words)); }
        fs.writeFileSync(track, JSON.stringify(await lipsync({ audio, words, lang })));
        console.log(`lip-sync -> ${track}`);
      }
    }
    const [w, h] = opt('--size', '1080x1920').split('x').map(Number);
    const bg = opt('--bg', '#ffffff');
    job = { char: fsUrl(char), track: track && fsUrl(track), audio: audio && path.resolve(audio), pose: opt('--pose'), expr: opt('--expr'), gaze: opt('--gaze'),
      cues: opt('--cues') ? JSON.parse(fs.readFileSync(opt('--cues'), 'utf8')) : [], fit: opt('--fit', 'body'), size: [w, h],
      flip: flag('--flip'), transparent, bg: transparent ? null : bg, bgImage: !transparent && fs.existsSync(bg) ? fsUrl(bg) : null,
      duration: opt('--duration') ? +opt('--duration') : undefined, fps: +opt('--fps', 30) };
  }
  const jobFile = path.join(ROOT, 'render', `.job-${process.pid}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const { page, close } = await browserPage(jobFile, 'render.html');
  try {
    const info = await page.evaluate(() => window.info);
    const fps = info.fps, dur = +opt('--to', info.duration), n = Math.round(dur * fps);
    const audioSrc = (s) => (s.startsWith('http') ? decodeURIComponent(new URL(s).pathname.replace(/^\/__fs/, '')) : s);
    const ins = [], filt = [];
    info.says.forEach((s, i) => { ins.push('-i', audioSrc(s.src)); filt.push(`[${i + 1}:a]adelay=${Math.round(s.at * 1000)}:all=1[a${i}]`); });
    const mix = info.says.length ? ['-filter_complex', `${filt.join(';')};${info.says.map((_, i) => `[a${i}]`).join('')}amix=inputs=${info.says.length}:normalize=0[aout]`, '-map', '0:v', '-map', '[aout]'] : [];
    const venc = !transparent ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac']
      : ext === '.webm' ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-auto-alt-ref', '0', '-c:a', 'libopus']
        : ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-c:a', 'pcm_s16le'];
    const ff = spawn(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', transparent ? 'png' : 'mjpeg', '-i', '-',
      ...ins, ...mix, ...venc, '-t', String(dur), out], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let k = 0; k < n; k++) {
      const url = await page.evaluate((t) => window.frame(t), k / fps);
      if (!ff.stdin.write(Buffer.from(url.split(',')[1], 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
      if (k % 30 === 0) process.stdout.write(`\rframe ${k}/${n}`);
    }
    ff.stdin.end();
    const code = await new Promise((r) => ff.on('close', r));
    if (code) die(`ffmpeg exited ${code}`);
    console.log(`\r-> ${out} (${dur.toFixed(1)}s @ ${fps}fps)`);
  } finally { await close(); }
}
