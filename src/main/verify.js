'use strict';

const { screen } = require('electron');

const { captureDisplay } = require('./capture');

/**
 * An end-to-end check that the overlay really lands on top of the desktop.
 *
 * It grabs the screen before and during a run and compares the average
 * luminance of horizontal bands. The effect darkens the picture towards the far
 * edge, so a working run shows the top band much darker than the baseline while
 * the bottom band stays close to it. Numbers only - no frames are written, and
 * nothing on screen is inspected beyond its brightness.
 *
 *   .\node_modules\.bin\electron.cmd . --verify
 */

/** Mean green channel over the top / middle / bottom of a bitmap. */
function bands(bitmap, width, height) {
  const rows = { top: [0, 0.25], middle: [0.35, 0.65], bottom: [0.75, 1] };
  const out = {};
  for (const [name, [from, to]] of Object.entries(rows)) {
    let sum = 0;
    let count = 0;
    const stepX = Math.max(1, Math.floor(width / 160));
    const stepY = Math.max(1, Math.floor(height / 160));
    for (let y = Math.floor(height * from); y < Math.floor(height * to); y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        sum += bitmap[(y * width + x) * 4 + 1];
        count += 1;
      }
    }
    out[name] = count ? sum / count : 0;
  }
  return out;
}

function line(label, value) {
  const pad = (n) => (Math.round(n * 10) / 10).toFixed(1).padStart(6);
  console.log(`${label.padEnd(10)} top ${pad(value.top)}  middle ${pad(value.middle)}  bottom ${pad(value.bottom)}`);
}

async function verifyOverlay({ trigger, overlay, wait, isPlaying }) {
  const display = screen.getPrimaryDisplay();
  const win = await overlay.ensure();

  const bounds = win.getBounds();
  console.log(`display    ${display.size.width}x${display.size.height} @${display.scaleFactor}x at ${display.bounds.x},${display.bounds.y}`);
  console.log(`overlay    ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}  alwaysOnTop=${win.isAlwaysOnTop()}  visible=${win.isVisible()}`);

  await wait(600);

  const before = await captureDisplay(display);
  const base = bands(before.bgra, before.width, before.height);
  line('baseline', base);

  // A screen grab costs roughly half a second, and the run lasts a couple of
  // seconds, so the only honest way to sample it is to keep grabbing until the
  // run ends and look at every frame that came back.
  const started = Date.now();
  const pending = trigger();
  const samples = [];
  const deadline = started + 12000;
  while (Date.now() < deadline) {
    const frame = await captureDisplay(display);
    const at = Date.now() - started;
    const current = bands(frame.bgra, frame.width, frame.height);
    samples.push({ at, current });
    line(`at ${String(at).padStart(5)}ms`, current);
    if (!isPlaying() && at > 800) break;
  }
  await pending;

  // Let the overlay hide itself if it has not already.
  const hideDeadline = Date.now() + 5000;
  while (win.isVisible() && Date.now() < hideDeadline) await wait(100);
  const hidden = !win.isVisible();

  let best = null;
  for (const sample of samples) {
    const topDrop = base.top - sample.current.top;
    const bottomDrop = base.bottom - sample.current.bottom;
    if (!best || topDrop > best.topDrop) best = { ...sample, topDrop, bottomDrop };
  }

  console.log(`overlay hidden after the run: ${hidden}`);
  if (best) {
    console.log(`strongest sample at ${best.at}ms: top dropped ${best.topDrop.toFixed(1)}, bottom dropped ${best.bottomDrop.toFixed(1)}`);
  }

  if (process.env.WIN_DUO_DEBUG) {
    const probe = await win.webContents.executeJavaScript('window.__winDuoDebug()');
    console.log(`renderer: ${JSON.stringify(probe)}`);
  }

  const pass = hidden
    && best
    && best.topDrop > 6
    && best.topDrop > best.bottomDrop + 3;
  console.log(pass
    ? 'PASS: the overlay composited above the desktop, and the far edge darkened far more than the near edge.'
    : 'FAIL: expected a hidden overlay and a sample whose top band darkened more than its bottom band.');
  return pass ? 0 : 1;
}

module.exports = { verifyOverlay };
