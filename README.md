# cleanup-tool

Windows 向けディスククリーンアップツール。ローカルに HTTP サーバーを起動し、
ブラウザ UI から一時ファイル・ブラウザキャッシュ・ダウンロード・重複ファイルなどを
検出して削除できます。Node.js 標準ライブラリのみで動作し、追加の npm 依存はありません。

## 必要環境

- Windows（`powershell.exe` に依存: レジストリ参照・シェルサムネイル・ゴミ箱移動）
- Node.js >= 16

## インストールと起動

```bash
npm install -g cleanup-tool
cleanup-tool
```

もしくはリポジトリを直接 clone して:

```bash
npm install
npm start
```

起動すると既定ブラウザで `http://localhost:8733` が自動的に開きます。

### 環境変数

- `PORT`: 待受ポートを固定します（未指定時は 8733 から空きポートを自動探索）
- `NO_OPEN=1`: 起動時にブラウザを自動で開かない

## 主な機能

- カテゴリ別スキャン（Temp / Browser / Downloads / Logs / Windows / Recent / Documents / Pictures）
- 任意フォルダ指定でのファイル一覧解析
- 完全一致（SHA-256）・類似画像（知覚ハッシュ）による重複検出
- スキャン結果のリアルタイムストリーミング表示（Server-Sent Events）
- 数十万件規模でも軽快な仮想スクロール一覧
- 一時停止・再開・キャンセル
- ゴミ箱移動 / 完全削除の選択
- 画像・動画・テキストのプレビュー

## アーキテクチャ

```
bin/cleanup-tool.js   CLI エントリポイント
src/main.js           メインスレッド起動（HTTP サーバー・各サービスの組み立て）
src/http-server.js     ルーティング + public/ の静的配信
src/scan-manager.js    Worker のライフサイクル管理（pause/resume/cancel）
src/worker/            Worker スレッド側の実装（ディレクトリ探索・ハッシュ計算等）
src/scanners/          スキャナー実装（IScanner のプラグイン群）
public/                ブラウザ UI（HTML / CSS / クライアント JS）
```

詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## 安全性について

- システム重要領域（`System32` / `Program Files` 等）は探索・削除ともに常に除外されます。
- 削除は既定でゴミ箱への移動です（`mode: "permanent"` を明示した場合のみ完全削除）。
- 詳細仕様は [DESIGN.md](./DESIGN.md) を参照してください。
