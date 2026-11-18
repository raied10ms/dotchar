/**
 * Text -> phonemes -> visemes. Canonical viseme set = Preston-Blair / Rhubarb 9 (X A B C D E F G H).
 * Kept small on purpose: 9 clearly distinct mouths read better on screen than finer 14-mouth sets (tested).
 *
 *   X rest · A M/B/P closed · B teeth (K S T D N EE) · C open (EH AE IH) · D wide (AA)
 *   E round (AO ER OH) · F pucker (UW OW W) · G F/V · H tongue (L TH)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VISEMES = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
/** expected jaw opening per viseme 0..1 (used to align phonemes to the loudness envelope) */
export const OPEN = { X: 0, A: 0, B: 0.25, C: 0.6, D: 1, E: 0.6, F: 0.3, G: 0.2, H: 0.45 };

const ARPA = {
  P: 'A', B: 'A', M: 'A', F: 'G', V: 'G', L: 'H', TH: 'H', DH: 'H',
  AA: 'D', AY: 'D', AW: 'D', AH: 'C', AE: 'C', EH: 'C', EY: 'C', IH: 'C', IY: 'B',
  AO: 'E', OY: 'E', ER: 'E', R: 'E', OW: 'F', UW: 'F', UH: 'F', W: 'F',
  S: 'B', Z: 'B', T: 'B', D: 'B', N: 'B', K: 'B', G: 'B', NG: 'B', Y: 'B', SH: 'B', ZH: 'B', CH: 'B', JH: 'B', HH: 'C',
};
export const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
const STOPS = new Set(['P', 'B', 'T', 'D', 'K', 'G']);

export const arpaToViseme = (p) => {
  const base = p.replace(/[0-9]/g, '');
  if (base === 'AH' && p.endsWith('0')) return 'C'; // schwa: small opening
  return ARPA[base] ?? 'B';
};
/** relative duration prior: vowels long, stops short */
export const durWeight = (p) => (VOWELS.has(p.replace(/[0-9]/g, '')) ? (p.endsWith('0') ? 0.7 : 1.15) : STOPS.has(p) ? 0.5 : 0.65);

// ---------------------------------------------------------------- English: CMUdict (ships with Rhubarb) + letter fallback
let CMU = null;
export const rhubarbDir = () =>
  process.env.RHUBARB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/rhubarb');
const cmu = () => {
  if (CMU) return CMU;
  CMU = new Map();
  const f = path.join(rhubarbDir(), 'res/sphinx/cmudict-en-us.dict');
  if (fs.existsSync(f))
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const [w, ...ph] = line.trim().split(/\s+/);
      if (w && !w.includes('(')) CMU.set(w.toLowerCase(), ph);
    }
  return CMU;
};

const LETTER = [
  [/^th/, ['TH']], [/^sh/, ['SH']], [/^ch/, ['CH']], [/^ph/, ['F']], [/^ng/, ['NG']], [/^ck/, ['K']], [/^qu/, ['K', 'W']],
  [/^oo/, ['UW']], [/^ee/, ['IY']], [/^ea/, ['IY']], [/^ai/, ['EY']], [/^ay/, ['EY']], [/^ou/, ['AW']], [/^ow/, ['OW']], [/^oa/, ['OW']],
  [/^a/, ['AE']], [/^e/, ['EH']], [/^i/, ['IH']], [/^o/, ['AA']], [/^u/, ['AH']], [/^y/, ['Y']],
  [/^b/, ['B']], [/^c/, ['K']], [/^d/, ['D']], [/^f/, ['F']], [/^g/, ['G']], [/^h/, ['HH']], [/^j/, ['JH']], [/^k/, ['K']], [/^l/, ['L']],
  [/^m/, ['M']], [/^n/, ['N']], [/^p/, ['P']], [/^r/, ['R']], [/^s/, ['S']], [/^t/, ['T']], [/^v/, ['V']], [/^w/, ['W']], [/^x/, ['K', 'S']], [/^z/, ['Z']],
];
const letters = (w) => {
  const out = [];
  let s = w.replace(/e$/, ''); // silent final e
  while (s.length) {
    const r = LETTER.find(([re]) => re.test(s));
    if (!r) { s = s.slice(1); continue; }
    out.push(...r[1]);
    s = s.slice(s.match(r[0])[0].length);
  }
  return out;
};

export const englishPhones = (word) => {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return [];
  return cmu().get(w) || cmu().get(w.replace(/'s$/, '')) || letters(w);
};

// ---------------------------------------------------------------- Bangla: grapheme rules (inherent vowel added except word-final / before hasanta)
const BN_CONS = {
  'প': 'P', 'ফ': 'F', 'ব': 'B', 'ভ': 'B', 'ম': 'M', 'ল': 'L', 'থ': 'TH', 'ধ': 'DH',
  'র': 'R', 'ড়': 'R', 'ঢ়': 'R', 'য়': 'Y', 'য': 'JH', 'হ': 'HH',
};
const BN_VOWEL = {
  'অ': 'AO', 'আ': 'AA', 'া': 'AA', 'ই': 'IY', 'ঈ': 'IY', 'ি': 'IY', 'ী': 'IY', 'উ': 'UW', 'ঊ': 'UW', 'ু': 'UW', 'ূ': 'UW',
  'এ': 'EH', 'ে': 'EH', 'ঐ': 'AY', 'ৈ': 'AY', 'ও': 'OW', 'ো': 'OW', 'ঔ': 'OW', 'ৌ': 'OW', 'ঋ': 'R', 'ৃ': 'R',
};
const isBnCons = (c) => /[ক-হড়-য়]/.test(c);
export const banglaPhones = (word) => {
  const cs = [...word.normalize('NFC')];
  const out = [];
  cs.forEach((c, i) => {
    if (BN_VOWEL[c]) return out.push(BN_VOWEL[c]);
    if (!isBnCons(c)) return;
    out.push(BN_CONS[c] ?? 'T');
    const next = cs[i + 1];
    const final = i === cs.length - 1;
    if (!final && next !== '্' && !BN_VOWEL[next] && !/[ংঃঁ]/.test(next || '')) out.push('AO0');
  });
  return out;
};

export const phonesFor = (word) => (/[ঀ-৿]/.test(word) ? banglaPhones(word) : englishPhones(word));
