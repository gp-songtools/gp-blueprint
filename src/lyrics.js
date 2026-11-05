// Lyric counting and section helpers (no React). The app counts lines and
// syllables itself so pasted-lyric structures are exact, not model guesses.

// English syllables by rule. Sung words can stretch or squeeze, so expect an occasional ±1.
const SYL_EXCEPTIONS = { every: 2, everyone: 3, everything: 3, everybody: 4, idea: 3, ideas: 3, quiet: 2, poem: 2, poems: 2, cruel: 2, fuel: 2, being: 2, area: 3, real: 1, really: 2, hour: 1, hours: 1, our: 1, fire: 1, fires: 1, desire: 2, tired: 1, lyric: 2, maybe: 2, someone: 2, sometimes: 2, somewhere: 2, something: 2, anyone: 3, forever: 3, heaven: 2, evening: 2, family: 3, different: 2, business: 2, chocolate: 2, interest: 2, beautiful: 3, wanna: 2, gonna: 2, gotta: 2, cause: 1, oh: 1, ooh: 1, yeah: 1, lion: 2, lions: 2, diamond: 2, diamonds: 2, violin: 3, riot: 2 };

export function countSyllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (SYL_EXCEPTIONS[w]) return SYL_EXCEPTIONS[w];
  if (w.length <= 3) return 1;
  w = w.replace(/([^aeiouy])e(ly|less|ful|ment|ness)$/, '$1$2'); // lone-ly, care-ful
  let bonus = 0;
  if (/[aeiouy]ing$/.test(w)) bonus++; // go-ing, cry-ing, play-ing
  if (/[^tscgl]i[ao]/.test(w)) bonus++; // ra-di-o, di-a-mond (not -tion, -sion)
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) w = w.slice(0, -1); // silent e (keep -le: lit-tle)
  else if (/[^aeiouytd]ed$/.test(w)) w = w.slice(0, -2); // walked, loved (not want-ed)
  else if (/[^aeiouysxzhcg]es$/.test(w)) w = w.slice(0, -2); // hopes, times (not box-es, pla-ces)
  w = w.replace(/^y/, '');
  return Math.max(1, (w.match(/[aeiouy]+/g) || []).length + bonus);
}

export const countLine = (line) => line.split(/[\s\-–—/]+/).reduce((n, w) => n + countSyllables(w), 0);
const lastWord = (line) => (line.match(/[A-Za-z'’]+(?=[^A-Za-z'’]*$)/) || [''])[0].toLowerCase();

// Split lyrics into blocks at blank lines and section headers like [Chorus] or "Verse 2:".
const HEADER = /^\s*(\[[^\]]+\]|\(?\s*(intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|hook|refrain|outro|breakdown|interlude|instrumental|solo|tag|coda)\b[^)]*\)?\s*:?)\s*$/i;

export function splitBlocks(text) {
  const blocks = [];
  let cur = null;
  const close = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (const raw of (text || '').split('\n')) {
    const t = raw.trim();
    if (HEADER.test(t)) { close(); cur = { name: t.replace(/^[[(\s]+|[\])\s:]+$/g, '').split(/\s+-\s+/)[0], lines: [] }; continue; }
    if (!t) { if (cur && cur.lines.length) close(); continue; }
    if (!cur) cur = { name: '', lines: [] };
    cur.lines.push(t);
  }
  close();
  return blocks.map((b) => ({ ...b, syl: b.lines.map(countLine), ends: b.lines.map(lastWord) }));
}

/** Put the app's own counts on the sections Gemini tagged with a block number (#1, #2...). */
export function applyCounts(sections, blocks) {
  if (!blocks.length) return sections;
  let next = 0;
  return sections.map((s) => {
    const ref = /^#\s*(\d+)/.exec(s.linesRaw || '');
    let b = ref ? blocks[Number(ref[1]) - 1] : null;
    if (!ref && s.lines > 0 && blocks[next]) b = blocks[next]; // no tag: match sung sections in order
    if (!b) return s;
    next = blocks.indexOf(b) + 1;
    return { ...s, lines: b.lines.length, meter: b.syl.join('.'), counted: b };
  });
}

/** One Suno header per section: [NAME: style hints], built from the section's tag. */
export function sectionHeader(s) {
  const tag = (s.tags || '').trim().replace(/^\[|\]$/g, '').trim();
  const sname = (s.name || '').trim();
  let hints = tag;
  let found = sname;
  if (sname && tag.toLowerCase().startsWith(sname.toLowerCase())) {
    hints = tag.slice(sname.length).replace(/^\s*(?::|[-–—])\s*/, ''); // "[Pre-Chorus - x]" or "[Pre-Chorus: x]"
  } else {
    const m = /^([^:]{1,40}?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(tag); // a differently worded name
    if (m) { hints = m[2]; found = sname || m[1]; }
  }
  hints = hints.trim();
  const name = (found || 'Section').toUpperCase();
  return hints ? `[${name}: ${hints}]` : `[${name}]`;
}

/** How well the generated lyrics follow the target meter. */
export function meterCheck(sections, lyrics) {
  const targets = sections.filter((s) => s.lines > 0 && /^\d+(\.\d+)*$/.test(s.meter));
  if (!targets.length || !lyrics) return '';
  const written = splitBlocks(lyrics);
  let within = 0;
  let total = 0;
  let lineMismatch = 0;
  targets.forEach((s, i) => {
    const w = written[i];
    if (!w) return;
    const want = s.meter.split('.').map(Number);
    if (w.lines.length !== s.lines) lineMismatch++;
    want.forEach((n, k) => { if (k < w.syl.length) { total++; if (Math.abs(w.syl[k] - n) <= 1) within++; } });
  });
  if (!total) return '';
  return `Meter check: ${within} of ${total} lines within one syllable of the target`
    + (lineMismatch ? ` · ${lineMismatch} section${lineMismatch > 1 ? 's have' : ' has'} a different line count` : '');
}

export const formatDuration = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;

/** The structure as plain text, for copying. */
export function formatStructure({ bpm, key, sections = [] }) {
  const head = [bpm && `${bpm} BPM`, key].filter(Boolean).join(', ');
  return (head ? `${head}\n\n` : '') + sections.map((s) => [
    sectionHeader(s),
    (s.lines > 0
      ? `${s.bars} bars (${s.seconds} secs / ${s.lines} lines). ${s.rhyme} ${s.meter}`
      : `${s.bars} bars (${s.seconds} secs, instrumental)`) + (s.description ? ` - ${s.description}` : ''),
  ].join('\n')).join('\n\n');
}
