'use strict';

/**
 * Pulls frames out of a video file, and lays them out as one contact sheet.
 *
 * Used to look at a reference clip frame by frame instead of squinting at
 * screenshots of a video player. Chromium does the decoding, so there is no
 * ffmpeg to install.
 *
 *   .\node_modules\.bin\electron.cmd tools\extract-video-frames.js <video> [outDir] [frames]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');

const VIDEO = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, '..', 'selftest-output', 'video');
const WANTED = Number(process.argv[4] || 10);

async function main() {
  if (!VIDEO || !fs.existsSync(VIDEO)) {
    console.error(`[frames] no such video: ${VIDEO}`);
    return 1;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const page = path.join(OUT, 'frames.html');
  fs.writeFileSync(page, '<!doctype html><html><body style="margin:0;background:#111">'
    + '<video id="v" muted playsinline></video></body></html>');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(page);

  const src = pathToFileURL(VIDEO).href;
  const meta = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v');
    v.src = ${JSON.stringify(src)};
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error('the video would not load'));
      setTimeout(() => reject(new Error('timed out loading metadata')), 15000);
    });
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  })()`);
  console.log(`[frames] ${path.basename(VIDEO)}  ${meta.width}x${meta.height}  ${meta.duration.toFixed(2)}s`);

  const stamps = [];
  for (let i = 0; i < WANTED; i += 1) {
    stamps.push((meta.duration * (i + 0.5)) / WANTED);
  }

  const captured = [];
  for (const t of stamps) {
    // eslint-disable-next-line no-await-in-loop
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const v = document.getElementById('v');
      await new Promise((resolve) => {
        v.onseeked = resolve;
        v.currentTime = ${t};
      });
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
      return canvas.toDataURL('image/png');
    })()`);
    const file = path.join(OUT, `frame-${t.toFixed(2).replace('.', '_')}s.png`);
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    captured.push({ t, file });
    console.log(`  ${path.basename(file)}`);
  }

  // One contact sheet, so the whole clip can be taken in at once.
  const columns = Math.min(5, captured.length);
  const rows = Math.ceil(captured.length / columns);
  const cellWidth = Math.min(meta.width, 480);
  const cellHeight = Math.round(cellWidth * (meta.height / meta.width));
  const sheet = await win.webContents.executeJavaScript(`(async () => {
    const files = ${JSON.stringify(captured.map((c) => ({ src: pathToFileURL(c.file).href, t: c.t })))};
    const canvas = document.createElement('canvas');
    canvas.width = ${cellWidth} * ${columns};
    canvas.height = (${cellHeight} + 22) * ${rows};
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < files.length; i += 1) {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = files[i].src; });
      const x = (i % ${columns}) * ${cellWidth};
      const y = Math.floor(i / ${columns}) * (${cellHeight} + 22);
      ctx.drawImage(image, x, y, ${cellWidth}, ${cellHeight});
      ctx.fillStyle = '#e9ebf1';
      ctx.font = '13px Consolas, monospace';
      ctx.fillText(files[i].t.toFixed(2) + 's', x + 6, y + ${cellHeight} + 15);
    }
    return canvas.toDataURL('image/png');
  })()`);
  const sheetFile = path.join(OUT, 'contact-sheet.png');
  fs.writeFileSync(sheetFile, Buffer.from(String(sheet).split(',')[1], 'base64'));
  console.log(`[frames] contact sheet: ${sheetFile}`);

  win.destroy();
  return 0;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.error('[frames] timed out'); process.exit(1); }, 90000);
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error(`[frames] ${error.message}`);
  }
  clearTimeout(guard);
  setTimeout(() => app.exit(code), 150);
});
