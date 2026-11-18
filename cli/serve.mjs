/** Local-only static server: repo files at /, POST /api/lipsync, and (render CLI only) any local file at /__fs/<absolute path>. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.css': 'text/css', '.char': 'application/zip', '.md': 'text/plain; charset=utf-8' };

/** absolute local path -> URL path the server answers */
export const fsUrl = (p) => '/__fs/' + path.resolve(p).split(path.sep).map(encodeURIComponent).join('/').replace(/^\//, '');

const body = (q) => new Promise((ok, err) => { const b = []; q.on('data', (d) => b.push(d)); q.on('end', () => ok(Buffer.concat(b))); q.on('error', err); });

export function startServer(port = 0, host = '127.0.0.1', { localFiles = false } = {}) {
  const srv = http.createServer(async (q, r) => {
    try {
      const u = new URL(q.url, 'http://x');
      if (u.pathname === '/api/ping') return r.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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
