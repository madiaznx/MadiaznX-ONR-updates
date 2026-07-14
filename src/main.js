const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const UPDATE_REPO_URL = 'https://github.com/madiaznx/MadiaznX-ONR-updates';

let mainWindow;

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
    backgroundColor: '#f4f1eb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendUpdateEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('updater:event', { type, ...payload });
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
