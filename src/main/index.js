'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');

const Preferences = require('./preferences');
const Overlay = require('./overlay');
const { captureDisplay } = require('./capture');
const { sweepOpenAngle, sweepShutAngle } = require('./defaults');
const { trayIconDataUrl, appIconPng } = require('./icon');
const { runSelfTest } = require('./selftest');
const strings = require('../shared/strings');

const ARGS = process.argv.slice(1);
const IS_SELFTEST = ARGS.includes('--selftest');
const IS_VERIFY = ARGS.includes('--verify');
const IS_TIMING = ARGS.includes('--timing');
const IS_CHECK_SETTINGS = ARGS.includes('--check-settings');

/** A run that never reports back would block every later one. */
const RUN_TIMEOUT_MS = 15000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let prefs = null;
let overlay = null;
let tray = null;
let settingsWindow = null;
let playing = false;
let runWatchdog = null;
let lang = 'en';
let S = null;
/** Wall clock at the start of the current run, for timing marks. */
let runStartedAt = 0;

// ---------------------------------------------------------------------------
// Effect runs
// ---------------------------------------------------------------------------

/**
 * One run of the effect: grab the screen, then hand the picture to the overlay
 * and let the renderer play the sweep.
 *
 * The grab happens *before* the overlay is shown, so the picture can never
 * contain the overlay itself.
 */
async function trigger() {
  if (playing || !prefs) return;
  const settings = prefs.all;
  if (!settings.enabled) return;

  runStartedAt = Date.now();
  const mark = (label) => {
    if (process.env.WIN_DUO_DEBUG) {
      console.log(`[win-duo] +${String(Date.now() - runStartedAt).padStart(4)}ms  ${label}`);
    }
  };

  const display = settings.displayMode === 'cursor'
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getPrimaryDisplay();

  mark('grabbing the screen');
  let capture = null;
  try {
    capture = await captureDisplay(display);
  } catch (error) {
    console.error('[win-duo] screen capture failed:', error.message);
  }
  if (!capture) return;
  mark('screen grabbed');

  playing = true;

  if (runWatchdog) clearTimeout(runWatchdog);
  runWatchdog = setTimeout(() => {
    if (!playing) return;
    console.warn('[win-duo] the run never reported back; releasing the overlay');
    endRun();
  }, RUN_TIMEOUT_MS);

  try {
    await overlay.play(display, {
      settings,
      bgra: capture.bgra,
      width: capture.width,
      height: capture.height,
      screenWidth: display.size.width,
      screenHeight: display.size.height,
      pixelScale: display.scaleFactor,
      openAngle: sweepOpenAngle(settings),
      shutAngle: sweepShutAngle(settings),
    });
    mark('handed to the overlay');
  } catch (error) {
    playing = false;
    console.error('[win-duo] overlay failed:', error.message);
  }
}

function endRun() {
  playing = false;
  if (runWatchdog) {
    clearTimeout(runWatchdog);
    runWatchdog = null;
  }
  if (overlay) overlay.hide();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function applyLoginItem(enabled) {
  // In development the executable is Electron itself, so registering it would
  // point the login item at the wrong program. The preference is still stored.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: [] });
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const accelerator = prefs.values.hotkey;
  if (!accelerator) return true;
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => { trigger(); });
  } catch (error) {
    ok = false;
  }
  if (!ok) console.warn(`[win-duo] could not register the hotkey ${accelerator}`);
  return ok;
}

function buildTrayMenu() {
  const settings = prefs.all;
  return Menu.buildFromTemplate([
    {
      label: `${S.tray.play}\t${settings.hotkey}`,
      click: () => { trigger(); },
    },
    { type: 'separator' },
    { label: S.tray.settings, click: () => { openSettings(); } },
    {
      label: S.tray.enabled,
      type: 'checkbox',
      checked: Boolean(settings.enabled),
      click: (item) => {
        prefs.update({ enabled: item.checked });
        refreshTray();
      },
    },
    {
      label: S.tray.launchAtLogin,
      type: 'checkbox',
      checked: Boolean(settings.launchAtLogin),
      click: (item) => {
        prefs.update({ launchAtLogin: item.checked });
        applyLoginItem(item.checked);
        refreshTray();
      },
    },
    { type: 'separator' },
    {
      label: S.tray.openSettingsFolder,
      click: () => { shell.showItemInFolder(path.join(app.getPath('userData'), 'settings.json')); },
    },
    { label: S.tray.quit, click: () => { app.quit(); } },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const image = nativeImage.createFromDataURL(trayIconDataUrl());
  tray = new Tray(image);
  tray.setToolTip(S.tray.tooltip);
  tray.on('click', () => { trigger(); });
  refreshTray();
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 660,
    minWidth: 400,
    minHeight: 520,
    title: 'Win Duo',
    backgroundColor: '#16171b',
    icon: nativeImage.createFromBuffer(appIconPng()),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
    { query: { lang } },
  );
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function broadcastSettings(settings) {
  if (overlay) overlay.sendSettings(settings);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('wd:settings', settings);
  }
  refreshTray();
}

function registerIpc() {
  ipcMain.handle('wd:get-settings', () => prefs.all);

  ipcMain.handle('wd:set-settings', (_event, patch) => {
    const before = prefs.all;
    const after = prefs.update(patch);

    if (before.hotkey !== after.hotkey) registerHotkey();
    if (before.launchAtLogin !== after.launchAtLogin) applyLoginItem(after.launchAtLogin);
    if (before.displayMode !== after.displayMode && overlay) overlay.displayMode = after.displayMode;

    broadcastSettings(after);
    return after;
  });

  ipcMain.handle('wd:reset-settings', () => {
    const after = prefs.reset();
    registerHotkey();
    applyLoginItem(after.launchAtLogin);
    if (overlay) overlay.displayMode = after.displayMode;
    broadcastSettings(after);
    return after;
  });

  ipcMain.handle('wd:preview', () => { trigger(); });
  ipcMain.handle('wd:quit', () => { app.quit(); });

  ipcMain.on('wd:overlay-finished', () => { endRun(); });

  ipcMain.on('wd:mark', (_event, name, at) => {
    if (process.env.WIN_DUO_DEBUG) {
      console.log(`[win-duo] +${String(at - runStartedAt).padStart(4)}ms  ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function onReady() {
  prefs = new Preferences();
  lang = strings.forLocale(app.getLocale());
  S = strings[lang];

  if (IS_SELFTEST) {
    try {
      app.exit(await runSelfTest({ prefs, real: ARGS.includes('--real') }));
    } catch (error) {
      console.error('[win-duo] selftest failed:', error);
      app.exit(1);
    }
    return;
  }

  overlay = new Overlay({ displayMode: prefs.values.displayMode });

  if (IS_CHECK_SETTINGS) {
    const { checkSettings } = require('./check-settings');
    registerIpc();
    try {
      const code = await checkSettings({ prefs, wait });
      process.exitCode = code;
      app.exit(code);
    } catch (error) {
      console.error('[win-duo] settings check failed:', error);
      app.exit(1);
    }
    return;
  }

  if (IS_TIMING) {
    const { timeOneRun } = require('./timing');
    registerIpc();
    try {
      process.exitCode = await timeOneRun({ trigger, overlay, wait, isPlaying: () => playing });
      app.exit(process.exitCode);
    } catch (error) {
      console.error('[win-duo] timing failed:', error);
      app.exit(1);
    }
    return;
  }

  if (IS_VERIFY) {
    const { verifyOverlay } = require('./verify');
    registerIpc();
    try {
      const code = await verifyOverlay({ trigger, overlay, wait, isPlaying: () => playing });
      if (process.env.WIN_DUO_DEBUG) console.log(`[win-duo] verify returning ${code}`);
      process.exitCode = code;
      app.exit(code);
    } catch (error) {
      console.error('[win-duo] verify failed:', error);
      app.exit(1);
    }
    return;
  }

  createTray();
  registerHotkey();
  registerIpc();
  applyLoginItem(prefs.values.launchAtLogin);

  // Warm the window up so the first trigger does not pay for a page load.
  overlay.ensure().catch((error) => {
    console.error('[win-duo] could not warm the overlay:', error.message);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { openSettings(); });
  // The app lives in the tray: closing the settings window must not quit it.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.whenReady().then(onReady);
}
