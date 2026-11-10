# 無限シャトルラン (Mugen Shuttle Run)

音階（ドレミ）で進むシャトルランの Web アプリ。Unity 版「FakeShuttleRun」の移行版。

- レベルが上がると走行速度が上がり、効果音はピッチを保ったまま短くなる
- その変換には ffmpeg（atempo、ffmpeg.wasm）を使い、再生前に先読みで変換してキャッシュする
- 再生タイミングは Web Audio のクロックでスケジューリングし、誤差を累積させない
- 初期速度・速度変化・レベルアップ時間はスライダーで変更可能
  （レベル1→2 の遷移だけ速度変化が2倍なのは、Léger の標準シャトルラン表 8.0→9.0 km/h の再現）

要件定義は移行元プロジェクトの `REQUIREMENTS.md`（../REQUIREMENTS.md 相当）参照。

## 開発

```sh
npm install
npm run dev     # 開発サーバ
npm run build   # dist/ にビルド
```

デプロイは GitHub Pages（gh-pages ブランチに dist を公開）。
