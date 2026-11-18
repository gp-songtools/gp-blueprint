// GP Blueprint's side of the GP Song Tools song spec (format: gp-songtools/toolsmenu songspec/SPEC.md).
// Reads optional inputs (Idea's topic, Lyrics, Earprint's analysis) and writes the sections Blueprint
// owns: Style, Structure, Stems, Reference, plus bpm/key when asked. No React here.
import './songspec.js'; // vendored copy; sets globalThis.SongSpec
import { formatStructure } from './lyrics.js';

export const SongSpec = globalThis.SongSpec;
export const TOOL = 'gp-blueprint';
const S = SongSpec;

const LABELS = { idea: 'Topic', lyrics: 'Lyrics', analysis: 'Analysis' };

/** What the song spec offers as optional inputs; each is null when missing or empty. */
export function specInputs(doc) {
  const idea = S.section(doc, 'idea');
  const topic = idea?.body.match(/^Topic:\s*(.+)$/m)?.[1]?.trim() || '';
  const lyrics = S.section(doc, 'lyrics');
  const analysis = S.section(doc, 'analysis');
  return {
    topic: topic ? { text: topic, by: idea.by } : null,
    lyrics: lyrics ? { text: lyrics.body, by: lyrics.by } : null,
    analysis: analysis ? { text: analysis.body, by: analysis.by } : null,
  };
}

const same = (a, b) => S.normalize(a) === S.normalize(b);

/**
 * Which song spec sections a run actually used: the topic and lyrics fields count only when they
 * still hold the spec's text; the analysis counts when it was added to the prompt.
 */
export function usedSections(inputs, { topic, lyrics, analysis }) {
  const used = [];
  if (inputs.topic && topic.trim() && same(topic, inputs.topic.text)) used.push('idea');
  if (inputs.lyrics && lyrics.trim() && same(lyrics, inputs.lyrics.text)) used.push('lyrics');
  if (inputs.analysis && analysis) used.push('analysis');
  return used;
}

/** "Topic (Idea Wizard), Analysis (Earprint)" for the status line. */
export function usedText(doc, used) {
  return used.map((id) => `${LABELS[id]} (${S.toolName(S.section(doc, id)?.by)})`).join(', ');
}

/** Earprint's analysis as a prompt block (reference only, like MusicAtlas data). */
export function analysisBlock(text) {
  return text ? `
EARPRINT ANALYSIS (measured by the user's own analyzer, usually from their own recording; tempo and key were measured from the audio, the rest is an AI review). Use it as reference for tempo, key, mood, instruments and vocals. Never name any track, artist or file it mentions.
<earprint>
${text}
</earprint>
` : '';
}

/** "replaces 89 BPM, Ab minor from Earprint" when another tool set them, else ''. */
export function bpmKeyNote(doc) {
  const by = S.setting(doc, 'bpm_key_by');
  const bpm = S.setting(doc, 'bpm');
  const key = S.setting(doc, 'key');
  if (!by || by === TOOL || !(bpm || key)) return '';
  return `replaces ${[bpm && `${bpm} BPM`, key].filter(Boolean).join(', ')} from ${S.toolName(by)}`;
}

/** Reasons to ask before saving over sections Blueprint owns (hand edits, locks). */
export function overwriteNotes(doc) {
  return ['style', 'structure', 'stems', 'reference'].map((id) => S.confirmReason(doc, id, TOOL)).filter(Boolean);
}

/**
 * Write one finished result into the spec. Replaces all of Blueprint's sections so they always come
 * from the same run (a Mozart run has no stems, so Stems is emptied). `run` = what the run used:
 * { artist, song, youtube, used: [section ids] }.
 */
export function specWrite(doc, r, run, { setBpmKey = true, at } = {}) {
  const from = run.used || [];
  const opts = { by: TOOL, from, at };
  S.setSection(doc, 'style', r.style || '', opts);
  S.setSection(doc, 'structure', r.sections?.length ? formatStructure(r) : '', opts);
  S.setSection(doc, 'stems', (r.stems || []).map((s) => `${s.group} || ${s.prompt}`).join('\n'), opts);
  S.setSection(doc, 'reference', [
    run.artist && `Artist: ${run.artist}`, run.song && `Song: ${run.song}`, run.youtube && `YouTube: ${run.youtube}`,
  ].filter(Boolean).join('\n'), { by: TOOL, at });
  if (setBpmKey) {
    const bpm = Math.round(Number(String(r.bpm || '').replace(/[^\d.]/g, '')));
    const key = String(r.key || '').trim();
    if ((bpm >= 1 && bpm <= 300) || key) {
      S.setSetting(doc, 'bpm', bpm >= 1 && bpm <= 300 ? String(bpm) : '', { by: TOOL });
      S.setSetting(doc, 'key', key, { by: TOOL });
      S.setSetting(doc, 'bpm_key_by', TOOL, { by: TOOL });
    }
  }
  return doc;
}
