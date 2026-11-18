# CLAUDE.md

GP Blueprint (formerly Suno Style Creator / SunoPrompt AI): Suno prompt generator: artist/song/topic/lyrics/YouTube Music link → style prompt, stem prompts, section structure, lyrics.
React 19 + Vite 7, plain JavaScript (no TypeScript; `npm test` runs the song spec tests). Gemini REST API + MusicAtlas MCP. Deployed to GitHub Pages at https://gp-songtools.github.io/gp-blueprint/ (repo `gp-songtools/gp-blueprint`; renamed from `suno-style-creator` on 2026-11-09, moved from `pcarenza` before that).

## Commands (run from repo root; keep output quiet)
- Install: `npm ci --silent --no-audit --no-fund`
- Lint (the only static check; no type checker exists): `npx eslint . --quiet`
- Lint one file: `npx eslint src/gemini.js --quiet`
- Build: `npx vite build --logLevel warn` (output `dist/`, gitignored; delete after checking)
- Dev / preview: `npm run dev` / `npx vite preview --port 4173` → `http://localhost:4173/gp-blueprint/`
- Smoke-test a pure function (no test runner):
  `node -e "import('./src/gemini.js').then(m=>console.log(m.pickDefaultModel(['gemini-3.6-flash'])))"`
- UI check: Playwright + Chromium are preinstalled (`require('playwright')`); stub `generativelanguage.googleapis.com` with `page.route`
- Proxy local run: `cd mcp-proxy && npx wrangler dev --var UPSTREAM:<url>`; deploy: `npx wrangler deploy` (user's Cloudflare account)
- Tests: `npm test` (Node's built-in runner, `tests/*.test.mjs`)
- Done = lint passes + tests pass + build passes (+ Playwright check for UI changes)

## Architecture
```
index.html            → loads /src/main.jsx
src/main.jsx          → mounts <App/>, imports index.css
src/App.jsx           → ALL UI + state (useState/useEffect only; no router, no store)
  ├─ src/gemini.js    → Gemini streaming client + prompt + @@-marker parser + YouTube URL normalizer (no React)
  ├─ src/lyrics.js    → syllable/line counting, block splitting, section headers, meter check (no React)
  ├─ src/mcp.js       → MCP client, loaded via dynamic import() (no React)
  ├─ src/spec.js      → song spec: optional inputs (Idea topic, Lyrics, Analysis) and writing Style/Structure/Stems/Reference/bpm/key (no React)
  │    └─ src/songspec.js → vendored copy of gp-songtools/toolsmenu songspec/songspec.js; never edit here (eslint-ignored)
  └─ src/mcpConfig.js → DEFAULT_MCP_URL, DIRECT_MUSICATLAS_URL (no imports)
src/index.css         → `@import "tailwindcss"` + base bg
mcp-proxy/worker.js   → Cloudflare Worker CORS proxy for MusicAtlas (separate deploy)
vite.config.js        → react() + tailwindcss() + copy-changelog (ships CHANGELOG.md in dist/); base '/gp-blueprint/' (must match repo name)
public/changelog.html → static page that fetches and renders CHANGELOG.md; edit only the .md
.github/workflows/deploy.yml → push to main: npm ci + build → gh-pages branch
```
- Dependency direction: App → gemini, lyrics, mcp, mcpConfig, spec; mcp → mcpConfig; spec → songspec, lyrics. gemini.js, lyrics.js and mcp.js never import React or App.
- Keep `mcp.js` behind `import()` (it pulls in the ~390 KB MCP SDK); mcpConfig.js stays separate so App can read the URL without loading the SDK.
- `src/assets/react.svg` is unused template leftover; the favicon is the 🎨 emoji as an inline SVG `<link rel="icon">` in `index.html` and `public/changelog.html` (matches the GP Song Tools menu card).

## Request flow (App.generatePrompt)
1. Validate artist + Gemini key.
2. Pasted lyrics → `splitBlocks` (the app counts lines/syllables; Gemini only names blocks "#1", "#2").
3. If MCP enabled: `gatherMusicContext(url, {artist, song}, onStep)` → describe_track, find_similar_tracks (song only), find_similar_artists; returns summarized text + `measured` {bpm, key}, which override Gemini's values.
4. `buildPrompt({artist, song, topic, lyrics, blocks, reference, hasAudio})` → `generateSunoPrompt({..., youtubeUrl, signal, onText})` streams via `streamGenerateContent?alt=sse`; each chunk → `parseSunoText` + `applyCounts` → re-render. Stop aborts and keeps partial text.
5. Final: `fitStylePrompt(style)` trims to STYLE_PROMPT_MAX at a sentence boundary; `meterCheck` compares lyrics to the target meter.

## Conventions & guardrails
- Song spec (format: gp-songtools/toolsmenu `songspec/SPEC.md`): Blueprint owns only Style, Structure, Stems, Reference (never sent to Suno) and, behind "Set the song's BPM and key", `bpm`/`key`/`bpm_key_by`. It only reads Idea, Lyrics and Analysis, and must work unchanged when they are missing. A save replaces all Blueprint sections from one run (Mozart mode: Style = the Hans prompt, Stems empty). To update the library, copy it from toolsmenu; `node toolsmenu/songspec/check-copies.js` checks the copies.
- Gemini reply is plain text with markers (no JSON schema, so it can stream): `@@STYLE` (in Mozart mode: one Hans 2.0 line ≤ HANS_PROMPT_MAX; no `@@STEMS`), `@@TEMPO` (bpm:/key:), `@@STEMS` (`group || prompt`), `@@STRUCTURE` (`name || bars || seconds || lines-or-#block || rhyme || meter || description || suno tag`), `@@LYRICS`, `@@END`. Changing a field means updating buildPrompt, parseSunoText and App rendering together.
- Structure copy text (`formatStructure`) is a contract with Lyricpad (`gp-songtools/lyricpad`), which parses it: see `docs/structure-format.md`. Rhyme and syllables are one value per lyric line. Change the format only together with that doc and Lyricpad's parser.
- YouTube Music input: `normalizeYouTubeUrl` → `fileData.fileUri` part + `mediaResolution: MEDIA_RESOLUTION_LOW`. Only YouTube links (Gemini can't fetch Spotify). Public tracks only.
- `STYLE_PROMPT_MAX = 1000` (user's choice; do not raise). The style prompt never contains artist or song names (Suno rejects them).
- Gemini REST: `v1beta`, key in the `?key=` query param (not a header). Model is discovered via ListModels; never hardcode a model id (gemini-2.5-flash was shut down 2026-10-16).
- Errors: throw `GeminiError(msg, {retryable, busy, status, cancelled, partial})`. `busy` (503/429/timeout) → retry once, then next model from `fallbackModels`; never retry once text has streamed. Idle timeout 120 s between chunks.
- MusicAtlas: call tools ONE AT A TIME (parallel calls return 500 "non-JSON response"); retry once on 5xx/timeout. Browser can't reach it directly (no CORS) → default URL is the proxy.
- Proxy: origin allowlist in worker.js (`gp-songtools.github.io`, old `pcarenza.github.io`, localhost:5173/4173); `UPSTREAM` env var overrides the target.
- localStorage keys: `gemini.model`, `gemini.rememberKey`, `gemini.key` (only while rememberKey is on; removed when it's off), `mcp.enabled`, `mcp.url`, `prompt.target` ('suno' | 'mozart'). Always wrap access in try/catch (readPref/writePref helpers). A saved `DIRECT_MUSICATLAS_URL` is migrated to the proxy on load.
- Styling: Tailwind utility classes inline in JSX, dark slate palette, lucide-react icons. No CSS modules.
- Naming: camelCase JS modules in `src/`, PascalCase only for components. Constants UPPER_SNAKE.
- `CHANGELOG.md`: add an entry in the same commit as every user-facing change: today's date heading, newest first (reuse it if it's already at the top), items under Added / Changed / Fixed, plain user wording.
- Cloudflare Web Analytics snippet sits before `</body>` in `index.html` and `public/changelog.html` (same token on all GP Song Tools); add it to any new page. Privacy & credits live on the suite page `gp-songtools.github.io/toolsmenu/privacy.html` (repo `gp-songtools/toolsmenu`), linked from the App footer; update it when changing what is sent, stored, or which libraries/services are used.
- Product name is **GP Blueprint** (trademark reasons): never put "Suno" in the product name, page title, header or logo. Describing compatibility ("Suno-ready", "for Suno") is fine. Internal identifiers (`generateSunoPrompt`, package name, `suno-mcp-proxy` worker) keep `suno`; users never see them. GitHub Pages does not redirect renamed repos, so the old address `/suno-style-creator/` is forwarded to `/gp-blueprint/` by the org root site (repo `gp-songtools/gp-songtools.github.io`: `suno-style-creator/index.html` and the `MOVED` map in `404.html`).
- UI copy: plain, specific, user-facing ("Gemini is overloaded (HTTP 503)..."); no internal jargon.
- Never commit API keys; the user pastes their Gemini key at runtime. It is stored only if they opt in with "Remember key on this device" (off by default; plain localStorage, shared with every page on gp-songtools.github.io).

## Git workflow
- Commit and push straight to `main` (owner's standing permission, 2026-11-07); no PRs unless the owner asks. Never push to `gh-pages`.
- Each push to `main` deploys: only push after lint + build (+ Playwright for UI) pass.
- Clone is shallow: `git fetch origin main` and rebase onto it before pushing.
- After pushing, watch the "Deploy GP Blueprint to GitHub Pages" run for that commit and report whether it succeeded (on failure, read the job log and fix).
- GitHub Pages source must stay `gh-pages` / root (Settings → Pages); serving `main` gives a blank page (`/src/main.jsx` 404).
- Deploy keeps old hashed assets on `gh-pages` (`clean: false` in deploy.yml) so tabs opened before a deploy can still lazy-load `mcp-*.js`; don't remove it.

## Related (not in this repo)
- "Suno Prompt Studio" is a separate claude.ai artifact (Claude + MusicAtlas connector, no API key). Changes to it are not made here.

## Output rules for Claude Code
- Surgical edits: change only the lines the task needs; use Edit with minimal old/new strings. No reformatting, reordering, or renaming of untouched code.
- Never rewrite a whole file when an Edit will do; no drive-by refactors or style changes.
- Keep existing comments and structure unless the task is about them.
- Bash: use quiet flags (`--quiet`, `--silent`, `--logLevel warn`, `-q`), pipe long output through `tail -n 20` or `grep`, and don't print lockfiles or `dist/`.
- Don't run `npm install <pkg>` unless the task needs a new dependency; prefer `npm ci`.
- Read only the files relevant to the task; `package-lock.json` is never relevant.
- Report results in a few lines: what changed, what was verified, what wasn't.

# Multi-Agent Delegation Rules
When acting as the primary session (Opus), operate as a **Tech Lead and Architect**. Conserve primary context and rate limits by delegating execution work to specialized subagents whenever possible.
## Available Subagents
1. **`haiku-helper` (Fast Scout & Clerk)**
- **When to delegate:** File discovery, searching across the codebase (`Grep`/`Glob`), checking git status or commit logs, reading configuration files, and summarizing documentation.
- **Constraint:** Read-only tasks. Do not ask `haiku-helper` to write or edit code.
2. **`sonnet-worker` (Builder & Tester)**
- **When to delegate:** Implementing features from a finalized specification, writing unit or integration tests, refactoring isolated modules, fixing localized bugs, and running test/build suites.
- **Constraint:** Always provide clear requirements, target file paths, and expected behavior when invoking `sonnet-worker`.
## Orchestration Workflow
1. **Explore First:** Before planning changes, dispatch `haiku-helper` to locate relevant files and summarize existing patterns.
2. **Design & Plan:** Synthesize the findings in the main session and outline the architectural plan or edge cases.
3. **Delegate Implementation:** Hand off well-scoped coding, refactoring, and test-writing tasks to `sonnet-worker`. You may launch multiple `sonnet-worker` instances in parallel for independent modules.
4. **Review & Verify:** Inspect the changes made by `sonnet-worker` (or have `haiku-helper` summarize `git diff`) to ensure architectural alignment before concluding the task.
