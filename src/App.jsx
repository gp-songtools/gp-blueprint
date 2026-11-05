import React, { useState, useEffect, useRef } from 'react';
import { Music, Mic2, Disc, Copy, Check, Sparkles, AlertCircle, Loader2, Play, FileText, MessageSquare, Key, Plug, Radio, Users, ChevronDown, Layers, ListMusic, Eraser, ClipboardList, Headphones, Square } from 'lucide-react';
import { DEFAULT_MCP_URL, DIRECT_MUSICATLAS_URL } from './mcpConfig';

// The MCP SDK is loaded on demand so it doesn't weigh down the first page load.
const loadMcp = () => import('./mcp');
import { listModels, pickDefaultModel, fallbackModels, buildPrompt, generateSunoPrompt, parseSunoText, normalizeYouTubeUrl, fitStylePrompt, STYLE_PROMPT_MAX } from './gemini';
import { splitBlocks, applyCounts, sectionHeader, meterCheck, formatStructure, formatDuration } from './lyrics';

const readPref = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const writePref = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
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
    { name: 'Intro', bars: 8, seconds: 16, lines: 0, rhyme: '-', meter: '-', description: 'A filtered loop slowly opens up.', tags: '[Intro: filtered disco loop, building]' },
    { name: 'Verse 1', bars: 16, seconds: 31, lines: 4, rhyme: 'AABB', meter: '6.6.7.7', description: 'The groove settles in under the talk-box.', tags: '[Verse 1: talk-box vocal, steady groove]' },
    { name: 'Chorus', bars: 16, seconds: 31, lines: 4, rhyme: 'AAAA', meter: '5.5.5.5', description: 'The full band hits with the repeated hook.', tags: '[Chorus: full band, euphoric, repeated hook]' },
    { name: 'Breakdown', bars: 16, seconds: 31, lines: 0, rhyme: '-', meter: '-', description: 'Everything drops to a filtered loop before the return.', tags: '[Breakdown: filtered, sparse, rising tension]' },
  ],
  lyrics: '[Intro: filtered disco loop, building]\n\n[Verse 1: talk-box vocal, steady groove]\nHarbor lights are low\nWaiting for the show\nCity calling through the rain\nPulling me back home again\n\n[Chorus: full band, euphoric, repeated hook]\nOne more night out\nOne more night out\nOne more night out\nOne more night out\n\n[Breakdown: filtered, sparse, rising tension]',
  source: 'Example: structure of a typical french house track',
  check: '',
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


  const generatePrompt = async () => {
    if (loading) return;
    if (!artist.trim()) {
      setError('Please enter an artist name.');
      return;
    }
    if (!customKey.trim()) {
      setError('Please paste your Gemini API key.');
      return;
    }
    const youtubeUrl = youtube.trim() ? normalizeYouTubeUrl(youtube) : '';
    if (youtube.trim() && !youtubeUrl) {
      setError("That doesn't look like a YouTube Music song link. Copy it from the song's Share menu; it should contain \"watch?v=\".");
      return;
    }

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
    const blocks = pasted ? splitBlocks(pasted).slice(0, 40) : [];
    const source = blocks.length ? 'Lines and syllables (green) counted from your pasted lyrics. Section names, rhyme and tags by Gemini.'
      : youtubeUrl ? 'Heard by Gemini from the YouTube Music recording. Paste the lyrics for exact line and syllable counts.'
      : song.trim() ? "Gemini's estimate from its knowledge of the song. Paste the lyrics for exact counts."
      : 'Typical structure for this artist (no song given)';
    let measured = {};
    // Parsed text + the app's own counts + MusicAtlas's measured tempo/key.
    const compose = (text, final) => {
      const p = parseSunoText(text, final);
      const sections = applyCounts(p.sections, blocks);
      const style = final ? fitStylePrompt(p.style) : { text: p.style, trimmed: false };
      return {
        ...p, sections, style: style.text, styleTrimmed: style.trimmed,
        bpm: measured.bpm || p.bpm, key: measured.key || p.key,
        measured: { bpm: !!measured.bpm, key: !!measured.key },
        source, streaming: !final, check: final ? meterCheck(sections, p.lyrics) : '',
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
          reference: buildReferenceBlock(ctx),
          hasAudio: !!youtubeUrl,
        }),
      });
      const r = compose(text, true);
      setResult(r);
      setModelUsed(used);
      if (!r.style || !r.sections.length) setError("Gemini's answer was missing some parts. Press Generate to try again.");
      else if (truncated) setError('Gemini ran out of room before finishing. Press Generate to try again.');
      else setStatus('Done.');
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

  // Clears the song inputs and results; keeps the API key, model and MCP settings.
  const clearAll = () => {
    setArtist(''); setSong(''); setTopic(''); setLyrics(''); setYoutube('');
    setResult(null); setError(null); setModelUsed(null); setGenStatus(null);
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

  const view = result || (showExample ? EXAMPLE : null);
  const total = view ? view.sections.reduce((a, sec) => a + (Number(sec.seconds) || 0), 0) : 0;
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const liveStatus = mcpStage === 'mcp' ? `Asking MusicAtlas: ${mcpStep}...`
    : `${model || 'Gemini'} is ${writing ? 'writing' : youtube.trim() ? 'listening' : 'thinking'}... ${elapsed}s`;
  const waiting = (text) => <span className="text-sm italic text-slate-500">{text}</span>;
  const copyButton = (text, id, label = 'Copy') => (
    <button
      onClick={() => copyToClipboard(text, id)}
      className="text-xs font-medium px-3 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors flex items-center gap-2 border border-slate-700 shrink-0"
    >
      {copiedSection === id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      {copiedSection === id ? 'Copied' : label}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-purple-500 selection:text-white pb-12">
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-gradient-to-br from-purple-500 to-indigo-600 p-2 rounded-lg">
              <Music className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">
              SunoPrompt AI
            </h1>
          </div>
          <span className="text-xs font-medium px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700">
            v5.0 Gemini + MCP
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        
        <section className="text-center space-y-3 mb-4">
          <h2 className="text-3xl font-bold text-white">Generate Suno.ai Styles & Lyrics</h2>
          <p className="text-slate-400 max-w-lg mx-auto">
            Enter an artist, a song and a topic to get a Suno style prompt, per-instrument stem prompts, a section-by-section structure, and original Suno-ready lyrics.
          </p>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Panel: Form */}
          <div className="lg:col-span-5 sticky top-24">
            <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 shadow-xl backdrop-blur-sm">
              <div className="space-y-4 mb-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Mic2 className="w-4 h-4 text-purple-400" /> Artist Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                    placeholder="e.g. Daft Punk"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Disc className="w-4 h-4 text-indigo-400" /> Song Title <span className="text-xs text-slate-500">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={song}
                    onChange={(e) => setSong(e.target.value)}
                    placeholder="e.g. Harder, Better, Faster, Stronger"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                  />
                </div>
              </div>
              
              <div className="mb-6 space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-pink-400" /> Lyrical Topic <span className="text-xs text-slate-500">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What should the song be about? (e.g. A robot learning to love)"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent transition-all"
                  onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                />
              </div>

              <div className="mb-6 space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-sky-400" /> Paste Song Lyrics <span className="text-xs text-slate-500">(Optional, for an accurate structure)</span>
                </label>
                <textarea
                  value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                  rows={5}
                  placeholder={'Paste the reference song\'s lyrics to measure its real line counts, rhyme and meter.\nThey are only analyzed, never copied into the results.'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition-all"
                />
                {lyrics.trim() && (
                  <p className="text-xs text-sky-400">
                    {lyrics.trim().split('\n').filter((l) => l.trim()).length} lines pasted. The app will count their lines and syllables exactly.
                  </p>
                )}
              </div>

              <div className="mb-6 space-y-2">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2" htmlFor="youtube-link">
                  <Headphones className="w-4 h-4 text-red-400" /> YouTube Music Link <span className="text-xs text-slate-500">(Optional, Gemini listens to it)</span>
                </label>
                <input
                  id="youtube-link"
                  type="url"
                  inputMode="url"
                  value={youtube}
                  onChange={(e) => setYoutube(e.target.value)}
                  placeholder="https://music.youtube.com/watch?v=..."
                  autoComplete="off"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
                  onKeyDown={(e) => e.key === 'Enter' && generatePrompt()}
                />
                <p className="text-xs text-slate-500">
                  Gemini hears the actual recording for instruments, vocals, production and structure. Free on Gemini's free tier (Google allows about 8 hours of YouTube audio a day); a key with billing turned on pays for roughly 25,000 tokens per 4-minute song. The track must be public.
                </p>
              </div>

              <div className="mb-6 space-y-3 border-t border-slate-800 pt-6">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-sm font-medium text-slate-300 flex items-center gap-2">
                    <Plug className="w-4 h-4 text-emerald-400" /> Ground with MCP audio analysis
                  </span>
                  <input
                    type="checkbox"
                    checked={useMcp}
                    onChange={(e) => setUseMcp(e.target.checked)}
                    className="w-5 h-5 accent-emerald-500"
                  />
                </label>
                {useMcp && (
                  <>
                    <p className="text-xs text-slate-500">
                      Calls MusicAtlas tools (describe_track, find_similar_tracks, find_similar_artists) before writing the prompt, so the tags describe how the music really sounds.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder={DEFAULT_MCP_URL}
                        className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono"
                      />
                      <button
                        type="button"
                        onClick={testMcp}
                        disabled={testing}
                        className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 flex items-center gap-1 disabled:opacity-50"
                      >
                        {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />} Test
                      </button>
                    </div>
                    {mcpUrl.trim() !== DEFAULT_MCP_URL && (
                      <button type="button" onClick={() => setMcpUrl(DEFAULT_MCP_URL)} className="text-xs text-slate-500 hover:text-slate-300 underline">
                        Reset to default (MusicAtlas via proxy)
                      </button>
                    )}
                    {mcpTest && (
                      <p className={`text-xs break-words ${mcpTest.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{mcpTest.text}</p>
                    )}
                  </>
                )}
              </div>

              <div className="mb-6 space-y-2 border-t border-slate-800 pt-6">
                <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                  <Key className="w-4 h-4 text-yellow-400" /> Gemini API Key <span className="text-red-400">*</span>
                </label>
                <input
                  type="password"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="Paste your Google Gemini API key here..."
                  autoComplete="off"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent transition-all"
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                    <input type="checkbox" checked={rememberKey} onChange={(e) => setRememberKey(e.target.checked)} className="accent-yellow-500" />
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
                <div className="flex items-center gap-2 pt-1">
                  <label className="text-xs text-slate-400 shrink-0" htmlFor="gemini-model">Model</label>
                  <select
                    id="gemini-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!models.length}
                    className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono disabled:opacity-50"
                  >
                    {!models.length && <option value={model}>{modelsLoading ? 'Loading models...' : (model || 'Paste your key to load models')}</option>}
                    {models.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                  {modelsLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
                </div>
                {modelsError && <p className="text-xs text-amber-400 break-words">{modelsError}</p>}
              </div>

              {mcpWarning && (
                <div className="mb-6 p-3 bg-amber-900/20 border border-amber-800/60 rounded-lg flex items-start gap-3 text-amber-200">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p className="text-xs break-words">{mcpWarning}</p>
                </div>
              )}

              {error && (
                <div className="mb-6 p-4 bg-red-900/20 border border-red-800 rounded-lg flex items-center gap-3 text-red-200">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              <div className="flex gap-3">
              <button
                onClick={generatePrompt}
                disabled={loading}
                className={`flex-1 py-4 rounded-xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 transition-all transform hover:scale-[1.01] active:scale-[0.99]
                  ${loading 
                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed' 
                    : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-purple-900/20'
                  }`}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" /> {mcpStage === 'mcp' ? 'Listening via MusicAtlas...' : 'Analyzing & Writing...'}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" /> Generate Prompt
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
                  <Square className="w-4 h-4 fill-current" /> Stop
                </button>
              ) : (
              <button
                type="button"
                onClick={clearAll}
                title="Clear the song fields and results (keeps your key and settings)"
                className="px-5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium flex items-center gap-2"
              >
                <Eraser className="w-4 h-4" /> Clear
              </button>
              )}
              </div>
            </div>
          </div>

          {/* Right Panel: Output */}
          <div className="lg:col-span-7 space-y-6">
            {(loading || status || view?.example) && (
              <div className="flex items-center gap-3 flex-wrap text-sm text-slate-400 min-h-6" aria-live="polite">
                {view?.example && !loading && (
                  <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded-full border border-amber-400/70 text-amber-300">Example output</span>
                )}
                {loading && <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" aria-hidden="true" />}
                <span>{loading ? liveStatus : status || 'Fill in an artist and press Generate. Below is what a result looks like.'}</span>
                {loading && genStatus && <span className="text-amber-300">{genStatus}</span>}
              </div>
            )}
            {view ? (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="bg-slate-900 rounded-2xl border border-purple-500/30 overflow-hidden shadow-2xl shadow-purple-900/10">
                  <div className="bg-slate-800/50 px-6 py-4 border-b border-slate-800 flex justify-between items-center">
                    <h3 className="font-semibold text-purple-300 flex items-center gap-2">
                      <Play className="w-4 h-4 fill-current" /> Suno Style Prompt
                    </h3>
                    {copyButton(view.style, 'tags')}
                  </div>
                  <div className="p-6">
                    {view.style ? (
                      <p className="text-base leading-relaxed text-slate-200 whitespace-pre-wrap">
                        <span className="block mb-2 font-medium text-slate-100">{view.style.split('\n')[0]}</span>
                        {view.style.split('\n').slice(1).join('\n').trim()}
                      </p>
                    ) : waiting(view.streaming ? 'Writing the style prompt...' : 'No style prompt.')}
                    {view.style && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className={
                        view.style.length > STYLE_PROMPT_MAX ? 'text-red-400 font-medium'
                          : view.style.length > STYLE_PROMPT_MAX * 0.9 ? 'text-amber-300 font-medium'
                          : 'text-emerald-400 font-medium'
                      }>
                        {view.style.length.toLocaleString()} / {STYLE_PROMPT_MAX.toLocaleString()} chars
                      </span>
                      {view.styleTrimmed && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                          <span className="text-amber-300">Shortened to fit</span>
                        </>
                      )}
                      <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                      <span>Ready for Suno.ai "Style of Music" box</span>
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
                </div>

                <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 shadow-lg">
                  <h4 className="font-medium text-amber-300 uppercase tracking-wider text-xs flex items-center gap-2 mb-1">
                    <Layers className="w-4 h-4" /> Stem Layer Prompts
                  </h4>
                  <p className="text-xs text-slate-500 mb-4">One prompt per instrument group, each for generating that layer on its own in Suno.</p>
                  {view.stems.length === 0 && waiting(view.streaming ? 'Waiting for stem prompts...' : 'No stem prompts.')}
                  <div className="space-y-3">
                    {view.stems.map((stem, i) => (
                      <div key={i} className="bg-slate-950 rounded-xl border border-slate-800/70 overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/70">
                          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: STEM_COLORS[i % STEM_COLORS.length] }}>
                            {stem.group}
                          </span>
                          {copyButton(stem.prompt, `stem-${i}`)}
                        </div>
                        <p className="px-4 py-3 text-sm text-slate-300 leading-relaxed">{stem.prompt}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 shadow-lg">
                  <div className="flex justify-between items-start mb-4 gap-3">
                    <h4 className="font-medium text-emerald-400 uppercase tracking-wider text-xs flex items-center gap-2">
                      <ListMusic className="w-4 h-4" /> Song Structure & Meter
                    </h4>
                    {copyButton(formatStructure(view), 'struct')}
                  </div>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {[
                      [view.bpm, view.measured?.bpm ? 'BPM · measured' : 'BPM'],
                      [view.key, view.measured?.key ? 'Key · measured' : 'Key'],
                      [total ? formatDuration(total) : '', 'Length'],
                      [view.sections.length ? String(view.sections.length) : '', 'Sections'],
                    ].filter(([v]) => v).map(([v, label]) => (
                      <div key={label} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 min-w-[92px] flex flex-col">
                        <span className="font-mono text-base text-slate-100">{v}</span>
                        <span className={`text-[10px] uppercase tracking-wider ${label.includes('measured') ? 'text-emerald-400' : 'text-slate-500'}`}>{label}</span>
                      </div>
                    ))}
                  </div>
                  {total > 0 && (
                    <>
                      <div className="flex h-7 rounded-md overflow-hidden border border-slate-800" aria-hidden="true">
                        {view.sections.map((sec, i) => (
                          <div
                            key={i}
                            title={`${sec.name} · ${sec.seconds}s`}
                            style={{ flex: `0 0 ${((Number(sec.seconds) || 0) / total) * 100}%`, background: STEM_COLORS[i % STEM_COLORS.length] }}
                            className="min-w-[2px] flex items-center px-1.5 text-[10px] font-mono text-slate-900 whitespace-nowrap overflow-hidden border-r border-slate-950"
                          >
                            {sec.name}
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-500 mt-1 mb-4" aria-hidden="true">
                        <span>0:00</span><span>{formatDuration(total)}</span>
                      </div>
                    </>
                  )}
                  {view.sections.length === 0 && waiting(view.streaming ? 'Waiting for the structure...' : 'No structure.')}
                  <div className="space-y-3">
                    {view.sections.map((sec, i) => (
                      <div key={i} className="bg-slate-950 rounded-xl border border-slate-800/70 px-4 py-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="text-sm font-mono text-slate-100 flex items-start gap-2 min-w-0 break-words">
                            <i className="w-2.5 h-2.5 rounded-sm shrink-0 mt-1" style={{ background: STEM_COLORS[i % STEM_COLORS.length] }} />
                            {sectionHeader(sec)}
                          </span>
                          <span className="text-xs font-mono text-slate-400">
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
                </div>

                <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 shadow-lg hover:border-slate-700 transition-colors">
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="font-medium text-indigo-400 uppercase tracking-wider text-xs flex items-center gap-2">
                      <FileText className="w-4 h-4" /> Sample Lyrics (Suno Ready)
                    </h4>
                    {copyButton(view.lyrics, 'lyrics', 'Copy Lyrics')}
                  </div>
                  <div className="bg-slate-950 p-6 rounded-xl border border-slate-800/50">
                    {view.lyrics ? (
                      <pre className="text-slate-300 whitespace-pre-wrap font-mono text-sm leading-relaxed">
                        {view.lyrics.split('\n').map((line, i) => (
                          <React.Fragment key={i}>
                            {/^\s*\[.*\]\s*$/.test(line) ? <span className="text-amber-300">{line}</span> : line}{'\n'}
                          </React.Fragment>
                        ))}
                      </pre>
                    ) : waiting(view.streaming ? 'Waiting for lyrics...' : 'No lyrics.')}
                  </div>
                  <p className="text-xs text-slate-500 mt-3">
                    Original lyrics written to fit the structure above, with Suno section tags. Paste into Suno's lyrics box.
                    {view.check && <span className="text-slate-400"> · {view.check}</span>}
                  </p>
                </div>

                {mcpContext && mcpContext.toolsUsed.length > 0 && (
                  <div className="bg-slate-900 rounded-2xl border border-emerald-500/20 p-6 shadow-lg">
                    <button
                      type="button"
                      onClick={() => setShowRaw(!showRaw)}
                      className="w-full flex justify-between items-center text-left"
                    >
                      <h4 className="font-medium text-emerald-400 uppercase tracking-wider text-xs flex items-center gap-2">
                        <Users className="w-4 h-4" /> MusicAtlas Data Gemini Used
                      </h4>
                      <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
                    </button>
                    <p className="text-xs text-slate-500 mt-2">Grounded with: {mcpContext.toolsUsed.join(', ')}</p>
                    {showRaw && (
                      <div className="mt-4 space-y-4">
                        {[['Track analysis', mcpContext.trackAnalysis], ['Similar tracks', mcpContext.similarTracks], ['Similar artists', mcpContext.similarArtists]]
                          .filter(([, v]) => v)
                          .map(([label, v]) => (
                            <div key={label}>
                              <p className="text-xs text-slate-400 mb-1">{label}</p>
                              <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-950 p-4 rounded-xl border border-slate-800/50 max-h-72 overflow-auto">{v}</p>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full min-h-[500px] flex flex-col items-center justify-center border-2 border-dashed border-slate-800/60 rounded-2xl p-12 text-slate-500 text-center bg-slate-900/20">
                {loading ? (
                  <div className="flex flex-col items-center animate-in fade-in duration-300">
                    <Loader2 className="w-12 h-12 animate-spin text-purple-500 mb-6" />
                    <p className="text-lg text-slate-300 font-medium">{mcpStage === 'mcp' ? 'Fetching audio analysis over MCP...' : 'Analyzing Musical Style...'}</p>
                    <p className="text-sm mt-2 max-w-sm">Generating Suno.ai tags, song structure, and writing original lyrics.</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center animate-in fade-in zoom-in-95 duration-500">
                    <Sparkles className="w-12 h-12 text-slate-700 mb-6" />
                    <p className="text-lg text-slate-400 font-medium">No results generated yet.</p>
                    <p className="text-sm mt-2 max-w-sm">Fill out the form on the left to create a highly optimized Suno.ai prompt based on any artist or theme.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
