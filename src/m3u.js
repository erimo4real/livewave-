/**
 * Parser for iptv-org style M3U playlists.
 *
 * Entry format:
 *   #EXTINF:-1 tvg-id="Channel.id@HD" tvg-logo="https://…" group-title="News",Channel Name
 *   https://example.com/stream.m3u8
 *   (#EXTVLCOPT:http-user-agent=… lines may appear before the URL)
 */
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

/**
 * Parse playlist text into a list of raw entries.
 * @param {string} text
 * @returns {Array<{id:string, name:string, logo:string, category:string, url:string, userAgent:string|null}>}
 */
export function parseM3U(text) {
  const entries = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      current = parseExtInf(line);
      if (current) entries.push(current);
    } else if (line.startsWith('#EXTVLCOPT:http-user-agent=') && current) {
      const ua = line.slice('#EXTVLCOPT:http-user-agent='.length).trim();
      if (ua) current.userAgent = ua;
    } else if (!line.startsWith('#') && current && !current.url) {
      current.url = line;
      current = null; // URL consumed — next EXTINF starts a new entry
    }
  }

  return entries.filter((e) => e.url);
}

function parseExtInf(line) {
  const rest = line.slice('#EXTINF:'.length);
  const attrs = {};

  let m;
  let lastEnd = 0;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(rest)) !== null) {
    attrs[m[1]] = m[2];
    lastEnd = ATTR_RE.lastIndex; // exec() resets lastIndex to 0 on failure, so save it now
  }

  // Anything after the last attribute is the display name:  "… ,Name" or "…,Name"
  const name = rest.slice(lastEnd).replace(/^\s*,\s*/, '').trim();
  if (!name) return null;

  const rawId = attrs['tvg-id'] || '';
  const quality = qualityFromId(rawId) || qualityFromName(name);

  return {
    // Base channel id (strip @HD/@SD). Anonymous channels are keyed by a
    // cleaned name so quality variants like "X (1080p)" / "X (720p)" group.
    id: rawId.split('@')[0] || `anon:${stripQualitySuffix(name).toLowerCase()}`,
    quality,
    name,
    logo: attrs['tvg-logo'] || '',
    category: attrs['group-title'] || 'Other',
    url: '',
    userAgent: attrs['http-user-agent'] || null,
  };
}

export function qualityFromId(rawId) {
  const q = (rawId.split('@')[1] || '').toUpperCase();
  const map = { SD: 'SD', HD: 'HD', FHD: 'FHD', '4K': '4K' };
  return map[q] || null;
}

export function qualityFromName(name) {
  const m = name.match(/\((4K|1080p|720p|576p|480p|FHD|HD|SD)\)/i);
  if (!m) return null;
  const label = m[1].toLowerCase();
  return label === '4k' ? '4K' : label;
}

/** Strip trailing quality/resolution and status tags: "X (1080p) [Geo-blocked]" → "X". */
export function stripQualitySuffix(name) {
  return name.replace(/(?:(?:\([^)]*\d+\s*[pi]\)|\[[^\]]*\])\s*)*$/i, '').trim();
}

/** Rank used to pick the best default stream for a channel. */
export function qualityRank(q) {
  const order = ['4K', '1080p', 'FHD', '720p', '576p', '480p', 'HD', 'SD'];
  const i = order.indexOf(q);
  return i === -1 ? order.length : i;
}
