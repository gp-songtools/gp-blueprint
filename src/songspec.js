/* songspec v1.0.1 — the GP Song Tools song spec: parse, edit, validate, share.
 * Canonical copy: gp-songtools/toolsmenu/songspec/songspec.js. Tools keep a byte-identical
 * copy; never edit a copy, change this file and copy it again. Format: songspec/SPEC.md.
 * No dependencies. Works as a classic <script> (global SongSpec), an ES/CommonJS import, and
 * from Node: `node songspec.js validate file.songspec.md` | `show file section` | `status file`.
 *
 * Rules this file guarantees:
 * - parse() never throws and serialize(parse(text)) === text, byte for byte.
 * - A write replaces only the owned section or setting line; every other byte stays put.
 * - A tool can write only what it owns (setSection/setSetting throw otherwise). The one
 *   exception is clearSection/newSong, which run only on the person's click.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SongSpec = api; // also global, so browser scripts, ES modules and Node all find it the same way
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.1';
  const SCHEMA_VERSION = 1;
  const PERSON = 'person';

  // Body sections in canonical order. `owner` is the tool id allowed to write it.
  const SECTIONS = [
    { id: 'idea', heading: 'Idea', owner: 'ideawizard' },
    { id: 'idea-structure', heading: 'Idea structure', owner: 'ideawizard' },
    { id: 'reference', heading: 'Reference (never send to Suno)', owner: 'gp-blueprint', match: /^reference\b/i },
    { id: 'analysis', heading: 'Analysis', owner: 'earprint' },
    { id: 'style', heading: 'Style', owner: 'gp-blueprint', max: 1000 },
    { id: 'negative-style', heading: 'Negative style', owner: PERSON, max: 1000 },
    { id: 'structure', heading: 'Structure', owner: 'gp-blueprint' },
    { id: 'stems', heading: 'Stems', owner: 'gp-blueprint' },
    { id: 'lyrics', heading: 'Lyrics', owner: 'lyricpad', max: 5000 },
    { id: 'sound', heading: 'Sound', owner: PERSON, max: 500 },
    { id: 'notes', heading: 'Notes', owner: PERSON },
  ];
  const SEC = Object.fromEntries(SECTIONS.map((s, i) => [s.id, { ...s, index: i }]));

  // Frontmatter settings in canonical order. `owner` may be a list (shared keys).
  const SETTINGS = [
    { key: 'schema_version', owner: '*' },
    { key: 'request', owner: PERSON, values: ['song', 'cover', 'sound'] },
    { key: 'title', owner: 'lyricpad', max: 256 },
    { key: 'model', owner: PERSON, values: ['v6-mini', 'v6', 'v6-wild'] },
    { key: 'instrumental', owner: PERSON, bool: true },
    { key: 'voice_id', owner: PERSON },
    { key: 'vocal_gender', owner: PERSON, values: ['male', 'female'] },
    { key: 'weirdness', owner: PERSON, range: [0, 1] },
    { key: 'style_influence', owner: PERSON, range: [0, 1] },
    { key: 'variety', owner: PERSON, range: [0, 4], int: true },
    { key: 'audio_influence', owner: PERSON, range: [0, 1] },
    { key: 'duration', owner: PERSON, range: [15, 360], int: true },
    { key: 'max_mode', owner: PERSON, bool: true },
    { key: 'cover_source', owner: PERSON },
    { key: 'loop', owner: PERSON, bool: true },
    { key: 'bpm', owner: ['gp-blueprint', 'earprint'], range: [1, 300], int: true },
    { key: 'key', owner: ['gp-blueprint', 'earprint'] },
    { key: 'bpm_key_by', owner: ['gp-blueprint', 'earprint'] },
  ];
  const SET = Object.fromEntries(SETTINGS.map((s, i) => [s.key, { ...s, index: i }]));

  const TOOL_NAMES = {
    'gp-blueprint': 'GP Blueprint', lyricpad: 'Lyricpad', ideawizard: 'Idea Wizard', earprint: 'Earprint',
    'auralyrics-studio': 'AuraLyrics Studio', 'gp-randomash': 'Randomash', 'gp-master': 'GP Mastering',
    person: 'you', claude: 'Claude',
  };
  const toolName = (id) => TOOL_NAMES[id] || id || 'unknown';

  // ---------- low-level text helpers ----------

  const splitLines = (text) => (text ? text.match(/[^\n]*\n|[^\n]+$/g) : []); // each keeps its "\n"
  const strip = (line) => line.replace(/\r?\n$/, '');
  const HEAD_RE = /^## (.*?)\s*$/;
  const MARK_RE = /^<!--\s*song-spec:(.*?)-->\s*$/;
  const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(?:\s(.*)|)$/;

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Buffer.from(str, 'utf8'); // very old Node only
  }

  /** Text as compared and hashed: LF endings, no trailing spaces, no blank lines at either end. */
  function normalize(body) {
    return String(body || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
      .join('\n').replace(/^\n+|\n+$/g, '');
  }

  /** FNV-1a 32-bit over the UTF-8 bytes of normalize(body); 8 hex digits. */
  function hash(body) {
    let h = 0x811c9dc5;
    for (const b of utf8(normalize(body))) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  const nowStamp = () => new Date().toISOString().slice(0, 16) + 'Z';

  function unquote(v) {
    v = v.trim();
    if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { /* keep as is */ } }
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  }
  function quote(v) {
    v = String(v ?? '');
    return /^[\s"'[\]{}>|*&!%@`#,?-]|: | #|\s$|\n/.test(v) ? JSON.stringify(v) : v;
  }

  function sectionIdFor(heading) {
    const h = heading.trim();
    for (const s of SECTIONS) {
      if (s.match ? s.match.test(h) : h.toLowerCase() === s.heading.toLowerCase()) return s.id;
    }
    return null;
  }

  // ---------- parse / serialize ----------

  /**
   * Parse a song spec. Never throws. The document keeps every original line:
   * doc.fm = { open, items:[{line, key?}], close } | null, doc.pre = [lines], doc.sections = [
   *   { id|null, heading, head: line, lines: [body lines incl. marker] } ].
   */
  function parse(text) {
    text = String(text ?? '');
    const lines = splitLines(text);
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    let i = 0;
    let fm = null;
    if (lines.length && strip(lines[0]) === '---') {
      const end = lines.findIndex((l, k) => k > 0 && strip(l) === '---');
      if (end > 0) {
        fm = { open: lines[0], items: lines.slice(1, end).map((line) => {
          const m = KEY_RE.exec(strip(line));
          return m ? { line, key: m[1] } : { line };
        }), close: lines[end] };
        i = end + 1;
      }
    }
    const pre = [];
    const sections = [];
    let cur = null;
    for (; i < lines.length; i++) {
      const m = HEAD_RE.exec(strip(lines[i]));
      if (m) {
        cur = { id: sectionIdFor(m[1]), heading: m[1], head: lines[i], lines: [] };
        sections.push(cur);
      } else (cur ? cur.lines : pre).push(lines[i]);
    }
    return { fm, pre, sections, eol };
  }

  function serialize(doc) {
    let out = '';
    if (doc.fm) out += doc.fm.open + doc.fm.items.map((x) => x.line).join('') + doc.fm.close;
    out += doc.pre.join('');
    for (const s of doc.sections) out += (s.pad || []).join('') + s.head + s.lines.join('');
    return out;
  }

  /** A new, empty spec. */
  function create() {
    return `---\nschema_version: ${SCHEMA_VERSION}\n---\n\n# Song spec\n`;
  }

  // ---------- reading ----------

  function parseMarker(line) {
    const m = MARK_RE.exec(strip(line || ''));
    if (!m) return null;
    const attrs = {};
    for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
      const k = tok.indexOf('=');
      if (k > 0) attrs[tok.slice(0, k)] = tok.slice(k + 1);
    }
    const from = {};
    for (const pair of (attrs.from || '').split(',').filter(Boolean)) {
      const [id, h] = pair.split(':');
      if (id && h) from[id] = h;
    }
    return { by: attrs.by || '', at: attrs.at || '', hash: attrs.hash || '', from, manual: attrs.manual === 'yes', attrs };
  }

  function rawSection(doc, id) {
    return doc.sections.find((s) => s.id === id) || null;
  }

  function splitBody(sec) {
    const first = sec.lines.findIndex((l) => strip(l).trim() !== '');
    const marker = first >= 0 ? parseMarker(sec.lines[first]) : null;
    const bodyLines = marker ? sec.lines.slice(first + 1) : sec.lines;
    return { marker, body: normalize(bodyLines.join('')) };
  }

  /**
   * One section, or null when it is missing or empty ("not available").
   * Returns { id, heading, body, hash, by, at, marker, manual, edited, stale:[{id, reason}] }.
   * edited: has text but no marker, or the text changed since the tool wrote it.
   */
  function section(doc, id) {
    const sec = rawSection(doc, id);
    if (!sec) return null;
    const { marker, body } = splitBody(sec);
    if (!body) return null;
    const h = hash(body);
    const stale = [];
    for (const [src, was] of Object.entries(marker?.from || {})) {
      const now = rawSection(doc, src) && splitBody(rawSection(doc, src)).body;
      if (!now) stale.push({ id: src, reason: 'removed' });
      else if (hash(now) !== was) stale.push({ id: src, reason: 'changed' });
    }
    return {
      id, heading: sec.heading.trim(), body, hash: h, marker,
      by: marker?.by || '', at: marker?.at || '', manual: !!marker?.manual,
      edited: !marker || (!!marker.hash && marker.hash !== h),
      stale,
    };
  }

  /** A setting's value ('' when missing or empty). */
  function setting(doc, key) {
    const it = doc.fm?.items.find((x) => x.key === key);
    if (!it) return '';
    return unquote(KEY_RE.exec(strip(it.line))[2] || '');
  }

  /** All settings present, as {key: value}. */
  function settings(doc) {
    const out = {};
    for (const it of doc.fm?.items || []) if (it.key && !(it.key in out)) out[it.key] = setting(doc, it.key);
    return out;
  }

  /**
   * Why a tool should ask before overwriting this section, or '' when it may just write.
   * Asks when you locked it (manual=yes), edited it by hand, or another writer put it there.
   */
  function confirmReason(doc, id, by) {
    const s = section(doc, id);
    if (!s) return '';
    const name = SEC[id]?.heading || id;
    if (s.manual) return `${name} is marked as edited by hand (manual=yes).`;
    if (!s.marker) return `${name} has text that no tool wrote (typed or pasted by hand).`;
    if (s.edited) return `${name} was changed by hand after ${toolName(s.by)} wrote it.`;
    if (s.by && by && s.by !== by) return `${name} was written by ${toolName(s.by)}.`;
    return '';
  }

  /** One line per stale source, e.g. "Idea structure is based on an older Structure." */
  function staleNotes(doc, id) {
    const s = section(doc, id);
    if (!s) return [];
    const name = SEC[id]?.heading || id;
    return s.stale.map((x) => {
      const src = SEC[x.id]?.heading || x.id;
      return x.reason === 'removed'
        ? `${name} was made from ${src}, which has since been cleared.`
        : `${name} is based on an older ${src}.`;
    });
  }

  /**
   * Which structure to use: the newest non-stale of Structure (GP Blueprint) and Idea structure
   * (Idea Wizard). Returns { id|null, options:[section info], note }. A person can override.
   */
  function pickStructure(doc) {
    const IDS = ['idea-structure', 'structure'];
    const opts = IDS.map((id) => section(doc, id)).filter(Boolean);
    if (!opts.length) return { id: null, options: [], note: '' };
    // Only a change in the other structure makes one out of date here (not, say, a new Analysis).
    const outdated = (o) => o.stale.some((x) => IDS.includes(x.id));
    const fresh = opts.filter((o) => !outdated(o));
    const pool = (fresh.length ? fresh : opts).slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')); // ISO stamps sort as text
    const pick = pool[0];
    const when = (o) => (o.at ? ', ' + o.at.replace('T', ' ').replace('Z', ' UTC') : '');
    let note = `Using ${pick.heading} (${toolName(pick.by)}${when(pick)}).`;
    const other = opts.find((o) => o !== pick);
    if (other) {
      note += outdated(other)
        ? ` ${other.heading} (${toolName(other.by)}) is based on an older ${SEC[other.stale.find((x) => IDS.includes(x.id)).id].heading}.`
        : ` ${other.heading} (${toolName(other.by)}${when(other)}) is older.`;
    }
    return { id: pick.id, options: opts, note };
  }

  // ---------- writing ----------

  function owns(owner, by) {
    if (owner === '*') return true;
    return Array.isArray(owner) ? owner.includes(by) : owner === by;
  }

  function ensureFm(doc) {
    if (!doc.fm) {
      const e = doc.eol;
      doc.fm = { open: '---' + e, items: [], close: '---' + e };
      if (doc.pre.length || doc.sections.length) doc.pre.unshift(e);
    }
    if (!doc.fm.items.some((x) => x.key === 'schema_version')) {
      doc.fm.items.unshift({ line: `schema_version: ${SCHEMA_VERSION}${doc.eol}`, key: 'schema_version' });
    }
  }

  function writeLine(doc, key, value) {
    ensureFm(doc);
    const line = `${key}: ${quote(value)}`.replace(/ $/, '') + doc.eol;
    const it = doc.fm.items.find((x) => x.key === key);
    if (it) { it.line = line; return; }
    const idx = SET[key]?.index ?? Infinity;
    let at = idx === Infinity ? doc.fm.items.length : 0; // after the last known key that comes before it
    if (idx !== Infinity) doc.fm.items.forEach((x, k) => { if (x.key && SET[x.key] && SET[x.key].index < idx) at = k + 1; });
    doc.fm.items.splice(at, 0, { line, key });
  }

  /** Write a setting this tool owns. Throws if it doesn't own the key. */
  function setSetting(doc, key, value, { by } = {}) {
    const def = SET[key];
    if (!def || !owns(def.owner, by)) throw new Error(`${toolName(by)} can't write the setting "${key}".`);
    writeLine(doc, key, value);
    return doc;
  }

  function sectionLines(doc, id, body, marker) {
    const e = doc.eol;
    const head = `## ${SEC[id].heading}${e}`;
    const lines = [];
    if (marker) lines.push(marker + e);
    const text = normalize(body);
    if (text) for (const l of text.split('\n')) lines.push(l + e);
    lines.push(e);
    return { head, lines };
  }

  function placeSection(doc, id, chunk) {
    const sec = rawSection(doc, id);
    if (sec) { sec.lines = chunk.lines; return; } // keep the existing heading line as written
    const idx = SEC[id].index;
    const e = doc.eol;
    let at = doc.sections.length;
    for (let k = 0; k < doc.sections.length; k++) {
      const sid = doc.sections[k].id;
      if (sid && SEC[sid].index > idx) { at = k; break; }
    }
    // Separate it from whatever comes before with a blank line, carried by the new section
    // (`pad`), so the section before it stays byte for byte as it was.
    const prev = at > 0 ? doc.sections[at - 1].lines : doc.pre;
    const last = prev.length ? prev[prev.length - 1] : at > 0 ? doc.sections[at - 1].head : null; // heading-only section
    const pad = [];
    if (last !== null && !/\n$/.test(last)) pad.push(e);
    if (last !== null && strip(last).trim() !== '') pad.push(e);
    if (at === 0 && !doc.sections.length && !doc.pre.some((l) => l.trim())) doc.pre.push(e, `# Song spec${e}`, e);
    doc.sections.splice(at, 0, { id, heading: SEC[id].heading, head: chunk.head, lines: chunk.lines, pad });
  }

  /**
   * Write a section this tool owns. `from` lists the section ids the result was made from;
   * their current hashes go into the marker so a later change shows as "out of date".
   * Throws if `by` doesn't own the section. Does NOT ask: call confirmReason() first.
   */
  function setSection(doc, id, body, { by, from = [], at } = {}) {
    const def = SEC[id];
    if (!def || !owns(def.owner, by)) throw new Error(`${toolName(by)} can't write the ${def ? def.heading : id} section.`);
    ensureFm(doc);
    const fromStr = (Array.isArray(from) ? from : Object.keys(from))
      .map((src) => { const s = section(doc, src); return s ? `${src}:${s.hash}` : null; })
      .filter(Boolean).join(',');
    const text = normalize(body);
    const marker = text ? `<!-- song-spec: by=${by} at=${at || nowStamp()} hash=${hash(text)}${fromStr ? ' from=' + fromStr : ''} -->` : '';
    placeSection(doc, id, sectionLines(doc, id, text, marker));
    return doc;
  }

  /** Empty a section (any section). Only on the person's explicit click. Keeps the heading. */
  function clearSection(doc, id) {
    const sec = rawSection(doc, id);
    if (sec) sec.lines = [doc.eol];
    return doc;
  }

  /** Empty every section and every tool-written setting; keeps your own settings. Person only. */
  function newSong(doc) {
    for (const s of doc.sections) s.lines = [doc.eol];
    if (doc.fm) doc.fm.items = doc.fm.items.filter((x) => !x.key || !SET[x.key] || SET[x.key].owner === PERSON || x.key === 'schema_version');
    return doc;
  }

  // ---------- validation ----------

  const BOOL = ['true', 'false'];
  const codepoints = (s) => [...s].length;

  /** [{level:'error'|'warning', field, message}] */
  function validate(doc) {
    const out = [];
    const err = (field, message) => out.push({ level: 'error', field, message });
    const warn = (field, message) => out.push({ level: 'warning', field, message });

    if (!doc.fm) err('schema_version', 'The file has no settings block (--- lines at the top) with schema_version: 1.');
    const sv = setting(doc, 'schema_version');
    if (doc.fm && sv !== String(SCHEMA_VERSION)) err('schema_version', `schema_version must be ${SCHEMA_VERSION} (found '${sv}').`);

    const seenKeys = {};
    for (const it of doc.fm?.items || []) {
      if (!it.key) continue;
      if (seenKeys[it.key]) err(it.key, `The setting "${it.key}" appears twice.`);
      seenKeys[it.key] = 1;
      if (!SET[it.key]) warn(it.key, `Unknown setting "${it.key}" (kept as is).`);
    }
    for (const def of SETTINGS) {
      const v = setting(doc, def.key);
      if (v === '' || def.key === 'schema_version') continue;
      if (def.max && codepoints(v) > def.max) err(def.key, `${def.key} is ${codepoints(v)} characters; Suno allows ${def.max}.`);
      if (def.values && !def.values.includes(v)) err(def.key, `${def.key} must be one of ${def.values.join(', ')} (found '${v}').`);
      if (def.bool && !BOOL.includes(v)) err(def.key, `${def.key} must be true or false (found '${v}').`);
      if (def.range) {
        const n = Number(v);
        const [lo, hi] = def.range;
        if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(v) || n < lo || n > hi || (def.int && !Number.isInteger(n))) {
          err(def.key, `${def.key} must be ${def.int ? 'a whole number' : 'a number'} from ${lo} to ${hi} (found '${v}').`);
        }
      }
    }
    const S = (k) => setting(doc, k);
    if (S('vocal_gender') && S('voice_id')) err('vocal_gender', 'vocal_gender can\'t be used with voice_id: the voice already has one.');
    if (S('audio_influence') && S('request') !== 'cover' && !S('voice_id')) err('audio_influence', 'audio_influence on a new song needs voice_id.');
    if (S('request') === 'cover' && !S('cover_source')) err('cover_source', 'request: cover needs cover_source (the Suno clip id to cover).');
    if (S('voice_id') && S('instrumental') === 'true') warn('voice_id', 'voice_id is set with instrumental: true; a voice always sings.');

    const seenSec = {};
    for (const s of doc.sections) {
      if (!s.id) { warn(s.heading, `Unknown section "${s.heading.trim()}" (kept as is).`); continue; }
      if (seenSec[s.id]) err(s.id, `The section "${SEC[s.id].heading}" appears twice.`);
      seenSec[s.id] = 1;
    }
    for (const def of SECTIONS) {
      const s = section(doc, def.id);
      if (!s) continue;
      if (def.max && codepoints(s.body) > def.max) {
        err(def.id, `${def.heading} is ${codepoints(s.body)} characters; Suno allows ${def.max}. Cut ${codepoints(s.body) - def.max}.`);
      }
      for (const n of staleNotes(doc, def.id)) warn(def.id, n);
    }
    const lyr = section(doc, 'lyrics');
    if (lyr) {
      if (S('instrumental') === 'true') err('lyrics', 'instrumental is true but Lyrics has text. Clear one of them.');
      if (!/^\s*\[[^\]]+\]/m.test(lyr.body)) warn('lyrics', 'Lyrics has no [Verse] / [Chorus] section tags.');
    }
    if (section(doc, 'negative-style') && !section(doc, 'style')) err('negative-style', 'Negative style needs a Style: Suno rejects it otherwise.');
    if (S('request') === 'sound' && !section(doc, 'sound')) err('sound', 'request: sound needs a Sound section (up to 500 characters).');
    return out;
  }

  /** One row per known section, for a status panel. */
  function summary(doc) {
    return SECTIONS.map((def) => {
      const s = section(doc, def.id);
      return {
        id: def.id, heading: def.heading, owner: def.owner, present: !!s,
        by: s?.by || '', at: s?.at || '', edited: !!s?.edited, manual: !!s?.manual,
        stale: s ? staleNotes(doc, def.id) : [], chars: s ? codepoints(s.body) : 0,
      };
    });
  }

  // ---------- the shared browser copy (all tools share the gp-songtools.github.io origin) ----------

  const STORE_KEY = 'gpsongtools.songspec.v1';
  const store = {
    key: STORE_KEY,
    /** The current spec text, or '' (none yet, or storage blocked). */
    load() { try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } },
    /** Save text; returns false when storage is blocked or full. */
    save(text) {
      try { localStorage.setItem(STORE_KEY, text); } catch { return false; }
      // The browser tells other tabs; tell this one too (panels and readers in the same page).
      try { window.dispatchEvent(new CustomEvent('songspec-change', { detail: text })); } catch { /* not a browser */ }
      return true;
    },
    /**
     * Read the newest copy, let fn change it, save. Always re-reads first, so two tabs never
     * overwrite each other's sections. Returns the changed doc.
     */
    update(fn) {
      const doc = parse(store.load() || create());
      fn(doc);
      store.save(serialize(doc));
      return doc;
    },
    /** Call cb(text) whenever the spec changes, in this tab or another. Returns an unsubscribe function. */
    onChange(cb) {
      if (typeof window === 'undefined') return () => {};
      const h = (e) => { if (e.key === STORE_KEY) cb(e.newValue || ''); };
      const here = (e) => cb(e.detail || '');
      window.addEventListener('storage', h);
      window.addEventListener('songspec-change', here);
      return () => { window.removeEventListener('storage', h); window.removeEventListener('songspec-change', here); };
    },
  };

  /** A file name from the title: "Paper Lanterns" -> "paper-lanterns.songspec.md". */
  function fileName(doc) {
    const t = setting(doc, 'title') || section(doc, 'idea')?.body.match(/^Title:\s*(.+)$/m)?.[1] || 'song';
    return (t.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60) || 'song') + '.songspec.md';
  }

  /** Browser only: download text as a file. */
  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Remove [section tags] and tag-only lines, for tools that show sung lines only. */
  function stripTags(lyrics) {
    return normalize(String(lyrics || '').split('\n').map((l) => l.replace(/\[[^\]]*\]/g, '').replace(/\s+$/, ''))
      .filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).join('\n'));
  }

  // ---------- the song spec panel (same in every tool; plain DOM, inherits the page's look) ----------

  const PANEL_CSS = `.ssp{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:10px;padding:.5rem .75rem;margin:.75rem 0;font-size:.9em}
.ssp summary{cursor:pointer;font-weight:600}.ssp p{margin:.4rem 0;opacity:.8}.ssp .ssp-row{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0}
.ssp button{font:inherit;font-size:.9em;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:6px;padding:.2rem .6rem;cursor:pointer}
.ssp button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.ssp ul{list-style:none;margin:.25rem 0;padding:0}
.ssp li{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .6rem;padding:.25rem 0;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.ssp .ssp-h{font-weight:600;min-width:9rem}.ssp .ssp-m{opacity:.75;flex:1;min-width:10rem}.ssp .ssp-w{color:#c77700}.ssp .ssp-e{color:#d33}`;

  /**
   * Show the shared song spec in `el`: Open, Download, Copy, New song, and each section with who
   * wrote it, when, whether it is out of date or edited by hand, and Clear. Clearing and New song
   * run only on the person's click, after confirming. `onChange(doc)` runs after any change,
   * including ones made in another tab. Returns { refresh, destroy }.
   */
  function mountPanel(el, { onChange, open = false } = {}) {
    if (!document.getElementById('ssp-css')) {
      const st = document.createElement('style'); st.id = 'ssp-css'; st.textContent = PANEL_CSS; document.head.append(st);
    }
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const btn = (label, fn) => { const b = mk('button', null, label); b.type = 'button'; b.onclick = fn; return b; };
    const box = mk('details', 'ssp'); box.open = open;
    const sum = mk('summary'); const msg = mk('p'); const list = mk('ul');
    const file = mk('input'); file.type = 'file'; file.accept = '.md,.markdown,.txt,text/markdown,text/plain'; file.hidden = true;
    const say = (t, cls) => { msg.textContent = t; msg.className = cls || ''; };
    const doc = () => parse(store.load() || create());
    const changed = () => { render(); if (onChange) onChange(doc()); };

    file.onchange = async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      const text = await f.text();
      if (store.load() && summary(doc()).some((r) => r.present) && !confirm(`Replace the song spec in this browser with ${f.name}?`)) return;
      if (!store.save(text)) { say('This browser blocked saving the song spec (private mode or storage full).', 'ssp-e'); return; }
      const errs = validate(parse(text)).filter((i) => i.level === 'error');
      changed();
      say(errs.length ? `Opened ${f.name}. ${errs.length} problem(s): ${errs.map((i) => i.message).join(' ')}` : `Opened ${f.name}.`, errs.length ? 'ssp-w' : '');
    };
    const actions = mk('div', 'ssp-row');
    actions.append(
      btn('Open file…', () => file.click()),
      btn('Download', () => { const d = doc(); download(serialize(d), fileName(d)); }),
      btn('Copy', async () => {
        try { await navigator.clipboard.writeText(serialize(doc())); say('Copied the song spec.'); } catch { say('Copying was blocked by the browser. Use Download instead.', 'ssp-w'); }
      }),
      btn('New song', () => {
        if (!confirm('Start a new song? This empties every section and the title, BPM and key. Your own Suno settings stay.')) return;
        store.update(newSong); changed(); say('Started a new song spec.');
      }),
      file,
    );
    box.append(sum, mk('p', null, 'One file per song, shared by the GP Song Tools in this browser. Each tool fills in its own part; Download saves it to hand to Claude.'), actions, list, msg);
    el.append(box);

    function render() {
      const d = doc();
      const rows = summary(d);
      const n = rows.filter((r) => r.present).length;
      const title = setting(d, 'title');
      sum.textContent = `Song spec${title ? `: ${title}` : ''} · ${n ? `${n} section${n === 1 ? '' : 's'} filled` : 'empty'}`;
      list.replaceChildren(...rows.filter((r) => r.present).map((r) => {
        const li = mk('li');
        const when = r.at ? ` · ${r.at.replace('T', ' ').replace('Z', ' UTC')}` : '';
        li.append(mk('span', 'ssp-h', r.heading), mk('span', 'ssp-m', `${toolName(r.by) === 'unknown' ? 'typed by hand' : toolName(r.by)}${when} · ${r.chars} chars`));
        if (r.manual) li.append(mk('span', 'ssp-w', 'locked'));
        else if (r.edited && r.by) li.append(mk('span', 'ssp-w', 'edited by hand'));
        for (const s of r.stale) li.append(mk('span', 'ssp-w', s));
        li.append(btn('Clear', () => {
          if (!confirm(`Clear the ${r.heading} section? ${toolName(r.by) === 'unknown' ? '' : `${toolName(r.by)} can fill it again.`}`)) return;
          store.update((x) => clearSection(x, r.id)); changed(); say(`Cleared ${r.heading}.`);
        }));
        return li;
      }));
    }
    const off = store.onChange(() => changed());
    render();
    return { refresh: render, say, destroy() { off(); box.remove(); } };
  }

  const api = {
    VERSION, SCHEMA_VERSION, SECTIONS, SETTINGS, STORE_KEY,
    parse, serialize, create, normalize, hash,
    section, setting, settings, confirmReason, staleNotes, pickStructure, summary,
    setSection, setSetting, clearSection, newSong,
    validate, store, fileName, download, stripTags, toolName, mountPanel,
  };

  // ---------- command line ----------
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const [cmd, file, arg] = process.argv.slice(2);
    const fs = require('fs');
    if (!cmd || !file) {
      console.log('usage: node songspec.js validate <file> | show <file> <section-id|setting> | status <file>');
      process.exit(2);
    }
    const doc = parse(fs.readFileSync(file, 'utf8'));
    if (cmd === 'validate') {
      const issues = validate(doc);
      for (const i of issues) console.log(`${i.level === 'error' ? 'ERROR  ' : 'warning'} ${i.field}: ${i.message}`);
      const n = issues.filter((i) => i.level === 'error').length;
      console.log(n ? `${n} error(s): fix before sending to Suno.` : 'OK: no errors.');
      process.exit(n ? 1 : 0);
    } else if (cmd === 'show') {
      const s = section(doc, arg);
      console.log(s ? s.body : setting(doc, arg));
    } else if (cmd === 'status') {
      for (const r of summary(doc)) {
        console.log(`${r.heading.padEnd(32)} ${r.present ? `${toolName(r.by).padEnd(14)} ${r.at.padEnd(18)}${r.edited ? ' edited' : ''}${r.manual ? ' locked' : ''}${r.stale.length ? ' OUT OF DATE' : ''}` : '-'}`);
      }
    } else { console.error(`unknown command "${cmd}"`); process.exit(2); }
  }

  return api;
});
