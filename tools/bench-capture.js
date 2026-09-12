'use strict';

/**
 * How long does one screen grab actually take, at several thumbnail sizes?
 * `desktopCapturer.getSources` opens a capture session per call, so this is the
 * latency between the hotkey and the first frame of the effect.
 *
 *   .\node_modules\.bin\electron.cmd tools\bench-capture.js [--sizes]
 */
const { app, desktopCapturer, screen } = require('electron');

const SIZES = [
  [2561, 1601],
  [2560, 1600],
  [1920, 1200],
  [1707, 1067],
  [1280, 800],
  [854, 534],
];

async function timeGrab(width, height, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const elapsed = Date.now() - started;
    if (!sources.length) return null;
    samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function main() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  console.log(`panel ${Math.round(display.size.width * scale)}x${Math.round(display.size.height * scale)} device px`);

  // Warm up once so the first measurement does not pay for module setup.
  await timeGrab(1280, 800, 1);

  for (const [width, height] of SIZES) {
    const median = await timeGrab(width, height, 5);
    console.log(`thumbnail ${width}x${height}: median grab ${median} ms`);
  }

  console.log('--- does a same-size repeat help? ---');
  for (let i = 0; i < 4; i += 1) {
    const one = await timeGrab(2561, 1601, 1);
    console.log(`repeat ${i}: ${one} ms`);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
