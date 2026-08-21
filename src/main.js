import { fetchPlaylist, fetchMeta, buildChannels, filterChannels, withProgrammeMatches } from './data.js';
import { isFootballChannel, footballLeagues } from './football.js';
import { fetchCountryEpg, getProgrammes, fetchChannelLineup, getChannelLineup } from './epg.js';
import { StreamPlayer } from './player.js';
import './style.css';

const PAGE = 120;

const $ = (id) => document.getElementById(id);

const el = {
  loading: $('loading'),
  loadingText: $('loading-text'),
  error: $('error'),
  errorText: $('error-text'),
  retry: $('retry'),
  grid: $('grid'),
  empty: $('empty'),
  loadMore: $('load-more'),
  search: $('search'),
  countryFilter: $('country-filter'),
  categoryFilter: $('category-filter'),
  clearFilters: $('clear-filters'),
  favFilter: $('fav-filter'),
  footballFilter: $('football-filter'),
  leagueFilter: $('league-filter'),
  resultCount: $('result-count'),
  headerStats: $('header-stats'),
  installBtn: $('install-btn'),
  // modal
  modal: $('modal'),
  player: $('player'),
  playerLogo: $('player-logo'),
  playerName: $('player-name'),
  playerMeta: $('player-meta'),
  openStream: $('open-stream'),
  copyUrl: $('copy-url'),
  copyUrl2: $('copy-url-2'),
  closeModal: $('close-modal'),
  playerOverlay: $('player-overlay'),
  playerOverlayText: $('player-overlay-text'),
  playerError: $('player-error'),
  playerErrorText: $('player-error-text'),
  retryStream: $('retry-stream'),
  streamList: $('stream-list'),
  favModal: $('fav-modal'),
  playerProgramme: $('player-programme'),
  programmeGuide: $('programme-guide'),
  programmeGuideList: $('programme-guide-list'),
  emptyText: document.querySelector('#empty p'),
};

const FAV_KEY = 'livewave:favorites';

let footballCount = 0; // total football channels (set in populateFilters)

let openModalGeneration = 0; // guards against overlapping async openModal calls
const cardElements = new Map(); // channelId -> { cardEl, nowEl } for in-place EPG updates

const state = {
  data: null,
  channelById: new Map(),
  favorites: loadFavorites(),
  favOnly: false,
  footballOnly: false,
  league: '',
  query: '',
  country: '',
  category: '',
  visible: PAGE,
  current: null,
  streamIndex: 0,
  autoTries: 0,
  player: null,
  streamHealth: new Map(), // url -> { ok: boolean, timestamp: number }
};

/* -------------------------------- favorites -------------------------------- */

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function persistFavorites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
  } catch {
    /* storage unavailable (private mode / quota) — favorites just won't persist */
  }
}

function toggleFav(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  persistFavorites();
  render();
}

/** Keep the toolbar + modal favorite buttons in sync with the saved list. */
function updateFavUI() {
  const n = state.favorites.size;
  el.favFilter.textContent = `⭐ Favorites${n ? ` (${n})` : ''}`;
  el.favFilter.classList.toggle('active', state.favOnly);
  if (state.current) {
    const fav = state.favorites.has(state.current.id);
    el.favModal.textContent = fav ? '★ Saved' : '☆ Favorite';
    el.favModal.classList.toggle('on', fav);
  }
}

/** Keep the football button + league select in sync with the filter state. */
function updateFootballUI() {
  el.footballFilter.textContent = `⚽ Football${footballCount ? ` (${footballCount})` : ''}`;
  el.footballFilter.classList.toggle('active', state.footballOnly);
  el.leagueFilter.disabled = !state.footballOnly && !state.league;
  if (!state.footballOnly && !state.league) el.leagueFilter.value = '';
}

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  el.loading.hidden = false;
  el.error.hidden = true;

  let entries;
  try {
    entries = await fetchPlaylist(onProgress);
  } catch (err) {
    console.error(err);
    return showLoadError(err);
  }

  // Render the channel grid immediately from the playlist (~3 MB).
  state.data = buildChannels(entries, null);
  state.channelById = new Map(state.data.channels.map((c) => [c.id, c]));
  el.headerStats.textContent = `${state.data.channels.length.toLocaleString()} channels · loading countries…`;
  populateFilters();
  render();
  el.loading.hidden = true;
  el.grid.hidden = false;

  // Fill in the country filter when the larger metadata file (~10 MB) arrives.
  try {
    const meta = await fetchMeta(onProgress);
    state.data = buildChannels(entries, meta);
    state.channelById = new Map(state.data.channels.map((c) => [c.id, c]));
    el.headerStats.textContent =
      `${state.data.channels.length.toLocaleString()} channels · ` +
      `${state.data.countries.length} countries · ` +
      `updated daily from iptv-org`;
    populateFilters();
    render();
  } catch (err) {
    console.warn('country metadata failed:', err);
    el.headerStats.textContent = `${state.data.channels.length.toLocaleString()} channels · country filter unavailable`;
  }

  // Background: load guides for the biggest countries so cards can show
  // what's on now. Channels without a known country are skipped.
  prefetchEpg();
}

function showLoadError(err) {
  el.loading.hidden = true;
  el.error.hidden = false;
  const reason = err?.name === 'AbortError'
    ? 'the download timed out'
    : err?.message || 'unknown error';
  el.errorText.textContent =
    `Couldn't load channels: ${reason}. Check your internet connection — ` +
    `some networks and ad-blockers block free-TV domains like iptv-org.github.io. ` +
    `Then press “Try again”.`;
}

function onProgress({ label, size }) {
  el.loadingText.textContent = size ? `${label} (${size})…` : `${label}…`;
}

/* --------------------------------- filters -------------------------------- */

function populateFilters() {
  const { countries, categories, channels } = state.data;

  // Clear previous options (keep the "All …" placeholders) — boot() may run twice.
  el.countryFilter.length = 1;
  el.categoryFilter.length = 1;

  for (const c of countries) {
    const count = channels.filter((ch) => ch.country === c.code).length;
    if (!count) continue;
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = `${c.flag} ${c.name} (${count.toLocaleString()})`;
    el.countryFilter.appendChild(opt);
  }

  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat.name;
    opt.textContent = `${cat.name} (${cat.count.toLocaleString()})`;
    el.categoryFilter.appendChild(opt);
  }

  // Football league tags are derived from channel names — collect them here.
  const leagues = new Set();
  for (const ch of channels) for (const lg of footballLeagues(ch.name)) leagues.add(lg);
  el.leagueFilter.length = 1; // keep "All leagues"
  for (const lg of [...leagues].sort((a, b) => a.localeCompare(b))) {
    const opt = document.createElement('option');
    opt.value = lg;
    opt.textContent = lg;
    el.leagueFilter.appendChild(opt);
  }

  footballCount = channels.filter((ch) => isFootballChannel(ch.name)).length;
}

function applyFilters() {
  state.query = el.search.value;
  state.country = el.countryFilter.value;
  state.category = el.categoryFilter.value;
  state.visible = PAGE;
  render();
}

/* ---------------------------------- render --------------------------------- */

function filtered() {
  let list = filterChannels(state.data.channels, {
    query: state.query,
    country: state.country,
    category: state.category,
    countryOf: state.data.countryOf,
  });
  if (state.favOnly) list = list.filter((ch) => state.favorites.has(ch.id));
  // Football: a chosen league narrows the football channels; the ⚽ button
  // alone shows all of them. Multi-sport networks stay out by design.
  if (state.league) {
    list = list.filter((ch) => footballLeagues(ch.name).includes(state.league));
  } else if (state.footballOnly) {
    list = list.filter((ch) => isFootballChannel(ch.name));
  }
  // Also match what's currently airing, using EPG data already in memory.
  list = withProgrammeMatches(list, state.data.channels, {
    query: state.query,
    country: state.country,
    category: state.category,
    nowTitleOf,
  });
  return list;
}

/** The title of what's currently airing on a channel ('' when unknown). */
function nowTitleOf(ch) {
  if (!ch.country) return '';
  const prog = getProgrammes(ch.country, ch.id);
  if (prog?.now?.title) return prog.now.title;
  return getChannelLineup(ch.country, ch.id)?.now?.title || '';
}

function render() {
  const list = filtered();
  const anyFilter = state.query || state.country || state.category || state.favOnly || state.footballOnly || state.league;

  el.clearFilters.hidden = !anyFilter;
  el.resultCount.textContent = list.length
    ? `${Math.min(state.visible, list.length).toLocaleString()} of ${list.length.toLocaleString()} channels`
    : '';
  el.empty.hidden = list.length > 0;
  if (list.length === 0) {
    el.emptyText.textContent = state.favOnly && state.favorites.size === 0
      ? 'No favorites yet — tap the ☆ on any channel to save it.'
      : state.league
        ? `No ${state.league} channels in the free playlist right now.`
        : state.footballOnly
          ? '😕 No football channels match your other filters.'
          : '😕 No channels match your filters.';
  }

  el.grid.textContent = '';
  cardElements.clear();
  const slice = list.slice(0, state.visible);
  for (const ch of slice) el.grid.appendChild(card(ch));

  el.loadMore.hidden = state.visible >= list.length;
  el.loadMore.textContent = `Show more (${(list.length - state.visible).toLocaleString()} remaining)`;
  updateFavUI();
  updateFootballUI();
}

function card(ch) {
  const btn = document.createElement('button');
  btn.className = 'card';
  btn.type = 'button';
  btn.setAttribute('aria-label', `Watch ${ch.name}`);

  const logo = document.createElement('div');
  logo.className = 'card-logo';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  const fallback = document.createElement('span');
  fallback.className = 'logo-fallback';
  fallback.textContent = initials(ch.name);
  if (ch.logo) {
    img.src = ch.logo;
    img.addEventListener('error', () => {
      img.remove();
      fallback.hidden = false;
    });
    logo.appendChild(img);
  }
  logo.appendChild(fallback);
  fallback.hidden = Boolean(ch.logo);

  const isFav = state.favorites.has(ch.id);
  const fav = document.createElement('span');
  fav.className = 'fav-btn' + (isFav ? ' on' : '');
  fav.setAttribute('role', 'button');
  fav.tabIndex = 0;
  fav.setAttribute('aria-label', isFav ? `Remove ${ch.name} from favorites` : `Add ${ch.name} to favorites`);
  fav.textContent = isFav ? '★' : '☆';
  fav.addEventListener('click', (e) => {
    e.stopPropagation(); // don't open the player
    toggleFav(ch.id);
  });
  fav.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(ch.id);
    }
  });
  logo.appendChild(fav);

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = ch.name;
  name.title = ch.name;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const country = ch.country ? state.data.countryOf(ch.country) : null;
  if (country) {
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = country.flag;
    meta.appendChild(flag);
  }
  const cat = document.createElement('span');
  cat.className = 'cat';
  cat.textContent = ch.category === 'Undefined' ? 'Other' : ch.category;
  meta.appendChild(cat);
  // In football mode, show which leagues each channel carries.
  if (state.footballOnly || state.league) {
    for (const lg of footballLeagues(ch.name)) {
      const chip = document.createElement('span');
      chip.className = 'league-chip';
      chip.textContent = lg;
      chip.title = lg;
      meta.appendChild(chip);
    }
  }

  btn.append(logo, name);
  let nowEl = null;
  const prog = ch.country ? getProgrammes(ch.country, ch.id) : null;
  if (prog?.now) {
    nowEl = document.createElement('div');
    nowEl.className = 'card-now';
    nowEl.textContent = `Now: ${prog.now.title}`;
    nowEl.title = `On now: ${prog.now.title}\nNext: ${prog.next ? prog.next.title : '—'}`;
    btn.appendChild(nowEl);
  }
  btn.appendChild(meta);
  btn.addEventListener('click', () => openModal(ch));
  cardElements.set(ch.id, { cardEl: btn, nowEl });
  return btn;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || 'TV';
}

/**
 * In-place EPG update: when new programme data arrives (from prefetchEpg),
 * update just the "Now:" labels on visible cards instead of rebuilding the
 * entire grid.  This avoids the flicker and GC pressure of a full re-render.
 */
function updateEpgLabels() {
  for (const [id, refs] of cardElements) {
    if (!refs.cardEl.isConnected) continue; // card was removed by a re-render
    const ch = state.data.channelById.get(id);
    if (!ch) continue;
    const prog = ch.country ? getProgrammes(ch.country, ch.id) : null;
    if (prog?.now) {
      if (!refs.nowEl) {
        // "Now:" element didn't exist yet — create and insert it.
        const nowEl = document.createElement('div');
        nowEl.className = 'card-now';
        const metaEl = refs.cardEl.querySelector('.card-meta');
        refs.cardEl.insertBefore(nowEl, metaEl);
        refs.nowEl = nowEl;
      }
      refs.nowEl.textContent = `Now: ${prog.now.title}`;
      refs.nowEl.title = `On now: ${prog.now.title}\nNext: ${prog.next ? prog.next.title : '—'}`;
    }
  }
}

/* ---------------------------------- modal ---------------------------------- */

/**
 * Quick HEAD-style probe: does the stream server respond at all?
 * Uses the CORS proxy so we avoid mixed-content / CORS blocks during probing.
 */
async function probeStream(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/stream?url=${encodeURIComponent(url)}`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Cancel the body immediately — we only needed the status code.
    if (res.body) res.body.cancel().catch(() => {});
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

/**
 * Probe all streams in parallel; resolve with the index of the first one
 * whose server responds OK.  Streams known-dead from a recent probe are
 * skipped.  Falls back to index 0 when nothing responds.
 */
async function findBestStream(streams) {
  if (streams.length <= 1) return 0;

  const PROBE_TIMEOUT = 4000;
  const FRESHNESS_MS = 5 * 60_000; // skip streams dead <5 min ago

  // Filter out recently-probed dead streams
  const candidates = streams
    .map((s, i) => ({ stream: s, index: i }))
    .filter(({ stream }) => {
      const h = state.streamHealth.get(stream.url);
      if (h && !h.ok && Date.now() - h.timestamp < FRESHNESS_MS) return false;
      return true;
    });

  if (candidates.length === 0) return 0; // all known-dead — try first anyway
  if (candidates.length === 1) return candidates[0].index;

  // Fire probes in parallel; resolve with the first success.
  const probes = candidates.map(({ stream, index }) =>
    probeStream(stream.url, PROBE_TIMEOUT).then((ok) => {
      state.streamHealth.set(stream.url, { ok, timestamp: Date.now() });
      if (!ok) throw new Error('probe failed');
      return index;
    }),
  );

  try {
    return await Promise.any(probes);
  } catch {
    return candidates[0].index;
  }
}

async function openModal(ch) {
  const generation = ++openModalGeneration;

  state.current = ch;
  state.streamIndex = 0;
  state.autoTries = 0;
  state.proxyRetried = false;
  state.player = new StreamPlayer(el.player);
  state.player.onError = onStreamError;
  state.player.onPlaying = () => {
    clearTimeout(state.startTimer);
    // Mark this stream as working in the health cache
    if (state.current) {
      const s = state.current.streams[state.streamIndex];
      state.streamHealth.set(s.url, { ok: true, timestamp: Date.now() });
    }
    hideOverlay();
  };

  el.playerLogo.src = ch.logo;
  el.playerLogo.hidden = !ch.logo;
  el.playerName.textContent = ch.name;

  const country = ch.country ? state.data.countryOf(ch.country) : null;
  el.playerMeta.textContent = [
    country ? `${country.flag} ${country.name}` : '',
    ch.category === 'Undefined' ? 'Other' : ch.category,
    `${ch.streams.length} stream${ch.streams.length > 1 ? 's' : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // EPG: topbar now/next line + the mini programme guide.
  el.playerProgramme.textContent = '';
  renderGuide();
  if (ch.country) {
    const cc = ch.country;
    const prog = getProgrammes(cc, ch.id);
    if (prog) setProgrammeText(prog);
    fetchChannelLineup(cc, ch.id)
      .then((data) => {
        if (state.current?.id !== ch.id) return;
        if (!getProgrammes(cc, ch.id)) setProgrammeText(data);
        renderGuide();
      })
      .catch(() => {});
  }
  clearInterval(state.guideTimer);
  state.guideTimer = setInterval(() => {
    if (state.current) renderGuide();
  }, 60000);

  renderStreamList();
  hideError();
  updateFavUI();

  el.modal.hidden = false;
  document.body.classList.add('modal-open');

  // Probe all streams in parallel to find the one most likely to work.
  if (ch.streams.length > 1) {
    showOverlay('Finding best stream…');
  } else {
    showOverlay('Starting stream…');
  }
  state.streamIndex = await findBestStream(ch.streams);

  // If the user opened a different channel while we were probing, bail out.
  if (generation !== openModalGeneration) return;

  state.proxyRetried = false;
  playStream();
}

function playStream() {
  const ch = state.current;
  const s = ch.streams[state.streamIndex];
  // On https pages browsers block http:// media (mixed content). Many IPTV
  // hosts serve both schemes, so try the https:// variant.
  const isHttpsPage = location.protocol === 'https:';
  const url = isHttpsPage && s.url.startsWith('http://')
    ? 'https://' + s.url.slice('http://'.length)
    : s.url;
  hideError();
  showOverlay(s.userAgent ? 'Starting stream (may need a special user-agent)…' : 'Starting stream…');
  el.openStream.href = s.url;
  // Fail fast: if the stream hasn't started within 12s it's dead or CORS-blocked.
  clearTimeout(state.startTimer);
  state.startTimer = setTimeout(() => onStreamError(new Error('Stream timed out')), 12000);
  // Pass the original (unrewritten) URL so the proxy can fetch it correctly.
  state.player.load(url, s.url);
  updateStreamListActive();
}

function onStreamError(err) {
  console.warn('stream error:', err);
  clearTimeout(state.startTimer);
  const ch = state.current;
  const s = ch.streams[state.streamIndex];

  // Record this stream as dead in the health cache.
  state.streamHealth.set(s.url, { ok: false, timestamp: Date.now() });

  // Retry through the CORS proxy — bypasses mixed-content and CORS blocks
  // that prevent the browser from loading IPTV streams directly.
  if (!state.proxyRetried) {
    state.proxyRetried = true;
    state.player.retryViaProxy();
    showOverlay('Retrying through proxy…');
    clearTimeout(state.startTimer);
    state.startTimer = setTimeout(() => onStreamError(new Error('Stream timed out')), 15000);
    return;
  }

  // Find the next stream that isn't known-dead.
  const FRESHNESS_MS = 5 * 60_000;
  let next = state.streamIndex + 1;
  while (next < ch.streams.length) {
    const h = state.streamHealth.get(ch.streams[next].url);
    if (!h || h.ok || Date.now() - h.timestamp > FRESHNESS_MS) break;
    next++;
  }

  // Silently try up to 2 more streams before bothering the user.
  if (next < ch.streams.length && state.autoTries < 2) {
    state.autoTries += 1;
    state.streamIndex = next;
    state.proxyRetried = false;
    playStream();
    return;
  }

  hideOverlay();
  el.playerErrorText.textContent =
    `This stream couldn't be played (${err?.message || 'unknown error'}). ` +
    (ch.streams.length > 1
      ? 'Try another stream below — different sources have different availability.'
      : 'This stream may be temporarily unavailable. Try again later.');
  el.playerError.hidden = false;
  updateStreamListActive();
}

function renderStreamList() {
  const ch = state.current;
  el.streamList.textContent = '';
  ch.streams.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'stream-btn';
    btn.dataset.index = String(i);
    btn.textContent = s.quality ? `${s.quality} stream` : `Stream ${i + 1}`;
    if (s.userAgent) btn.title = 'May require a special user-agent to play';
    btn.addEventListener('click', () => {
      state.streamIndex = i;
      state.autoTries = 0;
      state.proxyRetried = false;
      playStream();
    });
    el.streamList.appendChild(btn);
  });
}

function updateStreamListActive() {
  for (const btn of el.streamList.children) {
    btn.classList.toggle('active', Number(btn.dataset.index) === state.streamIndex);
  }
}

function closeModal() {
  clearTimeout(state.startTimer);
  clearInterval(state.guideTimer);
  if (state.player) {
    state.player.destroy();
    state.player = null;
  }
  state.current = null;
  el.modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function showOverlay(text) {
  el.playerOverlayText.textContent = text;
  el.playerOverlay.hidden = false;
}

function hideOverlay() {
  el.playerOverlay.hidden = true;
}

function hideError() {
  el.playerError.hidden = true;
}

/* ----------------------------------- EPG ----------------------------------- */

const EPG_PREFETCH_COUNT = 8;

/** Prefetch guides for the countries with the most channels, in the background. */
async function prefetchEpg() {
  if (!state.data) return;
  const counts = new Map();
  for (const ch of state.data.channels) {
    if (ch.country) counts.set(ch.country, (counts.get(ch.country) || 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, EPG_PREFETCH_COUNT)
    .map(([cc]) => cc);
  for (const cc of top) {
    try {
      await fetchCountryEpg(cc);
      updateEpgLabels(); // in-place update — no full grid rebuild
    } catch {
      /* provider has no guide for this country — skip */
    }
  }
}

/** Format the modal's now/next programme line. */
function setProgrammeText(prog) {
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (prog?.now && prog.next) {
    el.playerProgramme.textContent =
      `On now: ${prog.now.title} (until ${fmt(prog.now.stop)}) · Next: ${prog.next.title} at ${fmt(prog.next.start)}`;
  } else if (prog?.now) {
    el.playerProgramme.textContent = `On now: ${prog.now.title} (until ${fmt(prog.now.stop)})`;
  } else if (prog?.next) {
    el.playerProgramme.textContent = `Next: ${prog.next.title} at ${fmt(prog.next.start)}`;
  } else {
    el.playerProgramme.textContent = '';
  }
}

/**
 * Render the modal's mini programme guide from the cached lineup. The panel
 * stays hidden when no EPG data is available for the channel.
 */
function renderGuide() {
  const ch = state.current;
  if (!ch?.country) {
    el.programmeGuideList.textContent = '';
    el.programmeGuide.hidden = true;
    return;
  }
  const data = getChannelLineup(ch.country, ch.id);
  const list = data?.lineup || [];
  if (!list.length) {
    el.programmeGuideList.textContent = '';
    el.programmeGuide.hidden = true;
    return;
  }

  const now = Date.now();
  el.programmeGuideList.textContent = '';
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'guide-row' + (p.start <= now && now < p.stop ? ' now' : '');

    const time = document.createElement('span');
    time.className = 'guide-time';
    time.textContent = `${fmtClock(p.start)} – ${fmtClock(p.stop)}`;

    const title = document.createElement('span');
    title.className = 'guide-title';
    title.textContent = p.title;
    title.title = p.title;

    row.append(time, title);
    el.programmeGuideList.appendChild(row);
  }
  el.programmeGuide.hidden = false;
}

function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------- events --------------------------------- */

el.search.addEventListener('input', () => {
  clearTimeout(el.search._t);
  el.search._t = setTimeout(applyFilters, 150);
});
el.countryFilter.addEventListener('change', applyFilters);
el.categoryFilter.addEventListener('change', applyFilters);
el.clearFilters.addEventListener('click', () => {
  el.search.value = '';
  el.countryFilter.value = '';
  el.categoryFilter.value = '';
  state.favOnly = false;
  state.footballOnly = false;
  state.league = '';
  applyFilters();
});
el.favFilter.addEventListener('click', () => {
  state.favOnly = !state.favOnly;
  state.visible = PAGE;
  render();
});
el.footballFilter.addEventListener('click', () => {
  state.footballOnly = !state.footballOnly;
  if (!state.footballOnly) state.league = '';
  state.visible = PAGE;
  render();
});
el.leagueFilter.addEventListener('change', () => {
  state.league = el.leagueFilter.value;
  if (state.league) state.footballOnly = true; // a league implies football
  state.visible = PAGE;
  render();
});
el.favModal.addEventListener('click', () => {
  if (state.current) toggleFav(state.current.id);
});
el.loadMore.addEventListener('click', () => {
  state.visible += PAGE;
  render();
});
el.retry.addEventListener('click', boot);
el.closeModal.addEventListener('click', closeModal);
el.copyUrl.addEventListener('click', () => copyStreamUrl());
el.copyUrl2.addEventListener('click', () => copyStreamUrl());
el.retryStream.addEventListener('click', () => {
  if (state.current && state.streamIndex + 1 < state.current.streams.length) {
    state.streamIndex += 1;
    state.autoTries = 0;
    state.proxyRetried = false;
    playStream();
  } else {
    state.streamIndex = 0;
    state.autoTries = 0;
    state.proxyRetried = false;
    playStream();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modal.hidden) closeModal();
});
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});

function copyStreamUrl() {
  const ch = state.current;
  if (!ch) return;
  const url = ch.streams[state.streamIndex].url;
  navigator.clipboard
    ?.writeText(url)
    .then(() => flash('Copied stream URL ✓'))
    .catch(() => flash('Copy failed — select the URL manually'));
}

function flash(msg) {
  const badge = document.createElement('div');
  badge.className = 'toast';
  badge.textContent = msg;
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 2200);
}

/* ------------------------------- PWA install ------------------------------- */

let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // don't show the default mini-infobar; use our button
  deferredInstall = e;
  el.installBtn.hidden = false;
});

el.installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  el.installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  el.installBtn.hidden = true;
});

// Register the service worker in production builds so the app can be installed
// and works offline. Dev stays unregistered to keep Vite HMR clean.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
