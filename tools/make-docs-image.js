'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

/**
 * Builds the README's hero image from self test dumps: four angles of the same
 * picture, side by side, labelled.
 *
 *   .\node_modules\.bin\electron.cmd tools\make-docs-image.js
 *
 * It runs the self test first, so the montage always matches the current shader.
 */
const ANGLES = [110, 90, 72, 45];
const CELL_WIDTH = 620;
const CELL_HEIGHT = 388;
const GAP = 14;
const LABEL_HEIGHT = 34;

async function main() {
  const root = path.join(__dirname, '..');
  const shots = path.join(root, 'selftest-output');
  const outDir = path.join(root, 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  const missing = ANGLES.filter((angle) => {
    const file = path.join(shots, `angle-${String(angle).padStart(3, '0')}.png`);
    return !fs.existsSync(file);
  });
  if (missing.length) {
    throw new Error(`run "npm run selftest" first; missing angles: ${missing.join(', ')}`);
  }

  const columns = ANGLES.length;
  const width = GAP + columns * (CELL_WIDTH + GAP);
  const height = GAP + LABEL_HEIGHT + CELL_HEIGHT + GAP;

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // loadURL resolves on load; waiting for the did-finish-load event instead races
  // with the initial about:blank load and can hang forever.
  await win.loadURL('data:text/html,<html><body style="margin:0;background:#0d0e11"></body></html>');
  win.setSize(width, height);
  await new Promise((r) => setTimeout(r, 200));

  const dataUrls = ANGLES.map((angle) => {
    const file = path.join(shots, `angle-${String(angle).padStart(3, '0')}.png`);
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  });

  const png = await win.webContents.executeJavaScript(`(async () => {
    const angles = ${JSON.stringify(ANGLES)};
    const sources = ${JSON.stringify(dataUrls)};
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < angles.length; i += 1) {
      const image = new Image();
      await new Promise((resolve) => { image.onload = resolve; image.src = sources[i]; });
      const x = ${GAP} + i * (${CELL_WIDTH} + ${GAP});
      const y = ${GAP} + ${LABEL_HEIGHT};
      ctx.drawImage(image, x, y, ${CELL_WIDTH}, ${CELL_HEIGHT});
      ctx.strokeStyle = '#2b2e36';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, ${CELL_WIDTH} - 1, ${CELL_HEIGHT} - 1);
      ctx.fillStyle = '#e8eaf0';
      ctx.font = '600 18px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(angles[i] + '\\u00b0', x + ${CELL_WIDTH} / 2, ${GAP} + ${LABEL_HEIGHT} / 2);
    }
    return canvas.toDataURL('image/png');
  })()`);

  const file = path.join(outDir, 'fold-progression.png');
  fs.writeFileSync(file, Buffer.from(String(png).split(',')[1], 'base64'));
  console.log(`[win-duo] wrote ${file}`);
  win.destroy();
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // Never leave a headless run stuck.
  const guard = setTimeout(() => {
    console.error('[win-duo] make-docs-image timed out');
    process.exit(1);
  }, 60000);
  try {
    await main();
    clearTimeout(guard);
    app.exit(0);
  } catch (error) {
    clearTimeout(guard);
    console.error(`[win-duo] ${error.message}`);
    app.exit(1);
  }
});
