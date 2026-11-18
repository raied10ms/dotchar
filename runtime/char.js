/**
 * Load a character anywhere in the browser (web page, slide, Remotion, headless render).
 *
 *   import { loadChar } from './runtime/char.js';
 *   const bhasha = await loadChar('characters/bhasha.char');   // a .char file (zip)
 *   const x = await loadChar('my-char/char.json');              // or an unpacked folder
 *   const y = await loadChar(fileInput.files[0]);               // or a File / Blob / ArrayBuffer
 *   bhasha.draw(ctx, { pose: 'explain', expr: 'happy', mouth: 'D' }, { x: 540, y: 1800, scale: 1 });
 */
import { Puppet, imagePaths, loadPack } from './puppet.js';
import { readZip } from './zip.js';

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif' };
const cache = new Map();

export async function loadChar(src) {
  const key = typeof src === 'string' ? new URL(src, globalThis.location?.href).href : null;
  if (key && cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (key && /\.json(\?|$)/.test(key)) return loadPack(key);
    const bytes = key ? await (await fetch(key)).arrayBuffer() : src instanceof Blob ? await src.arrayBuffer() : src;
    return fromZip(new Uint8Array(bytes));
  })();
  if (key) cache.set(key, p);
  return p;
}

export async function fromZip(bytes) {
  const files = await readZip(bytes);
  const json = files.get('char.json');
  if (!json) throw new Error('.char has no char.json at its root');
  const pack = JSON.parse(new TextDecoder().decode(json));
  if (pack.format !== 'dotchar') console.warn('char.json: missing format "dotchar" (legacy pack?)');
  if (pack.formatVersion > 1) throw new Error(`.char formatVersion ${pack.formatVersion} is newer than this player (1): update runtime/`);
  const images = {};
  await Promise.all(imagePaths(pack).map(async (p) => {
    const d = files.get(p);
    if (!d) throw new Error(`.char is missing ${p}`);
    const blob = new Blob([d], { type: MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream' });
    images[p] = await createImageBitmap(blob);
  }));
  const puppet = new Puppet(pack, images);
  puppet.files = files; // raw entries (thumbnail, extra assets)
  return puppet;
}
