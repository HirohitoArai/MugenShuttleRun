# 無限シャトルラン Windows 版

Web 版（このリポジトリのルート）を Electron でラップした Windows アプリ。
中身は Web 版のビルド成果物（`dist/`）で、ローカル HTTP サーバー経由で表示する。
実行中は画面スリープを抑止する。

## ビルド手順

1. ルートで Web 版をビルドする: `npm run build`（`dist/` が生成される）
2. ルートの `dist/` をこのフォルダの `dist/` にコピーする
3. このフォルダで `npm install`
4. パッケージ化: `npx electron-packager . MugenShuttleRun --platform=win32 --arch=x64 --out=out`
5. `out/MugenShuttleRun-win32-x64/` を zip にして配布する

## 注意

- `package.json` に `version` を入れないこと。入れると electron-packager が
  exe へのバージョン刻印（rcedit）に進み、Linux/macOS では Wine が必要になる。
- exe ファイル自体のアイコン刻印も Wine が必要なため未対応。
  ウィンドウ／タスクバーのアイコンは `main.js` が `dist/icons/icon-512.png` を
  参照して表示する。
