'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'overlay.html');
const PRELOAD = path.join(__dirname, 'preload-overlay.js');

/**
 * The window the effect is drawn in.
 *
 * It covers one display, sits above everything including the taskbar, never
 * takes focus, and never takes a click. It is created once and then hidden and
 * shown, because re-creating a transparent window costs a visible moment.
 *
 * While it is hidden nothing renders: the page only runs a frame loop once the
 * main process hands it a picture.
 */
class Overlay {
  constructor({ displayMode = 'primary' } = {}) {
    this.win = null;
    this.loaded = null;
    this.displayMode = displayMode;
  }

  targetDisplay() {
    if (this.displayMode === 'cursor') {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    return screen.getPrimaryDisplay();
  }

  createWindow() {
    const display = this.targetDisplay();
    const { x, y, width, height } = display.bounds;

    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Never steal focus: the desktop behind has to look untouched when the
      // picture lands on it.
      focusable: false,
      acceptFirstMouse: false,
      // A hidden window still needs a backing store for the WebGL context to
      // exist before the first trigger.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (win.setMenuBarVisibility) win.setMenuBarVisibility(false);

    win.on('closed', () => {
      this.win = null;
    });

    // Errors in the page would otherwise vanish into a transparent window.
    win.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
      if (level >= 2 || process.env.WIN_DUO_DEBUG) {
        console.log(`[overlay:${level}] ${message} (${sourceId}:${lineNumber})`);
      }
    });
    win.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`[win-duo] overlay failed to load: ${code} ${description}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[win-duo] overlay renderer gone: ${JSON.stringify(details)}`);
    });

    this.loaded = new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
    });
    win.loadFile(PAGE);

    this.win = win;
    return win;
  }

  /** Creates the window if it is not up yet and resolves once the page is live. */
  async ensure() {
    const win = this.win && !this.win.isDestroyed() ? this.win : this.createWindow();
    await this.loaded;
    return win;
  }

  async play(display, payload) {
    const debug = Boolean(process.env.WIN_DUO_DEBUG);
    const started = Date.now();
    const mark = (label) => {
      if (debug) console.log(`[win-duo] play(): +${String(Date.now() - started).padStart(4)}ms  ${label}`);
    };

    const win = await this.ensure();
    mark('window ready');

    const bounds = {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.size.width,
      height: display.size.height,
    };

    // Hand the picture over while the window is still hidden: the page builds
    // its texture on receipt, which is work worth overlapping with showing the
    // window. Nothing renders until the window is up, and the first frame is
    // transparent anyway, so this cannot be seen.
    win.webContents.send('wd:play', payload);
    mark('payload sent');

    if (!win.isVisible()) win.showInactive();
    mark('shown');
    // Cheap insurance: a window that took a click would lock the desktop for the
    // length of the run.
    win.setIgnoreMouseEvents(true);

    // Windows clamps a window to the work area when it is created or first
    // mapped, which leaves the taskbar strip uncovered. Re-applying the bounds
    // is what actually covers it; the second call catches the first map, which
    // can still land a tick late.
    win.setBounds(bounds);
    mark('bounds set');
    setImmediate(() => {
      if (this.win && !this.win.isDestroyed()) this.win.setBounds(bounds);
      mark('bounds re-set');
    });
  }

  /**
   * Asks the page to end the run, which eases the picture back to flat before
   * fading out. Hide is done by the main process when the page reports back.
   */
  requestExit() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('wd:exit');
  }

  sendSettings(settings) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('wd:settings', settings);
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }
}

module.exports = Overlay;
