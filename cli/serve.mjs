/** Local-only static server: repo files at /, POST /api/lipsync, and (render CLI only) any local file at /__fs/<absolute path>. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.css': 'text/css', '.char': 'application/zip', '.md': 'text/plain; charset=utf-8' };

/** absolute local path -> URL path the server answers */
export const fsUrl = (p) => '/__fs/' + path.resolve(p).split(path.sep).map(encodeURIComponent).join('/').replace(/^\//, '');

const hasKey = (name) => !!process.env[name] || (fs.existsSync(path.join(ROOT, '.env')) && new RegExp(`^${name}=\\S+`, 'm').test(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')));
const jobDir = (job) => (/^[a-z0-9][a-z0-9-]*$/.test(job || '') ? path.join(ROOT, 'work', job) : null);
const auto = (stage, dir) => { const p = spawn(process.execPath, [path.join(ROOT, 'cli/auto.mjs'), stage, dir], { cwd: ROOT, env: process.env, stdio: 'ignore', detached: true }); p.unref(); };
const json = (r, o, code = 200) => r.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));

const body = (q) => new Promise((ok, err) => { const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => ok(Buffer.concat(b))); q.on('error', err); });

export function startServer(port = 0, host = '127.0.0.1', { localFiles = false } = {}) {
  const srv = http.createServer(async (q, r) => {
    try {
      const u = new URL(q.url, 'http://x');
      if (u.pathname === '/api/ping') return json(r, { ok: true, openai: hasKey('OPENAI_API_KEY'), stt: hasKey('DEEPGRAM_API_KEY') ? 'deepgram' : hasKey('OPENAI_API_KEY') ? 'openai' : null });
      // ---- photos -> character (cli/auto.mjs). Progress: GET /work/<job>/status.json
      if (q.method === 'POST' && u.pathname === '/api/auto/new') {
        const b = JSON.parse((await body(q)).toString('utf8'));
        if (!b.name || !b.photos?.length) return json(r, { error: 'name and at least one photo are required' }, 400);
        const id = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';
        const job = `${id}-${Date.now().toString(36)}`, dir = jobDir(job);
        fs.mkdirSync(path.join(dir, 'ref'), { recursive: true });
        const refs = b.photos.slice(0, 6).map((d, i) => { const m = d.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/); if (!m) throw new Error('photos must be PNG, JPEG or WebP'); const f = `ref/photo-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`; fs.writeFileSync(path.join(dir, f), Buffer.from(m[2], 'base64')); return f; });
        fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ id, name: b.name, refs, likeness: { outfit: b.outfit || '' }, identity: b.notes || '', style: b.style || undefined,
          lipsSet: b.lipsSet || 'female', poses: b.poses || 'quick', mouths: b.mouths || 'drawn' }, null, 1));
        auto('master', dir);
        return json(r, { job });
      }
      if (q.method === 'POST' && u.pathname === '/api/auto/go') {
        const dir = jobDir(u.searchParams.get('job')), step = u.searchParams.get('step');
        if (!dir || !fs.existsSync(dir) || !['master', 'rest'].includes(step)) return json(r, { error: 'unknown job or step' }, 400);
        const note = (await body(q)).toString('utf8').slice(0, 400);
        if (step === 'master' && note) { const f = path.join(dir, 'character.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); c.identity = note; fs.writeFileSync(f, JSON.stringify(c, null, 1)); }
        auto(step, dir);
        return json(r, { ok: true });
      }
      if (q.method === 'POST' && u.pathname === '/api/auto/publish') {
        const dir = jobDir(u.searchParams.get('job'));
        const st = dir && fs.existsSync(path.join(dir, 'status.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
        if (!st?.done) return json(r, { error: 'job not finished' }, 400);
        fs.copyFileSync(path.join(dir, st.char), path.join(ROOT, 'characters', st.char));
        await new Promise((ok) => spawn(process.execPath, [path.join(ROOT, 'cli/char.mjs'), 'list'], { cwd: ROOT, stdio: 'ignore' }).on('close', ok));
        return json(r, { ok: true, file: `characters/${st.char}` });
      }
      if (u.pathname === '/') return r.writeHead(302, { location: '/studio/' }).end();
      if (q.method === 'POST' && u.pathname === '/api/lipsync') {
        // body = raw audio; ?ext=mp3&lang=en&stt=deepgram|openai|none ; optional header x-words = JSON words (base64)
        const tmp = path.join(os.tmpdir(), `dotchar-${Date.now()}.${(u.searchParams.get('ext') || 'mp3').replace(/\W/g, '')}`);
        fs.writeFileSync(tmp, await body(q));
        try {
          const { lipsync } = await import('../lipsync/lipsync.mjs');
          const lang = u.searchParams.get('lang') || 'en', stt = u.searchParams.get('stt') || 'none';
          let words = q.headers['x-words'] ? JSON.parse(Buffer.from(q.headers['x-words'], 'base64').toString('utf8')) : null;
          let note = '';
          if (!words && stt !== 'none') {
            try { words = await (await import('../lipsync/stt.mjs')).transcribe(tmp, { provider: stt, lang }); }
            catch (e) { note = `STT skipped (${e.message.slice(0, 80)})`; }
          }
          const track = await lipsync({ audio: tmp, words, lang });
          r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...track, note }));
        } finally { fs.rmSync(tmp, { force: true }); }
        return;
      }
      let f;
      if (u.pathname.startsWith('/__fs/')) {
        if (!localFiles) return r.writeHead(403).end();
        f = decodeURIComponent(u.pathname.slice(5));
        if (process.platform === 'win32') f = f.slice(1);
      } else {
        f = path.join(ROOT, decodeURIComponent(u.pathname));
        if (!f.startsWith(ROOT)) return r.writeHead(403).end();
        if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      }
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end('not found');
      r.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(f).pipe(r);
    } catch (e) { r.writeHead(500, { 'content-type': 'text/plain' }).end(String(e.message || e)); }
  });
  return new Promise((ok) => srv.listen(port, host, () => ok(srv)));
}
