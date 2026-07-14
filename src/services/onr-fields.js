const PUBLICITY_LEVELS = [
  { value: 1, label: 'Somente quem enviou' },
  { value: 2, label: 'Somente a Serventia' },
  { value: 3, label: 'Todos os Oficiais pela intranet' },
  { value: 4, label: 'Publico em geral via internet' }
];

const POLYGON_CLASSIFICATIONS = [
  { value: 1, label: 'Geral' },
  { value: 2, label: 'Loteamento' },
  { value: 3, label: 'Usucapiao' },
  { value: 4, label: 'Retificacao' },
  { value: 5, label: 'REURB' },
  { value: 6, label: 'Definido pelo RI 1' },
  { value: 7, label: 'Definido pelo RI 2' },
  { value: 8, label: 'Estrangeiros' },
  { value: 9, label: 'Fusao' },
  { value: 10, label: 'Desmembramento' }
];

const POLYGON_CATEGORIES = [
  { value: 1, label: 'Categoria A' },
  { value: 2, label: 'Categoria B' },
  { value: 3, label: 'Categoria C' }
];

const LEGAL_RELATIONS = [
  'Concessao Real de Uso',
  'Enfiteuse / Aforamento',
  'Fiduciario',
  'Habitacao',
  'Propriedade',
  'Real de Aquisicao de Propriedade',
  'Superficie',
  'Uso',
  'Usufruto',
  'Nu-proprietario',
  'Fundeiro',
  'Fiduciante',
  'Arrendante',
  'Arrendatario',
  'Promitente comprador',
  'Multiproprietario',
  'Parceiro',
  'Expropriante',
  'Senhorio direto',
  'Enfiteuta',
  'Outros'
];

const PROPERTY_TYPES = [
  'Apto',
  'Casa',
  'Fazenda/Sitio/Chacara',
  'Galpao',
  'Loja',
  'Outros',
  'Predio Comercial',
  'Predio Residencial',
  'Sala/Conjunto',
  'Terreno/fracao'
];

const PROPERTY_KIND = ['URBANO', 'RURAL'];
const POLYGON_FORMATS = ['GeoJSON/Desenho', 'Long/Lat'];

const FORM_FIELDS = [
  'numeroPrenotacao',
  'matricula',
  'cadastroRegistro',
  'dataMatricula',
  'livroMatricula',
  'folhaMatricula',
  'itbi',
  'rip',
  'tipoRelacaoJuridica',
  'percentual',
  'dataInicio',
  'dataFim',
  'formatoPoligono',
  'nivelPublicidade',
  'classificacaoPoligonos',
  'categorizacaoPoligonos',
  'descricaoInterna',
  'descricaoPublica',
  'pontoCentral',
  'tipoImovel',
  'nomeImovel',
  'nomeProprietario',
  'cpfCnpj',
  'ccirSncr',
  'snci',
  'sigef',
  'cibNirf',
  'transcricao',
  'car',
  'cif',
  'confrontantesMatriculas',
  'nomeConfrontantes',
  'tipo',
  'endereco',
  'numeroImovel',
  'cep',
  'uf',
  'cidade',
  'areaHa',
  'areaM2',
  'perimetroM',
  'perimetroKm'
];

const REQUIRED_FORM_FIELDS = [
  'matricula',
  'cadastroRegistro',
  'formatoPoligono',
  'nivelPublicidade',
  'classificacaoPoligonos',
  'categorizacaoPoligonos',
  'tipoImovel'
];

function createRecord({ matricula, ocrFields, polygon, settings }) {
  const fields = emptyRecord(settings);
  fields.matricula = ocrFields.matricula || matricula || '';
  fields.cadastroRegistro = ocrFields.cadastroRegistro || '';
  fields.dataMatricula = ocrFields.dataMatricula || '';
  fields.livroMatricula = ocrFields.livroMatricula || '';
  fields.folhaMatricula = ocrFields.folhaMatricula || '';
  fields.itbi = ocrFields.itbi || '';
  fields.rip = ocrFields.rip || '';
  fields.nomeProprietario = ocrFields.nomeProprietario || '';
  fields.cpfCnpj = ocrFields.cpfCnpj || '';
  fields.ccirSncr = ocrFields.ccirSncr || '';
  fields.snci = ocrFields.snci || '';
  fields.sigef = ocrFields.sigef || '';
  fields.cibNirf = ocrFields.cibNirf || '';
  fields.transcricao = ocrFields.transcricao || '';
  fields.car = ocrFields.car || '';
  fields.endereco = ocrFields.endereco || '';
  fields.cep = ocrFields.cep || '';
  fields.areaM2 = ocrFields.areaM2 || '';
  fields.areaHa = ocrFields.areaHa || '';
  fields.tipo = inferKind(ocrFields);
  fields.numeroImovel = ocrFields.numeroImovel || '';

  if (polygon) {
    applyPolygon(fields, polygon);
  }

  fields.descricaoInterna = fields.descricaoInterna || `Importacao da matricula ${fields.matricula}`;
  fields.descricaoPublica = fields.descricaoPublica || fields.nomeImovel || fields.endereco || `Matricula ${fields.matricula}`;
  return fields;
}

function emptyRecord(settings = {}) {
  return {
    numeroPrenotacao: '',
    matricula: '',
    cadastroRegistro: '',
    dataMatricula: '',
    livroMatricula: '',
    folhaMatricula: '',
    itbi: '',
    rip: '',
    tipoRelacaoJuridica: 'Propriedade',
    percentual: '100',
    dataInicio: '',
    dataFim: '',
    formatoPoligono: settings.defaultPolygonFormat || 'GeoJSON/Desenho',
    nivelPublicidade: Number(settings.defaultPublicityLevel || 2),
    classificacaoPoligonos: Number(settings.defaultPolygonClassification || 1),
    categorizacaoPoligonos: Number(settings.defaultPolygonCategory || 3),
    descricaoInterna: '',
    descricaoPublica: '',
    pontoCentral: '',
    tipoImovel: settings.defaultPropertyType || 'Terreno/fracao',
    nomeImovel: '',
    nomeProprietario: '',
    cpfCnpj: '',
    ccirSncr: '',
    snci: '',
    sigef: '',
    cibNirf: '',
    transcricao: '',
    car: '',
    cif: '',
    confrontantesMatriculas: '',
    nomeConfrontantes: '',
    tipo: 'URBANO',
    endereco: '',
    numeroImovel: '',
    cep: '',
    uf: settings.defaultUf || 'SP',
    cidade: settings.defaultCity || 'Tremembe',
    areaHa: '',
    areaM2: '',
    perimetroM: '',
    perimetroKm: ''
  };
}

function applyPolygon(fields, polygon) {
  if (!polygon) return fields;
  fields.pontoCentral = polygon.center
    ? `${formatNumber(polygon.center.lon, 7)}, ${formatNumber(polygon.center.lat, 7)}`
    : fields.pontoCentral;
  fields.areaM2 = fields.areaM2 || formatNumber(polygon.areaM2, 2);
  fields.areaHa = fields.areaHa || formatNumber(polygon.areaHa, 4);
  fields.perimetroM = formatNumber(polygon.perimeterM, 2);
  fields.perimetroKm = formatNumber(polygon.perimeterKm, 4);
  fields.nomeImovel = fields.nomeImovel || polygon.name || '';
  return fields;
}

function validateRecord(fields, polygon) {
  const missing = REQUIRED_FORM_FIELDS.filter((field) => !String(fields[field] || '').trim());
  if (!polygon || !polygon.geometry || !polygon.geometry.rings.length) {
    missing.push('poligono');
  }
  return {
    ok: missing.length === 0,
    missing
  };
}

function inferKind(ocrFields) {
  if (ocrFields.car || ocrFields.ccirSncr || ocrFields.snci || ocrFields.sigef || ocrFields.cibNirf) {
    return 'RURAL';
  }
  return 'URBANO';
}

function toApiPayload(fields, fileNames) {
  return {
    categoria_poligono: String(fields.tipo || 'URBANO').toLowerCase() === 'rural' ? 'rural' : 'urbano',
    nivel_publicidade: Number(fields.nivelPublicidade || 2),
    classificacao_poligonos: Number(fields.classificacaoPoligonos || 1),
    numero_prenotacao: String(fields.numeroPrenotacao || fields.matricula || '').trim(),
    descricao_importacao: String(fields.descricaoInterna || fields.descricaoPublica || `Matricula ${fields.matricula}`).trim(),
    nomes_arquivos: fileNames
  };
}

function toDbfRow(fields) {
  return {
    MATRICULA: fields.matricula,
    DAT_MAT: fields.dataMatricula,
    LIV_MAT: fields.livroMatricula,
    FOL_MAT: fields.folhaMatricula,
    TRANSCRI: fields.transcricao,
    CNM: '',
    CNS: '',
    ENDERECO: fields.endereco,
    NUMERO: fields.numeroImovel,
    CEP: onlyDigits(fields.cep),
    MUNICIPIO: fields.cidade,
    UF: fields.uf,
    NOME_PROP: fields.nomeProprietario,
    CPF_CNPJ: fields.cpfCnpj,
    CONF_MAT: fields.confrontantesMatriculas,
    CONF_NOM: fields.nomeConfrontantes,
    REL_JUR: fields.tipoRelacaoJuridica,
    DAT_INI: fields.dataInicio,
    DAT_FIM: fields.dataFim,
    PER_REL: parseNumber(fields.percentual),
    NOME_IMO: fields.nomeImovel,
    AREA_HA: parseNumber(fields.areaHa),
    AREA_M2: parseNumber(fields.areaM2),
    PERIM_M: parseNumber(fields.perimetroM),
    PERIM_KM: parseNumber(fields.perimetroKm),
    CCIR_SNCR: fields.ccirSncr,
    SIGEF: fields.sigef,
    SNCI: fields.snci,
    CIB_NIRF: fields.cibNirf,
    ITBI: parseNumber(fields.itbi),
    CAR: fields.car,
    RIP: parseInteger(fields.rip),
    CIF: parseInteger(fields.cif),
    CLASSIFICA: Number(fields.categorizacaoPoligonos || 3)
  };
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : '';
}

function parseInteger(value) {
  const parsed = Number.parseInt(onlyDigits(value), 10);
  return Number.isFinite(parsed) ? parsed : '';
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatNumber(value, decimals) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(decimals) : '';
}

module.exports = {
  PUBLICITY_LEVELS,
  POLYGON_CLASSIFICATIONS,
  POLYGON_CATEGORIES,
  LEGAL_RELATIONS,
  PROPERTY_TYPES,
  PROPERTY_KIND,
  POLYGON_FORMATS,
  FORM_FIELDS,
  REQUIRED_FORM_FIELDS,
  createRecord,
  emptyRecord,
  applyPolygon,
  validateRecord,
  toApiPayload,
  toDbfRow
};
