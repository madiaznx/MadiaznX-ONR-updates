const fs = require('fs/promises');
const path = require('path');
const {
  normalizeMatricula,
  findMatriculaImages,
  collectOcrPageImages,
  createTesseractOcrSession,
  createPaddleOcrSession,
  extractFields,
  naturalCompare
} = require('../src/services/matricula-reader');

const rootDir = path.resolve(__dirname, '..');
const FIELD_KEYS = [
  'dataMatricula',
  'cadastroRegistro',
  'numeroImovel',
  'endereco',
  'nomeProprietario',
  'cpfCnpj',
  'cep',
  'ccirSncr',
  'sigef',
  'car'
];

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

async function main() {
  const imagesRoot = path.resolve(process.argv[2] || process.env.IMAGES_ROOT || rootDir);
  const limit = clampInteger(process.argv[3] || process.env.LIMIT, 1, 500, 50);
  const maxPages = clampInteger(process.env.MAX_PAGES, 0, 200, 20);
  const settings = {
    ocrLanguage: process.env.TESSERACT_LANG || 'por+eng',
    tesseractWorkers: clampInteger(process.env.TESSERACT_WORKERS, 1, 8, 8),
    paddleModel: process.env.PADDLE_MODEL || 'v5-latin-mobile',
    paddleStrategy: process.env.PADDLE_STRATEGY || 'per-line',
    paddleMaxSideLength: clampInteger(process.env.PADDLE_MAX_SIDE, 640, 2560, 1280),
    paddleConcurrency: clampInteger(process.env.PADDLE_CONCURRENCY, 1, 8, 2)
  };

  const matriculas = await discoverMatriculas(imagesRoot);
  if (!matriculas.length) {
    throw new Error(`Nenhuma matricula encontrada em ${imagesRoot}`);
  }

  const selected = pickMatriculas(matriculas, limit);
  console.log(`Comparando ${selected.length} matricula(s) em ${imagesRoot}`);
  console.log(`Tesseract workers=${settings.tesseractWorkers}; Paddle=${settings.paddleModel}, strategy=${settings.paddleStrategy}, maxSide=${settings.paddleMaxSideLength}, maxPages=${maxPages || 'sem limite'}`);

  const [tesseractSession, paddleSession] = await Promise.all([
    createTesseractOcrSession(settings, progressLogger('Tesseract')),
    createPaddleOcrSession(settings, progressLogger('Paddle'))
  ]);

  const results = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const matricula = selected[index];
      const result = await compareMatricula({
        imagesRoot,
        matricula,
        maxPages,
        tesseractSession,
        paddleSession,
        index,
        total: selected.length
      });
      results.push(result);
      printSummary(result, index, selected.length);
    }
  } finally {
    await Promise.all([
      tesseractSession.destroy(),
      paddleSession.destroy()
    ]);
  }

  const outputDir = path.join(rootDir, 'tmp');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `ocr-compare-${timestampForFile()}.json`);
  await fs.writeFile(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    imagesRoot,
    limit: selected.length,
    maxPages,
    settings,
    results
  }, null, 2), 'utf8');

  const aggregate = aggregateResults(results);
  console.log('');
  console.log(`Resumo: Tesseract ${aggregate.tesseractFilled}/${aggregate.totalFields} campos preenchidos, Paddle ${aggregate.paddleFilled}/${aggregate.totalFields}.`);
  console.log(`Relatorio: ${outputPath}`);
}

async function compareMatricula({ imagesRoot, matricula, maxPages, tesseractSession, paddleSession, index, total }) {
  const normalized = normalizeMatricula(matricula);
  const files = await findMatriculaImages(imagesRoot, normalized);
  const orderedFiles = [...files].sort(naturalCompare).reverse();
  const allPages = await collectOcrPageImages(orderedFiles);
  const pageImages = maxPages > 0 ? allPages.slice(0, maxPages) : allPages;

  console.log('');
  console.log(`[${index + 1}/${total}] Matricula ${normalized.digits}: ${orderedFiles.length} arquivo(s), ${pageImages.length}/${allPages.length} pagina(s)`);

  const [tesseract, paddle] = await Promise.all([
    runEngine(tesseractSession, pageImages, normalized.digits),
    runEngine(paddleSession, pageImages, normalized.digits)
  ]);

  return {
    matricula: normalized.digits,
    files: orderedFiles,
    pageCount: pageImages.length,
    skippedPages: allPages.length - pageImages.length,
    tesseract,
    paddle,
    comparison: compareFields(tesseract.fields || {}, paddle.fields || {})
  };
}

async function runEngine(session, pageImages, matricula) {
  const started = Date.now();
  try {
    const pages = await session.recognizePageImages(pageImages);
    const text = pages.map((page) => page.text).join('\n\n');
    const fields = extractFields(text, matricula);
    return {
      ok: true,
      durationMs: Date.now() - started,
      pageCount: pages.length,
      charCount: text.length,
      failedPages: pages.filter((page) => page.error).length,
      fields: pickFields(fields)
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: error && error.message ? error.message : String(error),
      fields: {}
    };
  }
}

async function discoverMatriculas(imagesRoot) {
  const entries = await fs.readdir(imagesRoot, { withFileTypes: true });
  const buckets = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
    .map((entry) => path.join(imagesRoot, entry.name))
    .sort(naturalCompare);
  const numbers = new Set();

  for (const bucket of buckets) {
    const files = await collectImageFiles(bucket, 2);
    for (const file of files) {
      const digits = onlyDigits(path.basename(file, path.extname(file)));
      if (digits) numbers.add(String(Number.parseInt(digits, 10)));
    }
  }

  return [...numbers]
    .filter((value) => value !== 'NaN' && value !== '0')
    .sort((left, right) => Number(left) - Number(right));
}

async function collectImageFiles(dir, depth) {
  if (depth < 0) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectImageFiles(fullPath, depth - 1));
      continue;
    }
    if (entry.isFile() && isImage(entry.name)) files.push(fullPath);
  }

  return files;
}

function pickMatriculas(matriculas, limit) {
  if (matriculas.length <= limit) return matriculas;
  const selected = [];
  if (matriculas.includes('13171')) selected.push('13171');

  for (let index = 0; index < limit * 2 && selected.length < limit; index += 1) {
    const sourceIndex = Math.round((index * (matriculas.length - 1)) / Math.max(1, limit * 2 - 1));
    const value = matriculas[sourceIndex];
    if (value && !selected.includes(value)) selected.push(value);
  }

  for (const value of matriculas) {
    if (selected.length >= limit) break;
    if (!selected.includes(value)) selected.push(value);
  }

  return selected;
}

function pickFields(fields) {
  const picked = {};
  for (const key of FIELD_KEYS) {
    picked[key] = fields[key] || '';
  }
  picked.livroMatricula = fields.livroMatricula || '';
  picked.isClosed = Boolean(fields.isClosed);
  picked.hasTransferHints = Boolean(fields.hasTransferHints);
  return picked;
}

function compareFields(tesseract, paddle) {
  return FIELD_KEYS.map((key) => {
    const left = normalizeFieldValue(tesseract[key]);
    const right = normalizeFieldValue(paddle[key]);
    return {
      field: key,
      tesseract: tesseract[key] || '',
      paddle: paddle[key] || '',
      same: left === right
    };
  });
}

function printSummary(result, index, total) {
  const tesseractFilled = countFilled(result.tesseract.fields);
  const paddleFilled = countFilled(result.paddle.fields);
  const different = result.comparison.filter((item) => !item.same && (item.tesseract || item.paddle)).map((item) => item.field);
  const tesseractTime = formatSeconds(result.tesseract.durationMs);
  const paddleTime = formatSeconds(result.paddle.durationMs);
  const diffText = different.length ? ` dif: ${different.slice(0, 5).join(', ')}` : ' sem diferencas principais';

  console.log(`[${index + 1}/${total}] ${result.matricula} T=${tesseractTime}s (${tesseractFilled}/${FIELD_KEYS.length}) P=${paddleTime}s (${paddleFilled}/${FIELD_KEYS.length})${diffText}`);
}

function aggregateResults(results) {
  return results.reduce((summary, result) => {
    summary.tesseractFilled += countFilled(result.tesseract.fields);
    summary.paddleFilled += countFilled(result.paddle.fields);
    summary.totalFields += FIELD_KEYS.length;
    return summary;
  }, { tesseractFilled: 0, paddleFilled: 0, totalFields: 0 });
}

function progressLogger(prefix) {
  return (payload) => {
    if (!payload || !payload.message) return;
    if (/recognizing text|loading tesseract core|initializing tesseract/i.test(payload.message)) return;
    if (!/Paddle ONNX|Tesseract/i.test(payload.message)) return;
    process.stderr.write(`${prefix}: ${payload.message}\n`);
  };
}

function countFilled(fields) {
  return FIELD_KEYS.filter((key) => String(fields && fields[key] || '').trim()).length;
}

function normalizeFieldValue(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isImage(filePath) {
  return ['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.bmp', '.webp'].includes(path.extname(filePath).toLowerCase());
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function formatSeconds(ms) {
  return (Number(ms || 0) / 1000).toFixed(1);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
