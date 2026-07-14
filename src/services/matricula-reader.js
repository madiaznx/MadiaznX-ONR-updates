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
  const allCpfCnpj = [...normalizedText.matchAll(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)]
    .map((match) => match[0])
    .filter(uniqueFilter)
    .join(', ');
  const nearbyOwnerCpfCnpj = findCpfCnpjNearOwner(normalizedText, currentOwner.name);
  const legalEntityCnpj = isLikelyLegalEntityName(currentOwner.name)
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
  const dataMatricula = firstMatch(normalizedText, /(?:data\s+da\s+matr[ií]cula|abertura)\D{0,20}(\d{2}\/\d{2}\/\d{4})/i)
    || firstMatch(normalizedText, /\b(\d{2}\/\d{2}\/\d{4})\b/);
  const livro = firstMatch(normalizedText, /livro\D{0,8}([A-Z0-9.\-]+)/i);
  const folha = firstMatch(normalizedText, /folha\D{0,8}([A-Z0-9.\-]+)/i);
  const ownerLine = currentOwner.name || firstLine(lines, /(adquirente|outorgado|comprador|propriet[aá]rio|fiduciante)/i);
  const ownerName = cleanPersonName(cleanLabeledLine(ownerLine));
  const ownerLooksLegal = isLikelyLegalEntityName(ownerName || currentOwner.name);
  const currentOwnerDocument = !ownerLooksLegal && isCnpjDocument(currentOwner.cpfCnpj) ? '' : currentOwner.cpfCnpj;
  const nearbyOwnerDocument = !ownerLooksLegal && isCnpjDocument(nearbyOwnerCpfCnpj) ? '' : nearbyOwnerCpfCnpj;
  const displayCpfCnpj = currentOwnerDocument
    || findCpfCnpjNearOwner(normalizedText, ownerName)
    || nearbyOwnerDocument
    || (ownerLooksLegal ? (legalEntityCnpj || allCpfCnpj) : '');
  const propertyAddress = extractPropertyAddress(normalizedText, lines);
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
    isClosed: /matr[ií]cula\s+encerrada|encerrad[ao]\s+a\s+matr[ií]cula|im[oó]vel\s+encerrado/i.test(normalizedText),
    hasTransferHints: /transfer[eê]ncia|alien[aç][aã]o|compra\s+e\s+venda|venda\s+e\s+compra|vendido|adquirente|transmitente|transmitiram|outorgante/i.test(normalizedText)
  };
}

function extractCurrentOwner(text, lines) {
  const latestOwner = extractLatestOwnerFromActs(text);
  if (latestOwner.name) return latestOwner;

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
    if (isSuspectOwnerName(name)) continue;
    const context = text.slice(match.index, match.index + 700);
    return {
      name,
      cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)
    };
  }

  const ownerLine = firstLine(lines, /(adquirente|comprador)/i);
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
    /credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*(?:j[aá]\s+qualificad[ao]|CNPJ|CPF|RG)|\s+passa\s+a\s+deter|\.)[^.]{0,260}?passa\s+a\s+deter\s+a\s+propriedade\s+plena/gi,
    /passa\s+a\s+deter\s+a\s+propriedade\s+plena[^.]{0,260}?credor[ao]\s+fiduci[aá]ri[ao]\s+(.+?)(?:,\s*(?:j[aá]\s+qualificad[ao]|CNPJ|CPF|RG)|\.|;)/gi,
    /(?:transmitiram|transmitiu|vendeu|venderam|doou|doaram|cedeu|cederam|alienou|alienaram)[^.]{0,420}?\s+a\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\s+pelo\s+valor|\.|;)/gi,
    /(?:adquirente[s]?|comprador(?:es)?|donat[aá]ri[ao]s?|cession[aá]ri[ao]s?)\s*[:\-]?\s*(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;|$)/gi,
    /(?:passa(?:m)?\s+a\s+pertencer|fica(?:m)?\s+pertencendo)\s+a\s+(.+?)(?:,\s*(?:RG|CPF|CPF\/MF|CNPJ|brasileir[ao]|portador|inscrit[ao]|casad[ao]|solteir[ao])|\.|;)/gi
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const name = cleanPersonName(match[1]);
      if (isSuspectOwnerName(name)) continue;
      const context = value.slice(match.index, match.index + 900);
      candidates.push({
        name,
        cpfCnpj: firstMatch(context, /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/),
        index: match.index
      });
    }
  }

  candidates.sort((left, right) => left.index - right.index);
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
  return /(^[,.;:]|pelo instrumento|propriet[aá]ri[ao]s?|p[aá]ginas?|faleceu|e a seus sucessores|selo digital|artigo|dever[aá]|leil[oõ]es|certid[aã]o|matr[ií]cula de origem|todos aqueles indicados|foram pagos|recursos pr[oó]prios|saldo devedor|direitos decorrentes|do im[oó]vel|na propor[cç][aã]o|valor de R\$|residente|domiciliad|^e\s+R\$|R\$-\d|RG\s*n|CPF\/?MF?\s*n)/i.test(text);
}

function isLikelyLegalEntityName(value) {
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
    /(?:averba[cç][aã]o|av\.)\D{0,80}(?:denomina[cç][aã]o\s+de\s+logradouro|logradouro|(?:n[uú]mero|numero)\s+predial|constru[cç][aã]o|recebeu\s+(?:o\s+)?(?:n[ºo°?.]?|n[uú]mero|numero))[^.]{0,420}/gi,
    /(?:denomina[cç][aã]o\s+de\s+logradouro|passou\s+a\s+denominar-se|logradouro\s+(?:p[uú]blico\s+)?denominado)[^.]{0,420}/gi,
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
  const match = text.match(/^(.*?)(?:,?\s*(?:sob\s*)?(?:n[ºo°?.]|n[uú]mero|numero|n\.)\s*([A-Za-z0-9\-\/]+))(?:\b|,|$)/i);
  if (!match) return { endereco: text, numero: '' };
  return {
    endereco: match[1].replace(/,\s*$/g, '').trim(),
    numero: match[2].replace(/[.,;:]$/g, '')
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
    .replace(/,\s*(?:onde\s+mede|distante|distando|do\s+lado|lado\s+(?:direito|esquerdo|par|impar|ímpar)|do\s+loteamento|com\s+fundos|medindo|confrontando|respectivamente|situad[ao]\s+nesta\s+cidade|mais\s+\d|por\s+\d|esquina\s+com).*$/i, '')
    .replace(/\s+(?:onde\s+mede|distante|distando|do\s+loteamento|contendo|com\s+\d{1,2}\s+dormit|area\s+constru|[aá]rea\s+constru|situad[ao](?:\s+nesta\s+cidade)?|mais\s+\d|por\s+\d|[\d.,]+m\s+a\s+(?:direita|esquerda)|com\s+igual\s+medida).*$/i, '')
    .replace(/\s+-\s+com\s+fundos.*$/i, '')
    .replace(/,\s*$/g, '')
    .trim();

  if (/^(?:r\s+que|r\s+\d|r\s+registrada|r\s+requerimento|rua|rua\s+com\s+o\s+lote|servid[aã]o\s+de\s+passagem)$/i.test(text)) return '';
  return text;
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
  const patterns = [
    /(?:recebeu|recebe|passou\s+a\s+ter)\s+(?:o\s+)?(?:numero(?:\s+predial)?|n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /numero\s+predial\D{0,12}([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:predio|casa|apartamento|galpao|construcao)\b.{0,120}\bsob\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /(?:predio|casa|apartamento|galpao|construcao)\b.{0,80}\b(?:numero|n[o?.]?)\s+([a-z0-9][a-z0-9\-\/]*)/i,
    /\bsob\s+n[o?.]?\s+([a-z0-9][a-z0-9\-\/]*)/i
  ];

  for (const pattern of patterns) {
    const match = search.match(pattern);
    if (!match) continue;
    const value = match[1].replace(/[.,;:]$/g, '');
    if (!/\d/.test(value)) continue;
    if (/^(?:esta|este|desta|deste|no|na)$/i.test(value)) continue;
    return value.toUpperCase();
  }

  return '';
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
    /\b(?:contribuinte|cadastro\s+municipal|cadastro\s+imobili[aá]rio|inscri[cç][aã]o\s+municipal)[^.;]{0,120}?\bB\.?\s*C\.?\s*(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)?\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
    /\bB\.?\s*C\.?\s*(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{1,})/gi,
    /\b(?:cadastro\s+(?:no\s+)?INCRA|INCRA)[^.;]{0,120}?(?:sob\s+)?(?:n[\u00ba\u00b0o?.]?|n[uú]mero|numero|n\.)\s*([A-Z0-9][A-Z0-9.\-\/]{2,})/gi
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const cadastro = cleanCadastroRegistroValue(match[1]);
      if (!cadastro) continue;
      candidates.push({
        value: cadastro,
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

  return candidates.length ? candidates[0].value : '';
}

function cleanCadastroRegistroValue(value) {
  const clean = String(value || '')
    .replace(/\s+/g, '')
    .replace(/[;,.:]+$/g, '')
    .replace(/^[^A-Z0-9]+/i, '')
    .trim();

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
  return String(value || '')
    .replace(/[|_=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^.*?\b(?:a|para)\s+(?=[A-ZÁÉÍÓÚÃÕÇ][A-ZÁÉÍÓÚÃÕÇ ]{3,})/u, '')
    .replace(/^[,.;:\s]+/g, '')
    .replace(/\b(RG|CPF|CPF\/MF|CNPJ|CNH|brasileir[ao]|maior|menor|casad[ao]|solteir[ao]|portador|inscrit[ao]|residente|domiciliad[ao])\b.*$/i, '')
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
