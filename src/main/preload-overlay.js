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
   * Whether the overlay should take mouse input. It stays click-through while
   * armed and waiting, and takes clicks once the picture is up, so that a click
   * can end the run.
   */
  setInteractive: (on) => ipcRenderer.send('wd:interactive', Boolean(on)),

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
