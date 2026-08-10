import { fetchPlaylist, fetchMeta, buildChannels, filterChannels } from './data.js';
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
  emptyText: document.querySelector('#empty p'),
};

const FAV_KEY = 'livewave:favorites';

const state = {
  data: null,
  channelById: new Map(),
  favorites: loadFavorites(),
  favOnly: false,
  query: '',
  country: '',
  category: '',
  visible: PAGE,
  current: null,
  streamIndex: 0,
  autoTries: 0,
  player: null,
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
  return list;
}

function render() {
  const list = filtered();
  const anyFilter = state.query || state.country || state.category || state.favOnly;

  el.clearFilters.hidden = !anyFilter;
  el.resultCount.textContent = list.length
    ? `${Math.min(state.visible, list.length).toLocaleString()} of ${list.length.toLocaleString()} channels`
    : '';
  el.empty.hidden = list.length > 0;
  if (list.length === 0) {
    el.emptyText.textContent = state.favOnly && state.favorites.size === 0
      ? 'No favorites yet — tap the ☆ on any channel to save it.'
      : '😕 No channels match your filters.';
  }

  el.grid.textContent = '';
  const slice = list.slice(0, state.visible);
  for (const ch of slice) el.grid.appendChild(card(ch));

  el.loadMore.hidden = state.visible >= list.length;
  el.loadMore.textContent = `Show more (${(list.length - state.visible).toLocaleString()} remaining)`;
  updateFavUI();
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

  btn.append(logo, name, meta);
  btn.addEventListener('click', () => openModal(ch));
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

/* ---------------------------------- modal ---------------------------------- */

function openModal(ch) {
  state.current = ch;
  state.streamIndex = 0;
  state.autoTries = 0;
  state.httpsRetried = false;
  state.player = new StreamPlayer(el.player);
  state.player.onError = onStreamError;
  state.player.onPlaying = () => {
    clearTimeout(state.startTimer);
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

  renderStreamList();
  hideError();
  showOverlay('Starting stream…');
  updateFavUI();
  playStream();

  el.modal.hidden = false;
  document.body.classList.add('modal-open');
}

function playStream() {
  const ch = state.current;
  const s = ch.streams[state.streamIndex];
  // On https pages browsers block http:// media (mixed content). Many IPTV
  // hosts serve both schemes, so try the https:// variant once first.
  const isHttpsPage = location.protocol === 'https:';
  const useHttps = isHttpsPage && s.url.startsWith('http://') && !state.httpsRetried;
  const url = useHttps ? 'https://' + s.url.slice('http://'.length) : s.url;
  hideError();
  showOverlay(s.userAgent ? 'Starting stream (may need a special user-agent)…' : 'Starting stream…');
  el.openStream.href = s.url;
  // Fail fast: if the stream hasn't started within 12s it's dead or CORS-blocked.
  clearTimeout(state.startTimer);
  state.startTimer = setTimeout(() => onStreamError(new Error('Stream timed out')), 12000);
  state.player.load(url);
  el.player.play().catch(() => {});
  updateStreamListActive();
}

function onStreamError(err) {
  console.warn('stream error:', err);
  clearTimeout(state.startTimer);
  const ch = state.current;
  const s = ch.streams[state.streamIndex];

  // If the http:// stream failed before we tried its https:// variant, retry
  // it once (same stream, https) before moving on.
  if (location.protocol === 'https:' && s.url.startsWith('http://') && !state.httpsRetried) {
    state.httpsRetried = true;
    playStream();
    return;
  }

  const next = state.streamIndex + 1;

  // Silently try up to 2 more streams before bothering the user.
  if (next < ch.streams.length && state.autoTries < 2) {
    state.autoTries += 1;
    state.streamIndex = next;
    state.httpsRetried = false;
    playStream();
    return;
  }

  hideOverlay();
  el.playerErrorText.textContent = `This stream couldn't be played (${err?.message || 'unknown error'}). ` +
    (ch.streams.length > 1 ? 'Try another stream below, or copy the URL and open it in VLC.' : 'Try copying the URL and opening it in VLC.');
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
      state.httpsRetried = false;
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
  applyFilters();
});
el.favFilter.addEventListener('click', () => {
  state.favOnly = !state.favOnly;
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
    state.httpsRetried = false;
    playStream();
  } else {
    state.streamIndex = 0;
    state.autoTries = 0;
    state.httpsRetried = false;
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
