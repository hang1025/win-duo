'use strict';

/**
 * Diagnoses the one thing the self test cannot check: whether the overlay window
 * actually composites above the desktop.
 *
 * It paints a solid red frame through the same page the effect uses and then
 * grabs the screen, so a working setup shows up as a large red shift. Numbers
 * only.
 *
 *   .\node_modules\.bin\electron.cmd tools\diagnose-overlay.js
 */
const path = require('path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const PAGE = path.join(__dirname, '..', 'src', 'renderer', 'overlay.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'main', 'preload-overlay.js');

async function grab() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
    fetchWindowIcons: false,
  });
  const image = sources[0].thumbnail;
  const size = image.getSize();
  return { width: size.width, height: size.height, bgra: image.toBitmap() };
}

/** Mean red-minus-green, which goes strongly positive for a red screen. */
function redness(frame) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < frame.bgra.length; i += 4 * 501) {
    sum += frame.bgra[i + 2] - frame.bgra[i + 1];
    count += 1;
  }
  return sum / count;
}

async function main() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  console.log(`display bounds ${width}x${height} at ${x},${y}  scale ${display.scaleFactor}`);

  const win = new BrowserWindow({
    x, y, width, height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    console.log(`[page] ${message}  (${sourceId}:${lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(`[page] did-fail-load ${code} ${description}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[page] render-process-gone ${JSON.stringify(details)}`);
  });

  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadFile(PAGE);
  });

  console.log(`after load: bounds ${JSON.stringify(win.getBounds())} visible=${win.isVisible()}`);

  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
  await new Promise((r) => setTimeout(r, 400));
  console.log(`after showInactive: visible=${win.isVisible()} bounds ${JSON.stringify(win.getBounds())}`);

  const probe = await win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('view');
    const gl = canvas.getContext('webgl2');
    const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      canvasCss: canvas.style.width + ' x ' + canvas.style.height,
      canvasPx: canvas.width + ' x ' + canvas.height,
      hasGl: Boolean(gl),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      dpr: window.devicePixelRatio,
    };
  })()`);
  console.log(`page probe: ${JSON.stringify(probe)}`);

  const before = await grab();
  console.log(`redness before: ${redness(before).toFixed(2)}`);

  // Paint an opaque red frame straight onto the page's canvas.
  await win.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('view');
    const gl = canvas.getContext('webgl2');
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.flush();
    return canvas.width + 'x' + canvas.height;
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  const after = await grab();
  console.log(`redness after:  ${redness(after).toFixed(2)}`);
  console.log(redness(after) > 40
    ? 'PASS: the overlay composites above the desktop.'
    : 'FAIL: the overlay is not visible on screen.');

  win.destroy();
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
