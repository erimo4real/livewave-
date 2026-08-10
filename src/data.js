/**
 * Data layer: fetches the iptv-org playlist + metadata and joins them
 * into a browsable list of channels.
 *
 * Loading is progressive: the channel grid renders from the playlist
 * (~3 MB) immediately, and the country filter fills in later when the
 * larger channel metadata file (~10 MB) arrives.
 */
import { parseM3U, qualityRank, stripQualitySuffix } from './m3u.js';

export const PLAYLIST_URL = 'https://iptv-org.github.io/iptv/index.m3u';
export const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
export const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';

const FETCH_TIMEOUT = 60000; // 60s — long enough for slow links, short enough to never hang forever

const bytes = (n) => (n / 1048576).toFixed(1) + ' MB';

function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Fetch and parse the channel playlist. Throws on failure. */
export async function fetchPlaylist(onProgress) {
  const res = await fetchWithTimeout(PLAYLIST_URL);
  if (!res.ok) throw new Error(`${PLAYLIST_URL} → HTTP ${res.status}`);
  onProgress?.({ label: 'Downloading channel list', size: bytes(Number(res.headers.get('content-length') || 0)) });
  const text = await res.text();
  onProgress?.({ label: 'Parsing channel list' });
  return parseM3U(text);
}

/** Fetch country + channel metadata (used for country flags/filter). */
export async function fetchMeta(onProgress) {
  const [channelsJson, countriesJson] = await Promise.all([
    fetchWithTimeout(CHANNELS_URL).then((r) => {
      if (!r.ok) throw new Error(`${CHANNELS_URL} → HTTP ${r.status}`);
      onProgress?.({ label: 'Downloading country info', size: bytes(Number(r.headers.get('content-length') || 0)) });
      return r.json();
    }),
    fetchWithTimeout(COUNTRIES_URL).then((r) => {
      if (!r.ok) throw new Error(`${COUNTRIES_URL} → HTTP ${r.status}`);
      return r.json();
    }),
  ]);
  return { channelsJson, countriesJson };
}

/**
 * Group playlist entries into channels and join metadata.
 * Metadata may be null (not loaded yet) — countries are then omitted.
 */
export function buildChannels(entries, meta) {
  const countryById = new Map();
  let countries = [];
  if (meta) {
    for (const c of meta.channelsJson) {
      if (!c.closed && c.country) countryById.set(c.id, c.country);
    }
    countries = meta.countriesJson.filter((c) => c.flag).sort((a, b) => a.name.localeCompare(b.name));
  }

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
        country: countryById.get(e.id) || null,
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
export function filterChannels(channels, { query, country, category }) {
  const q = query.trim().toLowerCase();
  return channels.filter((ch) => {
    if (country && ch.country !== country) return false;
    if (category && ch.category !== category) return false;
    if (q && !`${ch.name} ${ch.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
