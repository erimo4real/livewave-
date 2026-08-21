/**
 * CORS proxy for stream URLs. Fetches the stream server-side and pipes it
 * back with proper CORS headers, so the browser can load streams that would
 * otherwise be blocked by mixed-content or CORS policies.
 *
 * Protected by an origin allowlist and per-IP rate limiting so the endpoint
 * can't be abused as a free, anonymous proxy.
 *
 * Usage: /api/stream?url=https://example.com/stream.m3u8
 * Optional: &ua=<user-agent> to pass a custom User-Agent upstream.
 */
export const config = { maxDuration: 60 };

/* ────────────────────────── origin allowlist ───────────────────────── */

const ALLOWED_ORIGINS = [
  'https://livewave-sigma.vercel.app',
  'http://localhost:5173',  // Vite dev server
  'http://localhost:4173',  // Vite preview
];

function isOriginAllowed(req) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  // Allow requests with no origin (service worker, direct navigation)
  if (!origin && !referer) return true;
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o) || referer.startsWith(o));
}

/* ──────────────────────── per-IP rate limit ───────────────────────── */

const RATE_LIMIT = 40;        // max requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute sliding window
const rateMap = new Map();    // ip → { count, windowStart }

function rateLimitAllows(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Prevent unbounded growth — flush stale entries every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, entry] of rateMap) {
    if (entry.windowStart < cutoff) rateMap.delete(ip);
  }
}, 5 * 60_000);

/* ─────────────────────────── handler ──────────────────────────────── */

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Missing or invalid url parameter' });
  }

  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Origin check
  if (!isOriginAllowed(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limit (use x-forwarded-for for Vercel, fallback to socket)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateLimitAllows(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.query.ua) headers['User-Agent'] = req.query.ua;

    const upstream = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).end();
    }

    // Forward relevant response headers
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    const ar = upstream.headers.get('accept-ranges');
    if (ar) res.setHeader('Accept-Ranges', ar);

    res.setHeader('Cache-Control', 'public, max-age=5');
    res.status(upstream.status);

    // Stream the response body so we don't buffer large videos in memory
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy fetch failed' });
    }
  }
}
