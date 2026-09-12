'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recon', {
  /** Sensor inventory and collector availability, resolved once at startup. */
  inventory: () => ipcRenderer.invoke('recon:inventory'),
  /** Wi-Fi signal percentage, from the main process. */
  wifi: () => ipcRenderer.invoke('recon:wifi'),
  /** Latest ambient light reading, or null when the machine has no sensor. */
  light: () => ipcRenderer.invoke('recon:light'),
  /** Fire-and-forget sample batch. */
  samples: (batch) => ipcRenderer.send('recon:samples', batch),
  /** The session is over: analyse it, save it, and hand back the report. */
  finish: (session) => ipcRenderer.invoke('recon:finish', session),
  log: (line) => ipcRenderer.send('recon:log', line),
});
