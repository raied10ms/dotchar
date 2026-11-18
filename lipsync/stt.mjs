/**
 * Word timings from audio. Deepgram (nova-3) or OpenAI Whisper (verbose_json, word granularity).
 * Keys: environment variables, then the repo's .env file (DEEPGRAM_API_KEY / OPENAI_API_KEY).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWords } from './words.mjs';

const key = (name, files) => {
  if (process.env[name]) return process.env[name];
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of files) {
    const p = path.resolve(here, f);
    const m = fs.existsSync(p) && fs.readFileSync(p, 'utf8').match(new RegExp(`^${name}=(\\S+)`, 'm'));
    if (m) return m[1];
  }
  throw new Error(`${name} not found`);
};

export async function transcribe(file, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await once(file, opts); } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function once(file, { provider = 'deepgram', lang = 'en' } = {}) {
  const buf = fs.readFileSync(file);
  if (provider === 'deepgram') {
    const k = key('DEEPGRAM_API_KEY', ['../.env']);
    const res = await fetch(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=${lang}`, {
      method: 'POST', headers: { Authorization: `Token ${k}`, 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    if (!res.ok) throw new Error(`deepgram ${res.status} ${await res.text()}`);
    return normalizeWords(await res.json());
  }
  const k = key('OPENAI_API_KEY', ['../.env']);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(file));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', lang);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: form });
  if (!res.ok) throw new Error(`whisper ${res.status} ${await res.text()}`);
  return normalizeWords(await res.json());
}
