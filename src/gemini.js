// Gemini API client (REST, called from the browser with the user's own key).
const API = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, { retryable = false, busy = false, status = 0, cancelled = false, partial = '' } = {}) {
    super(message);
    this.retryable = retryable;
    this.busy = busy; // the model is overloaded or not answering: another model may work
    this.status = status; // HTTP status, 0 when there was none
    this.cancelled = cancelled; // the user pressed Stop
    this.partial = partial; // text already streamed before the failure
  }
}

async function readError(response) {
  const data = await response.json().catch(() => ({}));
  const msg = data.error?.message || response.statusText || 'Unknown error';
  const s = response.status;
  if (s === 400 && /api key/i.test(msg)) return new GeminiError('Invalid Gemini API key. Check the key you pasted.', { status: s });
  if (s === 401 || s === 403) return new GeminiError(`This Gemini API key isn't allowed to do that (HTTP ${s}): ${msg}`, { status: s });
  if (s === 404) return new GeminiError(`Model not found (HTTP 404). Pick another model from the list. ${msg}`, { status: s });
  if (s === 429) return new GeminiError(`Gemini rate limit or quota reached (HTTP 429): ${msg}`, { retryable: true, busy: true, status: s });
  if (s === 503) return new GeminiError(`Gemini is overloaded (HTTP 503): ${msg}`, { retryable: true, busy: true, status: s });
  if (s >= 500) return new GeminiError(`Gemini server error (HTTP ${s}): ${msg}`, { retryable: true, status: s });
  return new GeminiError(`Gemini API error (HTTP ${s}): ${msg}`, { status: s });
}

/** Models this key can call generateContent on, as plain ids like "gemini-x-flash". */
export async function listModels(apiKey) {
  const ids = [];
  let pageToken = '';
  do {
    const url = `${API}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw await readError(response);
    const data = await response.json();
    for (const m of data.models || []) {
      if (m.supportedGenerationMethods?.includes('generateContent') && m.name?.startsWith('models/gemini')) {
        ids.push(m.name.slice('models/'.length));
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return ids;
}

const SPECIALIZED = /lite|image|tts|live|audio|embedding|native|robotics|computer|learnlm/i;
const UNSTABLE = /preview|exp|latest|\d{2}-\d{4}$/i;
const version = (id) => parseFloat(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] || '0');

/** General-purpose Flash models, best first: stable newest-first, then preview newest-first. */
export function rankFlashModels(ids) {
  const flash = ids.filter((id) => /^gemini-[\d.]+-flash/.test(id) && !SPECIALIZED.test(id));
  const byNewest = (a, b) => version(b) - version(a) || a.length - b.length;
  return [
    ...flash.filter((id) => !UNSTABLE.test(id)).sort(byNewest),
    ...flash.filter((id) => UNSTABLE.test(id)).sort(byNewest),
  ];
}

/** Newest general-purpose Flash model, preferring stable over preview. */
export function pickDefaultModel(ids) {
  return rankFlashModels(ids)[0] || ids[0] || '';
}

/** Models to fall back to when `model` is busy: the next best Flash models. */
export function fallbackModels(ids, model, count = 2) {
  return rankFlashModels(ids).filter((id) => id !== model).slice(0, count);
}

export const STYLE_PROMPT_MAX = 1000;

/**
 * Keep the style prompt within STYLE_PROMPT_MAX characters, cutting at the
 * last sentence end (or comma) that fits so it never ends mid-phrase.
 */
export function fitStylePrompt(text, max = STYLE_PROMPT_MAX) {
  const clean = (text || '').trim();
  if (clean.length <= max) return { text: clean, trimmed: false };
  const head = clean.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.endsWith('.') ? max - 1 : -1);
  const cut = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : head.lastIndexOf(',');
  return { text: (cut > 0 ? head.slice(0, cut) : head).trim(), trimmed: true };
}


/**
 * A YouTube or YouTube Music track link as the canonical watch URL Gemini
 * accepts, or '' if `input` isn't one.
 */
export function normalizeYouTubeUrl(input) {
  let url;
  try { url = new URL((input || '').trim()); } catch { return ''; }
  const host = url.hostname.replace(/^(www|m)\./, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/) || [])[1] || '';
  }
  return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : '';
}

export function buildPrompt({ artist, song, topic, lyrics, blocks = [], reference = '', hasAudio = false }) {
  const subject = song ? `the song "${song}" by ${artist}` : `the artist ${artist}`;
  const structureRule = blocks.length
    ? `The app has already split the REFERENCE LYRICS into ${blocks.length} sung blocks and counted their lines and syllables exactly (MEASURED BLOCKS below); do not recount them. Write one STRUCTURE line for every block, in order, and in the <lyric lines> field write the block's number ("#1", "#2", ...) instead of a count. Add instrumental sections the song has (intro, solo, outro...) where they occur, with lyric lines 0. For each block, work out the rhyme letters from its listed end words and copy its measured meter. Name each block (Verse 1, Chorus, Bridge...) from its position, its header if it has one, and repetition.${hasAudio ? ' Take bars and seconds from the attached recording.' : ''} Never quote or reproduce any of the reference lyrics.`
    : hasAudio
      ? 'Describe the structure of the attached recording as you hear it: every section in order, including instrumental ones, with bars and seconds measured from the audio.'
      : song
        ? `Describe the real structure of "${song}" from your knowledge of it. Include only sections that exist in the song. Give your best estimate where unsure.`
        : "Describe a typical song structure for this artist's style (for example Intro, Verse, Pre-Chorus, Chorus, Bridge, Outro).";
  const audioText = hasAudio ? `
ATTACHED RECORDING: the audio attached to this message is ${song ? `"${song}" by ${artist}` : `a track by ${artist}`}. Listen to it and base the style, stems and structure on what you actually hear: the instruments and how they are played, the vocal timbre and delivery, the groove, how the arrangement builds and drops, and the mix and production. ${reference ? 'Where the MusicAtlas analysis gives a measured tempo or key, use those over your own estimate.' : 'Estimate tempo and key from the audio, and make sure the tempo is not half or double the real one.'}
` : '';
  return `You are a music producer and lyricist who writes prompts for Suno, the AI music generator. Analyze ${subject} and write a complete Suno prompt kit in its style.

Never write any artist name, band name or song title anywhere in your answer: Suno rejects prompts that contain them. Describe the sound instead.
${audioText}${reference}
Reply in EXACTLY this plain-text format, with each marker alone on its own line, no markdown, and nothing before the first marker:

@@STYLE
One line of comma-separated core style tags: genre and subgenre, era, tempo in BPM, key, vocal type, mood.
Then a few complete sentences on the instruments and how they are played, the vocal delivery, the groove, how the arrangement builds and drops, and the mix and production. The whole STYLE section must be 750 to 950 characters and never more than ${STYLE_PROMPT_MAX}.
@@TEMPO
bpm: <tempo as a whole number>
key: <key, e.g. G major>
@@STEMS
One line per instrument group actually present, chosen from: Drums & Percussion, Bass, Rhythm Guitar, Lead Guitar, Piano / Keys, Synthesizers, Strings / Orchestral, Brass / Horns, Vocals, Backing Vocals / Choir, Pads & Atmosphere, FX & Transitions.
Format: <group> || <prompt>
Each prompt is 200 to 350 characters of complete sentences describing ONLY that group in isolation, as if generating just that stem: specific instruments, playing style, tone, role in the mix, and tempo and key where relevant. Start with "Isolated <group> stem:".
@@STRUCTURE
One line per section, in song order. ${structureRule}
Format: <section name> || <bars> || <seconds> || <lyric lines> || <rhyme> || <meter> || <description> || <suno tag>
- seconds: the section's length at the song's tempo (in 4/4: bars x 4 x 60 / BPM, rounded).
- lyric lines: 0 for instrumental sections.
- rhyme: one end-rhyme letter per lyric line, such as ABABCDCD for 8 lines; "-" if instrumental.
- meter: syllables for every lyric line as a dot-separated list, one number per line, such as 8.7.8.7.8.7.8.7 for 8 lines; "-" if instrumental. Never leave it out for a sung section.
- description: one plain sentence on what the section does emotionally or structurally, noting variations (e.g. "Chorus 2 adds a second vocal layer").
- suno tag: the Suno section header in square brackets: the section name in upper case, then style elements, ALL separated by the pipe symbol | (never commas, colons or other punctuation between elements). Suno gives more weight to earlier elements, so always use this order and leave out any slot that does not apply (e.g. no vocal style in an instrumental section): [SECTION|mood/energy|vocal style|key instruments|dynamic/movement|spatial/effects|production style], such as [CHORUS|euphoric|soaring belted vocals|full band and stacked synths|explosive lift|wide stereo reverb|polished arena mix]. Never more than 7 elements in total, counting the section name. Never put contradictory elements in the same tag (e.g. whispered and belted, sparse and wall of sound). Never use an element that fights the STYLE section: it must fit its genre, instruments, vocal type, mood and production.
@@LYRICS
Complete ORIGINAL lyrics ${topic ? `about this topic: "${topic}"` : 'on a theme typical for this artist'}, written to fit STRUCTURE exactly: the same sections in the same order, each starting with its suno tag exactly as written in STRUCTURE on its own line, the same number of lines per section, the same rhyme scheme, and the meter line by line: the first line of a section has the first number of syllables in its meter pattern, the second line the second number, and so on. Count syllables as you write each line. Leave a blank line between sections. Instrumental sections get only their tag line. Do not reuse or paraphrase lines from any existing song${lyrics ? ', including the reference lyrics' : ''}.
@@END
${blocks.length ? `
MEASURED BLOCKS (counted by the app; exact):
${blocks.map((b, i) => `#${i + 1}${b.name ? ` (labelled "${b.name}")` : ''}: ${b.lines.length} lines; syllables per line ${b.syl.join('.')}; end words: ${b.ends.join(' / ')}`).join('\n')}
` : ''}${lyrics ? `
REFERENCE LYRICS (for naming the sections only; never reproduce them):
<reference_lyrics>
${lyrics.slice(0, 20000)}
</reference_lyrics>` : ''}`;
}

/**
 * Parse Gemini's marker-formatted answer (@@STYLE, @@TEMPO, @@STEMS,
 * @@STRUCTURE, @@LYRICS, @@END). With `final` false the last, still-being-written
 * line of the open part is dropped so half lines never render.
 */
export function parseSunoText(text, final) {
  const parts = {};
  const re = /^@@(STYLE|TEMPO|STEMS|STRUCTURE|LYRICS|END)\s*$/gm;
  let m;
  let last = null;
  let lastIdx = 0;
  while ((m = re.exec(text))) {
    if (last) parts[last] = text.slice(lastIdx, m.index);
    last = m[1];
    lastIdx = m.index + m[0].length;
  }
  if (last) parts[last] = text.slice(lastIdx);
  const names = Object.keys(parts);
  const done = (name) => final || names.indexOf(name) < names.length - 1;
  const lines = (name) => {
    const raw = (parts[name] || '').split('\n');
    if (!done(name)) raw.pop();
    return raw.map((l) => l.trim()).filter(Boolean);
  };
  const tempo = {};
  for (const l of lines('TEMPO')) {
    const [k, ...v] = l.split(':');
    tempo[k.trim().toLowerCase()] = v.join(':').trim();
  }
  const stems = lines('STEMS').map((l) => l.split('||').map((x) => x.trim())).filter((a) => a.length >= 2 && a[1])
    .map(([group, prompt]) => ({ group, prompt }));
  const sections = lines('STRUCTURE').map((l) => l.split('||').map((x) => x.trim())).filter((a) => a.length >= 7)
    .map((a) => ({
      name: a[0],
      bars: a[1],
      seconds: Number(a[2]) || 0,
      linesRaw: a[3],
      lines: /^#/.test(a[3]) ? 1 : Number(a[3]) || 0,
      rhyme: a[4],
      meter: a[5],
      description: a.length >= 8 ? a[6] : '',
      tags: a[a.length - 1],
    }));
  return {
    style: (parts.STYLE || '').trim(),
    bpm: tempo.bpm || '',
    key: tempo.key || '',
    stems,
    sections,
    lyrics: (parts.LYRICS || '').replace(/^\n+/, '').trimEnd(),
    complete: 'END' in parts,
  };
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const REQUEST_TIMEOUT_MS = 120000; // with no new data for this long, give up
const BUSY_DELAYS = [2000]; // retries on the same model before moving on when it is busy
const OTHER_DELAYS = [1000, 3000]; // retries for network errors and other 5xx

async function streamOnce({ apiKey, model, body, signal, onText }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); };
  let text = '';
  let finishReason = '';
  let blockReason = '';
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    let chunk;
    try { chunk = JSON.parse(line.slice(5)); } catch { return; }
    if (chunk.error) throw new GeminiError(`Gemini stopped with an error: ${chunk.error.message || 'unknown'}`, { retryable: !text });
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    const c = chunk.candidates?.[0];
    if (c?.finishReason) finishReason = c.finishReason;
    const piece = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (piece) { text += piece; onText?.(text); }
  };
  try {
    arm();
    const response = await fetch(`${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw await readError(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    handleLine(buf.trim());
  } catch (err) {
    if (signal?.aborted) throw new GeminiError('Stopped.', { cancelled: true, partial: text });
    if (err instanceof GeminiError) { err.partial = text; throw err; }
    if (err?.name === 'AbortError') {
      throw new GeminiError(`${model} stopped answering for ${REQUEST_TIMEOUT_MS / 1000}s.`, { retryable: !text, busy: !text, partial: text });
    }
    throw new GeminiError(`Could not reach the Gemini API: ${err.message}`, { retryable: !text, partial: text });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!text) {
    throw new GeminiError(`Gemini returned no result (${blockReason || finishReason || 'no content'}). Try a different artist, song or topic.`);
  }
  return { text, truncated: finishReason === 'MAX_TOKENS' };
}

/**
 * Stream from `model`, calling onText(fullTextSoFar) as text arrives. If the
 * model stays overloaded (503/429) or doesn't answer before writing anything,
 * move on to each of `fallbacks` in turn. With `youtubeUrl`, Gemini also
 * listens to that recording.
 * @returns {Promise<{ text: string, truncated: boolean, modelUsed: string }>}
 */
export async function generateSunoPrompt({ apiKey, model, fallbacks = [], prompt, youtubeUrl = '', onStatus, onText, signal }) {
  const parts = youtubeUrl ? [{ fileData: { fileUri: youtubeUrl } }, { text: prompt }] : [{ text: prompt }];
  const body = JSON.stringify({
    contents: [{ parts }],
    // Low resolution keeps a YouTube track to roughly 100 tokens a second; the audio is unaffected.
    ...(youtubeUrl ? { generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } } : {}),
  });
  const candidates = [model, ...fallbacks.filter((m) => m && m !== model)];
  let lastError;

  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i];
    if (i > 0) onStatus?.(`${candidates[i - 1]} is busy. Trying ${current}...`);
    let busyTries = 0;
    let otherTries = 0;
    for (;;) {
      if (signal?.aborted) throw new GeminiError('Stopped.', { cancelled: true });
      try {
        const res = await streamOnce({ apiKey, model: current, body, signal, onText });
        return { ...res, modelUsed: current };
      } catch (err) {
        lastError = err;
        if (!err.retryable) throw err;
        if (err.busy) {
          if (busyTries >= BUSY_DELAYS.length) break; // give up on this model
          onStatus?.(`${current} is busy. Retrying...`);
          await delay(BUSY_DELAYS[busyTries++]);
        } else {
          if (otherTries >= OTHER_DELAYS.length) throw err;
          onStatus?.('Gemini request failed. Retrying...');
          await delay(OTHER_DELAYS[otherTries++]);
        }
      }
    }
  }
  throw new GeminiError(
    `${lastError.message} Tried: ${candidates.join(', ')}. Wait a few minutes or pick another model.`,
    { status: lastError.status },
  );
}
