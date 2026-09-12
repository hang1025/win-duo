'use strict';

const { desktopCapturer } = require('electron');

/**
 * Grabs one frame of a display as raw pixels.
 *
 * This is the Windows answer to ScreenCaptureKit. `thumbnailSize` is asked for
 * in device pixels, so the returned image is 1:1 with the panel; Electron scales
 * the desktop to that size for us, which is also how we get away without a
 * capture stream.
 *
 * The bitmap `nativeImage` hands back is BGRA on Windows and on macOS. The
 * renderer swaps it to RGBA before uploading.
 */
async function captureDisplay(display) {
  const scale = display.scaleFactor || 1;
  const width = Math.max(1, Math.round(display.size.width * scale));
  const height = Math.max(1, Math.round(display.size.height * scale));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  if (!sources.length) return null;

  // `display_id` is empty on some setups; fall back to the first screen rather
  // than failing the whole effect.
  let source = sources.find((candidate) => String(candidate.display_id) === String(display.id));
  if (!source) [source] = sources;

  const image = source.thumbnail;
  const size = image.getSize();
  if (!size.width || !size.height) return null;

  return {
    width: size.width,
    height: size.height,
    bgra: image.toBitmap(),
    displayId: source.display_id || null,
  };
}

module.exports = { captureDisplay };
