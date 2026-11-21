import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Mic2, Disc, Copy, Check, Sparkles, AlertCircle, Loader2, Play, FileText, MessageSquare, Key, Plug, Radio, Users, ChevronDown, Layers, ListMusic, Eraser, ClipboardList, Headphones, Square, Save } from 'lucide-react';
import { DEFAULT_MCP_URL, DIRECT_MUSICATLAS_URL } from './mcpConfig';

// The MCP SDK is loaded on demand so it doesn't weigh down the first page load.
const loadMcp = () => import('./mcp');
import { listModels, pickDefaultModel, fallbackModels, buildPrompt, generateSunoPrompt, parseSunoText, normalizeYouTubeUrl, fitStylePrompt, STYLE_PROMPT_MAX, HANS_PROMPT_MAX } from './gemini';
import { splitBlocks, applyCounts, sectionHeader, meterCheck, formatStructure, formatDuration } from './lyrics';
import { SongSpec, specInputs, usedSections, usedText, analysisBlock, bpmKeyNote, overwriteNotes, specWrite } from './spec';

const readPref = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const writePref = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

// One plain line saying where the tempo, key and length shown in the result came from.
const originText = (v, hasLength) => {
  const atlas = 'measured by MusicAtlas from the audio';
  const tempo = v.bpm && (v.measured?.bpm ? atlas : v.origin?.gemini);
  const key = v.key && (v.measured?.key ? atlas : v.origin?.gemini);
  const parts = [];
  if (tempo && tempo === key) parts.push(`Tempo and key: ${tempo}.`);
  else {
    if (tempo) parts.push(`Tempo: ${tempo}.`);
    if (key) parts.push(`Key: ${key}.`);
  }
  if ((v.bpm && !v.measured?.bpm) || (v.key && !v.measured?.key)) parts.push(v.origin?.why || '');
  if (hasLength) parts.push("Length: Gemini's bars for each section at this tempo.");
  return parts.filter(Boolean).join(' ');
};

// Turn MCP tool output into a reference block for the Gemini prompt.
const buildReferenceBlock = (ctx) => {
  if (!ctx) return '';
  const sections = [];
  if (ctx.trackAnalysis) sections.push(`AUDIO ANALYSIS OF THE REFERENCE TRACK:\n${ctx.trackAnalysis}`);
  if (ctx.similarTracks) sections.push(`SONICALLY SIMILAR TRACKS:\n${ctx.similarTracks}`);
  if (ctx.similarArtists) sections.push(`SONICALLY SIMILAR ARTISTS:\n${ctx.similarArtists}`);
  if (!sections.length) return '';
  return `
MUSICATLAS AUDIO ANALYSIS (measured from the actual recording). Use the measured tempo and key exactly. Let the loudness, intensity and density inform the production description. Classifier and genre labels are automatic guesses: trust them only where they fit what you know. Similar tracks and artists are stylistic context only; never name them in your answer.
<musicatlas>
${sections.join('\n\n')}
</musicatlas>
`;
};

// Shown before the first run, clearly labelled as an example.
const EXAMPLE = {
  example: true,
  style: 'french house, filter disco, late 90s, 123 BPM, G major, vocoder lead, euphoric\nChopped disco horn and string samples loop through a slowly opening low-pass filter over a four-on-the-floor kick. A side-chained bassline pumps against the kick while a talk-box vocal carries a simple, repeated hook. The arrangement drops to filtered loops in the breakdown, then the full band slams back in. Warm, saturated mix with heavy compression and a wide stereo chorus.',
  styleTrimmed: false,
  bpm: '123', key: 'G major', measured: {},
  stems: [
    { group: 'Drums & Percussion', prompt: 'Isolated drum stem: four-on-the-floor kick at 123 BPM, open hi-hats on the offbeat, handclaps on 2 and 4, heavily compressed with a short room.' },
    { group: 'Bass', prompt: 'Isolated bass stem: round synth bass in G major playing a syncopated disco line, side-chained to the kick so it pumps on every beat.' },
    { group: 'Vocals', prompt: 'Isolated vocal stem: talk-box lead singing a short, repetitive hook, bright and slightly robotic, doubled an octave up in the choruses.' },
  ],
  sections: [
    { name: 'Intro', bars: 8, seconds: 16, lines: 0, rhyme: '-', meter: '-', description: 'A filtered loop slowly opens up.', tags: '[INTRO|hypnotic|filtered disco loop|slow build|swirling phaser]' },
    { name: 'Verse 1', bars: 16, seconds: 31, lines: 4, rhyme: 'AABB', meter: '6.6.7.7', description: 'The groove settles in under the talk-box.', tags: '[VERSE 1|laid-back|talk-box vocal|steady groove]' },
    { name: 'Chorus', bars: 16, seconds: 31, lines: 4, rhyme: 'AAAA', meter: '5.5.5.5', description: 'The full band hits with the repeated hook.', tags: '[CHORUS|euphoric|repeated vocoder hook|full band|big lift]' },
    { name: 'Breakdown', bars: 16, seconds: 31, lines: 0, rhyme: '-', meter: '-', description: 'Everything drops to a filtered loop before the return.', tags: '[BREAKDOWN|tense|sparse filtered loop|rising build]' },
  ],
  lyrics: '[Intro: filtered disco loop, building]\n\n[Verse 1: talk-box vocal, steady groove]\nHarbor lights are low\nWaiting for the show\nCity calling through the rain\nPulling me back home again\n\n[Chorus: full band, euphoric, repeated hook]\nOne more night out\nOne more night out\nOne more night out\nOne more night out\n\n[Breakdown: filtered, sparse, rising tension]',
  source: 'Example: structure of a typical french house track',
  check: '',
};


const MOZART_EXAMPLE = {
  ...EXAMPLE,
  target: 'mozart',
  style: 'French house at 123 BPM in G major, with filtered disco strings, four-on-the-floor drums and a bright talk-box hook about a night in the city. Let the breakdown narrow to the loop before the full groove returns.',
  stems: [],
  sections: EXAMPLE.sections.map((section) => ({ ...section, tags: `[${section.name.toUpperCase()}]` })),
  lyrics: EXAMPLE.lyrics.replace(/^\[([^:\]]+):[^\]]+\]$/gm, (_, name) => `[${name.toUpperCase()}]`),
};

const STEM_COLORS = ['#f0c040', '#a78bfa', '#40c080', '#f87171', '#60a5fa', '#fb923c', '#34d399', '#e879f9', '#facc15', '#38bdf8', '#4ade80', '#f472b6'];

export default function App() {
  const [artist, setArtist] = useState('');
  const [song, setSong] = useState('');
  const [topic, setTopic] = useState('');
  const [lyrics, setLyrics] = useState('');
  // Opt-in: the key is saved in this browser's localStorage only while "Remember key" is checked.
  const [rememberKey, setRememberKey] = useState(() => readPref('gemini.rememberKey', false));
  const [customKey, setCustomKey] = useState(() => (rememberKey ? readPref('gemini.key', '') : ''));
  useEffect(() => {
    writePref('gemini.rememberKey', rememberKey);
    if (rememberKey) writePref('gemini.key', customKey);
    else try { localStorage.removeItem('gemini.key'); } catch { /* storage unavailable */ }
  }, [rememberKey, customKey]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [result, setResult] = useState(null);
  const [copiedSection, setCopiedSection] = useState(null);
  const [youtube, setYoutube] = useState('');
  const [status, setStatus] = useState(null); // "Done.", "Stopped." after a run
  const [showExample, setShowExample] = useState(true);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [writing, setWriting] = useState(false); // Gemini has started sending text
  const [mcpStep, setMcpStep] = useState('');
  const abortRef = useRef(null);

  // The GP Song Tools song spec, shared with the other tools in this browser (see src/spec.js).
  const [specText, setSpecText] = useState(() => SongSpec.store.load());
  const specDoc = useMemo(() => SongSpec.parse(specText || SongSpec.create()), [specText]);
  const specIn = useMemo(() => specInputs(specDoc), [specDoc]);
  const [useAnalysis, setUseAnalysis] = useState(true);
  const [setBpmKey, setSetBpmKey] = useState(true);
  const [specMsg, setSpecMsg] = useState(null); // { ok, text }
  const panelRef = useRef(null);
  useEffect(() => {
    const panel = SongSpec.mountPanel(panelRef.current, { onChange: () => setSpecText(SongSpec.store.load()) });
    return () => panel.destroy();
  }, []);

  // Tick once a second while generating, for the elapsed-time status.
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loading]);

  // Gemini model: discovered from the API so retired model names can't break the app.
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(() => readPref('gemini.model', ''));
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [genStatus, setGenStatus] = useState(null); // e.g. "x is busy. Trying y..."
  const [modelUsed, setModelUsed] = useState(null);

  useEffect(() => { if (model) writePref('gemini.model', model); }, [model]);

  const loadModels = async (key) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const ids = await listModels(key);
      setModels(ids);
      const chosen = ids.includes(model) ? model : pickDefaultModel(ids);
      setModel(chosen);
      return { chosen, ids };
    } catch (err) {
      setModelsError(err.message);
      return { chosen: '', ids: [] };
    } finally {
      setModelsLoading(false);
    }
  };

  // Look up available models shortly after a key is pasted.
  useEffect(() => {
    const key = customKey.trim();
    if (key.length < 30) return;
    const t = setTimeout(() => loadModels(key), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customKey]);

  // MCP enrichment
  const [useMcp, setUseMcp] = useState(() => readPref('mcp.enabled', true));
  const [mcpUrl, setMcpUrl] = useState(() => {
    const saved = readPref('mcp.url', DEFAULT_MCP_URL);
    return saved === DIRECT_MUSICATLAS_URL ? DEFAULT_MCP_URL : saved;
  });
  const [mcpStage, setMcpStage] = useState(null); // null | 'mcp' | 'llm'
  const [mcpContext, setMcpContext] = useState(null);
  const [mcpWarning, setMcpWarning] = useState(null);
  const [mcpTest, setMcpTest] = useState(null); // { ok, text }
  const [testing, setTesting] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const [target, setTarget] = useState(() => (readPref('prompt.target', 'suno') === 'mozart' ? 'mozart' : 'suno'));
  useEffect(() => writePref('prompt.target', target), [target]);
  useEffect(() => writePref('mcp.enabled', useMcp), [useMcp]);
  useEffect(() => writePref('mcp.url', mcpUrl), [mcpUrl]);

  const testMcp = async () => {
    setTesting(true);
    setMcpTest(null);
    try {
      const { connectMcp } = await loadMcp();
      const { client, tools } = await connectMcp(mcpUrl.trim());
      client.close().catch(() => {});
      setMcpTest({ ok: true, text: `Connected. ${tools.length} tools: ${tools.map(t => t.name).join(', ')}` });
    } catch (err) {
      setMcpTest({ ok: false, text: err.message });
    }
    setTesting(false);
  };


  const showValidation = (field, message) => {
    setValidation({ field, message });
    document.getElementById(field)?.focus();
  };
  const fieldValidation = (field) => validation?.field === field;
  const validationMessage = (field) => fieldValidation(field) && (
    <p id={`${field}-error`} role="alert" className="text-xs text-red-300">{validation.message}</p>
  );

  const generatePrompt = async () => {
    if (loading) return;
    if (!artist.trim()) {
      showValidation('reference-artist', 'Please enter an artist name.');
      return;
    }
    if (!customKey.trim()) {
      showValidation('gemini-key', 'Please paste your Gemini API key.');
      return;
    }
    const youtubeUrl = youtube.trim() ? normalizeYouTubeUrl(youtube) : '';
    if (youtube.trim() && !youtubeUrl) {
      showValidation('youtube-link', 'Use a public YouTube link. Copy the link from the song’s Share menu.');
      return;
    }

    setValidation(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    setError(null);
    setStatus(null);
    setShowExample(false);
    setModelUsed(null);
    setGenStatus(null);
    setMcpContext(null);
    setMcpWarning(null);
    setShowRaw(false);
    setWriting(false);
    setStartedAt(Date.now());
    setNow(Date.now());

    const pasted = lyrics.trim();
    const specUsed = usedSections(specIn, { topic, lyrics, analysis: useAnalysis });
    setSpecMsg(null);
    const blocks = pasted ? splitBlocks(pasted).slice(0, 40) : [];
    const source = blocks.length ? 'Lines and syllables (green) counted from your pasted lyrics. Section names, rhyme and tags by Gemini.'
      : youtubeUrl ? 'Heard by Gemini from the YouTube Music recording. Paste the lyrics for exact line and syllable counts.'
      : song.trim() ? "Gemini's estimate from its knowledge of the song. Paste the lyrics for exact counts."
      : 'Typical structure for this artist (no song given)';
    let measured = {};
    // Where tempo/key come from when MusicAtlas didn't measure them (shown under the tiles).
    const origin = {
      gemini: youtubeUrl ? "Gemini's estimate from listening to the YouTube link"
        : song.trim() ? "Gemini's estimate from what it knows about the song"
        : "Gemini's guess for this artist's typical sound",
      why: !useMcp ? 'MusicAtlas is turned off, so nothing was measured.'
        : !song.trim() ? 'Add a song title to get MusicAtlas measurements.'
        : 'MusicAtlas had no measurement for this song.',
    };
    // Parsed text + the app's own counts + MusicAtlas's measured tempo/key.
    const compose = (text, final) => {
      const p = parseSunoText(text, final);
      const sections = applyCounts(p.sections, blocks);
      const style = final ? fitStylePrompt(p.style) : { text: p.style, trimmed: false };
      return {
        ...p, target, sections, style: style.text, styleTrimmed: style.trimmed,
        bpm: measured.bpm || p.bpm, key: measured.key || p.key,
        measured: { bpm: !!measured.bpm, key: !!measured.key }, origin,
        source, streaming: !final, check: final ? meterCheck(sections, p.lyrics) : '',
        run: { artist: artist.trim(), song: song.trim(), youtube: youtubeUrl, used: specUsed },
      };
    };
    setResult(compose('', false));
    const finish = () => { setGenStatus(null); setLoading(false); setMcpStage(null); abortRef.current = null; };

    // Step 1: ground the request in real audio data via MCP (best effort).
    let ctx = null;
    if (useMcp && mcpUrl.trim()) {
      setMcpStage('mcp');
      setMcpStep('connecting');
      try {
        const { gatherMusicContext } = await loadMcp();
        ctx = await gatherMusicContext(mcpUrl.trim(), { artist: artist.trim(), song: song.trim() }, setMcpStep);
        measured = ctx.measured || {};
        setMcpContext(ctx);
        if (ctx.warnings.length) setMcpWarning(ctx.warnings.join(' | '));
      } catch (err) {
        setMcpWarning(`${err.message} Continuing without MusicAtlas data.`);
      }
      if (ctl.signal.aborted) {
        setResult(null);
        setStatus('Stopped.');
        return finish();
      }
      setResult(compose('', false));
    }
    setMcpStage('llm');
    setStartedAt(Date.now());

    try {
      let chosenModel = models.includes(model) ? model : '';
      let available = models;
      if (!chosenModel) ({ chosen: chosenModel, ids: available } = await loadModels(customKey.trim()));
      if (!chosenModel) throw new Error('Could not find a Gemini model for this API key. Check the key.');
      const { text, truncated, modelUsed: used } = await generateSunoPrompt({
        apiKey: customKey.trim(),
        model: chosenModel,
        fallbacks: fallbackModels(available, chosenModel),
        youtubeUrl,
        signal: ctl.signal,
        onStatus: setGenStatus,
        onText: (t) => { setWriting(true); setResult(compose(t, false)); },
        prompt: buildPrompt({
          artist: artist.trim(),
          song: song.trim(),
          topic: topic.trim(),
          lyrics: pasted,
          blocks,
          reference: buildReferenceBlock(ctx) + (specUsed.includes('analysis') ? analysisBlock(specIn.analysis.text) : ''),
          hasAudio: !!youtubeUrl,
          target,
        }),
      });
      const r = compose(text, true);
      setResult(r);
      setModelUsed(used);
      if (!r.style || !r.sections.length) setError("Gemini's answer was missing some parts. Press Generate to try again.");
      else if (truncated) setError('Gemini ran out of room before finishing. Press Generate to try again.');
      else setStatus(specUsed.length ? `Done. Used from the song spec: ${usedText(specDoc, specUsed)}.` : 'Done.');
    } catch (err) {
      console.error(err);
      setResult(err.partial ? compose(err.partial, true) : null);
      if (err.cancelled) setStatus('Stopped.');
      else {
        setError(err.message + (youtubeUrl && err.status === 400
          ? ' Gemini could not open the YouTube Music link: the track must be public, not age-restricted, and available in your region.'
          : ''));
      }
    }
    finish();
  };

  const stopGenerating = () => abortRef.current?.abort();

  // Writes this result's Style, Structure, Stems and Reference (and BPM/key if ticked) into the song spec.
  const saveToSpec = () => {
    if (!result?.run || result.streaming) return;
    const notes = overwriteNotes(SongSpec.parse(SongSpec.store.load() || SongSpec.create()));
    if (notes.length && !window.confirm(`${notes.join('\n')}\n\nReplace them with this result?`)) return;
    const doc = SongSpec.store.update((d) => specWrite(d, result, result.run, { setBpmKey }));
    const saved = SongSpec.store.load() === SongSpec.serialize(doc);
    setSpecText(SongSpec.store.load());
    const parts = ['Style', 'Structure', result.stems?.length ? 'Stems' : '', 'Reference', setBpmKey ? 'BPM and key' : ''].filter(Boolean);
    setSpecMsg(saved
      ? { ok: true, text: `Saved to the song spec: ${parts.join(', ')}.${result.target === 'mozart' ? ' Style holds the Mozart prompt; Stems is empty (Mozart mode has none).' : ''}` }
      : { ok: false, text: 'This browser blocked saving the song spec (private mode or storage full). Use Download in the Song spec panel instead.' });
  };

  // Clears the song inputs and results; keeps the API key, model and MCP settings.
  const clearAll = () => {
    setArtist(''); setSong(''); setTopic(''); setLyrics(''); setYoutube('');
    setResult(null); setError(null); setValidation(null); setModelUsed(null); setGenStatus(null);
    setMcpContext(null); setMcpWarning(null); setShowRaw(false);
    setShowExample(false); setStatus('Cleared. Enter an artist and press Generate.');
  };

  const copyToClipboard = async (text, section) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSection(section);
      setTimeout(() => setCopiedSection(null), 2000);
      return;
    } catch { /* clipboard API blocked: fall back to a hidden textarea */ }
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      setCopiedSection(section);
      setTimeout(() => setCopiedSection(null), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
    }
    document.body.removeChild(textArea);
  };

  const view = result || (showExample ? (target === 'mozart' ? MOZART_EXAMPLE : EXAMPLE) : null);
  const total = view ? view.sections.reduce((a, sec) => a + (Number(sec.seconds) || 0), 0) : 0;
  const styleMax = view?.target === 'mozart' ? HANS_PROMPT_MAX : STYLE_PROMPT_MAX;
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const liveStatus = mcpStage === 'mcp' ? `Asking MusicAtlas: ${mcpStep}…`
    : `${model || 'Gemini'} is ${writing ? 'writing' : youtube.trim() ? 'listening' : 'thinking'}… ${elapsed}s`;
  const waiting = (text) => <span className="text-sm italic text-slate-500">{text}</span>;
  const copyButton = (text, id, label, accessibleLabel = label) => (
    <button
      onClick={() => copyToClipboard(text, id)}
      aria-label={copiedSection === id ? `Copied: ${accessibleLabel}` : accessibleLabel}
      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors flex items-center gap-2 border border-slate-700 shrink-0"
    >
      {copiedSection === id ? <Check aria-hidden="true" className="w-3 h-3 text-green-400" /> : <Copy aria-hidden="true" className="w-3 h-3" />}
      {copiedSection === id ? 'Copied' : label}
    </button>
  );

  return (
    <div className="blueprint">
      <a className="bp-skip" href="#workspace">Skip to workspace</a>
      <header className="bp-header">
        <nav className="bp-nav bp-shell" aria-label="Site">
          <a className="bp-brand" href="./" translate="no">
            <img src="blueprint-mark.svg" width="36" height="36" alt="" /> GP Blueprint
          </a>
          <a href="changelog.html">Changelog</a>
        </nav>
      </header>

      <main className="bp-main bp-shell" id="workspace" tabIndex={-1}>
        <section className="bp-intro" aria-labelledby="page-title">
          <div>
            <h1 id="page-title" className="bp-title">From reference to arrangement.</h1>
            <p>Start with an artist. Add a song or YouTube link for a specific reference. Use Gemini to build a style prompt, arrangement and original lyrics, plus instrument prompts for Suno.</p>
          </div>
          <aside className="bp-preview" aria-label="Example arrangement">
            <div className="bp-preview-head">
              <span className="bp-preview-title">French house example</span>
              <span className="bp-preview-meta">{EXAMPLE.bpm} BPM / {EXAMPLE.key}</span>
            </div>
            <ol>
              {EXAMPLE.sections.map((section, i) => (
                <li key={section.name} style={{ '--section-color': STEM_COLORS[i] }}>
                  <span>{section.name}</span>
                  <span>{section.bars} bars</span>
                </li>
              ))}
            </ol>
            <a href="#blueprint-output">{view?.example ? 'Explore the sample blueprint' : 'Go to blueprint output'}</a>
          </aside>
        </section>

        <div className="bp-workspace">
          <section className="bp-form" aria-labelledby="reference-title">
            <div className="bp-form-panel">
              <h2 className="bp-form-heading" id="reference-title">Track reference</h2>
              <p>You’ll need an artist name and a Gemini API key.</p>
              <div ref={panelRef} className="bp-song-spec" />
              <div className="space-y-4 mb-4">
                <div className="space-y-2">
                  <span className="text-sm font-medium text-slate-300">Write prompts for</span>
                  <div className="grid grid-cols-2 gap-1 p-1 bg-slate-800 border border-slate-700 rounded-lg" role="group" aria-label="Write prompts for">
                    {[['suno', 'Suno'], ['mozart', 'Mozart AI']].map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTarget(id)}
                        aria-pressed={target === id}
                        className="bp-target px-3 py-2 rounded-md text-sm font-medium transition-colors text-slate-300"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500">
                    {target === 'mozart'
                      ? "A short Hans 2.0 prompt with BPM and key, plus structure and lyrics for Mozart."
                      : 'Style prompt, stems, tagged structure and lyrics for Suno.'}
                  </p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="reference-artist" className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Mic2 aria-hidden="true" className="w-4 h-4 text-purple-400" /> Artist Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    id="reference-artist" name="reference-artist" autoComplete="off" value={artist}
                    aria-invalid={fieldValidation('reference-artist') || undefined}
                    aria-describedby={fieldValidation('reference-artist') ? 'reference-artist-error' : undefined}
                    onChange={(e) => {
                      setArtist(e.target.value);
                      if (fieldValidation('reference-artist')) setValidation(null);
                    }}
                    placeholder="e.g. Daft Punk…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500"
                    onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                  />
                  {validationMessage('reference-artist')}
                </div>
                <div className="space-y-2">
                  <label htmlFor="reference-song" className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Disc aria-hidden="true" className="w-4 h-4 text-indigo-400" /> Song Title <span className="text-xs text-slate-500">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    id="reference-song" name="reference-song" autoComplete="off" value={song}
                    onChange={(e) => setSong(e.target.value)}
                    placeholder="e.g. One More Time…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500"
                    onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                  />
                </div>
              </div>
              
              {(specIn.topic || specIn.lyrics || specIn.analysis) && (
                <div className="mb-6 p-3 rounded-lg border border-slate-700 bg-slate-800/40 space-y-2 text-xs text-slate-300">
                  <p className="font-medium text-slate-200">From the song spec <span className="text-slate-500 font-normal">(optional)</span></p>
                  {specIn.topic && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex-1 min-w-0 break-words">Topic from {SongSpec.toolName(specIn.topic.by)}: “{specIn.topic.text}”</span>
                      {topic.trim() === specIn.topic.text
                        ? <span className="text-emerald-400">In use</span>
                        : <button type="button" onClick={() => setTopic(specIn.topic.text)} className="px-2 py-1 rounded border border-slate-600 hover:bg-slate-700">Use as topic</button>}
                    </div>
                  )}
                  {specIn.lyrics && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex-1 min-w-0">Lyrics from {SongSpec.toolName(specIn.lyrics.by)} ({specIn.lyrics.text.split('\n').filter((l) => l.trim() && !/^\s*\[[^\]]*\]\s*$/.test(l)).length} lines)</span>
                      {lyrics.trim() && SongSpec.normalize(lyrics) === SongSpec.normalize(specIn.lyrics.text)
                        ? <span className="text-emerald-400">In use</span>
                        : <button type="button" onClick={() => setLyrics(specIn.lyrics.text)} className="px-2 py-1 rounded border border-slate-600 hover:bg-slate-700">Use for the structure</button>}
                    </div>
                  )}
                  {specIn.analysis && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" name="include-song-analysis" checked={useAnalysis} onChange={(e) => setUseAnalysis(e.target.checked)} className="accent-purple-500" />
                      Add {SongSpec.toolName(specIn.analysis.by)}'s analysis to the prompt (tempo, key, mood, instruments)
                    </label>
                  )}
                </div>
              )}

              <div className="mb-6 space-y-2">
                <label htmlFor="reference-topic" className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <MessageSquare aria-hidden="true" className="w-4 h-4 text-pink-400" /> Lyrical Topic <span className="text-xs text-slate-500">(Optional)</span>
                </label>
                <input
                  type="text"
                  id="reference-topic" name="reference-topic" autoComplete="off" value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. A robot learning to dance…"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500"
                  onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                />
              </div>

              <div className="mb-6 space-y-2">
                <label htmlFor="reference-lyrics" className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <ClipboardList aria-hidden="true" className="w-4 h-4 text-sky-400" /> Paste Song Lyrics <span className="text-xs text-slate-500">(Optional, for an accurate structure)</span>
                </label>
                <textarea
                  id="reference-lyrics" name="reference-lyrics" autoComplete="off" value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                  rows={5}
                  placeholder={'Paste the reference song\'s lyrics to measure its real line counts, rhyme and meter.\nThey are only analyzed, never copied into the results.'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 font-mono leading-relaxed resize-y"
                />
                {lyrics.trim() && (
                  <p className="text-xs text-sky-400">
                    {lyrics.trim().split('\n').filter((l) => l.trim()).length} lines pasted. The app will count their lines and syllables exactly.
                  </p>
                )}
              </div>

              <div className="mb-6 space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2" htmlFor="youtube-link">
                  <Headphones aria-hidden="true" className="w-4 h-4 text-red-400" /> YouTube Music Link <span className="text-xs text-slate-500">(Optional, Gemini listens to it)</span>
                </label>
                <input
                  id="youtube-link"
                  name="youtube-link" spellCheck={false}
                  type="url"
                  inputMode="url"
                  value={youtube}
                  aria-invalid={fieldValidation('youtube-link') || undefined}
                    aria-describedby={fieldValidation('youtube-link') ? 'youtube-link-error' : 'youtube-help'}
                    onChange={(e) => {
                      setYoutube(e.target.value);
                      if (fieldValidation('youtube-link')) setValidation(null);
                    }}
                  placeholder="https://youtu.be/…"
                  autoComplete="off"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                />
                {validationMessage('youtube-link')}
                <p id="youtube-help" className="text-xs text-slate-500">
                  Gemini hears the actual recording for instruments, vocals, production and structure. Free on Gemini's free tier (Google allows about 8 hours of YouTube audio a day); a key with billing turned on pays for roughly 25,000 tokens per 4-minute song. The track must be public.
                </p>
              </div>

              <div className="mb-6 space-y-3 border-t border-slate-800 pt-6">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Plug aria-hidden="true" className="w-4 h-4 text-emerald-400" /> Ground with MCP audio analysis
                  </span>
                  <input
                    type="checkbox"
                    name="musicatlas-enabled" checked={useMcp}
                    onChange={(e) => setUseMcp(e.target.checked)}
                    className="w-5 h-5 accent-emerald-500"
                  />
                </label>
                {useMcp && (
                  <>
                    <p className="text-xs text-slate-500">
                      Use MusicAtlas measurements and similar tracks to ground the prompt in the reference recording.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        name="musicatlas-url" aria-label="MusicAtlas server URL" autoComplete="off" spellCheck={false}
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder={DEFAULT_MCP_URL}
                        className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 font-mono"
                      />
                      <button
                        type="button"
                        onClick={testMcp}
                        disabled={testing}
                        className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 flex items-center gap-1 disabled:opacity-50"
                      >
                        {testing ? <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" /> : <Radio aria-hidden="true" className="w-3 h-3" />} Test
                      </button>
                    </div>
                    {mcpUrl.trim() !== DEFAULT_MCP_URL && (
                      <button type="button" onClick={() => setMcpUrl(DEFAULT_MCP_URL)} className="text-xs text-slate-500 hover:text-slate-300 underline">
                        Reset to default (MusicAtlas via proxy)
                      </button>
                    )}
                    {mcpTest && (
                      <p role="status" className={`text-xs break-words ${mcpTest.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{mcpTest.text}</p>
                    )}
                  </>
                )}
              </div>

              <div className="mb-6 space-y-2 border-t border-slate-800 pt-6">
                <label htmlFor="gemini-key" className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <Key aria-hidden="true" className="w-4 h-4 text-yellow-400" /> Gemini API Key <span className="text-red-400">*</span>
                </label>
                <input
                  type="password"
                  id="gemini-key" name="gemini-key" spellCheck={false} value={customKey}
                  aria-invalid={fieldValidation('gemini-key') || undefined}
                    aria-describedby={fieldValidation('gemini-key') ? 'gemini-key-error' : undefined}
                    onChange={(e) => {
                      setCustomKey(e.target.value);
                      if (fieldValidation('gemini-key')) setValidation(null);
                    }}
                  placeholder="Paste your Gemini API key…"
                  autoComplete="off"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500"
                />
                {validationMessage('gemini-key')}
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                    <input type="checkbox" name="remember-key" checked={rememberKey} onChange={(e) => setRememberKey(e.target.checked)} className="accent-yellow-500" />
                    Remember key on this device
                  </label>
                  {rememberKey && customKey && (
                    <button type="button" onClick={() => setCustomKey('')} className="text-xs text-slate-500 hover:text-slate-300 underline">
                      Forget key
                    </button>
                  )}
                </div>
                {rememberKey && (
                  <p className="text-xs text-slate-500">Saved unencrypted in this browser only. Use a key restricted to the Gemini API, and don't check this on a shared computer.</p>
                )}
                <div className="bp-model-row flex items-center gap-2 pt-1">
                  <label className="text-xs text-slate-400 shrink-0" htmlFor="gemini-model">Model</label>
                  <select
                    id="gemini-model" name="gemini-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!models.length}
                    className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono disabled:opacity-50"
                  >
                    {!models.length && <option value={model}>{modelsLoading ? 'Loading models…' : (model || 'Paste your key to load models')}</option>}
                    {models.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                  {modelsLoading && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin text-slate-500" />}
                </div>
                {modelsError && <p role="alert" className="text-xs text-amber-400 break-words">{modelsError}</p>}
              </div>

              {mcpWarning && (
                <div className="mb-6 p-3 bg-amber-900/20 border border-amber-800/60 rounded-lg flex items-start gap-3 text-amber-200">
                  <AlertCircle aria-hidden="true" className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p className="text-xs break-words">{mcpWarning}</p>
                </div>
              )}

              {error && (
                <div role="alert" className="mb-6 p-4 bg-red-900/20 border border-red-800 rounded-lg flex items-center gap-3 text-red-200">
                  <AlertCircle aria-hidden="true" className="w-5 h-5 flex-shrink-0" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
              <button
                onClick={generatePrompt}
                disabled={loading}
                className="bp-action flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 aria-hidden="true" className="w-5 h-5 animate-spin" /> {mcpStage === 'mcp' ? 'Listening via MusicAtlas…' : 'Analyzing & Writing…'}
                  </>
                ) : (
                  <>
                    <Sparkles aria-hidden="true" className="w-5 h-5" /> Generate Prompt
                  </>
                )}
              </button>
              {loading ? (
                <button
                  type="button"
                  onClick={stopGenerating}
                  title="Stop generating and keep what has been written so far"
                  className="px-5 rounded-xl border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium flex items-center gap-2"
                >
                  <Square aria-hidden="true" className="w-4 h-4 fill-current" /> Stop
                </button>
              ) : (
              <button
                type="button"
                onClick={clearAll}
                title="Clear the song fields and results (keeps your key and settings)"
                className="px-5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium flex items-center gap-2"
              >
                <Eraser aria-hidden="true" className="w-4 h-4" /> Clear
              </button>
              )}
              </div>
              <div className="bp-form-feedback" role="status">
                {loading ? (genStatus || (writing ? 'Writing your blueprint…' : 'Preparing your blueprint…')) : status}
              </div>
              {result && !loading && <a className="bp-form-jump" href="#blueprint-output">View blueprint output</a>}
            </div>
          </section>

          <section className="bp-output space-y-5" aria-labelledby="blueprint-output">
            <div className="bp-output-head" id="blueprint-output" tabIndex={-1}>
              <h2 className="bp-output-title">Blueprint output</h2>
            </div>
            {(loading || status || view?.example) && (
              <div className="flex items-center gap-3 flex-wrap text-sm text-slate-400 min-h-6">
                {view?.example && !loading && (
                  <span className="text-xs font-medium px-2 py-1 rounded-md bg-amber-400/10 text-amber-300">Example output</span>
                )}
                {loading && <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" aria-hidden="true" />}
                <span>{loading ? liveStatus : status || 'Sample results for the French house arrangement.'}</span>
              </div>
            )}
            {result?.run && !result.streaming && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-sm">
                <button
                  type="button"
                  onClick={saveToSpec}
                  title="Write this result's style, structure, stems and reference into the song spec the other GP Song Tools read"
                  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 hover:bg-slate-700 text-slate-100 font-medium flex items-center gap-2"
                >
                  <Save aria-hidden="true" className="w-4 h-4" /> Save to song spec
                </button>
                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input type="checkbox" name="set-song-tempo-and-key" checked={setBpmKey} onChange={(e) => setSetBpmKey(e.target.checked)} className="accent-purple-500" />
                  Set the song's BPM and key{bpmKeyNote(specDoc) ? ` (${bpmKeyNote(specDoc)})` : ''}
                </label>
                {specMsg && <span role="status" className={`w-full text-xs ${specMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{specMsg.text}</span>}
              </div>
            )}
            {view ? (
              <div className="space-y-4">
                <article className="bg-slate-900 border border-slate-700">
                  <div className="bp-result-actions px-6 py-4 border-b border-slate-700">
                    <h3 className="bp-result-heading flex items-center gap-2">
                      <Play aria-hidden="true" className="w-4 h-4 fill-current" /> {view.target === 'mozart' ? 'Mozart Prompt · Hans 2.0' : 'Suno Style Prompt'}
                    </h3>
                    {copyButton(view.style, 'tags', 'Copy', 'Copy style prompt')}
                  </div>
                  <div className="p-6">
                    {view.style ? (
                      <p className="text-base leading-relaxed text-slate-200 whitespace-pre-wrap">
                        {view.target === 'mozart' ? view.style : (<>
                          <span className="block mb-2 font-medium text-slate-100">{view.style.split('\n')[0]}</span>
                          {view.style.split('\n').slice(1).join('\n').trim()}
                        </>)}
                      </p>
                    ) : waiting(view.streaming ? 'Writing the style prompt…' : 'No style prompt.')}
                    {view.style && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className={
                        view.style.length > styleMax ? 'text-red-400 font-medium'
                          : view.style.length > styleMax * 0.9 ? 'text-amber-300 font-medium'
                          : 'text-emerald-400 font-medium'
                      }>
                        {view.style.length.toLocaleString()} / {styleMax.toLocaleString()} chars
                      </span>
                      {view.styleTrimmed && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                          <span className="text-amber-300">Shortened to fit</span>
                        </>
                      )}
                      <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                      <span>{view.target === 'mozart'
                        ? "Paste into Mozart's prompt box with Hans 2.0 selected. Hans treats tempo and key as suggestions."
                        : 'Ready for Suno.ai "Style of Music" box'}</span>
                      {modelUsed && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                          <span className={modelUsed !== model ? 'text-amber-300' : ''}>
                            {modelUsed !== model ? `Written by ${modelUsed} (${model} was busy)` : `Written by ${modelUsed}`}
                          </span>
                        </>
                      )}
                    </div>
                    )}
                  </div>
                </article>

                {view.target !== 'mozart' && (
                <article className="bg-slate-900 border border-slate-700 p-6">
                  <h3 className="bp-result-heading flex items-center gap-2 mb-1">
                    <Layers aria-hidden="true" className="w-4 h-4" /> Stem Layer Prompts
                  </h3>
                  <p className="text-xs text-slate-500 mb-4">One prompt per instrument group, each for generating that layer on its own in Suno.</p>
                  {view.stems.length === 0 && waiting(view.streaming ? 'Waiting for stem prompts…' : 'No stem prompts.')}
                  <div className="space-y-3">
                    {view.stems.map((stem, i) => (
                      <div key={i} className="bp-stem">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold min-w-0" style={{ color: STEM_COLORS[i % STEM_COLORS.length] }}>
                            {stem.group}
                          </span>
                          {copyButton(stem.prompt, `stem-${i}`, 'Copy', `Copy ${stem.group} prompt`)}
                        </div>
                        <p className="mt-2 text-sm text-slate-300 leading-relaxed">{stem.prompt}</p>
                      </div>
                    ))}
                  </div>
                </article>
                )}

                <article className="bg-slate-900 border border-slate-700 p-6">
                  <div className="bp-result-actions mb-4">
                    <h3 className="bp-result-heading flex items-center gap-2">
                      <ListMusic aria-hidden="true" className="w-4 h-4" /> Song Structure & Meter
                    </h3>
                    {copyButton(formatStructure(view), 'struct', 'Copy', 'Copy song structure')}
                  </div>
                  <div className="bp-metrics mb-4">
                    {[
                      [view.bpm, view.example ? 'Tempo (BPM)' : view.measured?.bpm ? 'Tempo (MusicAtlas)' : 'Tempo (Gemini)'],
                      [view.key, view.example ? 'Key' : view.measured?.key ? 'Key (MusicAtlas)' : 'Key (Gemini)'],
                      [total ? formatDuration(total) : '', 'Duration'],
                      [view.sections.length ? String(view.sections.length) : '', 'Sections'],
                    ].filter(([v]) => v).map(([v, label]) => (
                      <div key={label} className="bp-metric flex flex-col">
                        <span className="bp-readout text-slate-100">{v}</span>
                        <span className={`bp-label ${label.includes('MusicAtlas') ? 'text-emerald-400' : 'text-slate-500'}`}>{label}</span>
                      </div>
                    ))}
                  </div>
                  {!view.example && (view.bpm || view.key || total > 0) && (
                    <p className="text-xs text-slate-500 -mt-2 mb-4">{!view.example && originText(view, total > 0)}</p>
                  )}
                  {total > 0 && (
                    <>
                      <div className="bp-timeline flex rounded-sm overflow-hidden" aria-hidden="true">
                        {view.sections.map((sec, i) => (
                          <div
                            key={i}
                            title={`${sec.name} · ${sec.seconds}s`}
                            style={{ flex: `0 0 ${((Number(sec.seconds) || 0) / total) * 100}%`, background: STEM_COLORS[i % STEM_COLORS.length] }}
                            className="min-w-[2px] border-r border-slate-950"
                          />
                        ))}
                      </div>
                      <div className="flex justify-between text-xs text-slate-500 mt-1 mb-4" aria-hidden="true">
                        <span>0:00</span><span>{formatDuration(total)}</span>
                      </div>
                    </>
                  )}
                  {view.sections.length === 0 && waiting(view.streaming ? 'Waiting for the structure…' : 'No structure.')}
                  <div className="space-y-3">
                    {view.sections.map((sec, i) => (
                      <div key={i} className="bp-section-row">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="text-sm text-slate-100 flex items-start gap-2 min-w-0 break-words">
                            <i className="w-2.5 h-2.5 rounded-sm shrink-0 mt-1" style={{ background: STEM_COLORS[i % STEM_COLORS.length] }} />
                            {sectionHeader(sec)}
                          </span>
                          <span className="text-xs text-slate-400">
                            <b className="text-slate-200 font-medium">{sec.bars} bars</b> · {sec.seconds}s · {sec.lines > 0
                              ? (sec.counted
                                ? <><span className="text-emerald-400" title="Counted by the app from your pasted lyrics">{sec.lines} lines · {sec.meter}</span> · {sec.rhyme}</>
                                : `${sec.lines} lines · ${sec.rhyme} · ${sec.meter}`)
                              : 'instrumental'}
                          </span>
                        </div>
                        {sec.description && <p className="text-sm text-slate-400 mt-1.5">{sec.description}</p>}
                        {sec.counted && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer text-slate-500">Syllables per line</summary>
                            <ol className="mt-1.5 font-mono text-slate-500 space-y-0.5">
                              {sec.counted.lines.map((line, k) => (
                                <li key={k}><b className="inline-block min-w-[2.2em] text-slate-200 font-medium">{sec.counted.syl[k]}</b>{line}</li>
                              ))}
                            </ol>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-3">
                    {view.source ? `${view.source} · ` : ''}Rhyme letters mark end-rhyme groups · meter is syllables per line
                  </p>
                </article>

                <article className="bg-slate-900 border border-slate-700 p-6">
                  <div className="bp-result-actions mb-4">
                    <h3 className="bp-result-heading flex items-center gap-2">
                      <FileText aria-hidden="true" className="w-4 h-4" /> Sample Lyrics for {view.target === 'mozart' ? 'Mozart' : 'Suno'}
                    </h3>
                    {copyButton(view.lyrics, 'lyrics', 'Copy Lyrics')}
                  </div>
                  <div className="bp-lyrics-sheet">
                    {view.lyrics ? (
                      <pre className="text-slate-300 whitespace-pre-wrap font-mono text-sm leading-relaxed">
                        {view.lyrics.split('\n').map((line, i) => (
                          <React.Fragment key={i}>
                            {/^\s*\[.*\]\s*$/.test(line) ? <span className="text-amber-300">{line}</span> : line}{'\n'}
                          </React.Fragment>
                        ))}
                      </pre>
                    ) : waiting(view.streaming ? 'Waiting for lyrics…' : 'No lyrics.')}
                  </div>
                  <p className="text-xs text-slate-500 mt-3">
                    Original lyrics written to fit the structure above, {view.target === 'mozart'
                      ? "with section tags. Paste into Mozart's lyrics box (custom lyrics)."
                      : "with Suno section tags. Paste into Suno's lyrics box."}
                    {view.check && <span className="text-slate-400"> · {view.check}</span>}
                  </p>
                </article>

                {mcpContext && mcpContext.toolsUsed.length > 0 && (
                  <div className="bg-slate-900 rounded-2xl border border-emerald-500/20 p-6 shadow-lg">
                    <h3 className="bp-result-heading">
                    <button
                      type="button"
                      onClick={() => setShowRaw(!showRaw)} aria-expanded={showRaw} aria-controls="musicatlas-data"
                      className="w-full flex justify-between items-center text-left"
                    >
                      <span className="flex items-center gap-2">
                        <Users aria-hidden="true" className="w-4 h-4" /> MusicAtlas Data Gemini Used
                      </span>
                      <ChevronDown aria-hidden="true" className={`w-4 h-4 text-slate-500 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
                    </button>
                    </h3>
                    <p className="text-xs text-slate-500 mt-2">Grounded with: {mcpContext.toolsUsed.join(', ')}</p>
                      <div id="musicatlas-data" hidden={!showRaw} className="mt-4 space-y-4">
                        {[['Track analysis', mcpContext.trackAnalysis], ['Similar tracks', mcpContext.similarTracks], ['Similar artists', mcpContext.similarArtists]]
                          .filter(([, v]) => v)
                          .map(([label, v]) => (
                            <div key={label}>
                              <p className="text-xs text-slate-400 mb-1">{label}</p>
                              <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-950 p-4 rounded-xl border border-slate-800/50 max-h-72 overflow-auto">{v}</p>
                            </div>
                          ))}
                      </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="min-h-64 flex flex-col items-center justify-center border border-dashed border-slate-700 rounded-xl px-5 py-10 text-slate-500 text-center bg-slate-900/20">
                {loading ? (
                  <div className="flex flex-col items-center animate-in fade-in duration-300">
                    <Loader2 aria-hidden="true" className="w-12 h-12 animate-spin text-purple-500 mb-6" />
                    <p className="text-lg text-slate-300 font-medium">{mcpStage === 'mcp' ? 'Fetching audio analysis over MCP…' : 'Analyzing Musical Style…'}</p>
                    <p className="text-sm mt-2 max-w-sm">Generating the style prompt, song structure, and writing original lyrics.</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center animate-in fade-in zoom-in-95 duration-500">
                    <Sparkles aria-hidden="true" className="w-12 h-12 text-slate-500 mb-6" />
                    <p className="text-lg text-slate-400 font-medium">No results generated yet.</p>
                    <p className="text-sm mt-2 max-w-sm">Add a track reference and select Generate Prompt to see your blueprint here.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
      <footer className="bp-footer bp-shell">
        <a href="changelog.html" className="underline">Changelog</a>
        <a href="https://gp-songtools.github.io/toolsmenu/privacy.html" className="underline">Privacy &amp; credits</a>
      </footer>
    </div>
  );
}
