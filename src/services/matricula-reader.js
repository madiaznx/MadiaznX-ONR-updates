const fs = require('fs/promises');
const path = require('path');
const { createWorker } = require('tesseract.js');
const UTIF = require('utif');
const { PNG } = require('pngjs');

const IMAGE_EXTENSIONS = new Set(['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const OCR_ENGINES = new Set(['paddle', 'tesseract']);
let paddleModulePromise = null;

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
  const engine = normalizeOcrEngine(settings.ocrEngine);

  emit(onProgress, {
    stage: 'ocr-start',
    message: `${ocrEngineLabel(engine)} em ${selectedFiles.length} arquivo(s), do fim para o inicio...`
  });

  const pages = await ocrFiles(selectedFiles, settings, onProgress);
  const text = pages.map((page) => page.text).join('\n\n');
  const fields = extractFields(text, normalized.digits);
  const warnings = [];

  if (skippedFiles > 0) {
    warnings.push(`OCR limitado aos ${selectedFiles.length} arquivos mais recentes; ${skippedFiles} arquivo(s) ficaram fora do OCR.`);
  }
  const failedPages = pages.filter((page) => page.error);
  if (failedPages.length) {
    warnings.push(`${failedPages.length} pagina(s) falharam no ${ocrEngineLabel(engine)}. Revise a leitura antes de enviar.`);
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
    engine,
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

async function ocrFiles(files, settings = {}, onProgress) {
  const engine = normalizeOcrEngine(settings.ocrEngine);
  return engine === 'paddle'
    ? ocrFilesWithPaddle(files, settings, onProgress)
    : ocrFilesWithTesseract(files, settings, onProgress);
}

async function ocrFilesWithTesseract(files, settings = {}, onProgress) {
  const pageImages = await collectOcrPageImages(files, onProgress);
  const session = await createTesseractOcrSession(settings, onProgress);
  try {
    return await session.recognizePageImages(pageImages, onProgress);
  } finally {
    await session.destroy();
  }
}

async function ocrFilesWithPaddle(files, settings = {}, onProgress) {
  const pageImages = await collectOcrPageImages(files, onProgress);
  const session = await createPaddleOcrSession(settings, onProgress);
  try {
    return await session.recognizePageImages(pageImages, onProgress);
  } finally {
    await session.destroy();
  }
}

async function collectOcrPageImages(files, onProgress) {
  const pages = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    emit(onProgress, {
      stage: 'ocr-file',
      message: `Preparando ${path.basename(file)} (${fileIndex + 1}/${files.length})`
    });

    const images = await imageBuffersForOcr(file);
    for (let pageIndex = images.length - 1; pageIndex >= 0; pageIndex -= 1) {
      pages.push({
        file,
        fileIndex,
        pageIndex,
        imageBuffer: images[pageIndex]
      });
    }
  }

  return pages;
}

async function createTesseractOcrSession(settings = {}, onProgress) {
  const language = settings.ocrLanguage || 'por+eng';
  const workerCount = clampInteger(settings.tesseractWorkers || settings.ocrWorkers, 1, 8, 1);
  emit(onProgress, {
    stage: 'ocr-tesseract-init',
    message: `Carregando ${workerCount} worker(s) Tesseract...`
  });
  const workers = await Promise.all(Array.from({ length: workerCount }, (_unused, index) => createTesseractWorker(language, onProgress, index + 1)));

  return {
    engine: 'tesseract',
    async recognizePageImages(pageImages, progressCallback = onProgress) {
      const pages = new Array(pageImages.length);
      let nextIndex = 0;

      async function runWorker(worker, workerNumber) {
        while (nextIndex < pageImages.length) {
          const index = nextIndex;
          nextIndex += 1;
          const page = pageImages[index];
          emit(progressCallback, {
            stage: 'ocr-page',
            message: `Tesseract W${workerNumber} ${path.basename(page.file)} pagina ${page.pageIndex + 1} (${index + 1}/${pageImages.length})`
          });

          const result = await worker.recognize(page.imageBuffer);
          pages[index] = {
            file: page.file,
            pageIndex: page.pageIndex,
            engine: 'tesseract',
            text: (result.data && result.data.text ? result.data.text : '').trim()
          };
        }
      }

      await Promise.all(workers.map((worker, index) => runWorker(worker, index + 1)));
      return pages.filter(Boolean);
    },
    async destroy() {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  };
}

async function createTesseractWorker(language, onProgress, workerNumber) {
  const worker = await createWorker(language, 1, {
    logger: (message) => {
      if (message.status) {
        emit(onProgress, {
          stage: 'ocr-worker',
          message: `Tesseract W${workerNumber}: ${message.status} ${Math.round((message.progress || 0) * 100)}%`
        });
      }
    }
  });

  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300'
  });

  return worker;
}

async function createPaddleOcrSession(settings = {}, onProgress) {
  const paddle = await loadPaddleModule();
  const model = paddleModelPreset(paddle, settings.paddleModel);
  const strategy = normalizePaddleStrategy(settings.paddleStrategy);
  const maxSideLength = clampInteger(settings.paddleMaxSideLength, 640, 2560, 1280);
  const processingEngine = normalizePaddleProcessingEngine(settings.paddleProcessingEngine);
  const service = new paddle.PaddleOcrService({
    model,
    detection: { maxSideLength },
    recognition: { strategy },
    processing: { engine: processingEngine },
    session: {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    },
    debugging: {
      verbose: Boolean(settings.paddleVerbose)
    }
  });

  emit(onProgress, {
    stage: 'ocr-paddle-init',
    message: `Carregando Paddle ONNX (${normalizePaddleModel(settings.paddleModel)})...`
  });
  await service.initialize();

  return {
    engine: 'paddle',
    async recognizePageImages(pageImages, progressCallback = onProgress) {
      if (!pageImages.length) return [];
      emit(progressCallback, {
        stage: 'ocr-paddle-start',
        message: `Paddle ONNX em ${pageImages.length} pagina(s)...`
      });

      const pages = [];
      for (let index = 0; index < pageImages.length; index += 1) {
        const page = pageImages[index];
        emit(progressCallback, {
          stage: 'ocr-paddle-page',
          message: `Paddle ONNX ${path.basename(page.file)} pagina ${page.pageIndex + 1} (${index + 1}/${pageImages.length})`
        });

        try {
          const result = await service.recognize(toArrayBuffer(page.imageBuffer), {
            noCache: true,
            flatten: true,
            strategy
          });
          pages.push({
            file: page.file,
            pageIndex: page.pageIndex,
            engine: 'paddle',
            confidence: result && result.confidence,
            text: (result && result.text ? result.text : '').trim()
          });
        } catch (error) {
          pages.push({
            file: page.file,
            pageIndex: page.pageIndex,
            engine: 'paddle',
            text: '',
            error: error && error.message ? error.message : String(error || 'Falha no Paddle ONNX')
          });
        }
      }

      return pages;
    },
    async destroy() {
      await service.destroy();
    }
  };
}

async function loadPaddleModule() {
  if (!paddleModulePromise) {
    paddleModulePromise = import('ppu-paddle-ocr');
  }
  return paddleModulePromise;
}

async function imageBuffersForOcr(file) {
  const ext = path.extname(file).toLowerCase();
  const buffer = await fs.readFile(file);
  if (ext !== '.tif' && ext !== '.tiff') return [buffer];

  const ifds = UTIF.decode(buffer);
  if (!ifds.length) return [];

  const images = [];
  for (const ifd of ifds) {
    try {
      UTIF.decodeImage(buffer, ifd);
      const rgbaData = UTIF.toRGBA8(ifd);
      if (!rgbaData || !ifd.width || !ifd.height) continue;
      const rgba = Buffer.from(rgbaData);
      const png = new PNG({ width: ifd.width, height: ifd.height });
      rgba.copy(png.data);
      images.push(PNG.sync.write(png));
    } catch {
      // Some legacy TIF pages have broken strips; keep reading the remaining pages.
    }
  }

  return images;
}

function extractFields(text, fallbackMatricula) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ');
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const currentOwner = extractCurrentOwner(normalizedText, lines);
  const matricula = fallbackMatricula || onlyDigits(firstMatch(normalizedText, /matr[ií]cula\D{0,16}(\d[\d.\-\/]{0,14}\d)/i));
  const nearbyOwnerCpfCnpj = findCpfCnpjNearOwner(normalizedText, currentOwner.name);
  const legalEntityCnpj = /\bCAIXA\b/i.test(currentOwner.name)
    ? firstMatch(normalizedText, /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)
    : '';
  const cep = firstMatch(normalizedText, /\b(\d{5}-?\d{3})\b/);
  const car = firstMatch(normalizedText, /\b([A-Z]{2}-\d{7}-[A-Z0-9]{32,})\b/i);
  const ccir = firstMatch(normalizedText, /(?:CCIR|SNCR)\D{0,12}([\d.\-]{8,})/i);
  const sigef = firstMatch(normalizedText, /SIGEF\D{0,12}([a-f0-9-]{20,})/i);
  const snci = firstMatch(normalizedText, /SNCI\D{0,12}([\d.\-]{8,})/i);
  const cibNirf = firstMatch(normalizedText, /(?:CIB|NIRF)\D{0,12}([A-Z0-9.\-]{5,})/i);
  const rip = firstMatch(normalizedText, /RIP\D{0,12}(\d{5,})/i);
  const transcricao = firstMatch(normalizedText, /transcri[cç][aã]o\D{0,12}([A-Z0-9.\-\/]+)/i);
  const itbi = firstMatch(normalizedText, /ITBI\D{0,12}(?:R\$\s*)?([\d.]+,\d{2})/i);
  const dataMatricula = extractOpeningDate(normalizedText);
  const livro = '2';
  const folha = firstMatch(normalizedText, /folha\D{0,8}([A-Z0-9.\-]+)/i);
  const ownerLine = currentOwner.name || firstLine(lines, /(adquirente|outorgado|comprador|propriet[aá]ri[ao]s?|fiduciante)/i);
  const ownerName = cleanPersonName(cleanLabeledLine(ownerLine));
  const ownerLooksLegal = isLikelyLegalEntityName(ownerName || currentOwner.name);
  const currentOwnerDocument = cleanOwnerDocumentForDisplay(currentOwner.cpfCnpj, ownerLooksLegal);
  const nearbyOwnerDocument = cleanOwnerDocumentForDisplay(nearbyOwnerCpfCnpj, ownerLooksLegal);
  const ownerNameDocument = cleanOwnerDocumentForDisplay(findCpfCnpjNearOwner(normalizedText, ownerName), ownerLooksLegal);
  const displayCpfCnpj = currentOwnerDocument
    || ownerNameDocument
    || nearbyOwnerDocument
    || (ownerLooksLegal ? legalEntityCnpj : '');
  const propertyAddress = extractPropertyAddress(normalizedText, lines);
  const propertyProfile = extractPropertyProfile(normalizedText, lines);
  const cadastroRegistro = extractCadastroRegistro(normalizedText);
  const areaM2 = firstMatch(normalizedText, /(?:area|[aá]rea)\D{0,18}([\d.]+,\d{2})\s*m/i);
  const areaHa = firstMatch(normalizedText, /(?:area|[aá]rea)\D{0,18}([\d.]+,\d{2,4})\s*ha/i);

  return {
    matricula,
    dataMatricula,
    livroMatricula: livro,
    folhaMatricula: folha,
    cadastroRegistro,
    nomeProprietario: isSuspectOwnerName(ownerName) ? '' : ownerName,
    cpfCnpj: displayCpfCnpj,
    endereco: propertyAddress.endereco,
    numeroImovel: propertyAddress.numeroImovel,
    tipoImovel: propertyProfile.tipoImovel,
    nomeImovel: propertyProfile.nomeImovel,
    cep: propertyAddress.cep || cep,
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
    isClosed: /matr[ií]cula\s+encerrada|encerrad[ao]\s+(?:a|esta)\s+matr[ií]cula|ficando\s+em\s+consequ[eê]ncia\s+encerrada\s+esta\s+matr[ií]cula|im[oó]vel\s+encerrado/i.test(normalizedText),
    hasTransferHints: /transfer[eê]ncia|alien[aç][aã]o|compra\s+e\s+venda|venda\s+e\s+compra|vendido|adquirente|transmitente|transmitiram|outorgante/i.test(normalizedText)
  };
}

function extractOpeningDate(text) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const explicitDate = firstMatch(value, /(?:data\s+da\s+matr[ií]cula|abertura)\D{0,30}(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (explicitDate) return normalizeSlashDate(explicitDate);

  const headerDate = extractOpeningHeaderDate(value);
  if (headerDate) return headerDate;

  return '';
}

function extractOpeningHeaderDate(text) {
  const value = String(text || '');
  const candidates = [];
  const monthNames = 'janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
  const patterns = [
    new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${monthNames})\\s+(?:de\\s+)?(\\d{4})\\b`, 'gi'),
    new RegExp(`\\b(\\d{1,2})\\s+(?:[a-zç]{1,8}\\s+)?(\\d{4})\\s+(${monthNames})\\b`, 'gi')
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const month = monthNumber(match[2]) || monthNumber(match[3]);
      const year = /^\d{4}$/.test(match[2]) ? match[2] : match[3];
      const date = formatDateParts(match[1], month, year);
      if (!date) continue;

      const before = value.slice(Math.max(0, match.index - 450), match.index);
      const after = value.slice(match.index, match.index + 450);
      const beforeSearch = textForSearch(before);
      const afterSearch = textForSearch(after);
      const contextSearch = `${beforeSearch} ${afterSearch}`;
      let score = 0;

      const hasHeaderSignal = /(matricula\s+ficha|cns|livro\s+n|registro\s+geral|oficial\s+de\s+registro\s+de\s+imoveis)/i.test(contextSearch);
      if (hasHeaderSignal) score += 5;
      if (hasHeaderSignal && /\bimovel\b/.test(afterSearch)) score += 2;
      if (/\b(?:av|r)\.?\s*[-:]?\s*\d{1,4}\b|protocolo|escritura|averbacao|registro\s+anterior/i.test(beforeSearch)) score -= 8;

      candidates.push({ date, index: match.index, score });
    }
  }

  const dayMonthPattern = new RegExp(`\\b(\\d{1,2})\\b[^;\\n]{0,90}?\\b(${monthNames})\\b`, 'gi');
  for (const match of value.matchAll(dayMonthPattern)) {
    const beforeDay = value[match.index - 1] || '';
    const afterDay = value[match.index + String(match[1]).length] || '';
    if (/[.\-\/\d]/.test(beforeDay) || /[.\-\/\d]/.test(afterDay)) continue;

    const year = nearestYearAround(value, match.index, 140);
    const date = formatDateParts(match[1], monthNumber(match[2]), year);
    if (!date) continue;

    const before = value.slice(Math.max(0, match.index - 450), match.index);
    const after = value.slice(match.index, match.index + 450);
    const beforeSearch = textForSearch(before);
    const afterSearch = textForSearch(after);
    const contextSearch = `${beforeSearch} ${afterSearch}`;
    let score = 0;

    const hasHeaderSignal = /(matricula\s+ficha|cns|livro\s+n|registro\s+geral|oficial\s+de\s+registro\s+de\s+imoveis)/i.test(contextSearch);
    if (hasHeaderSignal) score += 4;
    if (hasHeaderSignal && /\bimovel\b/.test(afterSearch)) score += 2;
    if (/\b(?:av|r)\.?\s*[-:]?\s*\d{1,4}\b|protocolo|escritura|averbacao|registro\s+anterior/i.test(beforeSearch)) score -= 8;

    candidates.push({ date, index: match.index, score });
  }

  const monthOnlyPattern = new RegExp(`\\b(${monthNames})\\b`, 'gi');
  for (const match of value.matchAll(monthOnlyPattern)) {
    const prefixStart = Math.max(0, match.index - 100);
    const prefix = value.slice(prefixStart, match.index);
    const dayCandidates = [...prefix.matchAll(/\b(\d{1,2})\b/g)]
      .map((dayMatch) => ({
        day: dayMatch[1],
        index: prefixStart + dayMatch.index
      }))
      .filter((candidate) => {
        const beforeDay = value[candidate.index - 1] || '';
        const afterDay = value[candidate.index + String(candidate.day).length] || '';
        const dayNumber = Number.parseInt(candidate.day, 10);
        return dayNumber >= 1 && dayNumber <= 31 && !/[.\-\/\d]/.test(beforeDay) && !/[.\-\/\d]/.test(afterDay);
      });
    const dayCandidate = dayCandidates[dayCandidates.length - 1];
    if (!dayCandidate) continue;

    const year = nearestYearAround(value, dayCandidate.index, 160) || nearestYearAround(value, match.index, 160);
    const date = formatDateParts(dayCandidate.day, monthNumber(match[1]), year);
    if (!date) continue;

    const before = value.slice(Math.max(0, dayCandidate.index - 450), dayCandidate.index);
    const after = value.slice(dayCandidate.index, dayCandidate.index + 450);
    const beforeSearch = textForSearch(before);
    const afterSearch = textForSearch(after);
    const contextSearch = `${beforeSearch} ${afterSearch}`;
    let score = 0;

    const hasHeaderSignal = /(matricula\s+ficha|cns|livro\s+n|registro\s+geral|oficial\s+de\s+registro\s+de\s+imoveis)/i.test(contextSearch);
    if (hasHeaderSignal) score += 4;
    if (hasHeaderSignal && /\bimovel\b/.test(afterSearch)) score += 2;
    if (/\b(?:av|r)\.?\s*[-:]?\s*\d{1,4}\b|protocolo|escritura|averbacao|registro\s+anterior/i.test(beforeSearch)) score -= 8;

    candidates.push({ date, index: dayCandidate.index, score });
  }

  candidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return right.index - left.index;
  });

  return candidates.length && candidates[0].score > 0 ? candidates[0].date : '';
}

function nearestYearAround(text, index, distance) {
  const value = String(text || '');
  const start = Math.max(0, index - distance);
  const window = value.slice(start, index + distance);
  const years = [...window.matchAll(/\b(19\d{2}|20\d{2})\b/g)]
    .map((match) => ({
      year: match[1],
      distance: Math.abs((start + match.index) - index)
    }))
    .sort((left, right) => left.distance - right.distance);
  return years.length ? years[0].year : '';
}

function monthNumber(value) {
  const months = {
    janeiro: '01',
    fevereiro: '02',
    marco: '03',
    abril: '04',
    maio: '05',
    junho: '06',
    julho: '07',
    agosto: '08',
    setembro: '09',
    outubro: '10',
    novembro: '11',
    dezembro: '12'
  };
  return months[textForSearch(value)];
}

function formatDateParts(day, month, year) {
  const dayNumber = Number.parseInt(day, 10);
  if (!Number.isFinite(dayNumber) || dayNumber < 1 || dayNumber > 31) return '';
  const dd = String(dayNumber).padStart(2, '0');
  const yyyy = String(year || '').trim();
  if (!month || !/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(dd)) return '';
  return `${dd}/${month}/${yyyy}`;
}

function normalizeSlashDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!match) return '';
  return formatDateParts(match[1], String(Number.parseInt(match[2], 10)).padStart(2, '0'), match[3]);
}

function extractCurrentOwner(text, lines) {
  const latestOwner = extractLatestOwnerFromActs(text);
  if (latestOwner.name) return latestOwner;

  const patterns = [
    /tendo\s+passado\s+a\s+ostentar\s+a\s+denomina[cç][aã]o\s+de\s+(.+?)(?:\.|,|;)/i,
    /propriet[aá]ri[ao]s?\s*[:\-]\s*(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|NIRE|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;)/i,
    /doou[^.]{0,320}?(?:à|á|a)\s+(.+?)(?:,\s*CNPJ|,\s*CPF|,\s*RG|\.|;)/i,
    /(?:transmitiram|transmitiu|vendeu|venderam|doou|doaram|cedeu|cederam|alienou|alienaram)[^.]{0,520}?\s+[aàá]\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\s+pelo\s+valor|\.|;)/i,
    /transmitiram\s+o\s+im[oó]vel(?:\s+objeto\s+desta\s+matr[ií]cula)?\s+a\s+(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|\s*,\s*pelo\s+valor| pelo\s+valor)/i,
    /transmitiu\s+o\s+im[oó]vel(?:\s+objeto\s+desta\s+matr[ií]cula)?\s+a\s+(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|\s*,\s*pelo\s+valor| pelo\s+valor)/i,
    /adquirente[s]?\s*[:\-]?\s*(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|$)/i,
    /comprador(?:es)?\s*[:\-]?\s*(.+?)(?:,\s*RG|\s*,\s*CPF|\s*,\s*brasileir[ao]|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const name = cleanPersonName(match[1]);
    if (isSuspectOwnerName(name)) continue;
    const context = text.slice(match.index, match.index + 700);
    return {
      name,
      cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)
    };
  }

  const ownerLine = firstLine(lines, /(adquirente|comprador|propriet[aá]ri[ao]s?)/i);
  const fallbackOwner = ownerLine ? cleanPersonName(cleanLabeledLine(ownerLine)) : '';
  return {
    name: isSuspectOwnerName(fallbackOwner) ? '' : fallbackOwner,
    cpfCnpj: ''
  };
}

function extractLatestOwnerFromActs(text) {
  const value = String(text || '');
  const fiduciaryOwner = extractFiduciaryFullOwner(value);
  if (fiduciaryOwner.name) return fiduciaryOwner;

  const candidates = [];
  const patterns = [
    /tendo\s+passado\s+a\s+ostentar\s+a\s+denomina[cç][aã]o\s+de\s+(.+?)(?:\.|,|;)/gi,
    /propriet[aá]ri[ao]s?\s*[:\-]\s*(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|NIRE|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;)/gi,
    /credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*(?:j[aá]\s+qualificad[ao]|CNPJ|CPF|RG)|\s+passa\s+a\s+deter|\.)[^.]{0,260}?passa\s+a\s+deter\s+a\s+propriedade\s+plena/gi,
    /passa\s+a\s+deter\s+a\s+propriedade\s+plena[^.]{0,260}?credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*(?:j[aá]\s+qualificad[ao]|CNPJ|CPF|RG)|\.|;)/gi,
    /usucapi[aã]o.{0,700}?requerid[ao]\s+por\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;)/gi,
    /(?:doou|doaram)\s+(?:ao|aos|[a\u00e0\u00e1])\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|CNPJ\/MF|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao]|com\s+sede)|\s+o\s+im[oó]vel|\.|;)/gi,
    /(?:transmitiram|transmitiu|vendeu|venderam|doou|doaram|cedeu|cederam|alienou|alienaram).{0,520}?\s+[a\u00e0\u00e1]\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|CNPJ\/MF|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\s+pelo\s+valor|\.|;)/gi,
    /(?:adquirente[s]?|comprador(?:es)?|donat[aá]ri[ao]s?|cession[aá]ri[ao]s?)\s*[:\-]?\s*(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;|$)/gi,
    /(?:passa(?:m)?\s+a\s+pertencer|fica(?:m)?\s+pertencendo)\s+a\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;)/gi
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const name = cleanPersonName(match[1]);
      if (isSuspectOwnerName(name)) continue;
      const context = value.slice(match.index, match.index + 320);
      candidates.push({
        name,
        cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/),
        index: match.index,
        act: actNumberBefore(value, match.index)
      });
    }
  }

  candidates.sort((left, right) => {
    if (left.act !== right.act) {
      if (left.act == null) return 1;
      if (right.act == null) return -1;
      return right.act - left.act;
    }
    return left.index - right.index;
  });
  return candidates[0] || { name: '', cpfCnpj: '' };
}

function extractFiduciaryFullOwner(text) {
  const value = String(text || '');
  const match = value.match(/fica\s+consolidad[ao]\s+a\s+propriedade[^.]{0,260}?na\s+pessoa\s+d[ao]\s+credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*j[aá]\s+qualificad[ao]|,\s*CNPJ|,\s*CPF|,\s*RG|\.|;)/i)
    || value.match(/credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*j[aá]\s+qualificad[ao]|,\s*CNPJ|,\s*CPF|,\s*RG)[^.]{0,420}?passa\s+a\s+deter\s+a\s+propriedade\s+plena/i);
  if (!match) return { name: '', cpfCnpj: '' };

  const name = cleanPersonName(match[1]);
  if (isSuspectOwnerName(name)) return { name: '', cpfCnpj: '' };
  const context = value.slice(match.index, match.index + 900);
  return {
    name,
    cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)
  };
}

function isSuspectOwnerName(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 4 || text.length > 150) return true;
  if (/^ASSOCIA/i.test(text)) return false;
  if (/^(?:do\s+loteamento|loteamento)\b/i.test(text)) return true;
  return /(^[,.;:]|doa[cç][aã]o\s+foi\s+feita|em\s+cumprimento\s+ao\s+decreto|pelo instrumento|propriet[aá]ri[ao]s?|p[aá]ginas?|faleceu|e a seus sucessores|selo digital|artigo|dever[aá]|leil[oõ]es|certid[aã]o|matr[ií]cula de origem|todos aqueles indicados|foram pagos|recursos pr[oó]prios|saldo devedor|direitos decorrentes|do im[oó]vel|na propor[cç][aã]o|valor de R\$|residente|domiciliad|^e\s+R\$|R\$-\d|RG\s*n|CPF\/?MF?\s*n)/i.test(text);
}

function isLikelyLegalEntityName(value) {
  if (/\bASSOCIA/i.test(String(value || ''))) return true;
  return /\b(CAIXA|BANCO|COOPERATIVA|ASSOCIACAO|ASSOCIAÇÃO|EMPRESA|LTDA|S\.?A\.?|EIRELI|FEDERAL|MUNICIPIO|MUNICÍPIO|ESTADO)\b/i.test(String(value || ''));
}

function findCpfCnpjNearOwner(text, ownerName) {
  const name = String(ownerName || '').trim();
  if (!name || isSuspectOwnerName(name)) return '';

  const index = String(text || '').indexOf(name);
  if (index < 0) return '';
  const context = String(text || '').slice(index, index + 650);
  const cpf = firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/);
  const cnpj = firstMatch(context, /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/);
  return isLikelyLegalEntityName(name) ? (cnpj || cpf) : cpf;
}

function isCnpjDocument(value) {
  return /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(value || '').trim());
}

function cleanOwnerDocumentForDisplay(value, ownerLooksLegal) {
  const text = String(value || '').trim();
  if (!text) return '';

  const docs = text.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g) || [];
  if (docs.length !== 1) return '';

  const doc = docs[0];
  if (ownerLooksLegal && !isCnpjDocument(doc)) return '';
  if (!ownerLooksLegal && isCnpjDocument(doc)) return '';
  return doc;
}

function extractPropertyProfile(text, lines) {
  const openingDescription = extractOpeningPropertyDescription(text);
  const addressContexts = [
    ...collectPropertyAddressContexts(text, lines),
    ...collectPropertyAddressFallbackContexts(text, lines)
  ];
  const propertyContext = [openingDescription, ...addressContexts].filter(Boolean).join(' ');

  return {
    tipoImovel: inferPropertyType(propertyContext, text),
    nomeImovel: extractPropertyName(text, openingDescription)
  };
}

function inferPropertyType(propertyContext, fullText) {
  const context = textForSearch(propertyContext);
  const allText = textForSearch(fullText);

  if (/\b(?:apartamento|apto)\b/.test(context)) return 'Apto';
  if (/\b(?:sala|conjunto)\b/.test(context)) return 'Sala/Conjunto';
  if (/\bloja\b/.test(context)) return 'Loja';
  if (/\bgalpao\b/.test(context)) return 'Galpao';
  if (/\b(?:fazenda|sitio|chacara)\b/.test(context)) return 'Fazenda/Sitio/Chacara';
  if (/\bpredio\s+comercial\b/.test(context)) return 'Predio Comercial';
  if (/\bpredio\s+residencial\b/.test(context)) return 'Predio Residencial';
  if (hasConstructionNumberAct(allText)) return 'Predio Residencial';
  if (/\b(?:casa|residencia)\b/.test(context)) return 'Casa';
  return 'Terreno/fracao';
}

function hasConstructionNumberAct(searchText) {
  const value = String(searchText || '');
  const constructionPatterns = [
    /\b(?:av|averbacao)\b.{0,140}\bconstrucao\b.{0,260}\b(?:recebeu|numero\s+predial|numeracao\s+predial|sob\s+n[o.]?|n[o.]?)\b/i,
    /\bconstrucao\b.{0,260}\b(?:recebeu|numero\s+predial|numeracao\s+predial|sob\s+n[o.]?|n[o.]?)\b/i,
    /\b(?:recebeu|passou\s+a\s+ter)\b.{0,120}\b(?:numero\s+predial|n[o.]?)\b.{0,180}\bconstrucao\b/i
  ];
  return constructionPatterns.some((pattern) => pattern.test(value));
}

function extractPropertyName(text, openingDescription) {
  const value = String(text || '');
  const contexts = [
    String(openingDescription || ''),
    ...collectDenominationContexts(value)
  ].filter(Boolean);
  const candidates = [];

  for (const context of contexts) {
    if (isLotOrStreetDenomination(context)) continue;
    const patterns = [
      /\b(?:im[oó]vel|terreno|[aá]rea|gleba|ch[aá]cara|s[ií]tio|fazenda|propriedade|pr[eé]dio|casa)\b[^.;\n]{0,140}?\bdenominad[ao]\s+["“”']?([^".;,\n]{3,100})/gi,
      /\bpassou\s+a\s+denominar-se\s+["“”']?([^".;,\n]{3,100})/gi,
      /\bdenomina[cç][aã]o\b(?!\s+de\s+logradouro)[^.;\n]{0,220}?\b(?:denominad[ao]|denominar-se)\s+["“”']?([^".;,\n]{3,100})/gi
    ];

    for (const pattern of patterns) {
      for (const match of context.matchAll(pattern)) {
        const name = cleanPropertyName(match[1]);
        if (!name || isSuspectPropertyName(name, context)) continue;
        candidates.push({
          name,
          act: actNumberBefore(value, value.indexOf(context)),
          index: value.indexOf(context)
        });
      }
    }
  }

  candidates.sort((left, right) => {
    if (left.act !== right.act) {
      if (left.act == null) return 1;
      if (right.act == null) return -1;
      return right.act - left.act;
    }
    return right.index - left.index;
  });

  return candidates.length ? candidates[0].name : '';
}

function collectDenominationContexts(text) {
  const contexts = [];
  const patterns = [
    /(?:averba[cç][aã]o|av\.)[^.]{0,120}\bdenomina[cç][aã]o\b[^.]{0,420}/gi,
    /\b(?:im[oó]vel|terreno|[aá]rea|gleba|ch[aá]cara|s[ií]tio|fazenda|propriedade|pr[eé]dio|casa)\b[^.]{0,260}\bdenominad[ao]\b[^.]{0,260}/gi,
    /\bpassou\s+a\s+denominar-se\b[^.]{0,260}/gi
  ];

  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const context = sentenceAround(text, match.index).replace(/\s+/g, ' ').trim();
      if (context && !contexts.includes(context)) contexts.push(context);
    }
  }

  return contexts;
}

function extractOpeningPropertyDescription(text) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const match = value.match(/\bim[oó]vel\s*[:\-]\s*(.+?)(?=\b(?:registro\s+anterior|contribuinte|r\.?\s*0?1|av\.?\s*0?1|selo\s+digital|oficial)\b|$)/i);
  return match ? match[1].trim() : '';
}

function isLotOrStreetDenomination(value) {
  const search = textForSearch(value);
  return /denominacao\s+de\s+logradouro|logradouro|rua|avenida|travessa|alameda|praca/.test(search)
    || /\bloteamento\b.{0,100}\bdenominad/.test(search)
    || /\bdenominad[ao]\b.{0,100}\bloteamento\b/.test(search)
    || /\b(?:do|no|integrante\s+do)\s+loteamento\b/.test(search);
}

function cleanPropertyName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:de|do|da|o|a)\s+/i, '')
    .replace(/\s+(?:situad[ao]|localizad[ao]|com\s+frente|objeto|matr[ií]cula|cadastro|confrontando|medindo|com\s+[aá]rea)\b.*$/i, '')
    .replace(/["“”'.,;:]$/g, '')
    .trim();
}

function isSuspectPropertyName(name, context) {
  const value = textForSearch(name);
  const contextSearch = textForSearch(context);
  if (!value || value.length < 3 || value.length > 100) return true;
  if (/^(?:rua|avenida|travessa|alameda|praca|loteamento|bairro|quadra|lote)\b/.test(value)) return true;
  if (/^(?:um|uma|o|a|imovel|terreno|area|gleba|predio|casa)$/.test(value)) return true;
  if (/denominacao\s+de\s+logradouro|logradouro/.test(contextSearch)) return true;
  if (/\bloteamento\b/.test(contextSearch) && !/\b(?:imovel|propriedade|fazenda|sitio|chacara|gleba)\b/.test(contextSearch)) return true;
  return false;
}

function extractPropertyAddress(text, lines) {
  const contexts = collectPropertyAddressContexts(text, lines);
  for (const fallbackContext of collectPropertyAddressFallbackContexts(text, lines)) {
    if (!contexts.includes(fallbackContext)) contexts.push(fallbackContext);
  }
  let endereco = '';
  let numeroImovel = '';
  let cep = '';

  for (const context of contexts) {
    if (!numeroImovel) {
      numeroImovel = extractPropertyNumber(context);
    }
    if (!endereco) {
      endereco = extractStreetAddress(context);
    }
    if (!cep) {
      cep = firstMatch(context, /\b(\d{5}-?\d{3})\b/);
    }
    if (endereco && numeroImovel && cep) break;
  }

  const split = splitAddressNumber(endereco);
  return {
    endereco: cleanStreetAddress(split.endereco || endereco),
    numeroImovel,
    cep
  };
}

function collectPropertyAddressContexts(text, lines) {
  const contexts = [];
  const contextPatterns = [
    /(?:averba[cç][aã]o|av\.)\D{0,100}(?:denomina[cç][aã]o\s+de\s+logradouro|logradouro|(?:n[uú]mero|numero)\s+(?:predial|do\s+im[oó]vel)|numera[cç][aã]o\s+predial|constru[cç][aã]o|recebeu\s+(?:o\s+)?(?:n[ºo°?.]?|n[uú]mero|numero))[^.]{0,420}/gi,
    /(?:denomina[cç][aã]o\s+de\s+logradouro|passou\s+a\s+denominar-se|logradouro\s+(?:p[uú]blico\s+)?denominado)[^.]{0,420}/gi,
    /(?:(?:n[uú]mero|numero)\s+do\s+im[oó]vel|numera[cç][aã]o\s+predial)[^.]{0,320}/gi,
    /(?:constru[cç][aã]o|pr[eé]dio|casa|galp[aã]o|apartamento|terreno|lote)[^.]{0,360}(?:situad[ao]|localizad[ao]|com\s+frente\s+para|frente\s+para|sob\s+n[ºo°?.]?|recebeu\s+(?:o\s+)?(?:n[ºo°?.]?|n[uú]mero|numero))[^.]{0,420}/gi
  ];

  for (const pattern of contextPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (hasPersonalResidenceTerm(sentenceAround(text, match.index))) continue;
      addPropertyContext(contexts, match[0]);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isPropertyAddressLine(line)) continue;
    addPropertyContext(contexts, [lines[index - 1], line, lines[index + 1], lines[index + 2]].filter(Boolean).join(' '));
  }

  return contexts;
}

function addPropertyContext(contexts, value) {
  const context = String(value || '').replace(/\s+/g, ' ').trim();
  if (hasPersonalResidenceTerm(context)) return;
  const scoped = propertyContextSlice(context) || context;
  if (!scoped || isOwnerQualificationContext(scoped)) return;
  if (!contexts.includes(scoped)) contexts.push(scoped);
}

function isPropertyAddressLine(line) {
  const value = String(line || '');
  if (isOwnerQualificationContext(value)) return false;
  const hasPropertyWord = /(im[oó]vel|terreno|pr[eé]dio|casa|galp[aã]o|apartamento|lote|logradouro|constru[cç][aã]o|(?:n[uú]mero|numero)\s+predial)/i.test(value);
  const hasAddressWord = /(endere[cç]o|situad[ao]|localizad[ao]|rua|avenida|av\.|rodovia|estrada|travessa|alameda|pra[cç]a|com\s+frente\s+para|frente\s+para|recebeu\s+(?:o\s+)?(?:n[ºo°?.]?|n[uú]mero|numero)|sob\s+n[ºo°?.]?)/i.test(value);
  return hasPropertyWord && hasAddressWord;
}

function isOwnerQualificationContext(value) {
  const searchValue = textForSearch(value);
  if (hasPersonalResidenceTerm(searchValue)) return true;

  const hasPropertySignal = /(imovel\s+objeto|descricao\s+do\s+imovel|denominacao\s+de\s+logradouro|numero\s+predial|construcao|\b(?:terreno|predio|casa|apartamento|galpao|lote)\b.*\b(?:situad|localizad|sob\s+n|frente\s+para|recebeu))/i.test(searchValue);
  if (hasPropertySignal) return false;

  const hasPersonalQualification = /\b(residente|domiciliad[ao]s?|residencia|domicilio|rg|cpf|cpf\/mf|cnpj|ssp|brasileir[ao]s?|casad[ao]s?|solteir[ao]s?|profissao|qualificad[ao]s?)\b/i.test(searchValue);
  if (hasPersonalQualification) return true;

  const text = String(value || '');
  const hasPersonalAddress = /(residente|domiciliad[ao]s?|resid[eê]ncia|domic[ií]lio)/i.test(text);
  const hasPersonalId = /\b(RG|CPF|CPF\/MF|CNPJ|SSP|brasileir[ao]s?|casad[ao]s?|solteir[ao]s?|profiss[aã]o|qualificad[ao]s?)\b/i.test(text);
  const hasStrongPropertySignal = /(im[oó]vel\s+objeto|descri[cç][aã]o\s+do\s+im[oó]vel|denomina[cç][aã]o\s+de\s+logradouro|n[uú]mero\s+predial|constru[cç][aã]o)/i.test(text);
  return (hasPersonalAddress || hasPersonalId) && !hasStrongPropertySignal;
}

function extractStreetAddress(context) {
  if (hasPersonalResidenceTerm(context)) return '';

  const fallback = extractStreetAddressFallback(context);
  if (fallback) return fallback;
  if (hasOwnerQualificationBeforeAddress(propertyContextSlice(context) || String(context || ''))) return '';

  const streetType = '(?:Rua|R\\.?|Avenida|Av\\.?|Rodovia|Estrada|Travessa|Alameda|Pra[cç]a|Largo|Viela|Caminho|Passagem|Servid[aã]o)';
  const patterns = [
    new RegExp(`(?:situad[ao]|localizad[ao]|com\\s+frente\\s+para|frente\\s+para|endere[cç]o|logradouro(?:\\s+p[uú]blico)?(?:\\s+denominado)?|denominad[ao]|denomina[cç][aã]o\\s+de\\s+logradouro|passou\\s+a\\s+denominar-se)\\D{0,120}(${streetType}\\s+[^.;\\n]+?)(?=,\\s*(?:n[ºo°?.]|n[uú]mero|numero|sob)|,\\s*(?:CEP|comarca|munic[ií]pio|nesta|desta|confront|objeto)|\\.|;|$)`, 'i'),
    new RegExp(`(${streetType}\\s+[^.;\\n]+?)(?=,\\s*(?:n[ºo°?.]|n[uú]mero|numero|sob)|,\\s*(?:CEP|comarca|munic[ií]pio|nesta|desta|confront|objeto)|\\.|;|$)`, 'i')
  ];

  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function extractPropertyNumber(context) {
  if (hasPersonalResidenceTerm(context)) return '';
  if (hasOwnerQualificationBeforeAddress(propertyContextSlice(context) || String(context || ''))) return '';
  return extractPropertyNumberFallback(context);

  const fallback = extractPropertyNumberFallback(context);
  if (fallback) return fallback;
  if (hasOwnerQualificationBeforeAddress(propertyContextSlice(context) || String(context || ''))) return '';

  const patterns = [
    /(?:recebeu|recebe|passou\s+a\s+ter)\s+(?:o\s+)?(?:n[ºo°?.]|n[uú]mero(?:\s+predial)?|numero(?:\s+predial)?|n\.?)\s*([A-Za-z0-9\-\/]+)/i,
    /(?:(?:n[uú]mero|numero)\s+predial)\D{0,12}([A-Za-z0-9\-\/]+)/i,
    /(?:pr[eé]dio|casa|constru[cç][aã]o|im[oó]vel)\D{0,80}\bsob\s+n[ºo°?.]?\s*([A-Za-z0-9\-\/]+)/i,
    /\bsob\s+n[ºo°?.]?\s*([A-Za-z0-9\-\/]+)/i
  ];

  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match && !/protocolo/i.test(context.slice(Math.max(0, match.index - 20), match.index + 20))) {
      return match[1].replace(/[.,;:]$/g, '');
    }
  }
  return '';
}

function splitAddressNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(.*?)(?:,\s*(?:sob\s*)?(?:n[ºo°?.]|n[uú]mero|numero|n\.)\s*([A-Za-z0-9\-\/]+)|\s+sob\s+(?:n[ºo°?.]|n[uú]mero|numero|n\.)\s*([A-Za-z0-9\-\/]+))(?:\b|,|$)/i);
  if (!match) return { endereco: text, numero: '' };
  return {
    endereco: match[1].replace(/,\s*$/g, '').trim(),
    numero: (match[2] || match[3]).replace(/[.,;:]$/g, '')
  };
}

function cleanStreetAddress(value) {
  return polishStreetAddress(String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*(?:e\s+seu|e\s+respectivo|constitu[ií]do|constituido|correspondente|do\s+im[oó]vel|do\s+imovel|situado\s+no\s+bairro|bairro|medindo|confrontando|com\s+fundos).*$/i, '')
    .replace(/\s+\|.*$/g, '')
    .replace(/,\s*(?:Trememb(?:e|\u00e9)|SP|S(?:a|\u00e3)o\s+Paulo).*$/i, '')
    .replace(/^[^A-Za-z0-9]+/g, '')
    .replace(/,\s*$/g, '')
    .trim());
}

function polishStreetAddress(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  const streetStart = text.search(/\b(?:Rua|R\.|Avenida|Av\.|Rodovia|Estrada|Travessa|Alameda|Praca|Praça|Largo|Viela|Caminho|Passagem|Servidao|Servidão)\b/i);
  if (streetStart > 0 && streetStart < 30) {
    text = text.slice(streetStart).trim();
  }

  text = text
    .replace(/,\s*(?:onde\s+mede|dista|distante|distando|do\s+lado|lado\s+(?:direito|esquerdo|par|impar|ímpar)|do\s+loteamento|com\s+fundos|medindo|confrontando|respectivamente|situad[ao]\s+nesta\s+cidade|mais\s+\d|por\s+\d|esquina\s+com).*$/i, '')
    .replace(/\s+(?:onde\s+mede|dista|distante|distando|do\s+loteamento|contendo|com\s+\d{1,2}\s+dormit|area\s+constru|[aá]rea\s+constru|situad[ao](?:\s+nesta\s+cidade)?|mais\s+\d|por\s+\d|[\d.,]+m\s+a\s+(?:direita|esquerda)|com\s+igual\s+medida).*$/i, '')
    .replace(/\s+-\s+com\s+fundos.*$/i, '')
    .replace(/,\s*$/g, '')
    .trim();

  if (/^(?:r\s+que|r\s+\d|r\s+registrada|r\s+requerimento|rua|rua\s+com\s+o\s+lote|servid[aã]o\s+de\s+passagem)$/i.test(text)) return '';
  return extraPolishStreetAddress(text);
}

function extraPolishStreetAddress(value) {
  const text = String(value || '')
    .replace(/,\s*(?:\d|deflete|dist[aâ]ncia|pelo\s+lado|da\s+frente\s+aos\s+fundos).*$/i, '')
    .replace(/\s+(?:e\s+com\s+\d|deflete|com\s+a\s+travessa|com\s+as\s+ruas|pelo\s+lado|da\s+frente\s+aos\s+fundos).*$/i, '')
    .replace(/,\s*$/g, '')
    .trim();
  return /^r\b/i.test(text) ? '' : text;
}

function collectPropertyAddressFallbackContexts(text, lines) {
  const contexts = [];
  const candidates = [
    String(text || ''),
    ...String(text || '').split(/[.;]\s+/),
    ...lines
  ];

  for (const candidate of candidates) {
    if (hasPersonalResidenceTerm(candidate)) continue;
    const scoped = propertyContextSlice(candidate) || candidate;
    const clean = String(scoped || '').replace(/\s+/g, ' ').trim();
    if (!clean || !isPropertyAddressCandidate(clean) || isOwnerQualificationContext(clean)) continue;
    if (!contexts.includes(clean)) contexts.push(clean);
  }

  return contexts;
}

function isPropertyAddressCandidate(value) {
  if (hasOwnerQualificationBeforeAddress(value)) return false;

  const search = textForSearch(value);
  const hasProperty = /\b(descricao\s+do\s+imovel|imovel\s+objeto|imovel|terreno|predio|casa|apartamento|galpao|lote|logradouro|construcao|numero\s+predial)\b/i.test(search);
  const hasAddress = /(denominacao\s+de\s+logradouro|endereco|situad|localizad|\b(?:rua|avenida|av\.|rodovia|estrada|travessa|alameda|praca|largo|viela|caminho|passagem|servidao)\b|com\s+frente\s+para|frente\s+para|recebeu\s+(?:o\s+)?(?:n|numero)|sob\s+n|numero\s+predial)/i.test(search);
  return hasProperty && hasAddress;
}

function extractStreetAddressFallback(context) {
  const scoped = propertyContextSlice(context) || String(context || '');
  if (!scoped || isOwnerQualificationContext(scoped) || hasOwnerQualificationBeforeAddress(scoped)) return '';

  const streetType = '(?:Rua|R\\.?|Avenida|Av\\.?|Rodovia|Estrada|Travessa|Alameda|Pra(?:c|\\u00e7)a|Praca|Largo|Viela|Caminho|Passagem|Servid(?:a|\\u00e3)o|Servidao)';
  const frontPattern = new RegExp(`(?:com\\s+frente\\s+para|frente\\s+para|situad[ao][^.;\\n]{0,120}?com\\s+frente\\s+para|situad[ao][^.;\\n]{0,120}?(?:na|no))\\s+(?:a\\s+|o\\s+|ao\\s+)?(${streetType}\\s+[^.;\\n]+?)(?=,\\s*(?:e\\s+seu|e\\s+respectivo|constitu|correspondente|CEP|comarca|munic(?:i|\\u00ed)pio|municipio|nesta|desta|confront|objeto|bairro|Trememb(?:e|\\u00e9)|SP\\b)|\\.|;|$)`, 'i');
  const frontMatch = scoped.match(frontPattern);
  if (frontMatch) return cleanStreetAddress(frontMatch[1]);

  const pattern = new RegExp(`(${streetType}\\s+[^.;\\n]+?)(?=,\\s*(?:n[\\u00ba\\u00b0o?.]|n(?:u|\\u00fa)mero|numero|sob|CEP|comarca|munic(?:i|\\u00ed)pio|municipio|nesta|desta|confront|objeto|Trememb(?:e|\\u00e9)|SP\\b)|\\.|;|$)`, 'i');
  const match = scoped.match(pattern);
  return match ? cleanStreetAddress(match[1]) : '';
}

function extractPropertyNumberFallback(context) {
  const scoped = propertyContextSlice(context) || String(context || '');
  if (!scoped || isOwnerQualificationContext(scoped) || hasOwnerQualificationBeforeAddress(scoped)) return '';

  const normalizedNumber = extractPropertyNumberFromSearch(scoped);
  if (normalizedNumber) return normalizedNumber;
  return '';

  const patterns = [
    /(?:recebeu|recebe|passou\s+a\s+ter)\s+(?:o\s+)?(?:n(?:u|\u00fa)mero(?:\s+predial)?|numero(?:\s+predial)?|n(?:[\u00ba\u00b0o?.]|\s+)|n\.?)\s*([A-Za-z0-9\-\/]+)/i,
    /(?:(?:n(?:u|\u00fa)mero|numero)\s+predial)\D{0,12}([A-Za-z0-9\-\/]+)/i,
    /(?:pr(?:e|\u00e9)dio|predio|casa|constru(?:c|\u00e7)(?:a|\u00e3)o|construcao|im(?:o|\u00f3)vel|imovel)\D{0,100}\bsob\s+n(?:[\u00ba\u00b0o?.]|\s+)\s*([A-Za-z0-9\-\/]+)/i,
    /\bsob\s+n(?:[\u00ba\u00b0o?.]|\s+)\s*([A-Za-z0-9\-\/]+)/i
  ];

  for (const pattern of patterns) {
    const match = scoped.match(pattern);
    if (!match) continue;
    const nearby = scoped.slice(Math.max(0, match.index - 24), match.index + 24);
    if (/protocolo|matr[ií]cula/i.test(nearby)) continue;
    return match[1].replace(/[.,;:]$/g, '');
  }

  return '';
}

function extractPropertyNumberFromSearch(context) {
  const search = textForSearch(context);
  const hasBuildingNumberSignal = /\b(?:predio|casa|galpao|construcao|numero\s+(?:predial|do\s+imovel)|numeracao\s+predial|recebeu)\b|possui\s+atualmente\s+o\s+n[o.]?/i.test(search);
  if (/sem\s+benfeitorias/i.test(search) && !hasBuildingNumberSignal) return '';
  if (/\b(incra|ccir|cadastro|cadastrado|certificado\s+de\s+cadastro)\b/i.test(search) && !hasBuildingNumberSignal) {
    return '';
  }

  const patterns = [
    /(?:numero\s+do\s+imovel|numeracao\s+predial)\D{0,80}?(?:agora\s+)?(?:e|passou\s+a\s+ser|passou\s+a\s+ter|recebeu|sob\s+n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:imovel\s+objeto\s+desta\s+matricula|imovel)\D{0,120}?\bpossui\s+atualmente\s+o\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:passou\s+a\s+(?:ser|ter)|recebeu)\s+(?:o\s+)?(?:numero\s+do\s+imovel|numero\s+predial|n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:predio|casa|galpao|construcao)\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:recebeu|recebe|passou\s+a\s+ter)\s+(?:o\s+)?(?:numero(?:\s+predial)?|n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /numero\s+predial\D{0,12}([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:predio|casa|galpao|construcao)\b.{0,120}?\bsob\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:predio|casa|galpao|construcao)\b.{0,80}?\b(?:numero|n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /\bsob\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i
  ];

  for (const pattern of patterns) {
    const match = search.match(pattern);
    if (!match) continue;
    const value = match[1].replace(/[.,;:]$/g, '');
    if (!/\d/.test(value)) continue;
    if (/^(?:esta|este|desta|deste|no|na)$/i.test(value)) continue;
    return normalizePropertyNumberValue(value);
  }

  return '';
}

function normalizePropertyNumberValue(value) {
  const text = String(value || '').replace(/[.,;:]$/g, '').toUpperCase();
  if (/^[0-9O\-\/]+$/.test(text)) return text.replace(/O/g, '0');
  return text;
}

function hasOwnerQualificationBeforeAddress(value) {
  const search = textForSearch(value);
  const ownerIndex = firstPatternIndex(search, [
    /\b(?:rg|cpf|cpf\/mf|cnpj|residente|domiciliad[ao]s?|brasileir[ao]s?|casad[ao]s?|solteir[ao]s?|profissao|qualificad[ao]s?)\b/i
  ]);
  if (ownerIndex < 0) return false;

  const addressIndex = firstPatternIndex(search, [
    /denominacao\s+de\s+logradouro/i,
    /numero\s+predial/i,
    /\b(?:rua|avenida|av\.|rodovia|estrada|travessa|alameda|praca|largo|viela|caminho|passagem|servidao)\b/i,
    /endereco|situad|localizad|com\s+frente\s+para|frente\s+para/i,
    /recebeu\s+(?:o\s+)?(?:n|numero)/i,
    /sob\s+n/i
  ]);

  return addressIndex < 0 || ownerIndex < addressIndex;
}

function hasPersonalResidenceTerm(value) {
  return /\b(residente|domiciliad[ao]s?)\b/i.test(textForSearch(value));
}

function sentenceAround(text, index) {
  const value = String(text || '');
  const safeIndex = Math.max(0, Number(index || 0));
  const beforeCandidates = ['.', ';', '\n', '\r']
    .map((separator) => value.lastIndexOf(separator, safeIndex))
    .filter((position) => position >= 0);
  const afterCandidates = ['.', ';', '\n', '\r']
    .map((separator) => {
      const position = value.indexOf(separator, safeIndex);
      return position >= 0 ? position : value.length;
    });

  const start = beforeCandidates.length ? Math.max(...beforeCandidates) + 1 : 0;
  const end = afterCandidates.length ? Math.min(...afterCandidates) : value.length;
  return value.slice(start, end);
}

function firstPatternIndex(value, patterns) {
  let index = -1;
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match && (index === -1 || match.index < index)) index = match.index;
  }
  return index;
}

function propertyContextSlice(value) {
  const raw = String(value || '');
  const search = textForSearch(raw);
  const markers = [
    /descricao\s+do\s+imovel/i,
    /imovel\s+objeto/i,
    /denominacao\s+de\s+logradouro/i,
    /logradouro/i,
    /numero\s+do\s+imovel/i,
    /numeracao\s+predial/i,
    /numero\s+predial/i,
    /construcao/i,
    /\b(?:um|uma|o|a)\s+(?:imovel|terreno|predio|casa|apartamento|galpao|lote)\b/i,
    /\b(?:imovel|terreno|predio|casa|apartamento|galpao|lote)\b/i,
    /\b(?:recebeu|passou\s+a\s+ter)\s+(?:o\s+)?(?:n|numero)/i
  ];

  let start = -1;
  for (const marker of markers) {
    const match = search.match(marker);
    if (match && (start === -1 || match.index < start)) start = match.index;
  }

  return start >= 0 ? raw.slice(start).replace(/\s+/g, ' ').trim() : '';
}

function textForSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00ba\u00b0]/g, 'o')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractCadastroRegistro(text) {
  const candidates = [];
  const value = String(text || '');
  const patterns = [
    {
      pattern: /\b(?:averba[cç][aã]o\s+de\s+)?cadastro\s+municipal\b[^.]{0,280}?\b(?:atualmente\s+)?cadastrad[ao]\s+sob\s+(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
      score: 50
    },
    {
      pattern: /\b(?:averba[cç][aã]o\s+de\s+)?(?:cadastro\s+municipal|cadastro\s+imobili[aá]rio|contribuinte)\b[^.]{0,260}?\b(?:agora\s+)?(?:o\s+)?cadastro\s+(?:[eé]|passou\s+a\s+ser)\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
      score: 50
    },
    {
      pattern: /\b(?:im[oó]vel\s+objeto\s+desta\s+matr[ií]cula|im[oó]vel)[^.]{0,180}?\b(?:atualmente\s+)?cadastrad[ao]\s+sob\s+(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
      score: 45
    },
    {
      pattern: /\b(?:contribuinte|cadastro\s+municipal|cadastro\s+imobili[aá]rio|inscri[cç][aã]o\s+municipal)[^.;]{0,160}?\bB\.?\s*C\.?\s*(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)?\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
      score: 20
    },
    {
      pattern: /\bB\.?\s*C\.?\s*(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
      score: 10
    },
    {
      pattern: /\b(?:cadastro\s+(?:no\s+)?INCRA|INCRA)[^.;]{0,160}?(?:sob\s+)?(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{2,})/gi,
      score: 20
    }
  ];

  for (const { pattern, score } of patterns) {
    for (const match of value.matchAll(pattern)) {
      const cadastro = cleanCadastroRegistroValue(match[1]);
      if (!cadastro) continue;
      candidates.push({
        value: cadastro,
        index: match.index,
        act: actNumberBefore(value, match.index),
        score
      });
    }
  }

  candidates.sort((left, right) => {
    if (left.act !== right.act) {
      if (left.act == null) return 1;
      if (right.act == null) return -1;
      return right.act - left.act;
    }
    if (left.score !== right.score) return right.score - left.score;
    return right.index - left.index;
  });

  return candidates.length ? candidates[0].value : '';
}

function cleanCadastroRegistroValue(value) {
  let clean = String(value || '')
    .replace(/\s+/g, '')
    .replace(/[;,.:]+$/g, '')
    .replace(/^[^A-Z0-9]+/i, '')
    .toUpperCase()
    .trim();

  if (/^[O0-9.\-\/]+$/.test(clean)) {
    clean = clean.replace(/O/g, '0');
  }

  if (!/\d/.test(clean)) return '';
  if (/^(?:BC|INCRA|SOB|NUMERO|N)$/i.test(clean)) return '';
  return clean;
}

function actNumberBefore(text, index) {
  const before = textForSearch(String(text || '').slice(Math.max(0, index - 700), index));
  const matches = [...before.matchAll(/\b(?:av|r)\.?\s*[-:]?\s*(\d{1,4})\b/g)];
  if (!matches.length) return null;
  return Number.parseInt(matches[matches.length - 1][1], 10);
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

function cleanPersonName(value) {
  return cleanPersonNameStrict(value);

  return String(value || '')
    .replace(/[|_=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^.*?\b(?:a|para)\s+(?=[A-ZÁÉÍÓÚÃÕÇ][A-ZÁÉÍÓÚÃÕÇ ]{3,})/u, '')
    .replace(/^[,.;:\s]+/g, '')
    .replace(/\b(RG|CPF|CPF\/MF|CNPJ|CNH|brasileir[ao]|maior|menor|casad[ao]|solteir[ao]|portador|inscrit[ao]|residente|domiciliad[ao])\b.*$/i, '')
    .replace(/[;,.]\s*$/g, '')
    .trim();
}

function cleanPersonNameStrict(value) {
  return String(value || '')
    .replace(/[|_=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:propriet[aá]ri[ao]s?|adquirente(?:s)?|outorgado(?:s)?|comprador(?:es)?|donat[aá]ri[ao]s?|cession[aá]ri[ao]s?)\s*[:\-]?\s*/i, '')
    .replace(/^(?:a\s+)?(?:seu|sua|seus|suas)\s+(?:filh[ao]s?|sobrinh[ao]s?|net[ao]s?|irm[aã]os?|m[aã]e|pai)\s+/i, '')
    .replace(/^[,.;:\s]+/g, '')
    .replace(/\b(RG|CPF|CPF\/MF|CNPJ|CNH|NIRE|brasileir[ao]|maior|menor|casad[ao]|solteir[ao]|portador|inscrit[ao]|residente|domiciliad[ao]|com\s+sede)\b.*$/i, '')
    .replace(/[;,.]\s*$/g, '')
    .trim();
}

function normalizeOcrEngine(value) {
  const engine = String(value || 'paddle').trim().toLowerCase();
  return OCR_ENGINES.has(engine) ? engine : 'paddle';
}

function ocrEngineLabel(engine) {
  return normalizeOcrEngine(engine) === 'paddle' ? 'Paddle ONNX' : 'Tesseract';
}

function normalizePaddleModel(value) {
  const model = String(value || '').trim().toLowerCase();
  if (['v5-latin-mobile', 'v5-server', 'v6-small', 'v6-medium'].includes(model)) return model;
  return 'v5-latin-mobile';
}

function paddleModelPreset(paddle, value) {
  const model = normalizePaddleModel(value);
  const presets = {
    'v5-latin-mobile': paddle.V5_LATIN_MOBILE_MODEL,
    'v5-server': paddle.V5_SERVER_MODEL,
    'v6-small': paddle.V6_SMALL_MODEL,
    'v6-medium': paddle.V6_MEDIUM_MODEL
  };
  return presets[model] || paddle.V5_LATIN_MOBILE_MODEL;
}

function normalizePaddleStrategy(value) {
  const strategy = String(value || '').trim().toLowerCase();
  return ['per-line', 'per-box', 'cross-line'].includes(strategy) ? strategy : 'per-line';
}

function normalizePaddleProcessingEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  return engine === 'canvas-native' ? 'canvas-native' : 'opencv';
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function toArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer;
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
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
  extractFields,
  ocrFiles,
  ocrFilesWithTesseract,
  ocrFilesWithPaddle,
  collectOcrPageImages,
  createTesseractOcrSession,
  createPaddleOcrSession,
  imageBuffersForOcr,
  normalizeOcrEngine,
  naturalCompare
};
