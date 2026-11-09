# SunoPrompt AI

Generates Suno.ai style tags, song structure, rhyme scheme and Suno-ready lyrics from an artist, an optional song, and an optional topic.

## Gemini

- **Your key:** paste your Gemini API key into the form. It is sent only to Google's API from your browser and never stored.
- **Model:** after you paste the key, the app asks the Gemini API which models the key can use. It picks the newest stable general-purpose Flash model, so a retired model name (like `gemini-2.5-flash`, shut down 2026-10-16) can't break it. You can choose another model from the **Model** dropdown, and the choice is remembered.
- **Code:** the request, prompt and JSON schema live in `src/gemini.js`.

## MCP grounding (v4)

Before calling Gemini, the app can connect to a remote **MCP server** and pull real audio analysis. It uses [MusicAtlas](https://musicatlas.ai/connectors/), which is free and needs no account. MusicAtlas (`https://mcp.musicatlas.ai/mcp`) blocks direct browser calls (no CORS headers), so the default address is the proxy in `mcp-proxy/`, deployed at `https://suno-mcp-proxy.pcarenza.workers.dev/mcp`.

| Tool | When | Used for |
|---|---|---|
| `describe_track` | song given | instrumentation, tempo, energy, production → style tags |
| `find_similar_tracks` | song given | stylistic neighbours |
| `find_similar_artists` | always | stylistic neighbours |

- The results go into the Gemini prompt as reference data. Artist names are kept out of the style tags.
- You can see the raw data in the **MusicAtlas Reference Data** panel.
- If the MCP server can't be reached, the app shows a warning and generates without it.
- You can switch it off, or point it at any anonymous Streamable-HTTP MCP server, in the form. Use **Test** to list the server's tools.

### If the browser is blocked by CORS

Deploy the small proxy in `mcp-proxy/` (a Cloudflare Worker). Then set the app's MCP URL to `https://<worker>.workers.dev/mcp`:

```bash
cd mcp-proxy && npx wrangler deploy
```

## Privacy & credits

No server or account of its own: your key goes only to Google, and MusicAtlas requests pass through the stateless proxy in `mcp-proxy/`. Pages load Cloudflare Web Analytics, shared by all GP Song Tools, for anonymous visit counts (no cookies; it never sees your inputs or key). Built with React, Tailwind CSS, Lucide icons and the Model Context Protocol SDK; audio analysis by MusicAtlas. Details: [Privacy & credits](https://gp-songtools.github.io/toolsmenu/privacy.html).

## Dev

```bash
npm install
npm run dev
```

Paste a Gemini API key into the form to run locally. Pushes to `main` deploy to GitHub Pages.
