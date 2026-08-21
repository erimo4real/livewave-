/**
 * Player wrapper around <video> + hls.js. Handles teardown and error events
 * so the UI can react to dead streams.
 *
 * When direct playback fails (CORS, mixed-content, network), the player
 * automatically retries through the /api/stream CORS proxy so streams play
 * in the browser instead of forcing the user to open VLC.
 */
import Hls from 'hls.js';

const PROXY = '/api/stream?url=';

export class StreamPlayer {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    this.video = video;
    this.hls = null;
    this.onError = null;
    this.onPlaying = null;
    this._onNativeMeta = () => this.onPlaying?.();
    this._onNativeErr = () => this.onError?.(new Error('Stream failed to load'));
    this._usingProxy = false;
    this._originalUrl = null;
  }

  /**
   * Load a stream URL.  When `originalUrl` is provided it is the unrewritten
   * URL (e.g. http:// on an HTTPS page) used for the CORS proxy fallback.
   */
  load(url, originalUrl) {
    this.destroy();
    this.video.controls = true;
    this._retried = false;
    this._originalUrl = originalUrl || url;

    if (Hls.isSupported() && /\.m3u8($|\?)/i.test(url)) {
      this._loadHls(url);
    } else {
      this._loadNative(url);
    }
  }

  /* ----------------------------- HLS (hls.js) ----------------------------- */

  _loadHls(url) {
    const proxying = this._usingProxy;

    this.hls = new Hls({
      enableWorker: true,
      fragLoadingMaxRetry: proxying ? 3 : 4,
      manifestLoadingMaxRetry: proxying ? 2 : 1,
      levelLoadingMaxRetry: 2,
      // When using the proxy, route every XHR through /api/stream
      ...(proxying && {
        xhrSetup: (xhr, reqUrl) => {
          xhr.open('GET', PROXY + encodeURIComponent(reqUrl), true);
        },
      }),
    });

    this.hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          if (!this._retried) {
            // One automatic reload for transient network hiccups
            this._retried = true;
            this.hls.startLoad();
          } else {
            // Let the UI decide: proxy retry or next stream
            this.onError?.(new Error(`Network error: ${data.details || data.type}`));
          }
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          this.hls.recoverMediaError();
          break;
        default:
          this.onError?.(new Error(`Stream failed: ${data.details || data.type}`));
      }
    });

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.onPlaying?.();
      this.video.play().catch(() => {});
    });

    this.hls.loadSource(url);
    this.hls.attachMedia(this.video);
  }

  /* ---------------------------- Native <video> ---------------------------- */

  _loadNative(url) {
    this.video.addEventListener('loadedmetadata', this._onNativeMeta, { once: true });
    this.video.addEventListener('error', this._onNativeErr, { once: true });
    // When proxying, route through /api/stream
    this.video.src = this._usingProxy ? PROXY + encodeURIComponent(url) : url;
    this.video.play().catch(() => {});
  }

  /* -------------------------- Proxy fallback ------------------------------- */

  /** Retry the same stream through the CORS proxy. */
  retryViaProxy() {
    const url = this._originalUrl;
    if (!url) return;
    this._usingProxy = true;
    this.destroy();
    if (/\.m3u8($|\?)/i.test(url)) {
      this._loadHls(url);
    } else {
      this._loadNative(url);
    }
  }

  /* ------------------------------ Teardown --------------------------------- */

  destroy() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeEventListener('loadedmetadata', this._onNativeMeta);
    this.video.removeEventListener('error', this._onNativeErr);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
