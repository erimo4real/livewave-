/**
 * Vercel proxy + trimmer for EPG schedule data.
 *
 * iptv-epg.org publishes per-country XMLTV files (the US one is ~23 MB). This
 * function fetches one on the server, keeps only the current + next programme
 * per channel, and returns a compact JSON summary cached at the edge for 30
 * minutes. Channel ids match iptv-org tvg-ids (e.g. "CNN.us").
 *
 * Usage: GET /api/epg?country=us
 */
import { xmltvTimeToEpoch, unescapeXml, selectNowNext } from '../src/epg.js';

const TIMEOUT_MS = 50000;
const PROG_RE = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
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
    const text = await upstream.text();
    const channels = extractNowNext(text);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=21600');
    res.setHeader('CDN-Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');
    res.status(200).json({ generated: new Date().toISOString(), channels });
  } catch (err) {
    res.status(504).json({ error: 'upstream EPG fetch failed' });
  } finally {
    clearTimeout(timer);
  }
}

/** One pass over the XML: collect programmes, then pick now/next per channel. */
function extractNowNext(xml) {
  const programmes = [];
  let m;
  PROG_RE.lastIndex = 0;
  while ((m = PROG_RE.exec(xml)) !== null) {
    const attrs = {};
    let a;
    ATTR_RE.lastIndex = 0;
    const attrStr = m[1];
    while ((a = ATTR_RE.exec(attrStr)) !== null) attrs[a[1]] = a[2];
    const titleMatch = TITLE_RE.exec(m[2]);
    programmes.push({
      channel: attrs.channel || '',
      title: titleMatch ? unescapeXml(titleMatch[1]) : '',
      start: xmltvTimeToEpoch(attrs.start || ''),
      stop: xmltvTimeToEpoch(attrs.stop || ''),
    });
  }
  return selectNowNext(programmes);
}
