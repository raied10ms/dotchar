#!/usr/bin/env node
/**
 * Voice line with ElevenLabs, plus the word timings lip-sync needs (so no speech-to-text step, and Bangla works).
 *
 *   node tools/tts.mjs "হ্যালো বন্ধুরা!" --voice <voice id> -o line.mp3 [--model eleven_v3] [--lang bn]
 *   -> line.mp3, line.words.json, line.lipsync.json
 * Key: ELEVENLABS_API_KEY (env or repo .env). Audio tags like [cheerful] or [laughs] are spoken as acting, not text.
 * A character's own voice id is in its char.json: meta.voice.id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lipsync } from '../lipsync/lipsync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const text = process.argv[2], voice = arg('--voice'), out = arg('-o', 'line.mp3');
if (!text || !voice) { console.error('usage: tts.mjs "<text>" --voice <id> -o line.mp3 [--model eleven_v3] [--lang bn]'); process.exit(1); }
const key = process.env.ELEVENLABS_API_KEY || (() => {
  const env = path.join(here, '..', '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^ELEVENLABS_API_KEY=(\S+)/m);
  if (!m) { console.error('ELEVENLABS_API_KEY not set (env or .env in the repo root)'); process.exit(1); }
  return m[1];
})();
const model = arg('--model', process.env.ELEVENLABS_MODEL || 'eleven_v3');
const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
  method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: model }) });
if (!res.ok) { console.error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const j = await res.json();
fs.writeFileSync(out, Buffer.from(j.audio_base64, 'base64'));
// characters -> words; drop [audio tags] (they are performed, not pronounced)
const al = j.alignment || j.normalized_alignment, words = []; let cur = null, tag = 0;
al.characters.forEach((c, i) => {
  if (c === '[') tag++;
  const skip = tag > 0; if (c === ']') tag = Math.max(0, tag - 1);
  if (skip || /\s/.test(c)) { if (cur) words.push(cur); cur = null; return; }
  if (!cur) cur = { word: '', start: al.character_start_times_seconds[i] };
  cur.word += c; cur.end = al.character_end_times_seconds[i];
});
if (cur) words.push(cur);
const base = out.replace(/\.[^.]+$/, '');
fs.writeFileSync(`${base}.words.json`, JSON.stringify(words));
const track = await lipsync({ audio: out, words, lang: arg('--lang', 'en') });
fs.writeFileSync(`${base}.lipsync.json`, JSON.stringify(track));
console.log(`-> ${out} (${track.duration}s, ${words.length} words, lip-sync ${track.mode}, ${track.cues.length} mouth changes)`);
