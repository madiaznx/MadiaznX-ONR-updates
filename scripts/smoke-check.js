const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(rootDir, 'package.json'));

const requiredFiles = [
  'src/main.js',
  'src/preload.js',
  'src/services/config-store.js',
  'src/services/kml-service.js',
  'src/services/matricula-reader.js',
  'src/services/onr-api.js',
  'src/services/onr-fields.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css',
  'scripts/prepare-release-assets.js'
];

for (const file of requiredFiles) {
  const fullPath = path.join(rootDir, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Arquivo obrigatorio ausente: ${file}`);
  }
}

requiredFiles
  .filter((file) => file.endsWith('.js'))
  .forEach((file) => {
    const result = spawnSync(process.execPath, ['--check', path.join(rootDir, file)], {
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      throw new Error(`Falha de sintaxe em ${file}:\n${result.stderr || result.stdout}`);
    }
  });

if (packageJson.build.productName !== 'MadiaznX ONR') {
  throw new Error('build.productName deve ser MadiaznX ONR.');
}

const publish = packageJson.build.publish && packageJson.build.publish[0];
if (!publish || publish.provider !== 'github' || publish.owner !== 'madiaznx' || publish.repo !== 'MadiaznX-ONR-updates') {
  throw new Error('Publicacao GitHub nao esta configurada para madiaznx/MadiaznX-ONR-updates.');
}

if (packageJson.build.win.artifactName !== 'MadiaznX-ONR-Setup-v${version}.${ext}') {
  throw new Error('Nome do instalador versionado esta incorreto.');
}

console.log('Smoke check OK.');
