const versionLabel = document.getElementById('version');
const packageState = document.getElementById('packageState');
const updateStatus = document.getElementById('updateStatus');
const updateProgress = document.getElementById('updateProgress');
const checkButton = document.getElementById('checkButton');
const downloadButton = document.getElementById('downloadButton');
const installButton = document.getElementById('installButton');
const openLatestButton = document.getElementById('openLatestButton');

let updateAvailable = false;
let updateDownloaded = false;

function setStatus(message) {
  updateStatus.textContent = message;
}

function setProgress(value) {
  updateProgress.value = Math.max(0, Math.min(100, value));
}

function setBusy(isBusy) {
  checkButton.disabled = isBusy;
  downloadButton.disabled = isBusy || !updateAvailable || updateDownloaded;
  installButton.disabled = isBusy || !updateDownloaded;
}

function formatVersionInfo(info) {
  if (!info || !info.version) return '';
  return ` Versao encontrada: ${info.version}.`;
}

window.madiaznxONR.getAppInfo().then((info) => {
  versionLabel.textContent = `v${info.version}`;
  packageState.textContent = info.isPackaged
    ? 'Aplicativo instalado. Updates via GitHub Releases.'
    : 'Modo local. A checagem automatica roda no app instalado.';
});

window.madiaznxONR.onUpdaterEvent((event) => {
  if (!event || !event.type) return;

  if (event.type === 'checking') {
    setBusy(true);
    setProgress(0);
    setStatus('Verificando atualizacoes...');
    return;
  }

  if (event.type === 'available') {
    updateAvailable = true;
    updateDownloaded = false;
    setBusy(false);
    setStatus(`Atualizacao disponivel.${formatVersionInfo(event.info)} Clique em Baixar para continuar.`);
    return;
  }

  if (event.type === 'not-available') {
    updateAvailable = false;
    updateDownloaded = false;
    setBusy(false);
    setProgress(0);
    setStatus(`Voce ja esta na versao mais recente.${formatVersionInfo(event.info)}`);
    return;
  }

  if (event.type === 'download-progress') {
    setBusy(true);
    setProgress(event.percent || 0);
    setStatus(`Baixando atualizacao... ${event.percent || 0}%`);
    return;
  }

  if (event.type === 'downloaded') {
    updateDownloaded = true;
    setBusy(false);
    setProgress(100);
    setStatus('Atualizacao baixada. Clique em Instalar para reiniciar e aplicar.');
    return;
  }

  if (event.type === 'error') {
    setBusy(false);
    setStatus(`Falha na atualizacao: ${event.message || 'erro desconhecido'}`);
  }
});

checkButton.addEventListener('click', async () => {
  setBusy(true);
  setProgress(0);
  setStatus('Verificando atualizacoes...');

  try {
    const result = await window.madiaznxONR.checkForUpdates();
    if (result && result.skipped) {
      setBusy(false);
      setStatus(result.reason);
    }
  } catch (error) {
    setBusy(false);
    setStatus(`Falha na checagem: ${error.message}`);
  }
});

downloadButton.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Iniciando download...');

  try {
    const result = await window.madiaznxONR.downloadUpdate();
    if (result && result.skipped) {
      setBusy(false);
      setStatus(result.reason);
    }
  } catch (error) {
    setBusy(false);
    setStatus(`Falha no download: ${error.message}`);
  }
});

installButton.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Instalando atualizacao...');

  try {
    const result = await window.madiaznxONR.installUpdate();
    if (result && result.skipped) {
      setBusy(false);
      setStatus(result.reason);
    }
  } catch (error) {
    setBusy(false);
    setStatus(`Falha na instalacao: ${error.message}`);
  }
});

openLatestButton.addEventListener('click', () => {
  window.madiaznxONR.openLatestRelease();
});
