# MadiaznX ONR

Aplicativo Electron para preparar dados de matriculas, revisar campos do formulario ONR e enviar poligonos pela API do Mapa ONR.

## Uso

1. Abra `Configuracoes` e escolha a pasta do acervo de imagens. Exemplo: `I:\LIVRO 02`.
2. Escolha o arquivo `.kml` exportado do Google Earth.
3. Informe o token da API ONR.
4. Digite a matricula e clique em `Ler`.
5. Revise o formulario. Se o KML nao tiver a matricula no nome/descricao do Placemark, escolha o poligono manualmente.
6. Clique em `Gerar shapefile` para revisar os arquivos locais ou em `Enviar para ONR` para executar o fluxo da API.

O OCR le os arquivos da matricula da ultima pagina para a primeira. A busca usa a estrutura de pastas por milhar, como `00000000`, `00001000`, `00002000`.

## Auto-update

O canal de atualizacao usa GitHub Releases no repositorio `madiaznx/MadiaznX-ONR-updates`.

Cada release deve publicar:

- `MadiaznX-ONR-Setup-vX.Y.Z.exe`, instalador versionado.
- `MadiaznX-ONR-Setup.exe`, instalador estavel para links via `/releases/latest/download/MadiaznX-ONR-Setup.exe`.
- `latest.yml`, apontando para `MadiaznX-ONR-Setup.exe`.
- `MadiaznX-ONR-Setup.exe.blockmap`, quando gerado pelo build.

## Scripts

```powershell
npm run check
npm run release:win
```
