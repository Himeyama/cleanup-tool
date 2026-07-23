/**
 * @file scan-store.js
 * スキャン結果を id で保持するストア（Map<id, ScanResult>）。
 */

'use strict';

class ScanStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.map = new Map();
  }

  /** @param {object} rec */
  add(rec) {
    this.map.set(rec.id, rec);
  }

  /** @param {string} id @returns {object|undefined} */
  get(id) {
    return this.map.get(id);
  }

  /** @param {string} id @returns {boolean} */
  delete(id) {
    return this.map.delete(id);
  }

  clear() {
    this.map.clear();
  }

  /** @returns {number} */
  get size() {
    return this.map.size;
  }
}

module.exports = { ScanStore };
