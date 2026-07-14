# MadiaznX ONR

Aplicativo Electron para preparar dados de matriculas, revisar campos do formulario ONR e enviar poligonos pela API do Mapa ONR.

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
