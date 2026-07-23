/**
 * @file scanners/index.js
 * IScanner インターフェースと各スキャナ（プラグイン拡張点）。
 *
 * 新しいスキャナは IScanner を継承して SCANNERS に登録するだけで追加でき、
 * 既存コードを変更しない（Open/Closed Principle）。
 * ここでの責務は「探索対象ルート」と「カテゴリ既定フィルタ」の提供のみ。
 * 実際の走査は Worker 側の汎用ウォーカが担う。
 */

'use strict';

const path = require('path');
const { ENV } = require('../env');

/**
 * スキャナ抽象基底。
 * @abstract
 */
class IScanner {
  /** @returns {string} カテゴリ名。 */
  get category() {
    throw new Error('not implemented');
  }

  /** @returns {string[]} 探索対象の絶対パス群。 */
  roots() {
    return [];
  }

  /** @returns {object} カテゴリ既定フィルタ（ユーザーフィルタと AND 結合）。 */
  get baseFilter() {
    return {};
  }
}

class WindowsTempScanner extends IScanner {
  get category() {
    return 'Temp';
  }
  roots() {
    return [
      ENV.TEMP,
      path.join(ENV.WINDIR, 'Temp'),
      path.join(ENV.WINDIR, 'Prefetch'),
      ENV.LOCALAPPDATA && path.join(ENV.LOCALAPPDATA, 'Temp'),
    ].filter(Boolean);
  }
}

class BrowserCacheScanner extends IScanner {
  get category() {
    return 'Browser';
  }
  roots() {
    const L = ENV.LOCALAPPDATA;
    if (!L) return [];
    const out = [];
    const chromiumProfiles = [
      path.join(L, 'Microsoft', 'Edge', 'User Data', 'Default'),
      path.join(L, 'Google', 'Chrome', 'User Data', 'Default'),
    ];
    for (const p of chromiumProfiles) {
      out.push(path.join(p, 'Cache'));
      out.push(path.join(p, 'Code Cache'));
      out.push(path.join(p, 'GPUCache'));
    }
    // Firefox は各プロファイル配下の cache2 のみ対象（baseFilter で cache に限定）。
    out.push(path.join(L, 'Mozilla', 'Firefox', 'Profiles'));
    return out;
  }
  get baseFilter() {
    // どのブラウザでもキャッシュ領域のみ（プロファイルの重要データは除外）。
    return { pathContains: 'cache' };
  }
}

class DownloadScanner extends IScanner {
  get category() {
    return 'Downloads';
  }
  roots() {
    return [ENV.DOWNLOADS];
  }
}

class LogScanner extends IScanner {
  get category() {
    return 'Logs';
  }
  roots() {
    return [
      path.join(ENV.WINDIR, 'Logs'),
      ENV.TEMP,
    ].filter(Boolean);
  }
  get baseFilter() {
    return { extensions: ['.log'] };
  }
}

class WindowsScanner extends IScanner {
  get category() {
    return 'Windows';
  }
  roots() {
    return [
      path.join(ENV.WINDIR, 'SoftwareDistribution', 'Download'),
      path.join(ENV.WINDIR, 'Logs'),
    ];
  }
}

class RecentScanner extends IScanner {
  get category() {
    return 'Recent';
  }
  roots() {
    if (!ENV.APPDATA) return [];
    return [path.join(ENV.APPDATA, 'Microsoft', 'Windows', 'Recent')];
  }
}

class DocumentsScanner extends IScanner {
  get category() {
    return 'Documents';
  }
  roots() {
    return [ENV.DOCUMENTS];
  }
}

class PicturesScanner extends IScanner {
  get category() {
    return 'Pictures';
  }
  roots() {
    return [ENV.PICTURES];
  }
}

/** @type {Record<string, IScanner>} カテゴリ → スキャナのレジストリ。 */
const SCANNERS = {
  Temp: new WindowsTempScanner(),
  Browser: new BrowserCacheScanner(),
  Downloads: new DownloadScanner(),
  Logs: new LogScanner(),
  Windows: new WindowsScanner(),
  Recent: new RecentScanner(),
  Documents: new DocumentsScanner(),
  Pictures: new PicturesScanner(),
};

/** 左ペインのカテゴリ表示順。 */
const CATEGORY_ORDER = [
  'Temp', 'Browser', 'Downloads', 'Logs', 'Windows', 'Recent', 'Documents', 'Pictures',
];

module.exports = {
  IScanner,
  WindowsTempScanner,
  BrowserCacheScanner,
  DownloadScanner,
  LogScanner,
  WindowsScanner,
  RecentScanner,
  DocumentsScanner,
  PicturesScanner,
  SCANNERS,
  CATEGORY_ORDER,
};
