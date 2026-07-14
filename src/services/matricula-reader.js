const fs = require('fs/promises');
const path = require('path');
const { createWorker } = require('tesseract.js');
const UTIF = require('utif');
const { PNG } = require('pngjs');

const IMAGE_EXTENSIONS = new Set(['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.bmp', '.webp']);

async function analyzeMatricula({ imagesRoot, matricula, settings, onProgress }) {
  const normalized = normalizeMatricula(matricula);
  if (!imagesRoot) {
    throw new Error('Escolha a pasta de imagens nas configuracoes.');
  }
  if (!normalized.digits) {
    throw new Error('Informe o numero da matricula.');
  }

  emit(onProgress, { stage: 'finding', message: 'Localizando imagens da matricula...' });
  const files = await findMatriculaImages(imagesRoot, normalized);

  if (!files.length) {
    return {
      matricula: normalized.digits,
      files: [],
      pages: [],
      text: '',
      fields: extractFields('', normalized.digits),
      warnings: ['Nenhum arquivo TIF/imagem encontrado para esta matricula.']
    };
  }

  const orderedFiles = [...files].sort(naturalCompare).reverse();
  const maxPages = Math.max(0, Number(settings.maxOcrPages || 0));
  const selectedFiles = maxPages > 0 ? orderedFiles.slice(0, maxPages) : orderedFiles;
  const skippedFiles = orderedFiles.length - selectedFiles.length;

  emit(onProgress, {
    stage: 'ocr-start',
    message: `OCR em ${selectedFiles.length} arquivo(s), do fim para o inicio...`
  });

  const pages = await ocrFiles(selectedFiles, settings, onProgress);
  const text = pages.map((page) => page.text).join('\n\n');
  const fields = extractFields(text, normalized.digits);
  const warnings = [];

  if (skippedFiles > 0) {
    warnings.push(`OCR limitado aos ${selectedFiles.length} arquivos mais recentes; ${skippedFiles} arquivo(s) ficaram fora do OCR.`);
  }
  if (fields.isClosed) {
    warnings.push('A leitura encontrou indicio de matricula encerrada. Revise antes de enviar.');
  }
  if (fields.hasTransferHints) {
    warnings.push('Foram encontrados indicios de transferencia/alienacao. Revise o proprietario atual.');
  }

  return {
    matricula: normalized.digits,
    files: orderedFiles,
    pages,
    text,
    fields,
    warnings
  };
}

async function findMatriculaImages(imagesRoot, normalized) {
  const root = path.resolve(imagesRoot);
  const bucket = normalized.bucket;
  const candidates = uniquePaths([
    path.join(root, bucket),
    path.join(root, normalized.padded),
    path.join(root, bucket, normalized.padded),
    path.join(root, bucket, normalized.digits),
    path.join(root, normalized.digits)
  ]);

  const found = [];
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const stat = await fs.stat(candidate);
    if (stat.isFile() && isImage(candidate) && imagePathMatches(candidate, normalized)) {
      found.push(candidate);
    }
    if (stat.isDirectory()) {
      const mode = exactMatriculaDir(candidate, normalized) ? 'all' : 'match';
      found.push(...await collectImages(candidate, normalized, mode, 3));
    }
  }

  if (!found.length) {
    const bucketDir = path.join(root, bucket);
    if (await exists(bucketDir)) {
      found.push(...await collectImages(bucketDir, normalized, 'match', 2));
    }
  }

  return uniquePaths(found);
}

async function collectImages(dir, normalized, mode, depth) {
  if (depth < 0) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childMode = exactMatriculaDir(fullPath, normalized) ? 'all' : mode;
      files.push(...await collectImages(fullPath, normalized, childMode, depth - 1));
      continue;
    }

    if (!entry.isFile() || !isImage(entry.name)) continue;
    if (mode === 'all' || imagePathMatches(fullPath, normalized)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function ocrFiles(files, settings, onProgress) {
  const language = settings.ocrLanguage || 'por+eng';
  const worker = await createWorker(language, 1, {
    logger: (message) => {
      if (message.status) {
        emit(onProgress, {
          stage: 'ocr-worker',
          message: `${message.status} ${Math.round((message.progress || 0) * 100)}%`
        });
      }
    }
  });

  const pages = [];
  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      emit(onProgress, {
        stage: 'ocr-file',
        message: `Lendo ${path.basename(file)} (${fileIndex + 1}/${files.length})`
      });

      const images = await imageBuffersForOcr(file);
      for (let pageIndex = images.length - 1; pageIndex >= 0; pageIndex -= 1) {
        const imageBuffer = images[pageIndex];
        const result = await worker.recognize(imageBuffer);
        pages.push({
          file,
          pageIndex,
          text: (result.data && result.data.text ? result.data.text : '').trim()
        });
      }
    }
  } finally {
    await worker.terminate();
  }

  return pages;
}

async function imageBuffersForOcr(file) {
  const ext = path.extname(file).toLowerCase();
  const buffer = await fs.readFile(file);
  if (ext !== '.tif' && ext !== '.tiff') return [buffer];

  const ifds = UTIF.decode(buffer);
  if (!ifds.length) return [];

  return ifds.map((ifd) => {
    UTIF.decodeImage(buffer, ifd);
    const rgba = Buffer.from(UTIF.toRGBA8(ifd));
    const png = new PNG({ width: ifd.width, height: ifd.height });
    rgba.copy(png.data);
    return PNG.sync.write(png);
  });
}

function extractFields(text, fallbackMatricula) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ');
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const currentOwner = extractCurrentOwner(normalizedText, lines);
  const matricula = fallbackMatricula || onlyDigits(firstMatch(normalizedText, /matr[ií]cula\D{0,16}(\d[\d.\-\/]{0,14}\d)/i));
  const allCpfCnpj = [...normalizedText.matchAll(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)]
    .map((match) => match[0])
    .filter(uniqueFilter)
    .join(', ');
  const cpfCnpj = currentOwner.cpfCnpj || allCpfCnpj;
  const cep = firstMatch(normalizedText, /\b(\d{5}-?\d{3})\b/);
  const car = firstMatch(normalizedText, /\b([A-Z]{2}-\d{7}-[A-Z0-9]{32,})\b/i);
  const ccir = firstMatch(normalizedText, /(?:CCIR|SNCR)\D{0,12}([\d.\-]{8,})/i);
  const sigef = firstMatch(normalizedText, /SIGEF\D{0,12}([a-f0-9-]{20,})/i);
  const snci = firstMatch(normalizedText, /SNCI\D{0,12}([\d.\-]{8,})/i);
  const cibNirf = firstMatch(normalizedText, /(?:CIB|NIRF)\D{0,12}([A-Z0-9.\-]{5,})/i);
  const rip = firstMatch(normalizedText, /RIP\D{0,12}(\d{5,})/i);
  const transcricao = firstMatch(normalizedText, /transcri[cç][aã]o\D{0,12}([A-Z0-9.\-\/]+)/i);
  const itbi = firstMatch(normalizedText, /ITBI\D{0,12}(?:R\$\s*)?([\d.]+,\d{2})/i);
  const dataMatricula = firstMatch(normalizedText, /(?:data\s+da\s+matr[ií]cula|abertura)\D{0,20}(\d{2}\/\d{2}\/\d{4})/i)
    || firstMatch(normalizedText, /\b(\d{2}\/\d{2}\/\d{4})\b/);
  const livro = firstMatch(normalizedText, /livro\D{0,8}([A-Z0-9.\-]+)/i);
  const folha = firstMatch(normalizedText, /folha\D{0,8}([A-Z0-9.\-]+)/i);
  const ownerLine = currentOwner.name || firstLine(lines, /(adquirente|outorgado|comprador|propriet[aá]rio|fiduciante)/i);
  const addressLine = findPropertyAddressLine(lines);
  const areaM2 = firstMatch(normalizedText, /(?:area|[aá]rea)\D{0,18}([\d.]+,\d{2})\s*m/i);
  const areaHa = firstMatch(normalizedText, /(?:area|[aá]rea)\D{0,18}([\d.]+,\d{2,4})\s*ha/i);

  return {
    matricula,
    dataMatricula,
    livroMatricula: livro,
    folhaMatricula: folha,
    nomeProprietario: cleanLabeledLine(ownerLine),
    cpfCnpj,
    endereco: cleanAddressLine(addressLine),
    cep,
    ccirSncr: ccir,
    snci,
    sigef,
    cibNirf,
    transcricao,
    car,
    rip,
    itbi,
    areaM2,
    areaHa,
    isClosed: /matr[ií]cula\s+encerrada|encerrad[ao]\s+a\s+matr[ií]cula|im[oó]vel\s+encerrado/i.test(normalizedText),
    hasTransferHints: /transfer[eê]ncia|alien[aç][aã]o|compra\s+e\s+venda|venda\s+e\s+compra|vendido|adquirente|transmitente|transmitiram|outorgante/i.test(normalizedText)
  };
}

function extractCurrentOwner(text, lines) {
  const patterns = [
    /transmitiram\s+o\s+im[oó]vel(?:\s+objeto\s+desta\s+matr[ií]cula)?\s+a\s+(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|\s*,\s*pelo\s+valor| pelo\s+valor)/i,
    /transmitiu\s+o\s+im[oó]vel(?:\s+objeto\s+desta\s+matr[ií]cula)?\s+a\s+(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|\s*,\s*pelo\s+valor| pelo\s+valor)/i,
    /adquirente[s]?\s*[:\-]?\s*(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|$)/i,
    /comprador(?:es)?\s*[:\-]?\s*(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const name = cleanPersonName(match[1]);
    const context = text.slice(match.index, match.index + 700);
    return {
      name,
      cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)
    };
  }

  const ownerLine = firstLine(lines, /(adquirente|comprador)/i);
  return {
    name: ownerLine ? cleanPersonName(cleanLabeledLine(ownerLine)) : '',
    cpfCnpj: ''
  };
}

function findPropertyAddressLine(lines) {
  return lines.find((line) => {
    return /(im[oó]vel|terreno|pr[eé]dio|apartamento|lote)/i.test(line)
      && /(endere[cç]o|situad[ao]|localizad[ao]|rua|avenida|rodovia|estrada|travessa)/i.test(line);
  }) || firstLine(lines, /(endere[cç]o|situad[ao]|localizad[ao])/i);
}

function normalizeMatricula(value) {
  const digits = onlyDigits(value);
  const number = Number.parseInt(digits || '0', 10);
  const bucketStart = number < 1000 ? 0 : Math.floor(number / 1000) * 1000;
  return {
    digits,
    number,
    padded: digits.padStart(8, '0'),
    bucket: String(bucketStart).padStart(8, '0')
  };
}

function imagePathMatches(filePath, normalized) {
  const base = path.basename(filePath, path.extname(filePath));
  const baseDigits = onlyDigits(base);
  if (baseDigits === normalized.digits || baseDigits === normalized.padded) return true;
  if (baseDigits.startsWith(normalized.padded)) return true;

  const escaped = normalized.digits.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(base);
}

function exactMatriculaDir(dir, normalized) {
  const name = path.basename(dir);
  const digits = onlyDigits(name);
  return digits === normalized.digits || digits === normalized.padded;
}

function isImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? String(match[1] || '').trim() : '';
}

function firstLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) || '';
}

function cleanLabeledLine(line) {
  return String(line || '')
    .replace(/^(propriet[aá]rio(?:s)?|adquirente(?:s)?|outorgado(?:s)?|comprador(?:es)?|endere[cç]o|situado|localizado)\s*[:\-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAddressLine(line) {
  const cleaned = cleanLabeledLine(line);
  const propertyStart = cleaned.match(/\b(?:um|uma|o|a)\s+(?:im[oó]vel|terreno|pr[eé]dio|apartamento|lote)\b.*$/i);
  if (propertyStart) return propertyStart[0].trim();
  return cleaned.replace(/^[^A-Za-z0-9]+/g, '').trim();
}

function cleanPersonName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|maior|menor)\b.*$/i, '')
    .replace(/[;,.]\s*$/g, '')
    .trim();
}

function naturalCompare(left, right) {
  return left.localeCompare(right, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

function uniquePaths(items) {
  return [...new Set(items.filter(Boolean).map((item) => path.resolve(item)))];
}

function uniqueFilter(value, index, array) {
  return array.indexOf(value) === index;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function emit(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

module.exports = {
  analyzeMatricula,
  findMatriculaImages,
  normalizeMatricula,
  extractFields
};
