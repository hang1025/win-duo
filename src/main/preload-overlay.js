'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The overlay page talks to the main process through this and nothing else.
 */
contextBridge.exposeInMainWorld('winDuoBridge', {
  /** The picture to show, plus the settings for this run. */
  onPlay: (callback) => ipcRenderer.on('wd:play', (_event, payload) => callback(payload)),
  /** Settings changed while the overlay is alive. */
  onSettings: (callback) => ipcRenderer.on('wd:settings', (_event, settings) => callback(settings)),
  /**
   * The run is over and the overlay has faded out. The report carries what the
   * tracker saw, so the main process can refine the travel estimate.
   */
  finished: (report) => ipcRenderer.send('wd:overlay-finished', report),
  /**
   * The exit key was pressed. The key itself is registered in the main process
   * and only while a run is up, so Escape behaves normally the rest of the time.
   */
  onExit: (callback) => ipcRenderer.on('wd:exit', () => callback()),

  /**
   * The persistent monitor. `onMonitorStart` carries the camera and the
   * relative trigger/re-arm angles; `onMonitorStop` closes the one stream;
   * `onMonitorResume` is sent when the main process could not start a run and
   * the monitor should keep watching.
   */
  onMonitorStart: (callback) => ipcRenderer.on('wd:monitor-start', (_event, config) => callback(config)),
  onMonitorStop: (callback) => ipcRenderer.on('wd:monitor-stop', (_event, payload) => callback(payload || {})),
  onMonitorResume: (callback) => ipcRenderer.on('wd:monitor-resume', (_event, payload) => callback(payload || {})),
  /**
   * The monitor saw the lid pass the relative trigger. The main process is the
   * final gate and decides whether a run actually starts.
   */
  monitorCrossed: (info) => ipcRenderer.send('wd:monitor-crossed', info),
  /** Whether monitoring actually started, so the tray can report the truth. */
  monitorStatus: (status) => ipcRenderer.send('wd:monitor-status', status),

  /**
   * Timing marks. `Date.now()` is the same clock in both processes, so the main
   * process can line these up against the moment the hotkey fired.
   */
  mark: (name) => ipcRenderer.send('wd:mark', name, Date.now()),
  /**
   * Self test: the picture arrives over IPC (a bitmap is far too big for an
   * executeJavaScript literal) and the main process then pulls one frame per
   * angle back out.
   */
  onSelftestPayload: (callback) => ipcRenderer.on('wd:selftest-payload', (_event, payload) => callback(payload)),
});
