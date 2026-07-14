const fs = require('fs/promises');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true
});

async function loadKmlFile(kmlPath) {
  if (!kmlPath) {
    return { path: '', placemarks: [], polygons: [] };
  }

  const raw = await fs.readFile(kmlPath, 'utf8');
  const document = parser.parse(raw);
  const placemarkNodes = collectByKey(document, 'Placemark');
  const placemarks = placemarkNodes.map((node, index) => placemarkFromNode(node, index, kmlPath));
  const polygons = placemarks.filter((item) => item.geometry && item.geometry.rings.length > 0);

  return {
    path: kmlPath,
    placemarks,
    polygons
  };
}

function matchPolygonForMatricula(polygons, matricula) {
  const clean = onlyDigits(matricula);
  if (!clean) return null;

  const padded = clean.padStart(8, '0');
  return polygons.find((polygon) => {
    return polygon.matriculaCandidates.some((candidate) => {
      const candidateDigits = onlyDigits(candidate);
      return candidateDigits === clean || candidateDigits === padded || candidateDigits.padStart(8, '0') === padded;
    });
  }) || null;
}

function placemarkFromNode(node, index, sourcePath) {
  const name = textValue(node.name) || `Poligono ${index + 1}`;
  const description = stripHtml(textValue(node.description));
  const address = stripHtml(textValue(node.address));
  const extended = extractExtendedData(node);
  const text = [name, description, address, extended].filter(Boolean).join(' ');
  const polygonNode = collectByKey(node, 'Polygon')[0];
  const rings = polygonNode ? ringsFromPolygon(polygonNode) : [];
  const metrics = rings.length ? polygonMetrics(rings) : null;

  return {
    id: stablePlacemarkId(sourcePath, index, name),
    name,
    description,
    text,
    sourcePath,
    matriculaCandidates: matriculaCandidates(text),
    geometry: rings.length ? { type: 'Polygon', rings } : null,
    center: metrics ? metrics.center : null,
    areaM2: metrics ? metrics.areaM2 : 0,
    areaHa: metrics ? metrics.areaM2 / 10000 : 0,
    perimeterM: metrics ? metrics.perimeterM : 0,
    perimeterKm: metrics ? metrics.perimeterM / 1000 : 0
  };
}

function ringsFromPolygon(polygonNode) {
  const rings = [];
  const outerCoordinates = firstCoordinates(polygonNode.outerBoundaryIs);
  if (outerCoordinates.length) rings.push(closeRing(outerCoordinates));

  const innerBoundaries = toArray(polygonNode.innerBoundaryIs);
  for (const inner of innerBoundaries) {
    const innerCoordinates = firstCoordinates(inner);
    if (innerCoordinates.length) rings.push(closeRing(innerCoordinates));
  }

  return rings;
}

function firstCoordinates(node) {
  const coordinates = collectByKey(node, 'coordinates')
    .map(textValue)
    .filter(Boolean)[0];
  return parseCoordinates(coordinates || '');
}

function parseCoordinates(raw) {
  return String(raw)
    .trim()
    .split(/\s+/)
    .map((item) => item.split(',').map(Number))
    .filter((parts) => Number.isFinite(parts[0]) && Number.isFinite(parts[1]))
    .map((parts) => [parts[0], parts[1]]);
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function polygonMetrics(rings) {
  const outer = rings[0] || [];
  const center = centroid(outer);
  const projected = rings.map((ring) => ring.map((coord) => project(coord, center.lat)));
  const outerArea = Math.abs(shoelace(projected[0] || []));
  const holesArea = projected.slice(1).reduce((sum, ring) => sum + Math.abs(shoelace(ring)), 0);
  const perimeterM = ringLength(projected[0] || []);

  return {
    center,
    areaM2: Math.max(0, outerArea - holesArea),
    perimeterM
  };
}

function centroid(ring) {
  if (!ring.length) return { lon: 0, lat: 0 };
  const openRing = ring.slice(0, -1);
  const base = openRing.length ? openRing : ring;
  const total = base.reduce((sum, coord) => {
    sum.lon += coord[0];
    sum.lat += coord[1];
    return sum;
  }, { lon: 0, lat: 0 });

  return {
    lon: total.lon / base.length,
    lat: total.lat / base.length
  };
}

function project(coord, centerLat) {
  const earthRadius = 6378137;
  const lon = toRadians(coord[0]);
  const lat = toRadians(coord[1]);
  const lat0 = toRadians(centerLat || coord[1]);
  return {
    x: earthRadius * lon * Math.cos(lat0),
    y: earthRadius * lat
  };
}

function shoelace(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    sum += (current.x * next.y) - (next.x * current.y);
  }
  return sum / 2;
}

function ringLength(points) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    total += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return total;
}

function extractExtendedData(node) {
  const dataNodes = collectByKey(node, 'Data');
  const simpleDataNodes = collectByKey(node, 'SimpleData');
  const values = [];

  for (const data of dataNodes) {
    const name = data['@_name'] || '';
    const value = textValue(data.value);
    if (name || value) values.push(`${name} ${value}`.trim());
  }

  for (const data of simpleDataNodes) {
    const name = data['@_name'] || '';
    const value = textValue(data);
    if (name || value) values.push(`${name} ${value}`.trim());
  }

  return values.join(' ');
}

function matriculaCandidates(text) {
  const candidates = new Set();
  const value = stripHtml(text);
  const labeled = value.matchAll(/(?:matr[ií]cula|mat\.?|cadastro|registro)\D{0,12}(\d[\d.\-\/]{0,14}\d)/gi);
  const prefixed = value.matchAll(/(?:^|[\s(;])M[-.\s]*(\d{1,8})(?=$|[\s);-])/gi);

  for (const match of labeled) {
    const digits = onlyDigits(match[1]);
    if (digits.length >= 1 && digits.length <= 10) candidates.add(digits);
  }

  for (const match of prefixed) {
    const digits = onlyDigits(match[1]);
    if (digits.length >= 1 && digits.length <= 8) candidates.add(digits);
  }

  if (!candidates.size) {
    const compact = value.trim();
    if (/^\d{1,8}$/.test(compact)) {
      candidates.add(onlyDigits(compact));
    }
  }

  return [...candidates];
}

function collectByKey(node, key) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => collectByKey(item, key));

  const found = [];
  for (const [nodeKey, value] of Object.entries(node)) {
    if (nodeKey === key) {
      found.push(...toArray(value));
    } else if (value && typeof value === 'object') {
      found.push(...collectByKey(value, key));
    }
  }
  return found;
}

function textValue(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in value) return textValue(value['#text']);
  return '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stablePlacemarkId(sourcePath, index, name) {
  const base = `${path.basename(sourcePath || 'kml')}-${index}-${name}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `polygon-${index + 1}`;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toRadians(value) {
  return (Number(value) * Math.PI) / 180;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

module.exports = {
  loadKmlFile,
  matchPolygonForMatricula
};
