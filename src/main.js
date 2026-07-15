const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { createConfigStore } = require('./services/config-store');
const { analyzeMatricula } = require('./services/matricula-reader');
const { loadKmlFile, matchPolygonForMatricula } = require('./services/kml-service');
const { createRecord, emptyRecord, applyPolygon, validateRecord, PUBLICITY_LEVELS, POLYGON_CLASSIFICATIONS, POLYGON_CATEGORIES, LEGAL_RELATIONS, PROPERTY_TYPES, PROPERTY_KIND, POLYGON_FORMATS } = require('./services/onr-fields');
const { prepareShapefile, sendToOnr, getImportStatus } = require('./services/onr-api');

const UPDATE_REPO_URL = 'https://github.com/madiaznx/MadiaznX-ONR-updates';

let mainWindow;
let configStore;

app.setName('MadiaznX ONR');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 660,
    title: 'MadiaznX ONR',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: '#f4f1eb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function getConfigStore() {
  if (!configStore) {
    configStore = createConfigStore(app);
  }
  return configStore;
}

function sendUpdateEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('updater:event', { type, ...payload });
}

function sendWorkflowEvent(channel, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function updateInfoPayload(info) {
  if (!info) return null;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName,
    files: Array.isArray(info.files) ? info.files.map((file) => ({ url: file.url, size: file.size })) : []
  };
}

autoUpdater.on('checking-for-update', () => sendUpdateEvent('checking'));
autoUpdater.on('update-available', (info) => sendUpdateEvent('available', { info: updateInfoPayload(info) }));
autoUpdater.on('update-not-available', (info) => sendUpdateEvent('not-available', { info: updateInfoPayload(info) }));
autoUpdater.on('download-progress', (progress) => {
  sendUpdateEvent('download-progress', {
    percent: Math.round(progress.percent || 0),
    transferred: progress.transferred,
    total: progress.total
  });
});
autoUpdater.on('update-downloaded', (info) => sendUpdateEvent('downloaded', { info: updateInfoPayload(info) }));
autoUpdater.on('error', (error) => {
  sendUpdateEvent('error', { message: error && error.message ? error.message : String(error) });
});

ipcMain.handle('app:get-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  updateRepoUrl: UPDATE_REPO_URL
}));

ipcMain.handle('settings:get', async () => {
  return getConfigStore().getSettings();
});

ipcMain.handle('settings:save', async (_event, partial) => {
  return getConfigStore().saveSettings(partial || {});
});

ipcMain.handle('settings:choose-images-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher pasta de imagens das matriculas',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const settings = await getConfigStore().saveSettings({ imagesRoot: result.filePaths[0] });
  return { canceled: false, path: result.filePaths[0], settings };
});

ipcMain.handle('settings:choose-kml', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher arquivo KML do Google Earth',
    properties: ['openFile'],
    filters: [
      { name: 'Google Earth KML', extensions: ['kml'] },
      { name: 'Todos os arquivos', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const settings = await getConfigStore().saveSettings({ kmlPath: result.filePaths[0] });
  const kml = await loadKmlFile(result.filePaths[0]);
  return { canceled: false, path: result.filePaths[0], settings, kml };
});

ipcMain.handle('onr:get-options', () => ({
  publicityLevels: PUBLICITY_LEVELS,
  polygonClassifications: POLYGON_CLASSIFICATIONS,
  polygonCategories: POLYGON_CATEGORIES,
  legalRelations: LEGAL_RELATIONS,
  propertyTypes: PROPERTY_TYPES,
  propertyKind: PROPERTY_KIND,
  polygonFormats: POLYGON_FORMATS
}));

ipcMain.handle('kml:load', async () => {
  const settings = await getConfigStore().getSettings();
  return loadKmlFile(settings.kmlPath);
});

ipcMain.handle('matricula:analyze', async (_event, { matricula }) => {
  const settings = await getConfigStore().getSettings();
  const ocr = await analyzeMatricula({
    imagesRoot: settings.imagesRoot,
    matricula,
    settings,
    onProgress: (payload) => sendWorkflowEvent('matricula:progress', payload)
  });

  const kml = settings.kmlPath ? await loadKmlFile(settings.kmlPath) : { polygons: [] };
  const matchedPolygon = matchPolygonForMatricula(kml.polygons, ocr.matricula);
  const fields = createRecord({
    matricula: ocr.matricula,
    ocrFields: ocr.fields,
    polygon: matchedPolygon,
    settings
  });

  return {
    settings,
    ocr,
    kml,
    matchedPolygon,
    fields,
    validation: validateRecord(fields, matchedPolygon)
  };
});

ipcMain.handle('record:empty', async () => {
  const settings = await getConfigStore().getSettings();
  return emptyRecord(settings);
});

ipcMain.handle('record:apply-polygon', async (_event, { fields, polygon }) => {
  const nextFields = applyPolygon({ ...(fields || {}) }, polygon || null);
  return {
    fields: nextFields,
    validation: validateRecord(nextFields, polygon)
  };
});

ipcMain.handle('onr:prepare-shapefile', async (_event, { fields, polygon }) => {
  const outputRoot = path.join(app.getPath('documents'), 'MadiaznX ONR', 'exports');
  const prepared = await prepareShapefile({ fields, polygon, outputRoot });
  await shell.showItemInFolder(prepared.filePaths.shp);
  return prepared;
});

ipcMain.handle('onr:send', async (_event, { fields, polygon }) => {
  const settings = await getConfigStore().getSettings();
  const outputRoot = path.join(app.getPath('documents'), 'MadiaznX ONR', 'exports');
  return sendToOnr({
    settings,
    fields,
    polygon,
    outputRoot,
    onProgress: (payload) => sendWorkflowEvent('onr:progress', payload)
  });
});

ipcMain.handle('onr:status', async (_event, { importationId }) => {
  const settings = await getConfigStore().getSettings();
  return getImportStatus({ settings, importationId });
});

ipcMain.handle('app:open-update-repo', async () => {
  await shell.openExternal(`${UPDATE_REPO_URL}/releases/latest`);
  return { ok: true };
});

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) {
    return {
      ok: false,
      skipped: true,
      reason: 'A checagem automatica roda somente no app instalado.'
    };
  }

  const result = await autoUpdater.checkForUpdates();
  return { ok: true, info: updateInfoPayload(result && result.updateInfo) };
});

ipcMain.handle('updater:download', async () => {
  if (!app.isPackaged) {
    return {
      ok: false,
      skipped: true,
      reason: 'O download de update roda somente no app instalado.'
    };
  }

  await autoUpdater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle('updater:install', () => {
  if (!app.isPackaged) {
    return {
      ok: false,
      skipped: true,
      reason: 'A instalacao de update roda somente no app instalado.'
    };
  }

  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
