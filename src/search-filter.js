/**
 * @file search-filter.js
 * 検索フィルタ（Worker 側で ScanResult を評価）。
 */

'use strict';

/**
 * ワイルドカード（`*` / `?`）を正規表現へ変換する。
 * @param {string} glob
 * @returns {RegExp}
 */
function wildcardToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(pattern, 'i');
}

/** @param {*} v @returns {number|null} */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {string[]|undefined} list @returns {Set<string>|null} */
function normExt(list) {
  if (!list || !list.length) return null;
  const s = new Set();
  for (let e of list) {
    e = String(e).trim().toLowerCase();
    if (!e) continue;
    if (e[0] !== '.') e = '.' + e;
    s.add(e);
  }
  return s.size ? s : null;
}

/**
 * 検索条件を保持し ScanResult へ適用するフィルタ。
 * カテゴリ既定フィルタ（base）とユーザーフィルタ（user）を AND 結合する。
 */
class SearchFilter {
  /**
   * @param {object} [base] カテゴリ既定フィルタ
   * @param {object} [user] ユーザー指定フィルタ
   */
  constructor(base, user) {
    base = base || {};
    user = user || {};
    /** 拡張子はユーザー指定を優先、なければ base を採用。 */
    this.extensions = normExt(
      user.extensions && user.extensions.length ? user.extensions : base.extensions
    );
    this.sizeMin = numOrNull(user.sizeMin);
    this.sizeMax = numOrNull(user.sizeMax);
    this.atimeFrom = numOrNull(user.atimeFrom);
    this.atimeTo = numOrNull(user.atimeTo);
    this.mtimeFrom = numOrNull(user.mtimeFrom);
    this.mtimeTo = numOrNull(user.mtimeTo);
    this.birthFrom = numOrNull(user.birthFrom);
    this.birthTo = numOrNull(user.birthTo);
    this.pathContainsUser = (user.pathContains || '').toLowerCase();
    this.pathContainsBase = (base.pathContains || '').toLowerCase();
    this.nameContains = (user.nameContains || '').toLowerCase();
    this.includeHidden = !!user.includeHidden;
    this.includeSystem = !!user.includeSystem;
    this.wildcard = user.wildcard ? wildcardToRegExp(user.wildcard) : null;
    this.regex = null;
    if (user.regex) {
      try {
        this.regex = new RegExp(user.regex, user.regexFlags || 'i');
      } catch (e) {
        this.regex = null;
      }
    }
  }

  /**
   * ScanResult がフィルタ条件を満たすか。
   * @param {object} rec
   * @returns {boolean}
   */
  match(rec) {
    if (!this.includeHidden && rec.hidden) return false;
    if (!this.includeSystem && rec.system) return false;
    if (this.extensions && !this.extensions.has(rec.ext)) return false;
    if (this.sizeMin != null && rec.size < this.sizeMin) return false;
    if (this.sizeMax != null && rec.size > this.sizeMax) return false;
    if (this.atimeFrom != null && rec.atimeMs < this.atimeFrom) return false;
    if (this.atimeTo != null && rec.atimeMs > this.atimeTo) return false;
    if (this.mtimeFrom != null && rec.mtimeMs < this.mtimeFrom) return false;
    if (this.mtimeTo != null && rec.mtimeMs > this.mtimeTo) return false;
    if (this.birthFrom != null && rec.birthtimeMs < this.birthFrom) return false;
    if (this.birthTo != null && rec.birthtimeMs > this.birthTo) return false;
    const lp = rec.path.toLowerCase();
    if (this.pathContainsBase && lp.indexOf(this.pathContainsBase) === -1) return false;
    if (this.pathContainsUser && lp.indexOf(this.pathContainsUser) === -1) return false;
    if (this.nameContains && rec.name.toLowerCase().indexOf(this.nameContains) === -1) {
      return false;
    }
    if (this.wildcard && !this.wildcard.test(rec.name)) return false;
    if (this.regex && !this.regex.test(rec.name)) return false;
    return true;
  }
}

module.exports = { SearchFilter, wildcardToRegExp, numOrNull, normExt };
