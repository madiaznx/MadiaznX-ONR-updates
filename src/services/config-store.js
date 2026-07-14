const fs = require('fs/promises');
const path = require('path');

const DEFAULT_SETTINGS = {
  imagesRoot: '',
  kmlPath: '',
  apiBaseUrl: 'https://www.mapa.onr.org.br/',
  apiToken: '',
  ocrLanguage: 'por+eng',
  maxOcrPages: 20,
  defaultUf: 'SP',
  defaultCity: 'Tremembe',
  defaultPolygonFormat: 'GeoJSON/Desenho',
  defaultPublicityLevel: 2,
  defaultPolygonClassification: 1,
  defaultPolygonCategory: 3,
  defaultPropertyType: 'Terreno/fracao'
};

function createConfigStore(app) {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');

  async function getSettings() {
    try {
      const raw = await fs.readFile(settingsFile, 'utf8');
      return sanitizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Could not read settings:', error.message);
      }
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = sanitizeSettings({ ...current, ...partial });
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  return {
    settingsFile,
    getSettings,
    saveSettings
  };
}

function sanitizeSettings(value) {
  const next = { ...DEFAULT_SETTINGS, ...(value || {}) };
  next.imagesRoot = String(next.imagesRoot || '').trim();
  next.kmlPath = String(next.kmlPath || '').trim();
  next.apiBaseUrl = String(next.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).trim() || DEFAULT_SETTINGS.apiBaseUrl;
  next.apiToken = String(next.apiToken || '').trim();
  next.ocrLanguage = String(next.ocrLanguage || DEFAULT_SETTINGS.ocrLanguage).trim() || DEFAULT_SETTINGS.ocrLanguage;
  next.maxOcrPages = Math.max(0, Number.parseInt(next.maxOcrPages, 10) || DEFAULT_SETTINGS.maxOcrPages);
  next.defaultUf = String(next.defaultUf || DEFAULT_SETTINGS.defaultUf).trim().toUpperCase() || DEFAULT_SETTINGS.defaultUf;
  next.defaultCity = String(next.defaultCity || DEFAULT_SETTINGS.defaultCity).trim() || DEFAULT_SETTINGS.defaultCity;
  next.defaultPolygonFormat = String(next.defaultPolygonFormat || DEFAULT_SETTINGS.defaultPolygonFormat).trim();
  next.defaultPublicityLevel = Number.parseInt(next.defaultPublicityLevel, 10) || DEFAULT_SETTINGS.defaultPublicityLevel;
  next.defaultPolygonClassification = Number.parseInt(next.defaultPolygonClassification, 10) || DEFAULT_SETTINGS.defaultPolygonClassification;
  next.defaultPolygonCategory = Number.parseInt(next.defaultPolygonCategory, 10) || DEFAULT_SETTINGS.defaultPolygonCategory;
  next.defaultPropertyType = String(next.defaultPropertyType || DEFAULT_SETTINGS.defaultPropertyType).trim();
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  createConfigStore
};
