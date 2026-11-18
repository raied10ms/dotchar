/** STT word formats (Deepgram, Whisper, ElevenLabs alignment, plain) -> [{word,start,end}] */
export const normalizeWords = (j) => {
  if (!j) return [];
  if (Array.isArray(j)) return j.map((w) => ({ word: w.word ?? w.text ?? w.punctuated_word, start: +w.start, end: +w.end })).filter((w) => w.word);
  if (j.results?.channels) return normalizeWords(j.results.channels[0].alternatives[0].words); // Deepgram
  if (j.words) return normalizeWords(j.words); // Whisper verbose_json / generic
  if (j.segments) return normalizeWords(j.segments.flatMap((s) => s.words || []));
  if (j.characters && j.character_start_times_seconds) { // ElevenLabs alignment -> words
    const out = []; let cur = null;
    j.characters.forEach((c, i) => {
      if (/\s/.test(c)) { if (cur) out.push(cur); cur = null; return; }
      if (!cur) cur = { word: '', start: j.character_start_times_seconds[i] };
      cur.word += c; cur.end = j.character_end_times_seconds[i];
    });
    if (cur) out.push(cur);
    return out;
  }
  throw new Error('unrecognised words JSON (want Deepgram, Whisper, ElevenLabs alignment or [{word,start,end}])');
};
