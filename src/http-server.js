/**
 * @file http-server.js
 * HTTP サーバ本体。API ルーティングと静的 UI（public/）の配信を担う。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { guard } = require('./safety-guard');
const { IMAGE_MIME, VIDEO_MIME } = require('./constants');
const { CATEGORY_ORDER } = require('./scanners');
const { PRESETS, getUserDirs, browseDir } = require('./presets');
const { readBody, sendJson, streamFileRange } = require('./http-helpers');
const { ENV } = require('./env');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 静的配信するファイル → Content-Type。 */
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/client.js': { file: 'client.js', type: 'application/javascript; charset=utf-8' },
};

/** HTTP サーバ本体。API ルーティングと埋め込み UI の配信を担う。 */
class HttpServer {
  /**
   * @param {import('./scan-store').ScanStore} store
   * @param {import('./sse-hub').SseHub} hub
   * @param {import('./scan-manager').ScanManager} manager
   * @param {import('./preview-service').PreviewService} previews
   * @param {import('./delete-service').DeleteService} deleter
   * @param {import('./thumbnail-service').ThumbnailService} thumbs
   */
  constructor(store, hub, manager, previews, deleter, thumbs) {
    this.store = store;
    this.hub = hub;
    this.manager = manager;
    this.previews = previews;
    this.deleter = deleter;
    this.thumbs = thumbs;
    this.server = http.createServer((req, res) => this._route(req, res));
  }

  /** @param {number} port @param {() => void} cb */
  listen(port, cb) {
    this.server.listen(port, '127.0.0.1', cb);
  }

  /**
   * サーバのイベント（'error' など）を一度だけ購読する。
   * @param {string} event
   * @param {(...args:any[])=>void} handler
   */
  once(event, handler) {
    this.server.once(event, handler);
  }

  /** ルーティング。 */
  async _route(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const method = req.method;

    try {
      if (method === 'GET' && STATIC_FILES[pathname]) {
        const { file, type } = STATIC_FILES[pathname];
        fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
          if (err) {
            sendJson(res, 500, { error: 'ui asset read failed' });
            return;
          }
          res.writeHead(200, { 'Content-Type': type });
          res.end(buf);
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/events') {
        this.hub.add(req, res);
        return;
      }
      if (method === 'GET' && pathname === '/api/presets') {
        sendJson(res, 200, {
          presets: PRESETS,
          categories: CATEGORY_ORDER,
          userDirs: getUserDirs(),
          home: ENV.USERPROFILE,
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/browse') {
        const result = await browseDir(String(parsed.query.path || ''));
        sendJson(res, 200, result);
        return;
      }
      if (method === 'GET' && pathname === '/api/preview') {
        await this.previews.handle(String(parsed.query.id || ''), res);
        return;
      }
      if (method === 'GET' && pathname === '/api/thumb') {
        const size = Math.max(16, Math.min(1024, Number(parsed.query.size) || 64));
        await this.thumbs.handle(String(parsed.query.id || ''), size, res);
        return;
      }
      if (method === 'GET' && pathname === '/api/media') {
        const rec = this.store.get(String(parsed.query.id || ''));
        if (!rec || guard.isHardBlocked(rec.path)) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        streamFileRange(rec.path, IMAGE_MIME[rec.ext] || VIDEO_MIME[rec.ext] || 'application/octet-stream', req, res);
        return;
      }
      if (method === 'POST' && pathname === '/api/scan/start') {
        const body = await readBody(req);
        const categories =
          Array.isArray(body.categories) && body.categories.length
            ? body.categories
            : CATEGORY_ORDER.slice();
        this.manager.start(categories, body.filter || {});
        sendJson(res, 200, { ok: true, state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/scan/custom') {
        const body = await readBody(req);
        const roots = Array.isArray(body.roots) ? body.roots.filter(Boolean) : [];
        if (!roots.length) {
          sendJson(res, 400, { error: 'フォルダを1つ以上指定してください' });
          return;
        }
        this.manager.startCustom(roots, body.filter || {});
        sendJson(res, 200, { ok: true, state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/duplicates/start') {
        const body = await readBody(req);
        const roots = Array.isArray(body.roots) ? body.roots.filter(Boolean) : [];
        if (!roots.length) {
          sendJson(res, 400, { error: 'フォルダを1つ以上指定してください' });
          return;
        }
        this.manager.startDuplicates(roots, {
          exact: body.exact !== false,
          similar: body.similar !== false,
          threshold: Number.isFinite(body.threshold) ? body.threshold : 8,
        });
        sendJson(res, 200, { ok: true, state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/scan/pause') {
        sendJson(res, 200, { ok: this.manager.pause(), state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/scan/resume') {
        sendJson(res, 200, { ok: this.manager.resume(), state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/scan/cancel') {
        sendJson(res, 200, { ok: this.manager.cancel(), state: this.manager.state });
        return;
      }
      if (method === 'POST' && pathname === '/api/delete') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const mode = body.mode === 'permanent' ? 'permanent' : 'trash';
        const result = await this.deleter.delete(ids, mode, (p) => {
          this.hub.send('deleteProgress', p);
        });
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  }
}

module.exports = { HttpServer };
