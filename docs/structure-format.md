# Song structure copy format

What the **Copy** button on the Song Structure card produces (`formatStructure` in `src/lyrics.js`).
Lyricpad reads this text when the user pastes it, together with its own Topic field, and has AI write lyrics that fit it.
If you change the format, change Lyricpad's parser too.

## Example

```
89 BPM, Ab minor

[INTRO: fuzz guitar]
4 bars, 11 secs, instrumental. Driving drums and fuzz guitar.

[VERSE 1: half-spoken, tense]
16 bars, 43 secs, 8 lines. Rhyme: ABABCDCD. Syllables: 8.7.8.7.8.7.8.7. Restless, half-spoken.

[CHORUS: shouted gang vocals]
8 bars, 22 secs, 4 lines. Rhyme: AABB. Syllables: 6.6.8.8. Big shouted hook.
```

## Rules

- **First line (optional):** `<bpm> BPM, <key>`, either part may be missing; followed by a blank line. Absent when neither is known.
- **Sections** are separated by one blank line. Each section is exactly two lines:
  1. **Header**: the Suno section tag, `[NAME]` or `[NAME: style hints]`. The name is upper case. Paste it into the lyrics as-is.
  2. **Details**:
     - Sung: `<bars> bars, <secs> secs, <n> lines. Rhyme: <letters>. Syllables: <n1>.<n2>.... <description>`
     - Instrumental: `<bars> bars, <secs> secs, instrumental. <description>`
- **Rhyme**: exactly one letter per lyric line, A–Z. Lines with the same letter end-rhyme; a letter used only once doesn't need to rhyme. May be missing.
- **Syllables**: exactly one whole number per lyric line, dot-separated, in line order. May be missing.
- **Description**: free text, always last on the line; may be missing.
- When pasted lyrics were analysed, line and syllable counts were counted exactly by the app; otherwise they are Gemini's targets.

## Parsing sketch

```js
function parseStructure(text) {
  const blocks = text.trim().split(/\n\s*\n/);
  const first = blocks[0].startsWith('[') ? '' : blocks.shift(); // optional "89 BPM, Ab minor"
  const head = /^(?:(\d+(?:\.\d+)?) BPM)?(?:,?\s*(.+))?$/.exec(first);
  const sections = blocks.map((b) => {
    const [tag, details = ''] = b.split('\n');
    const lines = Number(/(\d+) lines\./.exec(details)?.[1] || 0);
    return {
      tag: tag.trim(),
      bars: Number(/(\d+) bars/.exec(details)?.[1] || 0),
      seconds: Number(/(\d+) secs/.exec(details)?.[1] || 0),
      lines,
      rhyme: /Rhyme: ([A-Z]+)\./.exec(details)?.[1] || '',
      syllables: (/Syllables: (\d+(?:\.\d+)*)\./.exec(details)?.[1] || '').split('.').filter(Boolean).map(Number),
    };
  });
  return { bpm: head?.[1] || '', key: head?.[2] || '', sections };
}
```
