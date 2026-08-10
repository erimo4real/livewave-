/**
 * Vercel proxy + trimmer for EPG schedule data.
 *
 * iptv-epg.org publishes per-country XMLTV files — the US one is ~200 MB
 * uncompressed — so this function streams it, keeps the current + next
 * programme per channel (plus a bounded upcoming lineup), and returns a
 * compact JSON summary cached at the edge for 30 minutes. Channel ids match
 * iptv-org tvg-ids (e.g. "CNN.us").
 *
 * Usage:
 *   GET /api/epg?country=us              → now/next summary for the whole country
 *   GET /api/epg?country=us&channel=CNN  → one channel's full lineup (tiny)
 */
import { xmltvTimeToEpoch, unescapeXml } from '../src/epg.js';

const TIMEOUT_MS = 50000;
const CLOSE = '</programme>';
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const LOOKAHEAD_MS = 6 * 3600e3; // how far ahead the lineup reaches
const MAX_LINEUP = 14; // hard cap per channel to keep payloads bounded
const CACHE_MS = 30 * 60e3; // in-process parse lifetime (edge cache is the primary layer)

// Parsing a country is the expensive part (~15 s for the US file), so keep the
// parsed result in-process and reuse it for any channel of that country. Vercel
// may reuse a warm instance across requests; this bounds upstream re-fetches.
const inProc = new Map(); // cc -> { fetchedAt, channels: Map<channelId, entry> }

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const cc = String(req.query.country || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) {
    res.status(400).json({ error: 'country must be a 2-letter code' });
    return;
  }
  const channel = String(req.query.channel || '').toLowerCase();
  if (channel && !/^[\w.-]+$/.test(channel)) {
    res.status(400).json({ error: 'channel must be an iptv-org channel id' });
    return;
  }

  let cached = inProc.get(cc);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(`https://iptv-epg.org/files/epg-${cc}.xml`, { signal: ctrl.signal });
      if (!upstream.ok) {
        res.status(upstream.status === 404 ? 404 : 502).json({ error: `upstream EPG HTTP ${upstream.status}` });
        return;
      }
      cached = { fetchedAt: Date.now(), channels: await streamLineups(upstream.body) };
      inProc.set(cc, cached);
    } catch {
      res.status(504).json({ error: 'upstream EPG fetch failed' });
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  const channels = cached.channels;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=21600');
  res.setHeader('CDN-Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');

  if (channel) {
    const entry = channels.get(channel);
    res.status(200).json({
      channel,
      now: entry?.now || null,
      next: entry?.next || null,
      lineup: entry?.lineup || [],
    });
    return;
  }

  // Whole-country summary (Maps don't JSON-serialize, so copy to a plain object).
  const out = {};
  for (const [id, entry] of channels) out[id] = { now: entry.now, next: entry.next };
  res.status(200).json({ generated: new Date().toISOString(), channels: out });
}

/**
 * Stream the XMLTV body, extracting each <programme> block as it completes and
 * keeping per channel: the current programme, the next one, and every upcoming
 * programme within LOOKAHEAD_MS (capped at MAX_LINEUP). Peak memory is bounded
 * by a single block plus the accumulated (small) summary.
 *
 * Exported for local testing.
 */
export async function streamLineups(body) {
  const now = Date.now();
  const channels = new Map();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf('<programme');
    while (idx !== -1) {
      const end = buf.indexOf(CLOSE, idx);
      if (end === -1) break; // block not complete yet — wait for more data
      processBlock(buf.slice(idx, end + CLOSE.length), now, channels);
      buf = buf.slice(end + CLOSE.length);
      idx = buf.indexOf('<programme');
    }
    // Safety net for malformed input; normally the buffer is drained above.
    if (buf.length > 4_000_000) buf = buf.slice(-4_000_000);
  }
  buf += decoder.decode(); // flush any trailing multibyte sequence

  // XMLTV blocks are usually time-sorted per channel but not guaranteed —
  // normalize order and cap after the fact.
  for (const entry of channels.values()) {
    entry.lineup.sort((a, b) => a.start - b.start || a.stop - b.stop);
    if (entry.now && entry.lineup[0] !== entry.now) entry.lineup.unshift(entry.now);
    if (entry.lineup.length > MAX_LINEUP) entry.lineup.length = MAX_LINEUP;
  }
  return channels;
}

function processBlock(block, now, channels) {
  const open = /^<programme\b([^>]*)>/.exec(block);
  if (!open) return;
  const attrs = {};
  let a;
  ATTR_RE.lastIndex = 0;
  const attrStr = open[1];
  while ((a = ATTR_RE.exec(attrStr)) !== null) attrs[a[1]] = a[2];

  const titleMatch = TITLE_RE.exec(block);
  const title = titleMatch ? unescapeXml(titleMatch[1]) : '';
  const start = xmltvTimeToEpoch(attrs.start || '');
  const stop = xmltvTimeToEpoch(attrs.stop || '');
  const channel = attrs.channel || '';
  if (!channel || !isFinite(start) || !isFinite(stop) || !title) return;

  const p = { title, start, stop };
  let entry = channels.get(channel);
  if (!entry) {
    entry = { now: null, next: null, lineup: [] };
    channels.set(channel, entry);
  }
  if (start <= now && stop > now) {
    if (!entry.now || start > entry.now.start) entry.now = p;
    if (entry.lineup.length < MAX_LINEUP) entry.lineup.push(p);
  } else if (start > now && start < now + LOOKAHEAD_MS) {
    if (!entry.next || start < entry.next.start) entry.next = p;
    if (entry.lineup.length < MAX_LINEUP) entry.lineup.push(p);
  }
}
