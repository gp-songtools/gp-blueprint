# CLAUDE.md

Suno prompt generator: artist/song/topic/lyrics → style prompt, stem prompts, section structure, lyrics.
React 19 + Vite 7, plain JavaScript (no TypeScript, no test suite). Gemini REST API + MusicAtlas MCP. Deployed to GitHub Pages.

## Commands (run from repo root; keep output quiet)
- Install: `npm ci --silent --no-audit --no-fund`
- Lint (the only static check; no type checker exists): `npx eslint . --quiet`
- Lint one file: `npx eslint src/gemini.js --quiet`
- Build: `npx vite build --logLevel warn` (output `dist/`, gitignored; delete after checking)
- Dev / preview: `npm run dev` / `npx vite preview --port 4173` → `http://localhost:4173/suno-style-creator/`
- Smoke-test a pure function (no test runner):
  `node -e "import('./src/gemini.js').then(m=>console.log(m.pickDefaultModel(['gemini-3.6-flash'])))"`
- UI check: Playwright + Chromium are preinstalled (`require('playwright')`); stub `generativelanguage.googleapis.com` with `page.route`
- Proxy local run: `cd mcp-proxy && npx wrangler dev --var UPSTREAM:<url>`; deploy: `npx wrangler deploy` (user's Cloudflare account)
- Done = lint passes + build passes (+ Playwright check for UI changes)

## Architecture
```
index.html            → loads /src/main.jsx (also a leftover Tailwind play-CDN <script>)
src/main.jsx          → mounts <App/>, imports index.css
src/App.jsx           → ALL UI + state (useState/useEffect only; no router, no store)
  ├─ src/gemini.js    → Gemini client + prompt + schema (no React)
  ├─ src/mcp.js       → MCP client, loaded via dynamic import() (no React)
  └─ src/mcpConfig.js → DEFAULT_MCP_URL, DIRECT_MUSICATLAS_URL (no imports)
src/index.css         → `@import "tailwindcss"` + base bg
mcp-proxy/worker.js   → Cloudflare Worker CORS proxy for MusicAtlas (separate deploy)
vite.config.js        → react() + tailwindcss(); base '/suno-style-creator/' (must match repo name)
.github/workflows/deploy.yml → push to main: npm ci + build → gh-pages branch
```
- Dependency direction: App → gemini, mcp, mcpConfig; mcp → mcpConfig. gemini.js and mcp.js never import React or App.
- Keep `mcp.js` behind `import()` (it pulls in the ~390 KB MCP SDK); mcpConfig.js stays separate so App can read the URL without loading the SDK.
- `src/assets/react.svg` is unused template leftover; `public/vite.svg` is the favicon.

## Request flow (App.generatePrompt)
1. Validate artist + Gemini key.
2. If MCP enabled: `gatherMusicContext(url, {artist, song})` → describe_track, find_similar_tracks (song only), find_similar_artists.
3. `buildPrompt({artist, song, topic, lyrics, reference})` → `generateSunoPrompt({apiKey, model, fallbacks, prompt, onStatus})`.
4. `fitStylePrompt(genre_tags)` trims to STYLE_PROMPT_MAX at a sentence boundary; render cards.

## Conventions & guardrails
- Gemini response schema (gemini.js SUNO_SCHEMA): `genre_tags, tempo_bpm, key, stems[{group,prompt}], sections[{name,bars,seconds,lines,rhyme,meter,description,suno_tags}], sample_lyrics`. Changing a field means updating schema, buildPrompt, and App rendering together.
- `STYLE_PROMPT_MAX = 1000` (user's choice; do not raise). The style prompt never contains artist or song names (Suno rejects them).
- Gemini REST: `v1beta`, key in the `?key=` query param (not a header). Model is discovered via ListModels; never hardcode a model id (gemini-2.5-flash was shut down 2026-10-16).
- Errors: throw `GeminiError(msg, {retryable, busy})`. `busy` (503/429/timeout) → retry once, then next model from `fallbackModels`. Request timeout 120 s.
- MusicAtlas: call tools ONE AT A TIME (parallel calls return 500 "non-JSON response"); retry once on 5xx/timeout. Browser can't reach it directly (no CORS) → default URL is the proxy.
- Proxy: origin allowlist in worker.js (`pcarenza.github.io`, localhost:5173/4173); `UPSTREAM` env var overrides the target.
- localStorage keys: `gemini.model`, `mcp.enabled`, `mcp.url`. Always wrap access in try/catch (readPref/writePref helpers). A saved `DIRECT_MUSICATLAS_URL` is migrated to the proxy on load.
- Styling: Tailwind utility classes inline in JSX, dark slate palette, lucide-react icons. No CSS modules.
- Naming: camelCase JS modules in `src/`, PascalCase only for components. Constants UPPER_SNAKE.
- UI copy: plain, specific, user-facing ("Gemini is overloaded (HTTP 503)..."); no internal jargon.
- Never commit API keys; the user pastes their Gemini key at runtime and it is never stored.

## Git & PR workflow
- Never push to `main` or `gh-pages` directly; `main` deploys automatically on merge.
- One branch per change from latest `origin/main`; names use dashes (`style-prompt-1000`). A branch named `feature` exists, so `feature/...` names are rejected.
- Open PRs with REST: `gh api repos/pcarenza/suno-style-creator/pulls -f title=... -f head=<branch> -f base=main -F body=@file` (`gh pr create` uses GraphQL, which is blocked in cloud sessions).
- Don't merge PRs yourself; the owner merges. Check merge state via `gh api .../pulls/<n> --jq .merged`.
- Clone is shallow: before pushing a new branch run `git fetch origin main`.
- If a PR was already merged, start follow-up work on a fresh branch from `origin/main`; never add commits to a merged branch.
- GitHub Pages source must stay `gh-pages` / root (Settings → Pages); serving `main` gives a blank page (`/src/main.jsx` 404).

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
