const api = window.madiaznxONR;

const state = {
  appInfo: null,
  settings: null,
  options: null,
  kml: { polygons: [] },
  fields: {},
  ocr: null,
  selectedPolygon: null,
  updateAvailable: false,
  updateDownloaded: false
};

const elements = {};

const fieldGroups = [
  {
    title: 'Identificacao',
    fields: [
      field('numeroPrenotacao', 'Prenotacao / protocolo'),
      field('matricula', 'Matricula', true),
      field('cadastroRegistro', 'Cadastro / registro', true),
      field('dataMatricula', 'Data da matricula'),
      field('livroMatricula', 'Livro'),
      field('folhaMatricula', 'Folha')
    ]
  },
  {
    title: 'Poligono',
    fields: [
      selectField('formatoPoligono', 'Formato', 'polygonFormats', true),
      selectField('nivelPublicidade', 'Nivel de publicidade', 'publicityLevels', true),
      selectField('classificacaoPoligonos', 'Classificacao', 'polygonClassifications', true),
      selectField('categorizacaoPoligonos', 'Categorizacao', 'polygonCategories', true),
      field('pontoCentral', 'Ponto central'),
      field('descricaoInterna', 'Descricao interna', false, 'textarea'),
      field('descricaoPublica', 'Descricao publica', false, 'textarea')
    ]
  },
  {
    title: 'Imovel',
    fields: [
      selectField('tipoImovel', 'Tipo do imovel', 'propertyTypes', true),
      selectField('tipo', 'Urbano / rural', 'propertyKind'),
      field('nomeImovel', 'Nome do imovel'),
      field('endereco', 'Endereco'),
      field('numeroImovel', 'Numero'),
      field('cep', 'CEP'),
      field('uf', 'UF'),
      field('cidade', 'Cidade')
    ]
  },
  {
    title: 'Parte',
    fields: [
      field('nomeProprietario', 'Nome do proprietario', false, 'textarea'),
      field('cpfCnpj', 'CPF/CNPJ', false, 'textarea'),
      selectField('tipoRelacaoJuridica', 'Relacao juridica', 'legalRelations'),
      field('percentual', 'Percentual'),
      field('dataInicio', 'Data de inicio'),
      field('dataFim', 'Data fim')
    ]
  },
  {
    title: 'Rural / cadastros',
    fields: [
      field('ccirSncr', 'CCIR/SNCR'),
      field('snci', 'SNCI'),
      field('sigef', 'SIGEF'),
      field('cibNirf', 'CIB/NIRF'),
      field('transcricao', 'Transcricao'),
      field('car', 'CAR'),
      field('rip', 'RIP'),
      field('cif', 'CIF'),
      field('itbi', 'Valor do ITBI')
    ]
  },
  {
    title: 'Confrontantes e medidas',
    fields: [
      field('confrontantesMatriculas', 'Confrontantes (matriculas)', false, 'textarea'),
      field('nomeConfrontantes', 'Nome dos confrontantes', false, 'textarea'),
      field('areaHa', 'Area ha'),
      field('areaM2', 'Area m2'),
      field('perimetroM', 'Perimetro m'),
      field('perimetroKm', 'Perimetro km')
    ]
  }
];

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();

  const [appInfo, settings, options, emptyRecord] = await Promise.all([
    api.getAppInfo(),
    api.getSettings(),
    api.getOnrOptions(),
    api.createEmptyRecord()
  ]);

  state.appInfo = appInfo;
  state.settings = settings;
  state.options = options;
  state.fields = emptyRecord;

  renderAppInfo();
  renderSettings();
  renderForm();
  await refreshKml();
}

function cacheElements() {
  [
    'version',
    'headlineStatus',
    'imagesRootInput',
    'kmlPathInput',
    'apiBaseUrlInput',
    'apiTokenInput',
    'ocrLanguageInput',
    'maxOcrPagesInput',
    'saveSettingsButton',
    'chooseImagesButton',
    'chooseKmlButton',
    'matriculaInput',
    'analyzeButton',
    'ocrStatus',
    'warningList',
    'polygonCount',
    'polygonSelect',
    'polygonMetrics',
    'formValidation',
    'onrForm',
    'newRecordButton',
    'prepareButton',
    'sendButton',
    'apiStatus',
    'importationIdInput',
    'statusButton',
    'packageState',
    'updateStatus',
    'updateProgress',
    'checkButton',
    'downloadButton',
    'installButton',
    'openLatestButton'
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll('[data-scroll-target]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  elements.chooseImagesButton.addEventListener('click', chooseImagesRoot);
  elements.chooseKmlButton.addEventListener('click', chooseKml);
  elements.saveSettingsButton.addEventListener('click', saveSettings);
  elements.analyzeButton.addEventListener('click', analyzeMatricula);
  elements.polygonSelect.addEventListener('change', () => selectPolygon(elements.polygonSelect.value));
  elements.onrForm.addEventListener('input', updateFieldsFromForm);
  elements.onrForm.addEventListener('change', updateFieldsFromForm);
  elements.newRecordButton.addEventListener('click', resetRecord);
  elements.prepareButton.addEventListener('click', prepareShapefile);
  elements.sendButton.addEventListener('click', sendToOnr);
  elements.statusButton.addEventListener('click', checkImportStatus);
  elements.openLatestButton.addEventListener('click', () => api.openLatestRelease());

  elements.checkButton.addEventListener('click', checkForUpdates);
  elements.downloadButton.addEventListener('click', downloadUpdate);
  elements.installButton.addEventListener('click', installUpdate);

  api.onMatriculaProgress((payload) => setOcrStatus(payload.message || 'OCR em andamento...'));
  api.onOnrProgress((payload) => setApiStatus(payload.message || 'Processando envio...'));
  api.onUpdaterEvent(handleUpdaterEvent);
}

function renderAppInfo() {
  elements.version.textContent = `v${state.appInfo.version}`;
  elements.packageState.textContent = state.appInfo.isPackaged
    ? 'Aplicativo instalado.'
    : 'Modo local.';
}

function renderSettings() {
  elements.imagesRootInput.value = state.settings.imagesRoot || '';
  elements.kmlPathInput.value = state.settings.kmlPath || '';
  elements.apiBaseUrlInput.value = state.settings.apiBaseUrl || '';
  elements.apiTokenInput.value = state.settings.apiToken || '';
  elements.ocrLanguageInput.value = state.settings.ocrLanguage || 'por+eng';
  elements.maxOcrPagesInput.value = state.settings.maxOcrPages ?? 20;
}

function renderForm() {
  elements.onrForm.innerHTML = fieldGroups.map((group) => {
    return `
      <fieldset class="form-group">
        <legend>${escapeHtml(group.title)}</legend>
        <div class="form-grid">
          ${group.fields.map(renderField).join('')}
        </div>
      </fieldset>
    `;
  }).join('');
  renderValidation();
}

function renderField(config) {
  const value = state.fields[config.key] ?? '';
  const required = config.required ? '<strong>*</strong>' : '';
  const common = `data-field="${escapeAttr(config.key)}" ${config.required ? 'required' : ''}`;

  if (config.type === 'select') {
    return `
      <label class="field">
        <span>${escapeHtml(config.label)} ${required}</span>
        <select ${common}>
          ${selectOptions(config.optionsKey, value)}
        </select>
      </label>
    `;
  }

  if (config.type === 'textarea') {
    return `
      <label class="field field-tall">
        <span>${escapeHtml(config.label)} ${required}</span>
        <textarea ${common}>${escapeHtml(value)}</textarea>
      </label>
    `;
  }

  return `
    <label class="field">
      <span>${escapeHtml(config.label)} ${required}</span>
      <input type="text" ${common} value="${escapeAttr(value)}" spellcheck="false" />
    </label>
  `;
}

function selectOptions(optionsKey, currentValue) {
  const values = state.options[optionsKey] || [];
  return values.map((item) => {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    const selected = String(value) === String(currentValue) ? 'selected' : '';
    return `<option value="${escapeAttr(value)}" ${selected}>${escapeHtml(label)}</option>`;
  }).join('');
}

async function chooseImagesRoot() {
  const result = await api.chooseImagesRoot();
  if (result.canceled) return;
  state.settings = result.settings;
  renderSettings();
  setHeadline('Pasta de imagens atualizada.');
}

async function chooseKml() {
  const result = await api.chooseKml();
  if (result.canceled) return;
  state.settings = result.settings;
  state.kml = result.kml || { polygons: [] };
  renderSettings();
  renderPolygonSelect();
  setHeadline('KML carregado.');
}

async function saveSettings() {
  state.settings = await api.saveSettings(readSettingsForm());
  renderSettings();
  await refreshKml();
  setHeadline('Configuracoes salvas.');
}

async function refreshKml() {
  try {
    state.kml = await api.loadKml();
  } catch (error) {
    state.kml = { polygons: [] };
    setHeadline(`KML nao carregado: ${error.message}`);
  }
  renderPolygonSelect();
}

async function analyzeMatricula() {
  const matricula = elements.matriculaInput.value.trim();
  if (!matricula) {
    setOcrStatus('Informe a matricula.');
    return;
  }

  setBusy(elements.analyzeButton, true);
  setOcrStatus('Iniciando OCR...');
  elements.warningList.innerHTML = '';

  try {
    const result = await api.analyzeMatricula({ matricula });
    state.settings = result.settings;
    state.ocr = result.ocr;
    state.kml = result.kml || { polygons: [] };
    state.fields = result.fields || {};
    state.selectedPolygon = result.matchedPolygon || null;
    renderSettings();
    renderPolygonSelect();
    renderForm();
    renderWarnings(result.ocr.warnings || []);
    setOcrStatus(`${result.ocr.files.length} arquivo(s), ${result.ocr.pages.length} pagina(s) OCR.`);
    setHeadline(result.matchedPolygon ? 'Matricula vinculada ao poligono automaticamente.' : 'Matricula lida. Selecione o poligono.');
  } catch (error) {
    setOcrStatus(`Falha: ${error.message}`);
  } finally {
    setBusy(elements.analyzeButton, false);
  }
}

function renderPolygonSelect() {
  const polygons = state.kml.polygons || [];
  elements.polygonCount.textContent = polygons.length
    ? `${polygons.length} poligono(s) no KML.`
    : 'Nenhum poligono carregado.';

  const currentId = state.selectedPolygon ? state.selectedPolygon.id : '';
  elements.polygonSelect.innerHTML = [
    '<option value="">Selecionar...</option>',
    ...polygons.map((polygon) => {
      const selected = polygon.id === currentId ? 'selected' : '';
      const candidates = polygon.matriculaCandidates.length ? ` [${polygon.matriculaCandidates.join(', ')}]` : '';
      return `<option value="${escapeAttr(polygon.id)}" ${selected}>${escapeHtml(polygon.name + candidates)}</option>`;
    })
  ].join('');

  renderPolygonMetrics();
}

async function selectPolygon(polygonId) {
  state.selectedPolygon = (state.kml.polygons || []).find((polygon) => polygon.id === polygonId) || null;
  if (state.selectedPolygon) {
    const result = await api.applyPolygon({ fields: gatherFields(), polygon: state.selectedPolygon });
    state.fields = result.fields;
    renderForm();
  }
  renderPolygonMetrics();
  renderValidation();
}

function renderPolygonMetrics() {
  const polygon = state.selectedPolygon;
  if (!polygon) {
    elements.polygonMetrics.innerHTML = '<div class="empty-state">Sem poligono selecionado.</div>';
    return;
  }

  elements.polygonMetrics.innerHTML = `
    <dt>Nome</dt><dd>${escapeHtml(polygon.name)}</dd>
    <dt>Centro</dt><dd>${polygon.center ? `${formatNumber(polygon.center.lon, 7)}, ${formatNumber(polygon.center.lat, 7)}` : '-'}</dd>
    <dt>Area</dt><dd>${formatNumber(polygon.areaM2, 2)} m2</dd>
    <dt>Perimetro</dt><dd>${formatNumber(polygon.perimeterM, 2)} m</dd>
  `;
}

function updateFieldsFromForm(event) {
  if (!event.target.dataset.field) return;
  state.fields[event.target.dataset.field] = event.target.value;
  renderValidation();
}

function gatherFields() {
  const fields = { ...state.fields };
  elements.onrForm.querySelectorAll('[data-field]').forEach((input) => {
    fields[input.dataset.field] = input.value;
  });
  state.fields = fields;
  return fields;
}

async function resetRecord() {
  state.fields = await api.createEmptyRecord();
  state.ocr = null;
  state.selectedPolygon = null;
  elements.matriculaInput.value = '';
  elements.warningList.innerHTML = '';
  setOcrStatus('Nenhuma leitura iniciada.');
  renderPolygonSelect();
  renderForm();
  setHeadline('Formulario limpo.');
}

async function prepareShapefile() {
  setBusy(elements.prepareButton, true);
  setApiStatus('Gerando shapefile...');
  try {
    const result = await api.prepareShapefile({ fields: gatherFields(), polygon: state.selectedPolygon });
    setApiStatus(`Shapefile gerado em ${result.outputDir}`);
  } catch (error) {
    setApiStatus(`Falha: ${error.message}`);
  } finally {
    setBusy(elements.prepareButton, false);
  }
}

async function sendToOnr() {
  const confirmed = confirm('Enviar este poligono para a API ONR?');
  if (!confirmed) return;

  setBusy(elements.sendButton, true);
  setApiStatus('Preparando envio...');
  try {
    const result = await api.sendToOnr({ fields: gatherFields(), polygon: state.selectedPolygon });
    elements.importationIdInput.value = result.importationId;
    setApiStatus(`Importacao confirmada: ${result.importationId}`);
  } catch (error) {
    setApiStatus(`Falha: ${error.message}`);
  } finally {
    setBusy(elements.sendButton, false);
  }
}

async function checkImportStatus() {
  const importationId = elements.importationIdInput.value.trim();
  if (!importationId) {
    setApiStatus('Informe o importation_id.');
    return;
  }
  try {
    const result = await api.getImportStatus({ importationId });
    setApiStatus(JSON.stringify(result.data || result, null, 2));
  } catch (error) {
    setApiStatus(`Falha: ${error.message}`);
  }
}

function renderWarnings(warnings) {
  elements.warningList.innerHTML = (warnings || []).map((warning) => {
    return `<div class="warning-item">${escapeHtml(warning)}</div>`;
  }).join('');
}

function renderValidation() {
  const fields = gatherFieldsIfReady();
  const missing = [];
  ['matricula', 'cadastroRegistro', 'formatoPoligono', 'nivelPublicidade', 'classificacaoPoligonos', 'categorizacaoPoligonos', 'tipoImovel'].forEach((key) => {
    if (!String(fields[key] || '').trim()) missing.push(labelForField(key));
  });
  if (!state.selectedPolygon) missing.push('Poligono');

  elements.formValidation.textContent = missing.length
    ? `Pendentes: ${missing.join(', ')}`
    : 'Campos obrigatorios preenchidos.';
}

function gatherFieldsIfReady() {
  if (!elements.onrForm || !elements.onrForm.childElementCount) return state.fields || {};
  return gatherFields();
}

function readSettingsForm() {
  return {
    imagesRoot: elements.imagesRootInput.value,
    kmlPath: elements.kmlPathInput.value,
    apiBaseUrl: elements.apiBaseUrlInput.value,
    apiToken: elements.apiTokenInput.value,
    ocrLanguage: elements.ocrLanguageInput.value,
    maxOcrPages: elements.maxOcrPagesInput.value
  };
}

async function checkForUpdates() {
  setUpdateBusy(true);
  setUpdateStatus('Verificando atualizacoes...');
  try {
    const result = await api.checkForUpdates();
    if (result && result.skipped) {
      setUpdateBusy(false);
      setUpdateStatus(result.reason);
    }
  } catch (error) {
    setUpdateBusy(false);
    setUpdateStatus(`Falha na checagem: ${error.message}`);
  }
}

async function downloadUpdate() {
  setUpdateBusy(true);
  setUpdateStatus('Iniciando download...');
  try {
    const result = await api.downloadUpdate();
    if (result && result.skipped) {
      setUpdateBusy(false);
      setUpdateStatus(result.reason);
    }
  } catch (error) {
    setUpdateBusy(false);
    setUpdateStatus(`Falha no download: ${error.message}`);
  }
}

async function installUpdate() {
  setUpdateBusy(true);
  setUpdateStatus('Instalando atualizacao...');
  try {
    const result = await api.installUpdate();
    if (result && result.skipped) {
      setUpdateBusy(false);
      setUpdateStatus(result.reason);
    }
  } catch (error) {
    setUpdateBusy(false);
    setUpdateStatus(`Falha na instalacao: ${error.message}`);
  }
}

function handleUpdaterEvent(event) {
  if (!event || !event.type) return;

  if (event.type === 'checking') {
    setUpdateBusy(true);
    setUpdateProgress(0);
    setUpdateStatus('Verificando atualizacoes...');
  }

  if (event.type === 'available') {
    state.updateAvailable = true;
    state.updateDownloaded = false;
    setUpdateBusy(false);
    setUpdateStatus(`Atualizacao disponivel: ${event.info?.version || ''}`);
  }

  if (event.type === 'not-available') {
    state.updateAvailable = false;
    state.updateDownloaded = false;
    setUpdateBusy(false);
    setUpdateProgress(0);
    setUpdateStatus('Versao mais recente instalada.');
  }

  if (event.type === 'download-progress') {
    setUpdateBusy(true);
    setUpdateProgress(event.percent || 0);
    setUpdateStatus(`Baixando... ${event.percent || 0}%`);
  }

  if (event.type === 'downloaded') {
    state.updateDownloaded = true;
    setUpdateBusy(false);
    setUpdateProgress(100);
    setUpdateStatus('Atualizacao baixada.');
  }

  if (event.type === 'error') {
    setUpdateBusy(false);
    setUpdateStatus(`Falha: ${event.message || 'erro desconhecido'}`);
  }
}

function setUpdateBusy(isBusy) {
  elements.checkButton.disabled = isBusy;
  elements.downloadButton.disabled = isBusy || !state.updateAvailable || state.updateDownloaded;
  elements.installButton.disabled = isBusy || !state.updateDownloaded;
}

function setUpdateStatus(message) {
  elements.updateStatus.textContent = message;
}

function setUpdateProgress(value) {
  elements.updateProgress.value = Math.max(0, Math.min(100, value));
}

function setOcrStatus(message) {
  elements.ocrStatus.textContent = message;
}

function setApiStatus(message) {
  elements.apiStatus.textContent = message;
}

function setHeadline(message) {
  elements.headlineStatus.textContent = message;
}

function setBusy(button, isBusy) {
  button.disabled = isBusy;
}

function field(key, label, required = false, type = 'input') {
  return { key, label, required, type };
}

function selectField(key, label, optionsKey, required = false) {
  return { key, label, required, type: 'select', optionsKey };
}

function labelForField(key) {
  const fields = fieldGroups.flatMap((group) => group.fields);
  return fields.find((item) => item.key === key)?.label || key;
}

function formatNumber(value, decimals) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(decimals) : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
