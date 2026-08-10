/**
 * Vercel proxy + trimmer for EPG schedule data.
 *
 * iptv-epg.org publishes per-country XMLTV files — the US one is ~200 MB
 * uncompressed — so this function streams it, keeps only the current + next
 * programme per channel, and returns a compact JSON summary cached at the
 * edge for 30 minutes. Channel ids match iptv-org tvg-ids (e.g. "CNN.us").
 *
 * Usage: GET /api/epg?country=us
 */
import { xmltvTimeToEpoch, unescapeXml } from '../src/epg.js';

const TIMEOUT_MS = 50000;
const CLOSE = '</programme>';
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const cc = String(req.query.country || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) {
    res.status(400).json({ error: 'country must be a 2-letter code' });
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`https://iptv-epg.org/files/epg-${cc}.xml`, { signal: ctrl.signal });
    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).json({ error: `upstream EPG HTTP ${upstream.status}` });
      return;
    }
    const channels = await streamNowNext(upstream.body);
    // Maps don't JSON-serialize, so copy into a plain object for the response.
    const out = {};
    for (const [channel, entry] of channels) out[channel] = entry;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=21600');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');
    res.status(200).json({ generated: new Date().toISOString(), channels: out });
  } catch (err) {
    res.status(504).json({ error: 'upstream EPG fetch failed' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream the XMLTV body, extracting each <programme> block as it completes
 * and keeping only the current + next programme per channel. Peak memory is
 * proportional to a single block, not the whole (multi-hundred-MB) file.
 *
 * Exported for local testing.
 */
export async function streamNowNext(body) {
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

  let entry = channels.get(channel);
  if (!entry) {
    entry = { now: null, next: null };
    channels.set(channel, entry);
  }
  if (start <= now && stop > now) {
    if (!entry.now || start > entry.now.start) entry.now = { title, start, stop };
  } else if (start > now && (!entry.next || start < entry.next.start)) {
    entry.next = { title, start, stop };
  }
}
