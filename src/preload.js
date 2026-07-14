const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('madiaznxONR', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  openLatestRelease: () => ipcRenderer.invoke('app:open-update-repo'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:event', listener);
    return () => ipcRenderer.removeListener('updater:event', listener);
  }
});
