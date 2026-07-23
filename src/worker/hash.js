/**
 * @file worker/hash.js
 * 完全一致重複検出のためのファイルハッシュと知覚ハッシュのハミング距離。
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * ファイル内容の SHA-256 をストリーミングで計算する。
 * @param {string} p
 * @returns {Promise<string>}
 */
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 2つの 64bit ビット文字列のハミング距離。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

module.exports = { hashFile, hamming };
