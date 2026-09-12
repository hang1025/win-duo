'use strict';

/**
 * Windows clamps a new window to the work area, which leaves the taskbar
 * uncovered. This tries the ways around it and reports what actually sticks.
 *
 *   .\node_modules\.bin\electron.cmd tools\diagnose-bounds.js
 */
const { app, BrowserWindow, screen } = require('electron');

// Destroying a window must not take the app with it while probing.
app.on('window-all-closed', () => {});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryWith(label, options, after) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    ...options,
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
  await wait(300);
  if (after) await after(win);
  await wait(200);
  const bounds = win.getBounds();
  console.log(`${label.padEnd(34)} -> ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`);
  win.destroy();
  await wait(150);
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  console.log(`target: ${width}x${height} at ${x},${y}`);
  console.log(`workArea: ${JSON.stringify(display.workArea)}`);
  console.log(`workAreaSize: ${JSON.stringify(display.workAreaSize)}`);

  await tryWith('constructor only', { x, y, width, height });
  await tryWith('setBounds after show', { x, y, width, height }, (win) => {
    win.setBounds({ x, y, width, height });
  });
  await tryWith('setBounds then show', { x, y, width, height }, (win) => {
    win.hide();
    win.setBounds({ x, y, width, height });
    win.showInactive();
  });
  await tryWith('setSize after show', { x, y, width, height }, (win) => {
    win.setSize(width, height);
    win.setPosition(x, y);
  });
  await tryWith('fullscreen: true', { x, y, width, height, fullscreen: true });

  app.exit(0);
});
