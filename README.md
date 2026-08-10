# LiveWave — Free Live TV

A free live TV web player powered entirely by the open
[iptv-org](https://github.com/iptv-org/iptv) playlist and [API](https://github.com/iptv-org/api).
No database, no signup — the app talks to iptv-org (directly, or through a small
caching proxy when deployed on Vercel).

## How it works

On load the app fetches the channel playlist plus country metadata and joins them in the
browser:

| Data | Source | Used for |
| --- | --- | --- |
| Channel playlist | [`iptv-org.github.io/iptv/index.m3u`](https://iptv-org.github.io/iptv/index.m3u) | Channel name, logo, category, stream URL |
| Channel metadata | [`iptv-org.github.io/api/channels.json`](https://iptv-org.github.io/api/channels.json) | Country per channel |
| Countries | [`iptv-org.github.io/api/countries.json`](https://iptv-org.github.io/api/countries.json) | Country names + flag emoji |

Streams are played with [hls.js](https://github.com/video-dev/hls.js). The playlist is
rebuilt by iptv-org every day, so the channel list is always current.

**LiveWave is also a PWA**: on production builds a service worker (`public/sw.js`)
caches the app shell and last-known channel data, so the site installs like an app
(Chrome/Edge/Safari offer an *Install app* button) and loads fast or works offline.

**Vercel deployments use a caching proxy** (`api/playlist.js`, `api/meta.js`). Fetching
~13 MB of data directly from `iptv-org.github.io` in the browser is slow or blocked on
many networks, so those two tiny functions fetch the data server-side, cache it at the
edge for 12 hours, and trim `channels.json` (10 MB) down to a small id→country map
(~1 MB). The browser then only talks to the deployment's own domain. If the proxy is
unavailable (e.g. the static build is hosted somewhere without functions), the app
automatically falls back to fetching iptv-org directly. Local dev always fetches directly.

## Running locally

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Deploying

Build it and host the `dist/` folder anywhere — GitHub Pages, Netlify, Vercel, Cloudflare
Pages, or a plain web server. On **Vercel**, the `api/` folder is picked up automatically
and the caching proxy kicks in (see above). On static hosts without functions, the app
still works — it falls back to fetching iptv-org directly, which is slower on some
networks.

## Known limitations

These are inherent to free IPTV streams, not the app:

- **Some streams won't play in a browser.** Many public streams block cross-origin
  requests (no CORS headers) or require a custom `User-Agent` / `Referer` header that
  browsers can't set on media requests. Those links still work in desktop players like
  **VLC** — use the *Copy URL* button and paste it into VLC (Media → Open Network Stream).
- **Availability varies by region and over time.** Some channels are geo-blocked,
  some go offline. When a stream fails, the app automatically tries the next stream
  for that channel and offers manual retry.
- The main playlist (`index.m3u`) intentionally excludes adult (NSFW) channels.

## Credits

All channel data and streams come from the community-maintained
[iptv-org](https://github.com/iptv-org/iptv) project (CC-BY-SA).
