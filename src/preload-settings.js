'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.send('settings:set', patch),
  close: () => ipcRenderer.send('settings:close'),
  onState: (callback) => {
    ipcRenderer.on('settings:state', (_event, payload) => callback(payload));
  },
});
