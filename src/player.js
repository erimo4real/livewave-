/**
 * Player wrapper around <video> + hls.js. Handles teardown and error events
 * so the UI can react to dead streams.
 */
import Hls from 'hls.js';

export class StreamPlayer {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    this.video = video;
    this.hls = null;
    this.onError = null;
    this.onPlaying = null;
  }

  load(url) {
    this.destroy();
    this.video.controls = true;
    this._retried = false;

    if (Hls.isSupported() && /\.m3u8($|\?)/i.test(url)) {
      this.hls = new Hls({
        enableWorker: true,
        // Some public streams are flaky — retry a bit, but fail fast so the
        // UI can move on to the next stream for the channel.
        fragLoadingMaxRetry: 4,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 2,
      });
      this.hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (!this._retried) {
                this._retried = true; // one automatic reload for transient hiccups
                this.hls.startLoad();
              } else {
                this.onError?.(new Error(`Network error: ${data.details || data.type}`));
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.hls.recoverMediaError();
              break;
            default:
              this.onError?.(new Error(`Stream failed: ${data.details || data.type}`));
          }
        }
      });
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.onPlaying?.();
        this.video.play().catch(() => {});
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS native HLS
      this.video.src = url;
      this.video.addEventListener('loadedmetadata', () => this.onPlaying?.(), { once: true });
      this.video.addEventListener('error', () => this.onError?.(new Error('Stream failed to load')), { once: true });
      this.video.play().catch(() => {});
    } else {
      // Plain MP4 / direct stream fallback
      this.video.src = url;
      this.video.addEventListener('loadedmetadata', () => this.onPlaying?.(), { once: true });
      this.video.addEventListener('error', () => this.onError?.(new Error('Stream failed to load')), { once: true });
      this.video.play().catch(() => {});
    }
  }

  destroy() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
