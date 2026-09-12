'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const { captureDisplay } = require('./capture');
const { sweepOpenAngle, sweepShutAngle } = require('./defaults');

const PAGE = path.join(__dirname, '..', 'renderer', 'overlay.html');
const PRELOAD = path.join(__dirname, 'preload-overlay.js');

/**
 * The self test renders the effect off screen at a set of angles and writes a
 * PNG for each.
 *
 * It exists because the geometry is easy to get subtly wrong - a flipped axis or
 * a transposed matrix still produces a plausible-looking warp - and because a
 * dump can be diffed and looked at, which a live window cannot. `--real` swaps
 * the drawn test pattern for an actual screen grab, so the capture path gets
 * exercised too.
 *
 * Run with: npm run selftest  /  npm run selftest -- --real
 */
const TEST_WIDTH = 1280;
const TEST_HEIGHT = 800;

async function runSelfTest({ prefs, real = false }) {
  const outDir = path.join(process.cwd(), 'selftest-output');
  fs.mkdirSync(outDir, { recursive: true });

  const display = screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadFile(PAGE, { query: { selftest: '1' } });
  });

  let captured = null;
  if (real) {
    captured = await captureDisplay(display);
    if (!captured) throw new Error('the screen capture returned nothing');
  }

  const settings = prefs.all;
  const payload = {
    settings,
    synthetic: !real,
    bgra: captured ? captured.bgra : null,
    width: captured ? captured.width : 0,
    height: captured ? captured.height : 0,
    screenWidth: TEST_WIDTH,
    screenHeight: TEST_HEIGHT,
    pixelScale: 1,
    // Deterministic dump size, whatever the desktop scaling happens to be.
    fixedCanvas: true,
    openAngle: sweepOpenAngle(settings),
    shutAngle: sweepShutAngle(settings),
  };

  win.webContents.send('wd:selftest-payload', payload);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await win.webContents.executeJavaScript('window.__winDuoSelftest.prepareStored()');

  const angles = [130, 110, 90, 80, 72, 60, 50, 45, 30, 20];
  for (const angle of angles) {
    const dataUrl = await win.webContents.executeJavaScript(
      `window.__winDuoSelftest.renderAt(${angle})`,
    );
    const base64 = String(dataUrl).split(',')[1] || '';
    const name = `angle-${String(angle).padStart(3, '0')}.png`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(base64, 'base64'));
    console.log(`[win-duo] selftest wrote ${name}`);
  }

  console.log(`[win-duo] selftest output in ${outDir}`);
  win.destroy();
  return 0;
}

module.exports = { runSelfTest };
