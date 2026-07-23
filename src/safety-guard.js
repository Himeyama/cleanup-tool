/**
 * @file safety-guard.js
 * 安全判定ユーティリティ。メイン・Worker 双方から参照される。
 */

'use strict';

const path = require('path');
const { ENV } = require('./env');

/**
 * 安全判定ユーティリティ。
 *
 * 2段階の防御線を持つ:
 *  - hardBlocked: システム破壊に直結する領域。探索・削除ともに「常に」禁止。
 *    どのモードでも解除されない。
 *  - junkExcluded: ユーザーの重要データ領域（Documents/Pictures 等）。
 *    ジャンクスキャンでは除外するが、ユーザーが明示的に指定する重複検索では
 *    対象にできる（削除は既定でゴミ箱＝復元可能）。
 */
class SafetyGuard {
  constructor() {
    const W = ENV.WINDIR;
    /** @type {string[]} システム重要領域（常時ブロック）。 */
    this.hardBlocked = [
      path.join(W, 'System32'),
      path.join(W, 'SysWOW64'),
      path.join(W, 'WinSxS'),
      path.join(W, 'Fonts'),
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData\\Microsoft\\Windows',
    ].map((p) => p.toLowerCase());
    // 注: Documents / Pictures は専用スキャナ（左ペインのカテゴリ）で明示的に
    // 対象にできるよう、ここには含めない。既定では未選択なので誤スキャンは起きない。
    /** @type {string[]} ユーザーデータ領域（ジャンクスキャンのみ除外）。 */
    this.junkExcluded = [
      ENV.DESKTOP,
      ENV.VIDEOS,
      ENV.MUSIC,
      path.join(ENV.USERPROFILE, 'OneDrive'),
    ].map((p) => p.toLowerCase());
  }

  /** @param {string} p @param {string[]} list @returns {boolean} */
  _under(p, list) {
    const lp = path.normalize(p).toLowerCase();
    for (const b of list) {
      if (lp === b || lp.startsWith(b + path.sep)) return true;
    }
    return false;
  }

  /**
   * システム重要領域か（どのモードでも触れてはならない）。削除の最終防御線。
   * @param {string} p 絶対パス
   * @returns {boolean}
   */
  isHardBlocked(p) {
    return this._under(p, this.hardBlocked);
  }

  /**
   * ジャンクスキャンで除外すべきか（システム領域＋ユーザーデータ領域）。
   * @param {string} p 絶対パス
   * @returns {boolean}
   */
  isBlockedForJunk(p) {
    return this._under(p, this.hardBlocked) || this._under(p, this.junkExcluded);
  }
}

const guard = new SafetyGuard();

module.exports = { SafetyGuard, guard };
