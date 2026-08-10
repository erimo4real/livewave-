/**
 * Vercel proxy + trimmer for iptv-org channel metadata.
 *
 * channels.json is ~10 MB, but the app only needs one field from it:
 * the country per channel (for flags + the country filter). This fetches
 * it server-side, strips everything else down to a tiny id→country map,
 * and caches that at the edge for 12 h.
 */
const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const TIMEOUT_MS = 50000;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const [channelsJson, countriesJson] = await Promise.all([
      fetchJson(CHANNELS_URL),
      fetchJson(COUNTRIES_URL),
    ]);

    const channelCountry = {};
    for (const c of channelsJson) {
      if (!c.closed && c.country) channelCountry[c.id] = c.country;
    }
    const countries = countriesJson
      .filter((c) => c.flag)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=43200, stale-while-revalidate=86400');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
    res.status(200).json({ channelCountry, countries });
  } catch (err) {
    res.status(504).json({ error: 'upstream metadata fetch failed' });
  }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal });
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    return upstream.json();
  } finally {
    clearTimeout(timer);
  }
}
