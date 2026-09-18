const { contextBridge, ipcRenderer } = require('electron');

// The single bridge between the Wyre web app running in the desktop shell and
// the Electron main process. Nothing else from Node is exposed to the page.
contextBridge.exposeInMainWorld('wyreDesktop', {
  platform: process.platform,
  appVersion: process.env.WYRE_DESKTOP_VERSION ?? '1.0.0',
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch ?? {}),
  openSettings: () => ipcRenderer.send('app:open-settings'),
  openLogs: () => ipcRenderer.send('app:open-logs'),
  quit: () => ipcRenderer.send('app:quit'),
  log: (level, line) => ipcRenderer.send('log', level, String(line ?? '').slice(0, 4000)),
  osControl: {
    available: () => ipcRenderer.invoke('os-control:available'),
    inject: (event) => ipcRenderer.invoke('os-control:event', event ?? {}),
  },
});
