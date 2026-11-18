#!/usr/bin/env node
/**
 * Photos -> finished .char, automatically. Two steps, because a person must approve the drawing before ~25 more image
 * calls are spent on it (and because likeness is the one thing no script can judge).
 *
 *   node cli/auto.mjs master <work>      # work/character.json + photos -> master.png  (1 image call). LOOK AT IT.
 *   node cli/auto.mjs rest   <work>      # eyes, expressions, poses, mouth + eye positions, drawn mouths, pack, judge
 *
 * <work>/character.json: { "name", "refs": ["ref/1.jpg", ...], "likeness": { "outfit": "..." }, "style": "...",
 *                          "lipsSet": "female"|"male", "poses": "quick"|"full", "mouths": "drawn"|"library" }
 * Progress is written to <work>/status.json and <work>/log.txt (the studio polls them).
 * Needs: OPENAI_API_KEY, python3 with pillow + numpy + opencv-python, Google Chrome, ffmpeg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [stage, workArg] = process.argv.slice(2);
if (!['master', 'rest'].includes(stage) || !workArg) { console.error('usage: auto.mjs master|rest <work>'); process.exit(1); }
const work = path.resolve(workArg);
const cfg = JSON.parse(fs.readFileSync(path.join(work, 'character.json'), 'utf8'));
const id = cfg.id || cfg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const W = (f) => path.join(work, f);
const logFile = W('log.txt');
const status = (s) => { const cur = fs.existsSync(W('status.json')) ? JSON.parse(fs.readFileSync(W('status.json'), 'utf8')) : {}; fs.writeFileSync(W('status.json'), JSON.stringify({ ...cur, id, name: cfg.name, ...s, at: Date.now() })); };
const log = (m) => { fs.appendFileSync(logFile, m + '\n'); console.log(m); };

function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((ok, err) => {
    log(`$ ${cmd === process.execPath ? 'node' : cmd} ${args.map((a) => (a.startsWith(ROOT) ? path.relative(ROOT, a) : a)).join(' ').slice(0, 220)}`);
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = '';
    const on = (d) => { out += d; fs.appendFileSync(logFile, d); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('close', (code) => (code === 0 || allowFail ? ok(out) : err(new Error(`${path.basename(args[0] || cmd)} failed:\n${out.split('\n').slice(-6).join('\n')}`))));
  });
}
const node = (script, ...args) => run(process.execPath, [path.join(ROOT, script), ...args]);
const py = (script, ...args) => run('python3', [path.join(ROOT, script), ...args]);
const QUICK = ['idle', 'explain', 'wave', 'point', 'thumbs-up'];
const FULL = [...QUICK, 'happy', 'sad', 'surprised', 'shrug', 'hands-hips'];

try {
  if (stage === 'master') {
    status({ stage: 'master', step: 'Drawing the character from the photos', progress: 0.05, error: null, done: false, masterReady: false });
    await node('tools/gen-images.mjs', work, '--stage', 'master', '--force');
    if (!fs.existsSync(W('master.png'))) throw new Error('the image model returned no master image (see log.txt)');
    status({ stage: 'approve', step: 'Check the drawing: does it look like them?', progress: 0.1, masterReady: true, masterV: Date.now() });
  } else {
    const poses = (cfg.poses === 'full' ? FULL : QUICK).map((p) => `pose-${p}`).join(',');
    status({ stage: 'rest', step: 'Drawing eyes, expressions and body poses', progress: 0.15, error: null });
    await Promise.all([
      node('tools/gen-images.mjs', work, '--stage', 'face', '--only', 'eyes-closed,expr-happy,expr-sad,expr-surprised,expr-angry,expr-worried,expr-excited')
        .then(() => node('tools/gen-images.mjs', work, '--stage', 'blinks')),
      node('tools/gen-images.mjs', work, '--stage', 'poses', '--only', poses),
      run(process.execPath, [path.join(ROOT, 'tools/gen-cycles.mjs'), work], { allowFail: true }),   // walk + run sheets
    ]);
    status({ step: 'Finding the mouth and eyes', progress: 0.5 });
    await node('tools/locate.mjs', work);
    await py('tools/auto_rig.py', work, '--name', cfg.name, '--lips-set', cfg.lipsSet || 'female');
    const build = JSON.parse(fs.readFileSync(W('build.json'), 'utf8'));
    if (!Object.keys(build.poses).length) throw new Error('no pose images were generated (see log.txt)');
    status({ step: 'Rigging: lining every pose up with the head', progress: 0.58, check: 'locate-check.png' });
    const drawn = cfg.mouths !== 'library';
    const first = W(`${id}-base.char`);
    const out = await node('cli/char.mjs', 'build', work, '-o', first, '--sheet', W('qa-library.png'));
    // eyes: one registered patch per expression x open/closed (no stacked layers, so no double eyebrows)
    fs.rmSync(W('char'), { recursive: true, force: true });
    await node('cli/char.mjs', 'unpack', first, W('char'));
    const eo = build.eyes?.openings;
    await py('tools/eye_states.py', W('char'), '--master', W('master.png'), '--dir', work, '--sheet', W('qa-eyes.png'), ...(eo ? ['--eyes', eo.join(',')] : []));
    if (fs.existsSync(W('cycle-walk.png')) || fs.existsSync(W('cycle-run.png'))) await run('python3', [path.join(ROOT, 'tools/cycle_fit.py'), work, W('char'), '--sheet', W('qa-cycles.png')], { allowFail: true });
    if (!drawn) await node('cli/char.mjs', 'pack', W('char'), '-o', W(`${id}.char`));
    if (drawn) {
      status({ step: 'Drawing the mouth shapes on their own face', progress: 0.66 });
      await py('tools/drawn_mouths.py', 'prep', W('mouths'), '--master', W('master.png'), '--lips', build.lipsBox.join(','));
      await node('tools/gen-mouths.mjs', W('mouths'), '--style', 'the exact art style and rendering of the supplied image');
      status({ step: 'Fitting the mouths to the face', progress: 0.88 });
      await py('tools/drawn_mouths.py', 'apply', W('mouths'), W('char'), '--sheet', W('qa.png'));
      await node('cli/char.mjs', 'pack', W('char'), '-o', W(`${id}.char`));
      status({ step: 'Second opinion from the vision judge', progress: 0.94 });
      const j = await run(process.execPath, [path.join(ROOT, 'tools/judge.mjs'), '--guide', W('mouths/crop.png'), '--render', W('qa.png'), '--out', W('judge.json')], { allowFail: true });
      log(j.split('\n')[0]);
    }
    const silent = [...out.matchAll(/pose (\S+): silent/g)].map((m) => m[1]);
    const judge = fs.existsSync(W('judge.json')) ? JSON.parse(fs.readFileSync(W('judge.json'), 'utf8')) : null;
    status({ stage: 'done', step: 'Done', progress: 1, done: true, char: `${id}.char`, sheet: drawn ? 'qa.png' : 'qa-library.png', silent,
      judge: judge && { verdict: judge.verdict, scores: judge.scores, fixes: (judge.fixes || []).slice(0, 4) } });
    log(`done -> ${W(`${id}.char`)}`);
  }
} catch (e) {
  log(`ERROR ${e.message}`);
  status({ error: e.message.split('\n').slice(0, 4).join(' ').slice(0, 400), stage: stage === 'master' ? 'master' : 'rest-failed' });
  process.exit(1);
}
