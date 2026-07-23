/**
 * @file main.js
 * メインスレッドのエントリポイント。HTTP サーバを起動しブラウザを開く。
 */

'use strict';

const { execFile } = require('child_process');
const { ScanStore } = require('./scan-store');
const { SseHub } = require('./sse-hub');
const { ScanManager } = require('./scan-manager');
const { PreviewService } = require('./preview-service');
const { ThumbnailService } = require('./thumbnail-service');
const { DeleteService } = require('./delete-service');
const { HttpServer } = require('./http-server');
const { guard } = require('./safety-guard');

/**
 * 既定ブラウザで URL を開く（失敗しても無視）。
 * @param {string} link
 */
function tryOpenBrowser(link) {
  try {
    execFile('cmd', ['/c', 'start', '', link], () => {});
  } catch (e) {
    /* noop */
  }
}

/** メインスレッドのエントリポイント。 */
function main() {
  const store = new ScanStore();
  const hub = new SseHub();
  const manager = new ScanManager(store, hub);
  const previews = new PreviewService(store);
  const thumbs = new ThumbnailService(store);
  const deleter = new DeleteService(store, guard);
  const server = new HttpServer(store, hub, manager, previews, deleter, thumbs);

  const basePort = Number(process.env.PORT) || 8733;
  // PORT を明示指定した場合は固定。既定ポートなら使用中でも次の空きへ回す。
  const fixed = !!process.env.PORT;
  const maxTries = fixed ? 1 : 20;

  const start = (port, attempt) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && attempt < maxTries) {
        process.stdout.write(
          '  ポート ' + port + ' は使用中です。次のポートを試します...\n'
        );
        start(port + 1, attempt + 1);
        return;
      }
      if (err && err.code === 'EADDRINUSE') {
        process.stderr.write(
          '\n  エラー: ポート ' + port + ' は既に使用中です。\n' +
            '  既に起動中の Cleanup Tool を停止するか、PORT=別番号 で起動してください。\n' +
            '  例: PORT=8750 node bin/cleanup-tool.js\n\n'
        );
      } else {
        process.stderr.write('\n  サーバ起動エラー: ' + ((err && err.message) || err) + '\n\n');
      }
      process.exit(1);
    });

    server.listen(port, () => {
      const link = 'http://localhost:' + port;
      process.stdout.write('\n  Cleanup Tool 起動しました\n');
      process.stdout.write('  → ' + link + '\n\n');
      thumbs.warm(); // サムネイル用 PowerShell を事前起動し初回遅延を解消
      if (process.env.NO_OPEN !== '1') tryOpenBrowser(link);
    });
  };

  start(basePort, 1);
}

module.exports = { main, tryOpenBrowser };
