'use strict';

/**
 * The tray / app icon, drawn in code.
 *
 * Node can encode a PNG with nothing but `zlib`, so the project ships no binary
 * assets at all: the repository stays text-only, and there is nothing to go
 * stale or to re-export when the design changes.
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes straight RGBA bytes as a PNG. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Convex quad hit test by consistent cross-product signs. Points are [x, y]. */
function inQuad(px, py, quad) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross === 0) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/**
 * A folded screen: two panels meeting at a gap, the far one dimmer so the fold
 * reads at 16 px.
 *
 * Both panels are the same blue rather than white, because a white glyph
 * disappears on a light taskbar and a black one disappears on the default dark
 * one. Saturation is what survives both.
 */
const NEAR = [91, 140, 255, 255];
const FAR = [91, 140, 255, 120];

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const s = size / 32;

  const near = [
    [3.5 * s, 6 * s],
    [14.5 * s, 8 * s],
    [14.5 * s, 26 * s],
    [3.5 * s, 24 * s],
  ];
  const far = [
    [17.5 * s, 8 * s],
    [28.5 * s, 6 * s],
    [28.5 * s, 24 * s],
    [17.5 * s, 26 * s],
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let colour = null;

      if (inQuad(px, py, near)) colour = NEAR;
      else if (inQuad(px, py, far)) colour = FAR;

      if (!colour) continue;
      const offset = (y * size + x) * 4;
      rgba[offset] = colour[0];
      rgba[offset + 1] = colour[1];
      rgba[offset + 2] = colour[2];
      rgba[offset + 3] = colour[3];
    }
  }

  return rgba;
}

function iconPng(size) {
  return encodePng(size, size, drawIcon(size));
}

/**
 * The same drawing as a Windows `.ico`, for desktop shortcuts and the window
 * icon. Each entry holds a PNG rather than a DIB, which every supported Windows
 * version reads.
 */
function iconIco(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = sizes.map((size) => ({ size, png: iconPng(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((image, index) => {
    const at = index * 16;
    // 256 and up are encoded as 0 in the single-byte width and height fields.
    entries[at] = image.size >= 256 ? 0 : image.size;
    entries[at + 1] = image.size >= 256 ? 0 : image.size;
    entries[at + 2] = 0; // palette size
    entries[at + 3] = 0; // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(image.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

/** A `nativeImage`-ready data URL for the tray. */
function trayIconDataUrl() {
  return `data:image/png;base64,${iconPng(32).toString('base64')}`;
}

/** The full-size icon, for electron-builder and the settings window. */
function appIconPng() {
  return iconPng(256);
}

module.exports = { iconPng, iconIco, trayIconDataUrl, appIconPng, encodePng };
