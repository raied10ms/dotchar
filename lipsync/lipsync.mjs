#!/usr/bin/env node
/**
 * Audio + timed words (STT)  ->  frame-accurate viseme track for any rig.
 *
 *   node lipsync/lipsync.mjs line.mp3 --words line.words.json [--lang en|bn] [--fps 30] [--lead 0] [--out track.json]
 *   node lipsync/lipsync.mjs line.mp3 --stt deepgram|openai      # fetch word timings first (see stt.mjs)
 *
 * Three evidence sources, each trusted for what it is good at:
 *   1. ACOUSTIC  Rhubarb 1.14 (verified identical to the official release) — best open/close TIMING. This is
 *                gives the most natural open/close rhythm; we keep it as the backbone.
 *   2. TEXT      STT words -> phonemes (CMUdict / Bangla grapheme rules), placed inside each word span by a
 *                DP that aligns expected jaw-opening to the measured loudness envelope. Picks the SHAPE.
 *   3. ENERGY    10 ms RMS envelope — gates silence (breaths, pauses) and drives a continuous `open` curve.
 * Fusion fixes the errors viewers actually notice: missed lip closures on M/B/P, unrounded OO/OH, F/V without
 * teeth-on-lip, mouths moving during breaths. Then animation craft: anticipation lead, 1-frame closures kept,
 * 1-frame flicker removed, held-open warnings.
 * Works without Rhubarb (text+energy only) and without words (Rhubarb+energy only).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OPEN, phonesFor, arpaToViseme, durWeight, rhubarbDir } from './phonemes.mjs';
import { normalizeWords } from './words.mjs';
export { normalizeWords };

const SR = 16000, HOP = 0.01;

// ---------------------------------------------------------------- audio
export const decode = (file) => {
  const raw = execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(raw.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;
  return pcm;
};

/** 10 ms RMS in dB, normalised 0..1 between the noise floor (p10) and loud speech (p95). */
export const envelope = (pcm) => {
  const n = Math.floor(pcm.length / (SR * HOP));
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * 160; j < (i + 1) * 160; j++) s += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(s / 160 + 1e-10);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.1)], hi = sorted[Math.floor(n * 0.95)];
  return Float32Array.from(db, (d) => Math.min(1, Math.max(0, (d - lo - 6) / (hi - lo - 6 || 1))));
};
const envAt = (env, t) => env[Math.min(env.length - 1, Math.max(0, Math.round(t / HOP)))] ?? 0;

// ---------------------------------------------------------------- 1. acoustic: Rhubarb
export const rhubarb = (pcmFile, dialog, lang) => {
  const bin = process.env.RHUBARB_BIN || path.join(rhubarbDir(), process.platform === 'win32' ? 'rhubarb.exe' : 'rhubarb');
  if (!fs.existsSync(bin)) return null;
  const args = ['-f', 'json', '-r', /^en/.test(lang) ? 'pocketSphinx' : 'phonetic', '--extendedShapes', 'GHX', '--threads', '2', '-q'];
  let dlg;
  if (dialog && /^en/.test(lang)) { dlg = path.join(os.tmpdir(), `rig-dlg-${process.pid}.txt`); fs.writeFileSync(dlg, dialog); args.push('-d', dlg); }
  args.push(pcmFile);
  let out = JSON.parse(execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26 }));
  if (out.mouthCues.every((c) => c.value === 'X') && args[3] === 'pocketSphinx') { // fallback: recogniser found nothing
    args[3] = 'phonetic'; out = JSON.parse(execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26 }));
  }
  if (dlg) fs.rmSync(dlg, { force: true });
  return out.mouthCues.map((c) => ({ start: c.start, end: c.end, v: c.value }));
};

// ---------------------------------------------------------------- 2. text: phonemes aligned to loudness inside each word
export const alignWord = (w, env) => {
  const phones = phonesFor(w.word);
  if (!phones.length) return [];
  const t0 = w.start, n = Math.max(1, Math.round((w.end - w.start) / HOP));
  const m = phones.length;
  const wts = phones.map(durWeight), tot = wts.reduce((a, b) => a + b, 0);
  if (n < m * 2) { // too short to align: proportional split
    let t = t0;
    return phones.map((p, i) => { const d = (w.end - w.start) * wts[i] / tot; const r = { start: t, end: t + d, p, v: arpaToViseme(p) }; t += d; return r; });
  }
  // prior centres (fraction of word) from duration weights
  const centre = []; let acc = 0;
  wts.forEach((x) => { centre.push((acc + x / 2) / tot); acc += x; });
  const op = phones.map((p) => OPEN[arpaToViseme(p)]);
  const INF = 1e9, cost = Array.from({ length: n }, () => new Float64Array(m).fill(INF)), back = Array.from({ length: n }, () => new Int8Array(m));
  const fc = (i, j) => (op[j] - envAt(env, t0 + i * HOP)) ** 2 + 3 * ((i + 0.5) / n - centre[j]) ** 2;
  cost[0][0] = fc(0, 0);
  for (let i = 1; i < n; i++)
    for (let j = 0; j < m; j++) {
      const stay = cost[i - 1][j], adv = j ? cost[i - 1][j - 1] : INF;
      cost[i][j] = Math.min(stay, adv) + fc(i, j);
      back[i][j] = adv < stay ? 1 : 0;
    }
  const seg = new Array(m).fill(null).map(() => [Infinity, -Infinity]);
  for (let i = n - 1, j = m - 1; i >= 0; i--) { seg[j][0] = Math.min(seg[j][0], i); seg[j][1] = Math.max(seg[j][1], i); if (back[i][j]) j--; }
  return phones.map((p, j) => ({ start: t0 + seg[j][0] * HOP, end: Math.min(w.end, t0 + (seg[j][1] + 1) * HOP), p, v: arpaToViseme(p) }));
};

// ---------------------------------------------------------------- fusion
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

const insertCue = (cues, cue) => {
  const out = [];
  for (const c of cues) {
    if (c.end <= cue.start || c.start >= cue.end) { out.push(c); continue; }
    if (c.start < cue.start) out.push({ ...c, end: cue.start });
    if (c.end > cue.end) out.push({ ...c, start: cue.end });
  }
  out.push(cue);
  return out.sort((a, b) => a.start - b.start);
};

export const fuse = (acoustic, phones, words, env, log) => {
  let cues = acoustic.map((c) => ({ ...c, src: 'rhubarb' }));
  // a) shape correction: when the words clearly say round / F-V / tongue, and Rhubarb drew a generic opening
  const SWAP = { F: ['B', 'C', 'D'], E: ['C', 'D'], G: ['B', 'C'], H: ['B', 'C'] };
  for (const c of cues) {
    if (c.v === 'X' || c.v === 'A') continue;
    const votes = {};
    for (const p of phones) { const o = overlap(c, p); if (o) votes[p.v] = (votes[p.v] || 0) + o; }
    const [best, amt] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || [];
    if (best && best !== c.v && SWAP[best]?.includes(c.v) && amt > 0.5 * (c.end - c.start)) { log.swaps++; c.v = best; c.src = 'text'; }
  }
  // b) closures: every M/B/P must show closed lips for >= 1 frame near where the words put it
  for (const p of phones.filter((q) => q.v === 'A')) {
    const t = (p.start + p.end) / 2;
    const near = cues.some((c) => (c.v === 'A' || c.v === 'X') && c.end > t - 0.06 && c.start < t + 0.06);
    if (!near) { cues = insertCue(cues, { start: t - 0.035, end: t + 0.035, v: 'A', src: 'closure' }); log.closures++; }
  }
  // c) breaths / noise outside any word that Rhubarb animated -> rest
  const inWord = (t) => words.some((w) => t >= w.start - 0.08 && t <= w.end + 0.08);
  if (words.length) for (const c of cues) if (c.v !== 'X' && !inWord((c.start + c.end) / 2) && envAt(env, (c.start + c.end) / 2) < 0.35) { c.v = 'X'; c.src = 'gate'; log.gated++; }
  return cues;
};

/**
 * Non-speech vocals (laughs, gasps, sighs from TTS audio tags): loud stretches OUTSIDE every word where the mouth
 * would rest. Neither recognizer treats laughter as speech, so animate it from its loudness pulses ("ha-ha").
 */
export const vocalize = (cues, words, env, log) => {
  if (!words.length) return cues;
  const inWord = (t) => words.some((w) => t >= w.start - 0.05 && t <= w.end + 0.05);
  const restAt = (t) => { const c = cues.find((q) => t >= q.start && t < q.end); return !c || c.v === 'X'; };
  const STEP = 0.03, runs = [];
  for (let t = 0; t < env.length * HOP; t += STEP) {
    let e = 0; for (let k = 0; k < 3; k++) e = Math.max(e, envAt(env, t + k * HOP));
    const v = inWord(t + STEP / 2) || !restAt(t + STEP / 2) ? null : e > 0.55 ? 'D' : e > 0.3 ? 'C' : e > 0.15 ? 'B' : null;
    const last = runs[runs.length - 1];
    if (v && last && last.v === v && Math.abs(last.end - t) < 1e-6) last.end = t + STEP;
    else if (v) runs.push({ start: t, end: t + STEP, v, src: 'vocal' });
  }
  // only real vocal events (>= 90 ms of sound in a stretch), not clicks
  const groups = [];
  for (const r of runs) { const g = groups[groups.length - 1]; if (g && r.start - g.end < 0.07) { g.end = r.end; g.runs.push(r); } else groups.push({ start: r.start, end: r.end, runs: [r] }); }
  for (const g of groups) if (g.end - g.start >= 0.09) for (const r of g.runs) { cues = insertCue(cues, r); log.vocal++; }
  return cues;
};

export const textOnly = (phones, words, duration) => {
  const cues = [];
  let t = 0;
  for (const p of phones) {
    if (p.start - t > 0.1) cues.push({ start: t, end: p.start, v: 'X', src: 'gap' });
    else if (p.start > t && cues.length) cues[cues.length - 1].end = p.start;
    cues.push({ start: p.start, end: p.end, v: p.v, src: 'text' });
    t = p.end;
  }
  cues.push({ start: t, end: duration, v: 'X', src: 'gap' });
  return cues;
};

// ---------------------------------------------------------------- animation craft -> frames
export const toFrames = (cues, duration, fps, lead) => {
  const n = Math.ceil(duration * fps);
  const f = new Array(n).fill('X');
  for (const c of cues) {
    const a = Math.max(0, Math.round((c.start - lead) * fps)), b = Math.max(a + (c.v === 'A' ? 1 : 0), Math.round((c.end - lead) * fps));
    for (let k = a; k < Math.min(n, b); k++) f[k] = c.v;
  }
  // 1-frame flicker: an isolated non-closure frame takes the neighbour closest in jaw opening
  for (let k = 1; k < n - 1; k++)
    if (f[k] !== f[k - 1] && f[k] !== f[k + 1] && f[k] !== 'A') {
      const prev = f[k - 1], next = f[k + 1];
      if (prev === 'X' && next === 'X') f[k] = 'X';
      else if (prev !== 'A' && next !== 'A') f[k] = Math.abs(OPEN[prev] - OPEN[f[k]]) <= Math.abs(OPEN[next] - OPEN[f[k]]) ? prev : next;
    }
  return f;
};

const runs = (frames, fps) => {
  const out = [];
  frames.forEach((v, k) => { const last = out[out.length - 1]; if (last && last.v === v) last.end = (k + 1) / fps; else out.push({ start: k / fps, end: (k + 1) / fps, v }); });
  return out.map((r) => ({ start: +r.start.toFixed(4), end: +r.end.toFixed(4), v: r.v }));
};

// ---------------------------------------------------------------- main
export async function lipsync({ audio, words: wordsIn, lang = 'en', fps = 30, lead = 0, useRhubarb = true }) {
  const pcm = decode(audio);
  const duration = pcm.length / SR;
  const env = envelope(pcm);
  const words = normalizeWords(wordsIn);
  const phones = words.flatMap((w) => alignWord(w, env));
  const log = { swaps: 0, closures: 0, gated: 0, vocal: 0, mode: '' };
  let acoustic = null;
  if (useRhubarb) {
    const wav = path.join(os.tmpdir(), `rig-${process.pid}-${Date.now()}.wav`);
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-y', '-i', audio, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', wav]);
    try { acoustic = rhubarb(wav, words.map((w) => w.word).join(' '), lang); } finally { fs.rmSync(wav, { force: true }); }
  }
  let cues;
  if (acoustic && words.length) { cues = vocalize(fuse(acoustic, phones, words, env, log), words, env, log); log.mode = 'rhubarb+text'; }
  else if (acoustic) { cues = acoustic; log.mode = 'rhubarb'; }
  else if (words.length) { cues = textOnly(phones, words, duration); log.mode = 'text+energy'; }
  else { // last resort: loudness only (open on voiced 10 ms frames, half-open on the edges)
    cues = Array.from(env, (e, i) => ({ start: i * HOP, end: (i + 1) * HOP, v: e > 0.55 ? 'D' : e > 0.3 ? 'C' : e > 0.15 ? 'B' : 'X' }));
    log.mode = 'energy';
  }
  const frames = toFrames(cues, duration, fps, lead);
  // continuous jaw: attack 1 frame / release ~3 frames, zero on closed shapes
  const open = []; let o = 0;
  for (let k = 0; k < frames.length; k++) {
    const target = frames[k] === 'X' || frames[k] === 'A' ? 0 : Math.max(OPEN[frames[k]], envAt(env, k / fps + lead));
    o += (target - o) * (target > o ? 0.8 : 0.35);
    open.push(+o.toFixed(3));
  }
  const warnings = runs(frames, fps).filter((r) => 'CDE'.includes(r.v) && r.end - r.start > 0.4).map((r) => `held ${r.v} ${r.start.toFixed(2)}-${r.end.toFixed(2)}s`);
  return {
    version: 1, fps, duration: +duration.toFixed(4), lead, lang,
    audio: path.basename(audio), audioSha256: crypto.createHash('sha256').update(fs.readFileSync(audio)).digest('hex'),
    mode: log.mode, fixes: { shapeSwaps: log.swaps, closuresInserted: log.closures, breathsGated: log.gated, vocalCues: log.vocal }, warnings,
    words, cues: runs(frames, fps), frames: frames.join(''), open,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
  const audio = process.argv[2];
  if (!audio) { console.error('usage: lipsync.mjs <audio> [--words w.json | --stt deepgram|openai] [--lang en] [--fps 30] [--lead 0] [--no-rhubarb] [--out t.json]'); process.exit(1); }
  const lang = a('--lang', 'en');
  let words = a('--words') ? JSON.parse(fs.readFileSync(a('--words'), 'utf8')) : null;
  if (!words && a('--stt')) words = await (await import('./stt.mjs')).transcribe(audio, { provider: a('--stt'), lang });
  const track = await lipsync({ audio, words, lang, fps: +a('--fps', 30), lead: +a('--lead', 0), useRhubarb: !process.argv.includes('--no-rhubarb') });
  const out = a('--out', audio.replace(/\.[^.]+$/, '.lipsync.json'));
  fs.writeFileSync(out, JSON.stringify(track));
  console.log(`${out}: ${track.mode}, ${track.cues.length} cues, fixes ${JSON.stringify(track.fixes)}${track.warnings.length ? ', ' + track.warnings.length + ' held-mouth warnings' : ''}`);
}
