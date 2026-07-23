/**
 * @file preview-service.js
 * プレビュー生成サービス。拡張子で Image/Text/Binary プロバイダへ振り分ける。
 * 画像はバイト列を LRU キャッシュ（最大100枚）する。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const { IMAGE_MIME, TEXT_EXT } = require('./constants');
const { LruCache } = require('./lru-cache');
const { sendJson } = require('./http-helpers');

class PreviewService {
  /** @param {import('./scan-store').ScanStore} store */
  constructor(store) {
    this.store = store;
    /** @type {LruCache<Buffer>} */
    this.imageCache = new LruCache(100);
    this.MAX_IMAGE = 8 * 1024 * 1024; // 8MB までキャッシュ
    this.TEXT_BYTES = 64 * 1024; // 先頭 64KB
  }

  /**
   * プレビューを HTTP レスポンスへ書き出す。
   * @param {string} id
   * @param {import('http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async handle(id, res) {
    const rec = this.store.get(id);
    if (!rec) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = rec.ext;

    if (IMAGE_MIME[ext]) {
      await this._image(rec, res);
      return;
    }
    if (TEXT_EXT.has(ext)) {
      await this._text(rec, res);
      return;
    }
    // BinaryPreview: メタ情報のみ
    sendJson(res, 200, {
      type: 'binary',
      name: rec.name,
      size: rec.size,
      ext: rec.ext,
    });
  }

  /** 画像プレビュー（LRU 経由）。 */
  async _image(rec, res) {
    if (rec.size > this.MAX_IMAGE) {
      sendJson(res, 200, { type: 'binary', name: rec.name, size: rec.size, note: 'too large' });
      return;
    }
    let buf = this.imageCache.get(rec.id);
    if (!buf) {
      try {
        buf = await fsp.readFile(rec.path);
      } catch (e) {
        sendJson(res, 500, { error: 'read failed' });
        return;
      }
      this.imageCache.set(rec.id, buf);
    }
    res.writeHead(200, {
      'Content-Type': IMAGE_MIME[rec.ext],
      'Content-Length': buf.length,
      'X-Preview-Type': 'image',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  }

  /** テキストプレビュー（先頭のみ）。 */
  async _text(rec, res) {
    let fh;
    try {
      fh = await fsp.open(rec.path, 'r');
      const len = Math.min(rec.size, this.TEXT_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Preview-Type': 'text',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    } catch (e) {
      sendJson(res, 500, { error: 'read failed' });
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }
}

module.exports = { PreviewService };
