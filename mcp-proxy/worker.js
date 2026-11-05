// Cloudflare Worker: CORS proxy for remote MCP servers (Streamable HTTP).
// Only needed if the browser can't call the MCP server directly because of CORS.
//
// Deploy:  cd mcp-proxy && npx wrangler deploy
// Then set the app's MCP URL to:  https://<your-worker>.workers.dev/mcp

// Override with the UPSTREAM variable (e.g. for local testing).
const DEFAULT_UPSTREAM = 'https://mcp.musicatlas.ai/mcp';

// Lock this down to your GitHub Pages origin (and localhost for dev).
const ALLOWED_ORIGINS = [
  'https://gp-songtools.github.io',
  'https://pcarenza.github.io', // old address before the repo moved to gp-songtools
  'http://localhost:5173',
  'http://localhost:4173',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }

    const headers = new Headers();
    for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }

    const upstream = await fetch(env.UPSTREAM || DEFAULT_UPSTREAM, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });

    // Stream the response straight through (SSE responses included).
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
