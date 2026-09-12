'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winDuoSettings', {
  get: () => ipcRenderer.invoke('wd:get-settings'),
  set: (patch) => ipcRenderer.invoke('wd:set-settings', patch),
  reset: () => ipcRenderer.invoke('wd:reset-settings'),
  preview: () => ipcRenderer.invoke('wd:preview'),
  quit: () => ipcRenderer.invoke('wd:quit'),
  onSettings: (callback) => ipcRenderer.on('wd:settings', (_event, settings) => callback(settings)),
});
