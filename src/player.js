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
    // Bound once so the same handlers can be added/removed across stream switches.
    this._onNativeMeta = () => this.onPlaying?.();
    this._onNativeErr = () => this.onError?.(new Error('Stream failed to load'));
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
    } else {
      // Native HLS (Safari/iOS) or plain MP4 / direct stream fallback
      this.video.addEventListener('loadedmetadata', this._onNativeMeta, { once: true });
      this.video.addEventListener('error', this._onNativeErr, { once: true });
      this.video.src = url;
      this.video.play().catch(() => {});
    }
  }

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
