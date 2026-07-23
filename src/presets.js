/**
 * @file presets.js
 * 検索プリセット、ユーザーフォルダ/ドライブ列挙、フォルダ選択 UI 用ブラウズ。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ENV } = require('./env');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff'];
const VIDEO_EXTS = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

/**
 * 初期プリセット定義。
 * @type {Array<{id:string,name:string,categories:string[],filter:object}>}
 */
const PRESETS = [
  { id: 'windows-standard', name: 'Windows標準', categories: ['Temp', 'Windows'], filter: {} },
  { id: 'browser-cache', name: 'ブラウザキャッシュのみ', categories: ['Browser'], filter: {} },
  { id: 'downloads', name: 'ダウンロードフォルダ', categories: ['Downloads'], filter: {} },
  { id: 'temp-only', name: '一時ファイルのみ', categories: ['Temp'], filter: {} },
  { id: 'logs-only', name: 'ログファイルのみ', categories: ['Logs', 'Windows'], filter: { extensions: ['.log'] } },
  { id: 'images', name: '画像のみ', categories: ['Downloads', 'Temp'], filter: { extensions: IMAGE_EXTS } },
  { id: 'videos', name: '動画のみ', categories: ['Downloads'], filter: { extensions: VIDEO_EXTS } },
  { id: 'large-files', name: '大容量ファイル', categories: ['Downloads', 'Temp'], filter: { sizeMin: 100 * 1024 * 1024 } },
];

/**
 * 重複検索のクイック選択用に、実在するユーザーフォルダの一覧を返す。
 * @returns {Array<{name:string,path:string}>}
 */
function getUserDirs() {
  const defs = [
    ['ピクチャ', ENV.PICTURES],
    ['ドキュメント', ENV.DOCUMENTS],
    ['ダウンロード', ENV.DOWNLOADS],
    ['デスクトップ', ENV.DESKTOP],
    ['ビデオ', ENV.VIDEOS],
    ['ミュージック', ENV.MUSIC],
  ];
  return defs
    .filter(([, p]) => {
      try {
        return fs.existsSync(p);
      } catch (e) {
        return false;
      }
    })
    .map(([name, p]) => ({ name, path: p }));
}

/**
 * 利用可能なドライブ（C:〜Z:）を列挙する。
 * @returns {Array<{name:string,path:string}>}
 */
function listDrives() {
  const drives = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(d)) drives.push({ name: String.fromCharCode(c) + ':', path: d });
    } catch (e) {
      /* noop */
    }
  }
  return drives;
}

/**
 * フォルダ選択 UI 用に、指定パス直下のサブフォルダを一覧化する。
 * path が空ならドライブ一覧を返す（読み取り専用の列挙のみ）。
 * @param {string} p
 * @returns {Promise<{path:string,parent:string,entries:Array<{name:string,path:string}>,error?:string}>}
 */
async function browseDir(p) {
  if (!p) return { path: '', parent: '', entries: listDrives() };
  let norm;
  try {
    norm = path.resolve(p);
  } catch (e) {
    norm = p;
  }
  const parent = path.dirname(norm) === norm ? '' : path.dirname(norm);
  let items;
  try {
    items = await fsp.readdir(norm, { withFileTypes: true });
  } catch (e) {
    return { path: norm, parent, entries: [], error: 'このフォルダは読み取れません' };
  }
  const entries = [];
  for (const it of items) {
    const full = path.join(norm, it.name);
    let isDir = false;
    try {
      isDir = it.isDirectory();
    } catch (e) {
      /* noop */
    }
    // OneDrive 等のジャンクション/シンボリックリンクは dirent 上は directory では
    // なくリンク扱いになる。実体を stat してフォルダなら一覧に含める。
    if (!isDir && it.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        isDir = st.isDirectory();
      } catch (e) {
        /* リンク切れ等は除外 */
      }
    }
    if (isDir) entries.push({ name: it.name, path: full });
  }
  entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  return { path: norm, parent, entries };
}

module.exports = { IMAGE_EXTS, VIDEO_EXTS, PRESETS, getUserDirs, listDrives, browseDir };
