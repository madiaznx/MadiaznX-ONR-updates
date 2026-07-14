const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('madiaznxONR', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseImagesRoot: () => ipcRenderer.invoke('settings:choose-images-root'),
  chooseKml: () => ipcRenderer.invoke('settings:choose-kml'),
  getOnrOptions: () => ipcRenderer.invoke('onr:get-options'),
  loadKml: () => ipcRenderer.invoke('kml:load'),
  analyzeMatricula: (payload) => ipcRenderer.invoke('matricula:analyze', payload),
  createEmptyRecord: () => ipcRenderer.invoke('record:empty'),
  applyPolygon: (payload) => ipcRenderer.invoke('record:apply-polygon', payload),
  prepareShapefile: (payload) => ipcRenderer.invoke('onr:prepare-shapefile', payload),
  sendToOnr: (payload) => ipcRenderer.invoke('onr:send', payload),
  getImportStatus: (payload) => ipcRenderer.invoke('onr:status', payload),
  openLatestRelease: () => ipcRenderer.invoke('app:open-update-repo'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onMatriculaProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('matricula:progress', listener);
    return () => ipcRenderer.removeListener('matricula:progress', listener);
  },
  onOnrProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('onr:progress', listener);
    return () => ipcRenderer.removeListener('onr:progress', listener);
  },
  onUpdaterEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:event', listener);
    return () => ipcRenderer.removeListener('updater:event', listener);
  }
});
