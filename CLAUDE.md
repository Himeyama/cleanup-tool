# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイドです。

## 概要

Windows 向けディスククリーンアップツール。単一の `app.js`（旧実装、3369行）から
npm 配布可能なモジュール構成へ分割済み。Node.js 標準ライブラリのみで動作し、
npm 依存はゼロ（`package.json` の `dependencies` は空）。

起動: `node bin/cleanup-tool.js`（または `npm start`）。HTTP サーバーが立ち上がり、
既定ブラウザで UI が開く。

## ディレクトリ構成

```
bin/cleanup-tool.js       CLI エントリポイント（shebang、src/main.js の main() を呼ぶだけ）
src/main.js                メインスレッド起動。各サービスを組み立てて HttpServer を listen する
src/http-server.js          ルーティング（/api/* + public/ の静的配信）
src/http-helpers.js         readBody / sendJson / streamFileRange（Range 対応ストリーミング）
src/scan-manager.js         Worker のライフサイクル管理（spawn/pause/resume/cancel の状態機械）
src/scan-store.js           Map<id, ScanResult> ストア
src/sse-hub.js              SSE クライアント管理・イベント配信
src/preview-service.js      画像/テキスト/バイナリのプレビュー（画像は LRU キャッシュ）
src/thumbnail-service.js    常駐 PowerShell によるサムネイル生成（IShellItemImageFactory 経由）
src/delete-service.js       ゴミ箱移動 / 完全削除
src/safety-guard.js         削除・探索対象の安全判定（hardBlocked / junkExcluded の二段防御）
src/scanners/index.js       IScanner 実装群（カテゴリごとの探索ルート定義）
src/search-filter.js        ユーザー検索条件の評価（拡張子・サイズ・日時・正規表現等）
src/presets.js              検索プリセット・ユーザーフォルダ列挙・フォルダブラウズ
src/env.js                  シェルフォルダー実パス解決（レジストリ経由、OneDrive 対応）
src/constants.js             MIME マップ・humanSize
src/worker/scan-worker.js   Worker スレッドのエントリポイント（ScanManager が new Worker() で起動）
src/worker/walk.js          非同期ジェネレータによるディレクトリ再帰列挙
src/worker/worker-control.js  SharedArrayBuffer(Int32Array) による pause/cancel 制御
src/worker/hash.js          SHA-256 ハッシュ・ハミング距離
src/worker/phash.js         知覚ハッシュ（dHash）・サムネイル生成の PowerShell 連携
public/index.html           UI の HTML シェル
public/style.css            UI の CSS
public/client.js            クライアント側 JS（バニラ JS、フレームワーク不使用）
```

## 非自明な設計判断・注意点

- **Worker のエントリファイル**: `ScanManager._spawn()` は `new Worker(SCAN_WORKER_PATH)`
  で `src/worker/scan-worker.js` を起動する。旧実装は `new Worker(__filename)` で
  自分自身を `isMainThread` 分岐しながら再実行していたが、分割後は専用ファイルにした。
  Worker 側のコードを変更する際は `src/worker/` 配下のみで完結させ、メインスレッド側
  （`src/scan-manager.js` 等）に `worker_threads` の `parentPort`/`workerData` を
  持ち込まないこと。
- **PowerShell 連携は UTF-8 固定が必須**: レジストリ参照（`src/env.js`）・サムネイル生成
  （`src/worker/phash.js`, `src/thumbnail-service.js`）はいずれも
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8` を明示している。外さないと
  日本語パスが文字化けする。
- **SafetyGuard の二段防御**（`src/safety-guard.js`）:
  - `hardBlocked`: System32 / Program Files 等。どのモードでも解除されない最終防御線。
  - `junkExcluded`: Desktop/Videos/Music/OneDrive 等のユーザーデータ領域。ジャンクスキャン
    （`ScanManager.start`）でのみ除外され、ユーザー明示指定の重複検索・フォルダ解析
    （`startCustom` / `startDuplicates`）では対象にできる。
- **pause/cancel プロトコル**（`src/worker/worker-control.js`）: `control[0]` は
  `0=running, 1=paused, 2=canceled`。`Atomics.wait`/`Atomics.notify` で同期する。
- **UI は `public/` の実ファイル**: 旧実装は HTML/CSS/クライアント JS 全体を1つの
  JS テンプレートリテラル（`PAGE` 定数）に埋め込んでいたため、クライアント JS 内で
  バックスラッシュを二重化する必要があった（`\\'` 等）。分割後の `public/client.js` は
  独立した通常の JS ファイルなので、この制約はもう存在しない。バックスラッシュは
  そのまま1つで書けばよい。
- **サーバーの再起動**: `src/**/*.js` を変更した場合は Node プロセスの再起動が必要
  （`node bin/cleanup-tool.js` を再実行）。`public/**` の変更はブラウザのリロードのみで
  反映される（サーバーは毎リクエスト `fs.readFile` で読み直すため）。
- **単一ユーザー・ローカル専用**: `HttpServer.listen` は `127.0.0.1` にのみバインドする。
  外部公開を前提にした認証等は実装していない。

## 動作確認

```bash
node --check <変更したファイル>            # 構文チェック
PORT=8799 NO_OPEN=1 node bin/cleanup-tool.js  # 固定ポートでヘッドレス起動
curl http://localhost:8799/api/presets        # API 疎通確認
```

詳細な機能仕様は [DESIGN.md](./DESIGN.md) を参照。
