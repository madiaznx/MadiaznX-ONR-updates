const fs = require('fs/promises');
const path = require('path');
const shpwrite = require('@mapbox/shp-write');
const { toApiPayload, toDbfRow, validateRecord } = require('./onr-fields');

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]';

const DBF_FIELDS = [
  { name: 'MATRICULA', type: 'C', size: 30 },
  { name: 'CADASTRO', type: 'C', size: 60 },
  { name: 'DAT_MAT', type: 'C', size: 10 },
  { name: 'LIV_MAT', type: 'C', size: 20 },
  { name: 'FOL_MAT', type: 'C', size: 20 },
  { name: 'TRANSCRI', type: 'C', size: 40 },
  { name: 'CNM', type: 'C', size: 30 },
  { name: 'CNS', type: 'C', size: 20 },
  { name: 'ENDERECO', type: 'C', size: 180 },
  { name: 'NUMERO', type: 'C', size: 20 },
  { name: 'CEP', type: 'C', size: 12 },
  { name: 'MUNICIPIO', type: 'C', size: 80 },
  { name: 'UF', type: 'C', size: 2 },
  { name: 'NOME_PROP', type: 'C', size: 220 },
  { name: 'CPF_CNPJ', type: 'C', size: 160 },
  { name: 'NOME_IMO', type: 'C', size: 160 },
  { name: 'CCIR_SNCR', type: 'C', size: 40 },
  { name: 'SIGEF', type: 'C', size: 80 },
  { name: 'SNCI', type: 'C', size: 40 },
  { name: 'CIB_NIRF', type: 'C', size: 40 },
  { name: 'ITBI', type: 'N', size: 18, decimals: 2 },
  { name: 'CAR', type: 'C', size: 80 },
  { name: 'RIP', type: 'N', size: 20, decimals: 0 },
  { name: 'CIF', type: 'N', size: 20, decimals: 0 },
  { name: 'CLASSIFICA', type: 'N', size: 4, decimals: 0 }
];

async function prepareShapefile({ fields, polygon, outputRoot }) {
  const validation = validateRecord(fields, polygon);
  if (!validation.ok) {
    throw new Error(`Campos obrigatorios ausentes: ${validation.missing.join(', ')}`);
  }

  const baseName = safeBaseName(`matricula-${fields.matricula || Date.now()}`);
  const outputDir = path.join(outputRoot, `${baseName}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outputDir, { recursive: true });

  const row = toDbfRow(fields);
  const geometries = [polygon.geometry.rings];
  const files = await writeShape(row, geometries);
  const filePaths = {
    shp: path.join(outputDir, `${baseName}.shp`),
    shx: path.join(outputDir, `${baseName}.shx`),
    dbf: path.join(outputDir, `${baseName}.dbf`),
    prj: path.join(outputDir, `${baseName}.prj`)
  };

  await fs.writeFile(filePaths.shp, dataViewToBuffer(files.shp));
  await fs.writeFile(filePaths.shx, dataViewToBuffer(files.shx));
  await fs.writeFile(filePaths.dbf, writeDbf([row], DBF_FIELDS));
  await fs.writeFile(filePaths.prj, WGS84_PRJ, 'utf8');

  return {
    outputDir,
    baseName,
    filePaths,
    fileNames: Object.values(filePaths).map((item) => path.basename(item))
  };
}

async function sendToOnr({ settings, fields, polygon, outputRoot, onProgress }) {
  if (!settings.apiToken) {
    throw new Error('Informe o token da API ONR nas configuracoes.');
  }

  emit(onProgress, { stage: 'prepare', message: 'Gerando shapefile...' });
  const prepared = await prepareShapefile({ fields, polygon, outputRoot });
  const payload = toApiPayload(fields, prepared.fileNames);
  const baseUrl = normalizeBaseUrl(settings.apiBaseUrl);

  emit(onProgress, { stage: 'request-urls', message: 'Solicitando URLs de upload...' });
  const urlResponse = await postJson(`${baseUrl}api/v1/poligonos/gerar-url-importacao`, settings.apiToken, payload);
  const data = urlResponse.data || {};
  const importationId = data.importation_id;
  const uploadUrls = data.upload_urls || [];

  if (!importationId || !uploadUrls.length) {
    throw new Error('A API nao retornou importation_id/upload_urls.');
  }

  for (const upload of uploadUrls) {
    const fileName = upload.filename || upload.fileName;
    const uploadUrl = upload.upload_url || upload.uploadUrl;
    const localPath = Object.values(prepared.filePaths).find((item) => path.basename(item) === fileName);
    if (!localPath || !uploadUrl) {
      throw new Error(`URL de upload incompleta para ${fileName || 'arquivo desconhecido'}.`);
    }

    emit(onProgress, { stage: 'upload', message: `Enviando ${fileName}...` });
    const fileBuffer = await fs.readFile(localPath);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer
    });

    if (!response.ok) {
      throw new Error(`Falha no upload de ${fileName}: HTTP ${response.status}`);
    }
  }

  emit(onProgress, { stage: 'confirm', message: 'Confirmando importacao...' });
  const confirmResponse = await postJson(`${baseUrl}api/v1/poligonos/confirmar`, settings.apiToken, {
    importation_id: importationId
  });

  return {
    importationId,
    prepared,
    payload,
    response: confirmResponse
  };
}

async function getImportStatus({ settings, importationId }) {
  if (!settings.apiToken) {
    throw new Error('Informe o token da API ONR nas configuracoes.');
  }
  if (!importationId) {
    throw new Error('Informe o ID da importacao.');
  }

  const baseUrl = normalizeBaseUrl(settings.apiBaseUrl);
  return postJson(`${baseUrl}api/v1/poligonos/status`, settings.apiToken, {
    importation_id: importationId
  });
}

function writeShape(row, geometries) {
  return new Promise((resolve, reject) => {
    shpwrite.write([row], 'POLYGON', geometries, (error, files) => {
      if (error) reject(error);
      else resolve(files);
    });
  });
}

function writeDbf(rows, fields) {
  const headerLength = 32 + (fields.length * 32) + 1;
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.size, 0);
  const buffer = Buffer.alloc(headerLength + (recordLength * rows.length) + 1, 0);
  const now = new Date();

  buffer[0] = 0x03;
  buffer[1] = now.getFullYear() - 1900;
  buffer[2] = now.getMonth() + 1;
  buffer[3] = now.getDate();
  buffer.writeUInt32LE(rows.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);
  buffer[29] = 0x03;

  fields.forEach((field, index) => {
    const offset = 32 + (index * 32);
    writeLatin(buffer, offset, 11, field.name.slice(0, 10));
    buffer[offset + 11] = field.type.charCodeAt(0);
    buffer[offset + 16] = field.size;
    buffer[offset + 17] = field.decimals || 0;
  });
  buffer[headerLength - 1] = 0x0d;

  rows.forEach((row, rowIndex) => {
    let offset = headerLength + (rowIndex * recordLength);
    buffer[offset] = 0x20;
    offset += 1;

    fields.forEach((field) => {
      const rawValue = row[field.name];
      const value = field.type === 'N'
        ? formatDbfNumber(rawValue, field)
        : formatDbfString(rawValue, field);
      buffer.fill(0x20, offset, offset + field.size);
      writeLatin(buffer, offset, field.size, value);
      offset += field.size;
    });
  });

  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

function formatDbfString(value, field) {
  return normalizeLatin(value).slice(0, field.size).padEnd(field.size, ' ');
}

function formatDbfNumber(value, field) {
  if (value === '' || value === null || typeof value === 'undefined' || Number.isNaN(Number(value))) {
    return ''.padStart(field.size, ' ');
  }
  const decimals = field.decimals || 0;
  const text = Number(value).toFixed(decimals);
  return text.slice(0, field.size).padStart(field.size, ' ');
}

function writeLatin(buffer, offset, length, value) {
  const bytes = Buffer.from(toLatin(value).slice(0, length), 'latin1');
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
}

function normalizeLatin(value) {
  return toLatin(value).trim();
}

function toLatin(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\xff]/g, '')
    .replace(/\s+/g, ' ');
}

function dataViewToBuffer(view) {
  if (Buffer.isBuffer(view)) return view;
  return Buffer.from(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
}

async function postJson(url, token, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    const message = body.mensagem || body.message || body.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function normalizeBaseUrl(value) {
  const base = String(value || 'https://www.mapa.onr.org.br/').trim();
  return base.endsWith('/') ? base : `${base}/`;
}

function safeBaseName(value) {
  return String(value || 'poligono')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'poligono';
}

function emit(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

module.exports = {
  prepareShapefile,
  sendToOnr,
  getImportStatus,
  writeDbf,
  DBF_FIELDS
};
