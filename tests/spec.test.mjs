// GP Blueprint and the song spec: works with and without other tools' sections, and never
// changes anything it doesn't own. Run: npm test (Node's built-in runner, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongSpec as S, specInputs, usedSections, specWrite, bpmKeyNote, overwriteNotes, analysisBlock } from '../src/spec.js';

const RESULT = {
  target: 'suno', style: 'Indie folk, 89 BPM, Ab minor, soft breathy vocals. Fingerpicked guitar over warm pads.',
  bpm: '89', key: 'Ab minor',
  stems: [{ group: 'Drums & Percussion', prompt: 'Isolated Drums & Percussion stem: brushed snare.' }],
  sections: [
    { name: 'Intro', bars: '4', seconds: 11, lines: 0, rhyme: '-', meter: '-', description: 'Guitar alone.', tags: '[INTRO|calm|fingerpicked guitar]' },
    { name: 'Verse 1', bars: '16', seconds: 43, lines: 4, rhyme: 'ABAB', meter: '8.7.8.7', description: 'Quiet.', tags: '[VERSE 1|wistful]' },
  ],
};
const RUN = { artist: 'Some Artist', song: '', youtube: '', used: [] };

// Upstream sections from other tools, plus things nobody owns: an unknown key, an unknown section,
// a comment, CRLF-free spacing quirks. All of it must come through a Blueprint save byte for byte.
const UPSTREAM = `---
schema_version: 1
# my own comment
request: song
title: Paper Lanterns
model: v6
x_custom: keep me
---

# Song spec

## Idea
<!-- song-spec: by=ideawizard at=2026-11-17T14:02Z hash=00000000 -->
Title: Paper Lanterns
Topic: Letting go of a friendship
Hook: I let the light go up

## Idea structure
<!-- song-spec: by=ideawizard at=2026-11-17T14:05Z hash=00000000 -->
[VERSE 1]
16 bars, 43 secs, 8 lines. Rhyme: ABABCDCD.

## Analysis
<!-- song-spec: by=earprint at=2026-11-17T13:40Z hash=00000000 -->
Earprint analysis
Tempo: 91 BPM
Key: A minor (8A)

## Lyrics
<!-- song-spec: by=lyricpad at=2026-11-17T14:20Z hash=00000000 -->
[VERSE 1]
Your name still glows across my screen
A message never sent

## My extra section
Hand-written, unknown to every tool.

## Notes
<!-- song-spec: by=person manual=yes -->
Try a male voice.
`;

/** Every chunk of the file that GP Blueprint does not own, as raw text. */
function notOwned(text) {
  const doc = S.parse(text);
  const mine = new Set(['style', 'structure', 'stems', 'reference']);
  const mineKeys = new Set(['bpm', 'key', 'bpm_key_by', 'schema_version']);
  return {
    sections: doc.sections.filter((s) => !mine.has(s.id)).map((s) => s.head + s.lines.join('')),
    settings: (doc.fm?.items || []).filter((x) => !mineKeys.has(x.key)).map((x) => x.line),
    pre: doc.pre.join(''),
  };
}

test('no song spec at all: no inputs, and a save creates a valid spec', () => {
  const doc = S.parse('');
  const inp = specInputs(doc);
  assert.deepEqual(inp, { topic: null, lyrics: null, analysis: null });
  assert.deepEqual(usedSections(inp, { topic: 'my own topic', lyrics: '', analysis: true }), []);
  specWrite(doc, RESULT, RUN);
  const text = S.serialize(doc);
  assert.equal(S.validate(S.parse(text)).filter((i) => i.level === 'error').length, 0);
  assert.equal(S.section(S.parse(text), 'style').body, RESULT.style);
  assert.match(S.section(S.parse(text), 'structure').body, /^89 BPM, Ab minor\n\n\[INTRO\|calm\|fingerpicked guitar\]/);
  assert.equal(S.section(S.parse(text), 'style').marker.from && Object.keys(S.section(S.parse(text), 'style').marker.from).length, 0);
  assert.equal(S.setting(S.parse(text), 'bpm'), '89');
  assert.equal(S.setting(S.parse(text), 'bpm_key_by'), 'gp-blueprint');
});

test('empty sections count as missing', () => {
  const doc = S.parse('---\nschema_version: 1\n---\n\n## Idea\n\n## Lyrics\n\n## Analysis\n');
  assert.deepEqual(specInputs(doc), { topic: null, lyrics: null, analysis: null });
});

test('with upstream sections: offers them, records what was used, keeps everything else', () => {
  const doc = S.parse(UPSTREAM);
  const inp = specInputs(doc);
  assert.equal(inp.topic.text, 'Letting go of a friendship');
  assert.equal(inp.topic.by, 'ideawizard');
  assert.match(inp.lyrics.text, /^\[VERSE 1\]\nYour name/);
  assert.match(inp.analysis.text, /^Earprint analysis/);
  assert.match(analysisBlock(inp.analysis.text), /<earprint>\nEarprint analysis/);

  // Fields that still hold the spec's text count as used; an edited topic does not.
  assert.deepEqual(usedSections(inp, { topic: inp.topic.text, lyrics: inp.lyrics.text + '\n', analysis: true }), ['idea', 'lyrics', 'analysis']);
  assert.deepEqual(usedSections(inp, { topic: 'something else', lyrics: '', analysis: false }), []);

  const before = notOwned(UPSTREAM);
  specWrite(doc, RESULT, { ...RUN, used: ['idea', 'analysis'] });
  const after = S.serialize(doc);
  assert.deepEqual(notOwned(after), before, 'a Blueprint save changed something it does not own');
  const style = S.section(S.parse(after), 'style');
  assert.deepEqual(Object.keys(style.marker.from), ['idea', 'analysis']);
  assert.equal(style.stale.length, 0);
  assert.equal(S.section(S.parse(after), 'reference').body, 'Artist: Some Artist');
  // Sections land in the canonical order.
  assert.deepEqual(S.parse(after).sections.map((s) => s.id || s.heading),
    ['idea', 'idea-structure', 'reference', 'analysis', 'style', 'structure', 'stems', 'lyrics', 'My extra section', 'notes']);
});

test('a second save replaces only Blueprint sections, so a Mozart run empties Stems', () => {
  const doc = S.parse(UPSTREAM);
  specWrite(doc, RESULT, RUN);
  const before = notOwned(S.serialize(doc));
  specWrite(doc, { ...RESULT, target: 'mozart', style: 'Upbeat funky disco, 118 BPM, A minor', stems: [] }, RUN);
  const text = S.serialize(doc);
  assert.deepEqual(notOwned(text), before);
  assert.equal(S.section(S.parse(text), 'stems'), null);
  assert.equal(S.section(S.parse(text), 'style').body, 'Upbeat funky disco, 118 BPM, A minor');
});

test('BPM and key: rounded, optional, and the note names who set them before', () => {
  const doc = S.parse(UPSTREAM);
  S.setSetting(doc, 'bpm', '91', { by: 'earprint' });
  S.setSetting(doc, 'key', 'A minor', { by: 'earprint' });
  S.setSetting(doc, 'bpm_key_by', 'earprint', { by: 'earprint' });
  assert.equal(bpmKeyNote(doc), 'replaces 91 BPM, A minor from Earprint');

  specWrite(doc, RESULT, RUN, { setBpmKey: false });
  assert.equal(S.setting(doc, 'bpm'), '91', 'unticked: Earprint’s BPM stays');
  specWrite(doc, { ...RESULT, bpm: '89.6' }, RUN);
  assert.equal(S.setting(doc, 'bpm'), '90');
  assert.equal(S.setting(doc, 'key'), 'Ab minor');
  assert.equal(bpmKeyNote(doc), '');
});

test('asks before overwriting hand edits and locks, not its own untouched sections', () => {
  const doc = S.parse(UPSTREAM);
  specWrite(doc, RESULT, RUN);
  assert.deepEqual(overwriteNotes(doc), []);
  const edited = S.serialize(doc).replace('Fingerpicked guitar over warm pads.', 'Fingerpicked guitar, hand-edited.');
  assert.equal(overwriteNotes(S.parse(edited)).length, 1);
  assert.match(overwriteNotes(S.parse(edited))[0], /changed by hand/);
});

test('Blueprint cannot write sections it does not own', () => {
  const doc = S.parse(UPSTREAM);
  assert.throws(() => S.setSection(doc, 'lyrics', 'x', { by: 'gp-blueprint' }));
  assert.throws(() => S.setSetting(doc, 'title', 'x', { by: 'gp-blueprint' }));
});
