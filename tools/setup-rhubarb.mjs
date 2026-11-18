#!/usr/bin/env node
/**
 * Downloads the official Rhubarb Lip Sync 1.14.0 release (MIT, github.com/DanielSWolf/rhubarb-lip-sync) into tools/rhubarb/.
 * Rhubarb gives the acoustic mouth timing; its bundled CMU dictionary gives English phonemes.
 * Lip-sync still works without it (text + loudness only), but it looks noticeably worse.
 *   node tools/setup-rhubarb.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../runtime/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, 'rhubarb');
const OS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform];
if (!OS) throw new Error(`no Rhubarb build for ${process.platform}`);
const exe = process.platform === 'win32' ? 'rhubarb.exe' : 'rhubarb';
if (fs.existsSync(path.join(dest, exe))) { console.log(`Rhubarb already installed: ${path.join(dest, exe)}`); process.exit(0); }

const url = `https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.14.0/Rhubarb-Lip-Sync-1.14.0-${OS}.zip`;
console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const files = await readZip(new Uint8Array(await res.arrayBuffer()));
for (const [name, data] of files) {
  const rel = name.split('/').slice(1).join('/'); // drop the top-level "Rhubarb-Lip-Sync-1.14.0-<OS>/" folder
  if (!rel || rel.startsWith('extras/') || rel.startsWith('tests/')) continue;
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}
fs.chmodSync(path.join(dest, exe), 0o755);
if (process.platform === 'darwin') { try { (await import('node:child_process')).execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest]); } catch {} }
console.log(`Rhubarb installed: ${path.join(dest, exe)}`);
