// Minimal browser MCP client used to ground Suno prompts in real music data.
// Talks to any remote MCP server over Streamable HTTP (default: MusicAtlas).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DEFAULT_MCP_URL } from './mcpConfig';

export { DEFAULT_MCP_URL };

const TIMEOUT_MS = 45000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function connectMcp(url) {
  const client = new Client({ name: 'suno-style-creator', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await withTimeout(client.connect(transport), 20000, 'MCP connect');
  } catch (err) {
    throw new Error(explainError(err, url));
  }
  const { tools } = await client.listTools();
  return { client, tools };
}

// Find a tool by exact name, falling back to a suffix match
// (some servers namespace tool names, e.g. "musicatlas_describe_track").
export function findTool(tools, name) {
  return tools.find((t) => t.name === name) || tools.find((t) => t.name.endsWith(name));
}

// Flatten an MCP tool result into plain text for use in an LLM prompt.
export function resultToText(result) {
  if (!result?.content) return '';
  const parts = result.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text.trim());
  if (parts.length === 0 && result.structuredContent) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return parts.join('\n\n');
}

const TRANSIENT = /\b5\d\d\b|non-JSON|timed out|rate limit|too many/i;

// Retry once after a short pause when the server reports a temporary failure.
async function callWithRetry(fn, pauseMs = 1500) {
  try {
    return await fn();
  } catch (err) {
    if (!TRANSIENT.test(err?.message || '')) throw err;
    await new Promise((res) => setTimeout(res, pauseMs));
    return fn();
  }
}

export async function callTool(client, tools, name, args) {
  const tool = findTool(tools, name);
  if (!tool) return null;
  const result = await withTimeout(
    client.callTool({ name: tool.name, arguments: args }),
    TIMEOUT_MS,
    `${tool.name}`,
  );
  const text = resultToText(result);
  if (result.isError) throw new Error(text || `${tool.name} returned an error`);
  return text;
}

const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
const parseJson = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };

// Turn MusicAtlas's JSON into short labelled lines for the prompt and the data panel.
function summarize(tool, payload) {
  if (tool === 'describe_track') {
    const mc = payload.music_characteristics || {};
    const ac = payload.audio_characteristics || {};
    const vp = payload.classifications?.vocal_profile;
    return [
      mc.bpm != null && `Measured tempo: ${Math.round(mc.bpm * 10) / 10} BPM`,
      mc.key && `Measured key: ${mc.key}${mc.mode ? ` ${mc.mode}` : ''}`,
      ac.loudness_lufs != null && `Loudness: ${ac.loudness_lufs} LUFS`,
      ac.perceived_intensity && `Perceived intensity: ${ac.perceived_intensity}`,
      ac.frequency_density && `Frequency density: ${ac.frequency_density}`,
      vp?.label && `Vocal profile (classifier guess, may be wrong): ${vp.label} (${vp.confidence})`,
      payload.genres?.length && `Genre tags (automatic, some may be noise): ${payload.genres.join(', ')}`,
    ].filter(Boolean).join('\n');
  }
  if (tool === 'find_similar_tracks') {
    const list = take(payload.matches, 12).map((t) => `${t.artist} – ${t.title}`).join('\n');
    return list + (payload.hashtags?.length ? `\nTags: ${payload.hashtags.join(' ')}` : '');
  }
  if (tool === 'find_similar_artists') {
    return take(payload.artists, 10).map((a) => {
      const ex = a.examples?.[0];
      return ex ? `${a.name} (e.g. "${ex.match_track}" sounds like "${ex.seed_track}")` : a.name;
    }).join('\n');
  }
  return '';
}

/**
 * Pull reference data for an artist (and optional song) from the MCP server.
 * Each tool call is independent; one failing doesn't sink the others.
 * `measured` holds MusicAtlas's tempo and key when describe_track returned them.
 */
export async function gatherMusicContext(url, { artist, song }, onStep) {
  const { client, tools } = await connectMcp(url);
  const calls = [];
  if (song) {
    calls.push(['trackAnalysis', 'describe_track', { artist, track: song }, 'audio analysis']);
    calls.push(['similarTracks', 'find_similar_tracks', { artist, track: song }, 'similar tracks']);
  }
  calls.push(['similarArtists', 'find_similar_artists', { artist }, 'similar artists']);

  // One call at a time: when the calls ran in parallel, MusicAtlas answered
  // all but the first with server errors (likely a concurrency limit).
  const context = { toolsUsed: [], warnings: [], measured: {} };
  for (const [key, tool, args, label] of calls) {
    onStep?.(label);
    try {
      const text = await callWithRetry(() => callTool(client, tools, tool, args));
      if (text) {
        const payload = parseJson(text);
        const mc = payload?.music_characteristics;
        if (tool === 'describe_track' && mc) {
          if (mc.bpm != null) context.measured.bpm = String(Math.round(mc.bpm));
          if (mc.key) context.measured.key = `${mc.key}${mc.mode ? ` ${mc.mode}` : ''}`;
        }
        context[key] = (payload && summarize(tool, payload)) || text.slice(0, 3000);
        context.toolsUsed.push(tool);
      }
    } catch (err) {
      // 404 means MusicAtlas doesn't know this artist/track yet: a different spelling,
      // or a recording it only started analysing on this request (takes about a minute).
      if (/\(404\)/.test(err?.message || '')) {
        const subject = args.track ? `"${args.track}" by ${artist}` : `"${artist}"`;
        context.warnings.push(`MusicAtlas has no ${label} data for ${subject} yet. If it's a newer release, MusicAtlas may still be analysing it: try again in a minute. Otherwise check the spelling. Continued without it.`);
      } else {
        context.warnings.push(`${tool}: ${err?.message || err}`);
      }
    }
  }

  client.close().catch(() => {});
  return context;
}

function explainError(err, url) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(msg)) {
    return `Couldn't reach ${url} from the browser (network or CORS blocked). ` +
      `Deploy the proxy in mcp-proxy/ and use its URL instead.`;
  }
  if (/401|unauthori[sz]ed/i.test(msg)) {
    return `${url} requires sign-in (OAuth). This app only supports MCP servers that allow anonymous access.`;
  }
  return `MCP connection failed: ${msg}`;
}
