/**
 * Vercel proxy for the iptv-org playlist (index.m3u, ~3 MB).
 *
 * The browser used to download this directly from iptv-org.github.io,
 * which many ISPs throttle or block entirely — leaving users staring at
 * a spinner. This function fetches the playlist server-side (fast from
 * Vercel's datacenters) and caches the result at the edge for 12 h, so
 * the browser only ever talks to the deployment's own domain.
 */
const PLAYLIST_URL = 'https://iptv-org.github.io/iptv/index.m3u';
const TIMEOUT_MS = 50000;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(PLAYLIST_URL, { signal: ctrl.signal });
    if (!upstream.ok) {
      res.status(502).json({ error: `upstream playlist HTTP ${upstream.status}` });
      return;
    }
    const text = await upstream.text();
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=43200, stale-while-revalidate=86400');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
    res.status(200).send(text);
  } catch (err) {
    res.status(504).json({ error: 'upstream playlist fetch failed' });
  } finally {
    clearTimeout(timer);
  }
}
