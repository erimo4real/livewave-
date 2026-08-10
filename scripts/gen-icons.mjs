/**
 * Generates the LiveWave PWA icons (public/icon-*.png) with zero
 * dependencies — zlib (for PNG compression) is built into Node.
 *
 * Design: LiveWave-red rounded square with a white play triangle
 * (a subtle nod to both "TV" and "wave"). A maskable variant fills the
 * whole canvas with the content kept inside the central safe zone.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');

/* ------------------------------ minimal PNG ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA image. pixelFn(x, y) → [r, g, b, a]. */
function encodePNG(size, pixelFn) {
  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(size * rowLen);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- drawing --------------------------------- */

function inRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Right-pointing play triangle centered in the icon. */
function inTriangle(x, y, size, w, h) {
  const cx = size / 2;
  const cy = size / 2;
  const leftX = cx - w / 2;
  const topY = cy - h / 2;
  const t = (y - topY) / h; // 0 at top, 1 at bottom
  if (t < 0 || t > 1) return false;
  const rightX = leftX + t * w;
  return x >= leftX && x <= rightX;
}

/** 2×2 supersampled coverage per pixel. */
function iconPixels(size, maskable) {
  const radius = maskable ? 0 : size * 0.22;
  const triW = size * (maskable ? 0.28 : 0.36);
  const triH = size * (maskable ? 0.36 : 0.46);
  return (x, y) => {
    let bg = 0;
    let tri = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const X = x + sx;
      const Y = y + sy;
      if (inRoundedRect(X, Y, size, radius)) bg++;
      if (inTriangle(X, Y, size, triW, triH)) tri++;
    }
    const alpha = Math.max(bg, tri) / 4;
    const t = alpha === 0 ? 0 : tri / Math.max(bg, tri); // white share of the opaque part
    return [
      Math.round(229 + (255 - 229) * t), // #e5233a → white
      Math.round(35 + (255 - 35) * t),
      Math.round(58 + (255 - 58) * t),
      Math.round(alpha * 255),
    ];
  };
}

/* --------------------------------- main ----------------------------------- */

mkdirSync(outDir, { recursive: true });
for (const [file, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  const png = encodePNG(size, iconPixels(size, maskable));
  writeFileSync(join(outDir, file), png);
  console.log(`wrote public/${file} (${png.length} bytes)`);
}
