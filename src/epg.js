/**
 * EPG (Electronic Program Guide) support.
 *
 * Schedule data comes from iptv-epg.org's per-country XMLTV files, which use
 * the same channel ids as iptv-org (e.g. "CNN.us"). The browser always asks
 * our own /api/epg?country=XX endpoint — a Vercel function that trims the
 * (huge) XMLTV file down to a compact now/next summary and caches it at the
 * edge. In local dev, vite.config.js proxies /api to the deployed app.
 *
 * The pure helpers here (xmltvTimeToEpoch, unescapeXml) are shared with the
 * api/epg.js proxy function — keep them free of browser APIs.
 */

const epgCache = new Map(); // cc -> { channels, fetchedAt }
const inflight = new Map(); // cc -> Promise
const lineupCache = new Map(); // "cc:id" -> { now, next, lineup }
const lineupInflight = new Map(); // "cc:id" -> Promise

/** Parse an XMLTV timestamp "20260809100000 +0000" into epoch ms. */
export function xmltvTimeToEpoch(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(String(s).trim());
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    const mins = (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * sign;
    t -= mins * 60000;
  }
  return t;
}

/** Decode the entities XMLTV producers actually use. */
export function unescapeXml(s) {
  const cp = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Fetch + cache a country's EPG summary. Resolves to { channels, fetchedAt }. */
export function fetchCountryEpg(cc) {
  cc = String(cc).toLowerCase();
  if (epgCache.has(cc)) return Promise.resolve(epgCache.get(cc));
  if (inflight.has(cc)) return inflight.get(cc);
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(`/api/epg?country=${encodeURIComponent(cc)}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`EPG ${cc} → HTTP ${res.status}`);
      const d = await res.json();
      const data = { channels: d.channels || {}, fetchedAt: Date.now() };
      epgCache.set(cc, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  })().catch((err) => {
    inflight.delete(cc);
    throw err;
  });
  inflight.set(cc, p);
  return p;
}

/** Look up a channel's now/next from already-loaded data (null if unknown). */
export function getProgrammes(cc, channelId) {
  return epgCache.get(String(cc).toLowerCase())?.channels?.[channelId] || null;
}

/**
 * Fetch one channel's full programme lineup (current + upcoming ~6 h) from
 * /api/epg?country=..&channel=.. — a tiny response, unlike the whole-country
 * summary. Resolves to { now, next, lineup } or rejects on failure.
 */
export function fetchChannelLineup(cc, channelId) {
  cc = String(cc).toLowerCase();
  channelId = String(channelId);
  const key = `${cc}:${channelId}`;
  if (lineupCache.has(key)) return Promise.resolve(lineupCache.get(key));
  if (lineupInflight.has(key)) return lineupInflight.get(key);
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(`/api/epg?country=${encodeURIComponent(cc)}&channel=${encodeURIComponent(channelId)}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`EPG ${key} → HTTP ${res.status}`);
      const d = await res.json();
      const data = { now: d.now || null, next: d.next || null, lineup: d.lineup || [] };
      lineupCache.set(key, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  })().catch((err) => {
    lineupInflight.delete(key);
    throw err;
  });
  lineupInflight.set(key, p);
  return p;
}

/** Look up a channel's cached lineup (null if not fetched yet). */
export function getChannelLineup(cc, channelId) {
  return lineupCache.get(`${String(cc).toLowerCase()}:${channelId}`) || null;
}
