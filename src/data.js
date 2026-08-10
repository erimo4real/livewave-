/**
 * Data layer: fetches the iptv-org playlist + metadata and joins them
 * into a browsable list of channels.
 *
 * Loading is progressive: the channel grid renders from the playlist
 * (~3 MB) immediately, and the country filter fills in later when the
 * channel metadata arrives.
 *
 * Production builds fetch through the deployment's own caching proxy
 * (/api/playlist, /api/meta — see api/ folder) so the browser never
 * downloads the big files from iptv-org.github.io, which many networks
 * throttle or block. If the proxy is unavailable (e.g. the static build
 * is hosted somewhere without functions), it falls back to iptv-org
 * directly. Local dev always fetches directly.
 */
import { parseM3U, qualityRank, stripQualitySuffix } from './m3u.js';

const DIRECT_PLAYLIST = 'https://iptv-org.github.io/iptv/index.m3u';
const DIRECT_CHANNELS = 'https://iptv-org.github.io/api/channels.json';
const DIRECT_COUNTRIES = 'https://iptv-org.github.io/api/countries.json';

const USE_PROXY = !import.meta.env.DEV;
const FETCH_TIMEOUT = 60000; // 60s — long enough for slow links, short enough to never hang forever

const bytes = (n) => (n / 1048576).toFixed(1) + ' MB';

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Fetch and parse the channel playlist. Throws on failure. */
export async function fetchPlaylist(onProgress) {
  const urls = USE_PROXY ? ['/api/playlist', DIRECT_PLAYLIST] : [DIRECT_PLAYLIST];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      onProgress?.({ label: 'Downloading channel list', size: bytes(Number(res.headers.get('content-length') || 0)) });
      const text = await res.text();
      onProgress?.({ label: 'Parsing channel list' });
      return parseM3U(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('failed to load playlist');
}

/**
 * Fetch country + channel metadata (used for country flags/filter).
 * Returns { channelCountry: {id: countryCode}, countries: [...] }.
 */
export async function fetchMeta(onProgress) {
  onProgress?.({ label: 'Downloading country info' });
  if (USE_PROXY) {
    try {
      const res = await fetchWithTimeout('/api/meta');
      if (res.ok) return res.json();
    } catch {
      // proxy unavailable — fall back to fetching iptv-org directly
    }
  }
  const [channelsJson, countriesJson] = await Promise.all([
    fetchWithTimeout(DIRECT_CHANNELS).then((r) => {
      if (!r.ok) throw new Error(`${DIRECT_CHANNELS} → HTTP ${r.status}`);
      return r.json();
    }),
    fetchWithTimeout(DIRECT_COUNTRIES).then((r) => {
      if (!r.ok) throw new Error(`${DIRECT_COUNTRIES} → HTTP ${r.status}`);
      return r.json();
    }),
  ]);
  return trimMeta(channelsJson, countriesJson);
}

/** Reduce the ~10 MB channels.json to just the id→country map the UI needs. */
export function trimMeta(channelsJson, countriesJson) {
  const channelCountry = {};
  for (const c of channelsJson) {
    if (!c.closed && c.country) channelCountry[c.id] = c.country;
  }
  const countries = countriesJson
    .filter((c) => c.flag)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { channelCountry, countries };
}

/**
 * Group playlist entries into channels and join metadata.
 * Metadata may be null (not loaded yet) — countries are then omitted.
 */
export function buildChannels(entries, meta) {
  const countryById = meta?.channelCountry || {};
  let countries = meta?.countries || [];

  const byCountry = new Map(countries.map((c) => [c.code, c]));
  const countryOf = (code) => byCountry.get(code);

  const channels = new Map();
  for (const e of entries) {
    let ch = channels.get(e.id);
    if (!ch) {
      ch = {
        id: e.id,
        name: stripQualitySuffix(e.name),
        logo: e.logo,
        category: e.category,
        country: countryById[e.id] || null,
        streams: [],
        streamUrls: new Set(),
      };
      channels.set(e.id, ch);
    }
    if (ch.streamUrls.has(e.url)) continue; // dedupe identical stream URLs
    ch.streamUrls.add(e.url);
    ch.streams.push(e);
    // Prefer the plainest name ("CNN" over "CNN (1080p)")
    if (!e.quality && /\s\(/.test(ch.name) && !/\s\(/.test(e.name)) ch.name = e.name;
  }

  const list = [...channels.values()].map(({ streamUrls, ...ch }) => ({
    ...ch,
    streams: ch.streams.sort(
      (a, b) => qualityRank(a.quality) - qualityRank(b.quality) || Number(b.url.startsWith('https')) - Number(a.url.startsWith('https')),
    ),
  }));

  list.sort((a, b) => a.name.localeCompare(b.name));

  return { channels: list, countries, countryOf, categories: collectCategories(list) };
}

function collectCategories(channels) {
  const counts = new Map();
  for (const ch of channels) {
    const label = ch.category === 'Undefined' ? 'Other' : ch.category;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/** Filter a channel list by the active search/filters. */
export function filterChannels(channels, { query, country, category, countryOf }) {
  const q = query.trim().toLowerCase();
  return channels.filter((ch) => {
    if (country && ch.country !== country) return false;
    if (category && ch.category !== category) return false;
    if (q) {
      const countryName = ch.country ? countryOf?.(ch.country)?.name || '' : '';
      const haystack = `${ch.name} ${ch.category} ${countryName}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Append channels whose currently-airing programme title matches the query.
 *
 * Regular matches (name/category/country) stay first — they rank higher — then
 * channels found only by "what's on now" follow, in the same name-sorted order.
 * `nowTitleOf` is a callback returning the channel's current programme title
 * ('' when unknown); it may read EPG data the app already has in memory.
 * Respects the same country/category filters as the main pass.
 */
export function withProgrammeMatches(list, allChannels, { query, country, category, nowTitleOf }) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return list; // 1-char queries match almost every title — noise
  const matched = new Set(list.map((ch) => ch.id));
  const extra = allChannels.filter((ch) => {
    if (matched.has(ch.id)) return false;
    if (country && ch.country !== country) return false;
    if (category && ch.category !== category) return false;
    return nowTitleOf(ch).toLowerCase().includes(q);
  });
  return extra.length ? [...list, ...extra] : list;
}
