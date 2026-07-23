/**
 * @file constants.js
 * MIME マッピングと汎用ユーティリティ。メイン・Worker 双方から参照される。
 */

'use strict';

/** プレビュー可能な画像拡張子 → MIME。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** 動画拡張子 → MIME。プレビューでの再生・ポスターサムネイルに用いる。 */
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
};

/** テキストとしてプレビュー可能な拡張子。 */
const TEXT_EXT = new Set([
  '.txt', '.log', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts',
  '.md', '.csv', '.ini', '.cfg', '.conf', '.yml', '.yaml', '.bat', '.ps1',
  '.sh', '.py', '.c', '.h', '.cpp', '.java', '.sql',
]);

/**
 * バイト数を人間可読な文字列へ整形する。
 * @param {number} n バイト数
 * @returns {string}
 */
function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(2) + ' ' + units[i];
}

module.exports = { IMAGE_MIME, VIDEO_MIME, TEXT_EXT, humanSize };
