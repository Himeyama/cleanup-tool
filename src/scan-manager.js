/**
 * @file scan-manager.js
 * スキャンの状態機械と Worker の生成・制御を担う。
 * 状態: idle → scanning ⇄ paused → completed / canceled
 */

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { guard } = require('./safety-guard');
const { SCANNERS } = require('./scanners');

const SCAN_WORKER_PATH = path.join(__dirname, 'worker', 'scan-worker.js');

class ScanManager {
  /**
   * @param {import('./scan-store').ScanStore} store
   * @param {import('./sse-hub').SseHub} hub
   */
  constructor(store, hub) {
    this.store = store;
    this.hub = hub;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {Int32Array|null} */
    this.control = null;
    this.state = 'idle';
    this.count = 0;
    this.totalSize = 0;
  }

  /**
   * ジャンクスキャンを開始する（既存スキャンは破棄）。
   * @param {string[]} categories
   * @param {object} filterSpec
   */
  start(categories, filterSpec) {
    const jobs = this._buildJobs(categories);
    const sab = this._spawn({ control: null, jobs, filterSpec: filterSpec || {} });
    this.hub.send('scanStarted', { categories, jobs: jobs.map((j) => j.root) });
    return sab;
  }

  /**
   * ユーザー指定の任意フォルダを解析する（通常のファイル一覧スキャン）。
   * システム領域のみ禁止し、Documents/Pictures 等も対象にできる。
   * @param {string[]} roots
   * @param {object} filterSpec
   */
  startCustom(roots, filterSpec) {
    const safeRoots = (roots || []).filter((r) => r && !guard.isHardBlocked(r));
    const jobs = safeRoots.map((root) => ({ category: 'Custom', root, baseFilter: {} }));
    this._spawn({ control: null, jobs, filterSpec: filterSpec || {}, junkHardOnly: true });
    this.hub.send('scanStarted', { categories: ['Custom'], jobs: safeRoots });
  }

  /**
   * 重複検索を開始する。
   * @param {string[]} roots ユーザー指定のフォルダ群
   * @param {{exact?:boolean,similar?:boolean,threshold?:number}} options
   */
  startDuplicates(roots, options) {
    const safeRoots = (roots || []).filter((r) => r && !guard.isHardBlocked(r));
    this._spawn({ control: null, kind: 'duplicate', roots: safeRoots, options: options || {} });
    this.hub.send('duplicatesStarted', { roots: safeRoots, options: options || {} });
  }

  /**
   * Worker を生成し共通のイベント配線を行う。
   * @param {object} workerPayload workerData（control は内部で差し込む）
   */
  _spawn(workerPayload) {
    this._kill();
    this.store.clear();
    this.count = 0;
    this.totalSize = 0;
    this.state = 'scanning';

    const sab = new SharedArrayBuffer(4);
    this.control = new Int32Array(sab);
    Atomics.store(this.control, 0, 0);

    this.worker = new Worker(SCAN_WORKER_PATH, {
      workerData: Object.assign({}, workerPayload, { control: sab }),
    });
    this.worker.on('message', (m) => this._onMessage(m));
    this.worker.on('error', (e) => {
      this.state = 'idle';
      this.hub.send('error', { message: String((e && e.message) || e) });
    });
    this.worker.on('exit', () => {
      if (this.state === 'scanning') this.state = 'idle';
    });
    return sab;
  }

  /**
   * カテゴリ群から探索ジョブ（root 単位）を構築する。
   * @param {string[]} categories
   * @returns {Array<{category:string,root:string,baseFilter:object}>}
   */
  _buildJobs(categories) {
    const jobs = [];
    for (const cat of categories) {
      const scanner = SCANNERS[cat];
      if (!scanner) continue;
      for (const root of scanner.roots()) {
        if (guard.isBlockedForJunk(root)) continue;
        jobs.push({ category: cat, root, baseFilter: scanner.baseFilter });
      }
    }
    return jobs;
  }

  /** Worker からのメッセージ処理。 */
  _onMessage(m) {
    switch (m.type) {
      case 'fileFound':
        for (const rec of m.records) {
          this.store.add(rec);
          this.count++;
          this.totalSize += rec.size;
        }
        this.hub.send('fileFound', { records: m.records });
        break;
      case 'progress':
        this.hub.send('progress', {
          count: this.count,
          totalSize: this.totalSize,
          phase: m.phase,
          total: m.total,
          scanCount: m.count,
          current: m.current,
        });
        break;
      case 'duplicateGroup':
        for (const rec of m.records) this.store.add(rec);
        this.hub.send('duplicateGroup', { kind: m.kind, records: m.records });
        break;
      case 'duplicatesCompleted':
        this.state = 'completed';
        this.hub.send('duplicatesCompleted', { groups: m.groups, files: m.files });
        break;
      case 'completed':
        this.state = 'completed';
        this.hub.send('scanCompleted', { count: this.count, totalSize: this.totalSize });
        break;
      case 'canceled':
        this.state = 'idle';
        this.hub.send('scanCanceled', { count: this.count, totalSize: this.totalSize });
        break;
      case 'error':
        this.hub.send('error', { message: m.message });
        break;
      default:
        break;
    }
  }

  /** 一時停止。 */
  pause() {
    if (this.state !== 'scanning' || !this.control) return false;
    this.state = 'paused';
    Atomics.store(this.control, 0, 1);
    Atomics.notify(this.control, 0);
    this.hub.send('scanPaused', { count: this.count, totalSize: this.totalSize });
    return true;
  }

  /** 再開。 */
  resume() {
    if (this.state !== 'paused' || !this.control) return false;
    this.state = 'scanning';
    Atomics.store(this.control, 0, 0);
    Atomics.notify(this.control, 0);
    this.hub.send('scanResumed', { count: this.count, totalSize: this.totalSize });
    return true;
  }

  /** キャンセル（取得済み結果は保持）。 */
  cancel() {
    if (!this.control) return false;
    Atomics.store(this.control, 0, 2);
    Atomics.notify(this.control, 0);
    return true;
  }

  /** 稼働中 Worker を破棄する。 */
  _kill() {
    if (this.worker) {
      if (this.control) {
        Atomics.store(this.control, 0, 2);
        Atomics.notify(this.control, 0);
      }
      try {
        this.worker.terminate();
      } catch (e) {
        /* noop */
      }
      this.worker = null;
      this.control = null;
    }
  }
}

module.exports = { ScanManager };
