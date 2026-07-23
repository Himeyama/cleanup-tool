/**
 * @file http-helpers.js
 * リクエストボディ読み取り・JSON 応答・Range 対応ストリーミングの共通ヘルパー。
 */

'use strict';

const fs = require('fs');

/**
 * リクエストボディを JSON として読み取る。
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) req.destroy(); // 過大ボディ防止
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * JSON レスポンスを返す。
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} obj
 */
function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

/**
 * ファイルを HTTP Range 対応でストリーミングする（動画のシーク・再生用）。
 * @param {string} filePath
 * @param {string} mime
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function streamFileRange(filePath, mime, req, res) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const total = st.size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

module.exports = { readBody, sendJson, streamFileRange };
