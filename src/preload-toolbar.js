'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  action: (name) => ipcRenderer.send('widget:action', String(name)),
  getState: () => ipcRenderer.invoke('widget:get-state'),
  onState: (callback) => {
    ipcRenderer.on('widget:state', (_event, payload) => callback(payload));
  },
});
