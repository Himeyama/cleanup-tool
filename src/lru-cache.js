/**
 * @file lru-cache.js
 * 単純な LRU キャッシュ（Map の挿入順序を利用）。
 * @template V
 */

'use strict';

class LruCache {
  /** @param {number} max 最大保持数 */
  constructor(max) {
    this.max = max;
    /** @type {Map<string, V>} */
    this.map = new Map();
  }

  /** @param {string} key @returns {V|undefined} */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v); // 最近使用として末尾へ
    return v;
  }

  /** @param {string} key @param {V} val */
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

module.exports = { LruCache };
