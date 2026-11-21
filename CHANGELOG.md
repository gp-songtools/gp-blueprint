# Changelog

All notable changes to GP Blueprint (formerly Suno Style Creator), newest first. The app has no version numbers, so entries are grouped by date.

## 2026-11-20 — Blueprint workspace

### Changed

- Redesigned the generator and changelog with larger type, more readable arrangement details and layouts for desktop and mobile.
- The example follows the selected Suno or Mozart AI mode. A shortcut opens the example or result from the top of the workspace.
- Form errors identify the field to correct. Generation status appears next to the Generate Prompt button.

### Fixed

- The browser tab uses the same arrangement mark as the app header.

## 2026-11-18 — Song spec

### Added

- **Song spec panel** at the top of the form: the song file shared by the GP Song Tools in this browser. See which tool filled each part and when, clear a part, start a new song, open a `.songspec.md` file or download one to hand to Claude.
- **From the song spec:** when other tools have saved Idea Wizard's topic, Lyricpad's lyrics or Earprint's analysis, the form offers them. Use the topic or lyrics with one click, and tick whether to add Earprint's analysis to the prompt. When a result used any of them, the status line says which.
- **Save to song spec** under the results stores the style prompt, song structure, stem prompts and the artist, song and link you used, marked "never send to Suno". In Mozart mode the Style part holds the Mozart prompt and Stems is left empty. **Set the song's BPM and key** (on by default) also saves the tempo and key, and says when it would replace Earprint's.

## 2026-11-17 — Mozart AI prompts

### Added

- **Choose Suno or Mozart AI** at the top of the form. Mozart mode gives a short prompt for Mozart's Hans 2.0 model (genre, mood, instruments, vocals, BPM and key, and what the song is about, in up to 280 characters), plus the song structure with plain section tags like [CHORUS] and lyrics under 3,000 characters. Your choice is remembered on this device.

### Changed

- **Suno style prompts follow a clearer order**: genre with subgenre influences, mood, main and supporting instruments, vocals, how the song develops, then production.

## 2026-11-14 — Pipe-separated section tags

### Changed

- **Section tags in the song structure and lyrics now use pipes**, like `[CHORUS|euphoric|soaring vocals|full band|explosive lift|wide reverb|polished mix]`. Elements follow Suno's weighting, most important first: mood/energy, vocal style, key instruments, dynamics, space/effects, production. Each tag has at most 7 elements, never mixes contradictory ones, and always fits the style prompt.

## 2026-11-09 — Visit statistics and credits

### Added

- **Changelog** and **Privacy & credits** links at the bottom of the page.

### Changed

- The browser tab now shows GP Blueprint's own icon, 🎨, the same one as on the GP Song Tools menu, on every page.
- **Renamed to GP Blueprint** (formerly Suno Style Creator, shown in the app as SunoPrompt AI), to match the other GP Song Tools.
- **New address:** https://gp-songtools.github.io/gp-blueprint/ (was `/suno-style-creator/`). Update any bookmarks. Your saved key (if remembered), model and MusicAtlas settings carry over.
- The app now counts visits with Cloudflare Web Analytics: anonymous totals only, with no cookies. It never sees what you type or your key. The Privacy & credits page explains what it reports.

## 2026-11-08 — Changelog page

### Added

- A **Changelog page** (`changelog.html`) that shows this changelog in a readable layout, with the newest changes first.

## 2026-11-07 — Measurement sources

### Added

- The BPM and Key tiles say where each value came from: **MusicAtlas** (measured from the audio) or **Gemini** (estimate). A line under the tiles explains how each was obtained, and why MusicAtlas didn't measure when it didn't (turned off, no song title, or no data).

### Fixed

- A tab opened before a site update could fail on Generate with "Failed to fetch dynamically imported module". Older files now stay available after an update.

## 2026-11-06 — Structure for Lyricpad

### Changed

- The copied **Song structure** now gives one rhyme letter and one syllable count per lyric line, labelled, so [Lyricpad](https://github.com/gp-songtools/lyricpad) can write a whole song from it. The format is documented in `docs/structure-format.md`.

### Fixed

- At narrow widths, results scrolled underneath the form. The form now stays in place only in the two-column layout.
- A MusicAtlas "not found" error now explains that it doesn't know that artist or track yet, instead of showing the raw error.

## 2026-11-05 — Live streaming, YouTube Music, remember key

### Added

- **Optional YouTube Music link**: Gemini listens to the recording.
- Results **stream in live**, with a **Stop** button that keeps the partial output and an elapsed-time status.
- Pasted lyrics are counted in the app (lines and per-line syllables), and the generated lyrics get a **meter check**.
- Meters row and coloured section timeline.
- Labelled example output before the first run.
- **Remember key on this device** for the Gemini key. It's off by default; unticking it or pressing Forget key removes the saved key.

### Changed

- Tempo and key measured by MusicAtlas now override Gemini's estimates.
- The site moved to https://gp-songtools.github.io/suno-style-creator/.

## 2026-10-31 — MusicAtlas grounding, Gemini model choice, richer output

### Added

- **MusicAtlas grounding**: before calling Gemini, the app fetches real audio analysis (track description, similar tracks, similar artists) and shows it in a **MusicAtlas Reference Data** panel. It can be turned off or pointed at another MCP server, with a **Test** button. If the server can't be reached, the app warns and carries on without it.
- **Model dropdown**: the app lists the Gemini models your key can use and picks the newest stable Flash model by default. Your choice is remembered.
- **Busy fallback**: if the chosen model is overloaded or times out, the app retries once, then tries up to two other Flash models, showing which one it's trying and which one wrote the result.
- **Stem prompts**: one Suno stem prompt per instrument group in the song, each with its own Copy button.
- **Song structure & meter**: per section, bars, seconds, lyric lines, rhyme scheme, syllable meter, description and Suno tag, measured from pasted lyrics when given.
- **Paste Song Lyrics** box, and original **sample lyrics** on your topic that fit the structure exactly.
- **Clear** button: empties the song fields and results but keeps the key, model and MusicAtlas settings.

### Changed

- The style tags became a descriptive **Suno Style Prompt** of up to 1,000 characters, with a character counter. Over-long prompts are cut at the last full sentence that fits. The prompt never contains artist or song names.
- MusicAtlas tools are called one at a time, retrying once on server errors.

### Fixed

- The page's styles were never actually applied (Tailwind wasn't compiled). They now are.
- Requests could hang forever. Each now times out after 120 seconds.

## 2026-05-17 — Deploy to GitHub Pages

### Added

- Pushes to `main` deploy the app to GitHub Pages.

## 2026-03-11 — First version

### Added

- Generates Suno style tags, a song structure, a rhyme scheme and sample lyrics from an artist, an optional song and an optional topic, using Gemini.
