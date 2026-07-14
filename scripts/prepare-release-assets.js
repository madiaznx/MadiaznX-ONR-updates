const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packageJson = require(path.join(rootDir, 'package.json'));
const distDir = path.join(rootDir, 'dist');
const versionedBaseName = `MadiaznX-ONR-Setup-v${packageJson.version}.exe`;
const latestBaseName = 'MadiaznX-ONR-Setup.exe';
const versionedInstaller = path.join(distDir, versionedBaseName);
const latestInstaller = path.join(distDir, latestBaseName);
const versionedBlockmap = `${versionedInstaller}.blockmap`;
const latestBlockmap = `${latestInstaller}.blockmap`;
const latestYml = path.join(distDir, 'latest.yml');

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo esperado nao encontrado: ${filePath}`);
  }
}

requireFile(versionedInstaller);
requireFile(latestYml);

fs.copyFileSync(versionedInstaller, latestInstaller);

if (fs.existsSync(versionedBlockmap)) {
  fs.copyFileSync(versionedBlockmap, latestBlockmap);
}

const yml = fs.readFileSync(latestYml, 'utf8');
const updatedYml = yml.split(versionedBaseName).join(latestBaseName);
fs.writeFileSync(latestYml, updatedYml, 'utf8');

console.log(`Pronto: ${versionedBaseName}`);
console.log(`Pronto: ${latestBaseName}`);
console.log('latest.yml aponta para o instalador geral.');
