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
    /** Called when the page dies underneath us, with a reason and details. */
    this.onGone = null;
    /** True while reset() is deliberately tearing the page down. */
    this.destroying = false;
    /** Test seam: makes requestExit a no-op so the watchdog path can be forced. */
    this.ignoreExitForTest = false;
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
      // An intentional reset() must not look like a crash to the main process.
      if (!this.destroying && this.onGone) this.onGone('closed', null);
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
      if (!this.destroying && this.onGone) this.onGone('render-process-gone', details);
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
    if (this.ignoreExitForTest) return;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('wd:exit');
  }

  /**
   * Tears the page down so the next ensure() rebuilds it. Used when a run has
   * stopped responding or the renderer is gone, where the old page cannot be
   * trusted to release the camera or the run.
   */
  reset() {
    this.destroying = true;
    try {
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
    } finally {
      this.win = null;
      this.loaded = null;
      this.destroying = false;
    }
  }

  sendSettings(settings) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('wd:settings', settings);
  }

  /**
   * Turns the persistent monitor on (or updates its settings) in the page. The
   * page owns the single camera stream; the main process only describes it.
   */
  async startMonitor(config) {
    const win = await this.ensure();
    win.webContents.send('wd:monitor-start', config);
  }

  /** Closes the monitor stream, unless a run is mid-flight and still owns it. */
  stopMonitor(payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('wd:monitor-stop', payload || {});
  }

  /** The automatic run could not start; keep watching from the same stream. */
  resumeMonitor(payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('wd:monitor-resume', payload || {});
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }
}

module.exports = Overlay;
