'use strict';

const fs = require('fs');
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
  session,
  shell,
} = require('electron');

const Preferences = require('./preferences');
const Overlay = require('./overlay');
const { captureDisplay } = require('./capture');
const { sweepOpenAngle, sweepShutAngle, monitorAngles } = require('./defaults');
const { trayIconDataUrl, appIconPng } = require('./icon');
const { runSelfTest } = require('./selftest');
const strings = require('../shared/strings');

const ARGS = process.argv.slice(1);
const IS_SELFTEST = ARGS.includes('--selftest');
const IS_VERIFY = ARGS.includes('--verify');
const IS_VERIFY_CAMERA = ARGS.includes('--verify-camera');
const IS_VERIFY_MONITOR = ARGS.includes('--verify-monitor');
const IS_TIMING = ARGS.includes('--timing');
const IS_CHECK_SETTINGS = ARGS.includes('--check-settings');
const IS_SHOT_FOLD = ARGS.includes('--shot-fold');
const IS_DIAGNOSE_COVER = ARGS.includes('--diagnose-cover');

/** A run that never reports back would block every later one. */
const RUN_TIMEOUT_MS = 15000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Exits, but not before stdout has had a chance to drain.
 *
 * `app.exit()` tears the process down immediately, and when stdout is a pipe -
 * which is every CI run and every `| Select-String` - the last writes are still
 * buffered and are simply lost. The checks looked like they had printed nothing
 * while actually passing.
 */
function exitAfterFlush(code) {
  setTimeout(() => app.exit(code), 150);
}

let prefs = null;
let overlay = null;
let tray = null;
let settingsWindow = null;
let playing = false;
let runWatchdog = null;
let runCleanupTimer = null;
/**
 * The run admission latch. It is taken synchronously, before the first await in
 * trigger(), so two triggers - a hotkey and a monitor crossing, say - can never
 * both capture the screen and play. It is released on every failure path and in
 * endRun.
 */
let runAdmission = false;
/**
 * A monotonic run id. The page echoes it back in its completion report, so a
 * late report from an old run can never end a newer one.
 */
let runGeneration = 0;
let currentRunId = 0;
/** What the last run reported, for the camera verification. */
let lastRunReport = null;
/**
 * The persistent monitor. `monitorPending` is the latch that stops a second
 * crossing from starting a run while the first is still being set up;
 * `monitorActive` mirrors what the page last reported, for the tray;
 * `monitorSynthetic` is remembered so an automatic run reuses the same
 * generated scene the verification harness started.
 */
let monitorPending = false;
let monitorActive = false;
let monitorSynthetic = false;
/**
 * The monitor decision counter. Every start, reconfigure and stop bumps it, and
 * both processes ignore anything carrying an older number. This is what makes a
 * disable that lands while a start, a capture or a run is still in flight win,
 * instead of a late async step resurrecting the monitor.
 */
let monitorGeneration = 0;
/** Set while the app is quitting, so overlay teardown does not restart the monitor. */
let appQuitting = false;
let lang = 'en';
let S = null;
/** Wall clock at the start of the current run, for timing marks. */
let runStartedAt = 0;

/**
 * Test seams. The monitor verification makes the screen grab slow and shortens
 * the watchdog, so the race paths can be exercised deterministically. In
 * production these are the real capture and the real timeouts.
 */
let captureForRun = captureDisplay;
let runTimeoutMs = RUN_TIMEOUT_MS;
let forceCleanupMs = 2500;

function setCaptureForTest(fn) {
  captureForRun = typeof fn === 'function' ? fn : captureDisplay;
}

function setRunTimeoutsForTest(options) {
  const source = options || {};
  const watchdog = Number(source.watchdogMs);
  const cleanup = Number(source.forceCleanupMs);
  runTimeoutMs = Number.isFinite(watchdog) && watchdog > 0 ? watchdog : RUN_TIMEOUT_MS;
  forceCleanupMs = Number.isFinite(cleanup) && cleanup > 0 ? cleanup : 2500;
}

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
async function trigger(overrides) {
  if (!prefs || runAdmission) return false;
  const settings = { ...prefs.all, ...(overrides || {}) };
  if (!settings.enabled) return false;

  // Taken before the first await. From here until the run ends, no other
  // trigger - manual or automatic - is admitted, so there is no window in
  // which two runs both capture the screen.
  runAdmission = true;
  // Set only by the monitor crossing handler. It keeps an automatic run from
  // ever opening a second camera when the monitor stream is not reusable.
  const fromMonitor = Boolean(settings.fromMonitor);
  // The monitor decision this automatic run belongs to. It is re-checked after
  // the capture await, so a disable or reconfigure during the grab wins.
  const monitorGen = monitorGeneration;

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
    capture = await captureForRun(display);
  } catch (error) {
    console.error('[win-duo] screen capture failed:', error.message);
  }
  if (!capture) {
    if (fromMonitor) console.warn('[win-duo] the automatic run could not grab the screen');
    runAdmission = false;
    return false;
  }
  mark('screen grabbed');

  // Revalidate the automatic request after the await: a monitor that was
  // disabled or reconfigured while the screen was being grabbed must not start
  // a delayed run, and the admission it holds must be handed back.
  if (fromMonitor
    && (!prefs.values.persistentMonitor || !prefs.values.enabled || monitorGeneration !== monitorGen)) {
    runAdmission = false;
    return false;
  }

  playing = true;
  const runId = (runGeneration += 1);
  currentRunId = runId;

  if (runWatchdog) clearTimeout(runWatchdog);
  runWatchdog = setTimeout(() => {
    if (!playing) return;
    requestRunCleanup('watchdog');
  }, runTimeoutMs);

  try {
    await overlay.play(display, {
      settings,
      runId,
      bgra: capture.bgra,
      width: capture.width,
      height: capture.height,
      screenWidth: display.size.width,
      screenHeight: display.size.height,
      pixelScale: display.scaleFactor,
      openAngle: sweepOpenAngle(settings),
      shutAngle: sweepShutAngle(settings),
      syntheticCamera: Boolean(settings.syntheticCamera),
      fromMonitor,
      // While the monitor holds a camera, any camera run reuses that one
      // stream rather than opening its own.
      reuseMonitor: fromMonitor || (monitorActive && settings.angleSource === 'camera'),
    });
    mark('handed to the overlay');
    registerExitKey();
    return true;
  } catch (error) {
    playing = false;
    runAdmission = false;
    currentRunId = 0;
    console.error('[win-duo] overlay failed:', error.message);
    return false;
  }
}

/**
 * Writes the last run to disk, trace and all.
 *
 * When the fold behaves oddly on someone else's machine this file is the only
 * way to see what the tracker actually did: a photograph of a wrong-looking
 * fold does not contain the numbers that explain it.
 */
function saveLastRun(report) {
  if (!report) return;
  try {
    const file = path.join(app.getPath('userData'), 'last-run.json');
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const line = [
      new Date().toISOString(),
      `mode=${report.mode}`,
      `reason=${report.reason}`,
      `peak=${Number(report.peakTravel).toFixed(1)}`,
      `maxPeak=${Number(report.maxPeak).toFixed(1)}`,
      `dir=${report.direction}`,
      `fps=${report.fps}`,
      `q=${report.quality}`,
      `strips=${report.strips}`,
      `armedMs=${report.armedMs}`,
    ].join(' ');
    fs.appendFileSync(path.join(app.getPath('userData'), 'runs.log'), `${line}\n`);
  } catch (error) {
    console.error('[win-duo] could not save the run report:', error.message);
  }
}

function endRun(report, runId) {
  // A completion that names a different run is a late report from an old one;
  // it must not tear down the run that is actually up.
  if (runId !== undefined && runId !== currentRunId) return;
  playing = false;
  runAdmission = false;
  currentRunId = 0;
  // The latch is released only when the run it guarded is actually over. The
  // page re-arms the monitor itself once the lid comes back.
  monitorPending = false;
  lastRunReport = report || null;
  unregisterExitKey();
  if (runWatchdog) {
    clearTimeout(runWatchdog);
    runWatchdog = null;
  }
  if (runCleanupTimer) {
    clearTimeout(runCleanupTimer);
    runCleanupTimer = null;
  }
  if (overlay) overlay.hide();
  saveLastRun(report);
  calibrateFromRun(report);
}

/**
 * Ends a run that has stopped responding, without trusting the page to report
 * back. It asks the page to release first; if nothing comes back in a bounded
 * time the overlay is torn down and recreated and the monitor state is
 * re-synced, so a stuck or crashed page cannot leave ownership split across the
 * two processes.
 */
function requestRunCleanup(reason) {
  if (!playing) return;
  const expected = currentRunId;
  console.warn(`[win-duo] run ${expected} did not report back (${reason}); asking the overlay to release`);
  if (overlay) overlay.requestExit();
  if (runCleanupTimer) clearTimeout(runCleanupTimer);
  runCleanupTimer = setTimeout(() => {
    runCleanupTimer = null;
    if (!playing || currentRunId !== expected) return;
    console.warn(`[win-duo] run ${expected} still did not report back; resetting the overlay`);
    hardResetOverlay();
    endRun(null, expected);
  }, forceCleanupMs);
}

/**
 * Destroys the overlay page so the next ensure() builds a clean one, and
 * forgets every monitor fact that belonged to the dead page. Monitoring is
 * restarted only if the user still has it switched on.
 */
function hardResetOverlay() {
  // Keep the synthetic flag so a test harness is not silently switched onto a
  // real camera when the overlay is rebuilt.
  const synthetic = monitorSynthetic;
  monitorGeneration += 1;
  monitorActive = false;
  monitorPending = false;
  monitorSynthetic = false;
  if (overlay) overlay.reset();
  if (prefs && prefs.values.persistentMonitor && prefs.values.enabled && !appQuitting) {
    startPersistentMonitor({ syntheticCamera: synthetic });
  } else {
    refreshTray();
  }
}

/**
 * Recovery when the overlay page dies or is closed underneath us: no stale run
 * or monitor state may survive, and the monitor is restarted only if it is
 * still opted in.
 */
function handleOverlayGone(kind, details) {
  if (appQuitting) return;
  console.error(`[win-duo] overlay ${kind}${details ? `: ${JSON.stringify(details)}` : ''}`);
  if (playing) {
    playing = false;
    runAdmission = false;
    currentRunId = 0;
    unregisterExitKey();
    if (runWatchdog) {
      clearTimeout(runWatchdog);
      runWatchdog = null;
    }
    if (runCleanupTimer) {
      clearTimeout(runCleanupTimer);
      runCleanupTimer = null;
    }
  }
  // Keep the synthetic flag so a test harness is not silently switched onto a
  // real camera when the overlay is rebuilt.
  const synthetic = monitorSynthetic;
  monitorGeneration += 1;
  monitorActive = false;
  monitorPending = false;
  monitorSynthetic = false;
  if (overlay) overlay.reset();
  if (prefs && prefs.values.persistentMonitor && prefs.values.enabled) {
    startPersistentMonitor({ syntheticCamera: synthetic });
  } else {
    refreshTray();
  }
}

/**
 * Refines the estimate of how much image travel a complete close produces.
 *
 * The travel depends on the camera, the room and where the user sits, so it
 * cannot be a constant. It also cannot be read off a partial close, which would
 * teach the wrong scale, so only a run that got most of the way to shut and came
 * back counts. The estimate drifts towards the middle of what is seen rather
 * than being replaced, because individual closes vary.
 *
 * It reads `maxPeak`, not `peakTravel`: the fold ratchets, so by the time the
 * run ends the live peak has already followed the lid back down to nothing.
 */
function calibrateFromRun(report) {
  if (!prefs || !report || report.mode !== 'camera' || !report.engaged) return;
  if (report.reason !== 'back at rest') return;
  // A run driven by the generated scene measures the test pattern, not this
  // user's room, so it must not be allowed to adjust their settings.
  if (report.synthetic) return;

  const peak = Number(report.maxPeak);
  if (!Number.isFinite(peak) || peak <= 0) return;

  const current = Number(prefs.values.fullTravel) || 170;
  if (peak < current * 0.6) return;

  const next = Math.round(current * 0.7 + peak * 0.3);
  if (next === current) return;
  prefs.update({ fullTravel: next });
  console.log(`[win-duo] full-travel estimate ${current} -> ${next} (this close measured ${peak.toFixed(1)})`);
}

// ---------------------------------------------------------------------------
// Persistent monitor
// ---------------------------------------------------------------------------

/**
 * Turns the persistent monitor on, or updates its settings while it is already
 * on. The overlay page owns the single camera stream; this only describes what
 * it should watch for. Safe to call repeatedly: the page keeps the same camera
 * open and only reconfigures when nothing changed but the angles.
 */
async function startPersistentMonitor(overrides) {
  if (!prefs || !overlay) return false;
  // The headless check modes must never open a camera behind the user's back.
  // `--verify-monitor` is the one exception, because driving the monitor is the
  // whole point of it.
  if (IS_CHECK && !IS_VERIFY_MONITOR) return false;
  const settings = { ...prefs.all, ...(overrides || {}) };
  if (!settings.persistentMonitor || !settings.enabled) return false;
  // This request owns the newest monitor decision until something newer arrives.
  const generation = (monitorGeneration += 1);
  const angles = monitorAngles(settings);
  monitorSynthetic = Boolean(settings.syntheticCamera);
  try {
    await overlay.startMonitor({
      generation,
      deviceId: settings.cameraDeviceId || '',
      syntheticCamera: monitorSynthetic,
      restAngle: settings.restAngle,
      fullTravel: settings.fullTravel,
      trackerGain: settings.trackerGain,
      triggerAngle: angles.triggerAngle,
      rearmAngle: angles.rearmAngle,
    });
  } catch (error) {
    console.error('[win-duo] could not start the persistent monitor:', error.message);
    return false;
  }
  if (generation !== monitorGeneration) {
    // A stop or a newer configuration won while the window was coming up. If
    // the newest decision is "off", send a corrective stop now that the page is
    // loaded, so the late start cannot leave a stream open.
    if (!(prefs.values.persistentMonitor && prefs.values.enabled)) {
      overlay.stopMonitor({ generation: monitorGeneration });
    }
    return false;
  }
  monitorActive = true;
  refreshTray();
  return true;
}

/** Closes the monitor stream and clears the pending latch. */
function stopPersistentMonitor() {
  // Always bump: this invalidates any start that is still in flight, even one
  // that has not reported active yet.
  monitorGeneration += 1;
  const generation = monitorGeneration;
  const wasActive = monitorActive || monitorPending;
  monitorActive = false;
  monitorPending = false;
  monitorSynthetic = false;
  if (overlay) overlay.stopMonitor({ generation });
  if (wasActive) refreshTray();
}

/**
 * Starts or stops the monitor to match the current settings. Called after any
 * settings change, so toggling the switch, disabling the effect or picking a
 * different camera all take effect immediately. Always stops when monitoring is
 * not wanted, so a start that is still awaiting its window is invalidated too.
 */
function syncMonitor(settings) {
  if (settings && settings.persistentMonitor && settings.enabled) {
    startPersistentMonitor(settings);
  } else {
    stopPersistentMonitor();
  }
}

/** The settings the monitor actually reads; a change to any of them re-syncs. */
const MONITOR_KEYS = [
  'persistentMonitor', 'enabled', 'cameraDeviceId',
  'restAngle', 'fullTravel', 'trackerGain',
  'monitorTriggerAngle', 'monitorRearmAngle',
];

function monitorSettingsChanged(before, after) {
  return MONITOR_KEYS.some((key) => before[key] !== after[key]);
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

/** The key that ends a run by hand. */
const EXIT_KEY = 'Escape';
let exitKeyRegistered = false;

/**
 * Registers Escape, but only for the length of a run.
 *
 * A global shortcut swallows the key everywhere, so leaving it registered would
 * break Escape in every other application. Registering it around the run means
 * it works exactly when the effect is up, which is the only time it is wanted,
 * and it also cancels a run that was armed by accident before the lid moved.
 */
function registerExitKey() {
  if (exitKeyRegistered) return true;
  let ok = false;
  try {
    ok = globalShortcut.register(EXIT_KEY, () => {
      if (overlay) overlay.requestExit();
    });
  } catch (error) {
    ok = false;
  }
  exitKeyRegistered = ok;
  if (!ok) {
    console.warn(`[win-duo] could not register ${EXIT_KEY}; the lid coming back still ends a run`);
  }
  return ok;
}

function unregisterExitKey() {
  if (!exitKeyRegistered) return;
  try {
    globalShortcut.unregister(EXIT_KEY);
  } catch (error) {
    // Already gone; nothing to do.
  }
  exitKeyRegistered = false;
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
  // unregisterAll above took the exit key with it.
  if (playing) registerExitKey();
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
        syncMonitor(prefs.all);
        refreshTray();
      },
    },
    {
      label: S.tray.monitor,
      type: 'checkbox',
      checked: Boolean(settings.persistentMonitor),
      click: (item) => {
        prefs.update({ persistentMonitor: item.checked });
        syncMonitor(prefs.all);
        refreshTray();
      },
    },
    {
      // A read-only status line, so the tray says whether the camera is
      // actually being held open rather than only what the switch claims.
      label: monitorActive ? S.tray.monitorOn : S.tray.monitorOff,
      enabled: false,
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
    if (monitorSettingsChanged(before, after)) syncMonitor(after);

    broadcastSettings(after);
    return after;
  });

  ipcMain.handle('wd:reset-settings', () => {
    const after = prefs.reset();
    registerHotkey();
    applyLoginItem(after.launchAtLogin);
    if (overlay) overlay.displayMode = after.displayMode;
    syncMonitor(after);
    broadcastSettings(after);
    return after;
  });

  ipcMain.handle('wd:preview', () => { trigger(); });
  ipcMain.handle('wd:quit', () => { app.quit(); });

  ipcMain.on('wd:overlay-finished', (_event, report) => {
    // A late report from an older run carries an older id and is ignored, so it
    // cannot end the run that is actually up.
    const runId = report && report.runId;
    if (runId !== undefined && runId !== currentRunId) return;
    endRun(report);
  });

  /**
   * The monitor saw the lid pass the relative trigger. The main process is the
   * final gate: the admission latch means one run at a time, and a run already
   * up wins over a fresh crossing.
   */
  ipcMain.on('wd:monitor-crossed', async (_event, info) => {
    if (!prefs || !prefs.values.persistentMonitor || !prefs.values.enabled) return;
    // Every crossing carries the monitor generation it was seen under. One
    // from an older generation - in flight when the monitor was stopped or
    // reconfigured - must not start a run, and must not touch the latch.
    const generation = Number(info && info.generation);
    if (!Number.isFinite(generation) || generation !== monitorGeneration) return;
    if (runAdmission || monitorPending) return;
    monitorPending = true;
    const started = await trigger({
      fromMonitor: true,
      syntheticCamera: monitorSynthetic,
      // An automatic run always ends itself when the lid comes back; waiting
      // for Esc would hold the camera and never re-arm.
      releaseOn: 'auto',
    });
    if (!started) {
      monitorPending = false;
      if (generation === monitorGeneration && prefs.values.persistentMonitor && prefs.values.enabled) {
        // The screenshot or the overlay failed, but the monitor is unchanged.
        // Keep it alive so the next close can try again, and re-arm rather than
        // fire on this same crossing.
        if (overlay) overlay.resumeMonitor({ generation: monitorGeneration });
      } else {
        // The monitor was stopped or reconfigured while the capture was in
        // flight. Re-assert whatever the newest decision is instead of
        // resurrecting a stale one, carrying the synthetic/test flag so a
        // re-sync never switches a harness onto a real camera.
        syncMonitor({ ...prefs.all, syntheticCamera: monitorSynthetic });
      }
    }
  });

  ipcMain.on('wd:monitor-status', (_event, status) => {
    // Ignore a report from a monitor decision that has already been superseded.
    const generation = Number(status && status.generation);
    if (Number.isFinite(generation) && generation !== monitorGeneration) return;
    const active = Boolean(status && status.active);
    if (monitorActive !== active) {
      monitorActive = active;
      refreshTray();
    }
    if (status && status.error) {
      console.warn(`[win-duo] persistent monitor could not start: ${status.error}`);
    }
  });

  ipcMain.on('wd:mark', (_event, name, at) => {
    if (process.env.WIN_DUO_DEBUG) {
      console.log(`[win-duo] +${String(at - runStartedAt).padStart(4)}ms  ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * The overlay opens the webcam, so the media permissions have to be granted
 * explicitly: an Electron page loaded from disk is not a secure origin and is
 * denied by default.
 */
function configurePermissions() {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

async function onReady() {
  prefs = new Preferences();
  lang = strings.forLocale(app.getLocale());
  S = strings[lang];
  configurePermissions();

  if (IS_SELFTEST) {
    try {
      exitAfterFlush(await runSelfTest({ prefs, real: ARGS.includes('--real') }));
    } catch (error) {
      console.error('[win-duo] selftest failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  overlay = new Overlay({ displayMode: prefs.values.displayMode });
  // The page dying (crash, or closed underneath us) must not leave a run or a
  // monitor owned by a process that no longer exists.
  overlay.onGone = handleOverlayGone;

  if (IS_CHECK_SETTINGS) {
    const { checkSettings } = require('./check-settings');
    registerIpc();
    try {
      const code = await checkSettings({ prefs, wait });
      process.exitCode = code;
      exitAfterFlush(code);
    } catch (error) {
      console.error('[win-duo] settings check failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  if (IS_TIMING) {
    const { timeOneRun } = require('./timing');
    registerIpc();
    try {
      process.exitCode = await timeOneRun({ trigger, overlay, wait, isPlaying: () => playing });
      exitAfterFlush(process.exitCode);
    } catch (error) {
      console.error('[win-duo] timing failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  if (IS_DIAGNOSE_COVER) {
    const { diagnoseCover } = require('./diagnose-cover');
    registerIpc();
    try {
      exitAfterFlush(await diagnoseCover({ overlay, wait }));
    } catch (error) {
      console.error('[win-duo] coverage diagnosis failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  if (IS_SHOT_FOLD) {
    const { shotFold } = require('./shot-fold');
    registerIpc();
    try {
      exitAfterFlush(await shotFold({ trigger, overlay, wait, prefs }));
    } catch (error) {
      console.error('[win-duo] screen capture failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  if (IS_VERIFY_CAMERA) {
    const { verifyCameraTracking } = require('./verify-camera');
    registerIpc();
    try {
      const code = await verifyCameraTracking({
        trigger,
        overlay,
        wait,
        isPlaying: () => playing,
        prefs,
        getLastReport: () => lastRunReport,
        registerExitKey,
      });
      process.exitCode = code;
      exitAfterFlush(code);
    } catch (error) {
      console.error('[win-duo] camera verification failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  if (IS_VERIFY_MONITOR) {
    const { verifyMonitor } = require('./verify-monitor');
    registerIpc();
    try {
      const code = await verifyMonitor({
        trigger,
        overlay,
        wait,
        isPlaying: () => playing,
        prefs,
        getLastReport: () => lastRunReport,
        startMonitor: startPersistentMonitor,
        stopMonitor: stopPersistentMonitor,
        isMonitorActive: () => monitorActive,
        isMonitorPending: () => monitorPending,
        setCaptureForTest,
        setRunTimeoutsForTest,
        isRunAdmitted: () => runAdmission,
        getCurrentRunId: () => currentRunId,
      });
      process.exitCode = code;
      exitAfterFlush(code);
    } catch (error) {
      console.error('[win-duo] monitor verification failed:', error);
      exitAfterFlush(1);
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
      exitAfterFlush(code);
    } catch (error) {
      console.error('[win-duo] verify failed:', error);
      exitAfterFlush(1);
    }
    return;
  }

  createTray();
  registerHotkey();
  registerIpc();
  applyLoginItem(prefs.values.launchAtLogin);

  // Opt-in and off by default: only start holding the camera open when the
  // user has actually asked for it.
  if (prefs.values.persistentMonitor && prefs.values.enabled) {
    startPersistentMonitor();
  }

  // `--shot-settings <path>`: open the settings panel, screenshot it and quit.
  // Used to check the panel renders, and to keep the README's picture current.
  const shotIndex = ARGS.indexOf('--shot-settings');
  if (shotIndex !== -1 && ARGS[shotIndex + 1]) {
    openSettings();
    await wait(1800);
    try {
      const image = await settingsWindow.webContents.capturePage();
      fs.writeFileSync(ARGS[shotIndex + 1], image.toPNG());
      console.log(`[win-duo] wrote ${ARGS[shotIndex + 1]}`);
    } catch (error) {
      console.error('[win-duo] settings screenshot failed:', error.message);
    }
    exitAfterFlush(0);
    return;
  }

  // Warm the window up so the first trigger does not pay for a page load.
  overlay.ensure().catch((error) => {
    console.error('[win-duo] could not warm the overlay:', error.message);
  });
}

/**
 * The headless check modes never show UI, and they are usually run while the app
 * is sitting in the tray. Taking the single-instance lock would make them quit
 * silently with a zero exit code - which is exactly what used to happen, and it
 * looks like the checks passed when they never ran at all.
 */
const IS_CHECK = IS_SELFTEST || IS_VERIFY || IS_VERIFY_CAMERA || IS_VERIFY_MONITOR || IS_TIMING
  || IS_CHECK_SETTINGS || IS_SHOT_FOLD || IS_DIAGNOSE_COVER || ARGS.includes('--shot-settings');

if (!IS_CHECK && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { openSettings(); });
  // The app lives in the tray: closing the settings window must not quit it.
  app.on('window-all-closed', () => {});
  // before-quit fires before the windows are torn down, so the closed handler
  // knows not to try to restart monitoring on the way out.
  app.on('before-quit', () => { appQuitting = true; });
  app.on('will-quit', () => {
    appQuitting = true;
    globalShortcut.unregisterAll();
    // Release the camera before the process goes down, rather than leaving it
    // to the renderer teardown.
    if (overlay) overlay.stopMonitor({ generation: monitorGeneration + 1 });
  });
  app.whenReady().then(onReady);
}
