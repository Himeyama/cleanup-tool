/**
 * @file worker/scan-worker.js
 * Worker スレッドのエントリポイント。ScanManager が `new Worker(このファイル)` で
 * 生成し、`workerData.kind` に応じてジャンクスキャン／重複検索を実行する。
 */

'use strict';

const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { guard } = require('../safety-guard');
const { SearchFilter } = require('../search-filter');
const { WorkerControl } = require('./worker-control');
const { walkFiles } = require('./walk');
const { hashFile, hamming } = require('./hash');
const { computePerceptualHashes, generateThumbBatch } = require('./phash');
const { IMAGE_MIME } = require('../constants');

/**
 * ScanResult レコードを構築する。
 * 注: Windows の hidden/system 属性は Node 標準 fs では取得できないため、
 * hidden はドット始まり名のヒューリスティックで判定する（system は false 固定）。
 * @param {number} seq
 * @param {string} full 絶対パス
 * @param {string} name ファイル名
 * @param {import('fs').Stats} st
 * @param {string} category
 * @returns {object}
 */
function buildRecord(seq, full, name, st, category) {
  return {
    id: category[0] + seq, // カテゴリ頭文字 + 連番でセッション内一意
    path: full,
    name,
    ext: path.extname(name).toLowerCase(),
    size: st.size,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
    birthtimeMs: st.birthtimeMs,
    category,
    hidden: name.startsWith('.'),
    system: false,
  };
}

/**
 * ジャンクスキャン: 各ジョブのルートを走査し、検出を逐次バッチで送る。
 * @param {SharedArrayBuffer} control
 * @param {Array<{category:string,root:string,baseFilter:object}>} jobs
 * @param {object} filterSpec
 */
async function runJunkScan(control, jobs, filterSpec) {
  const wc = new WorkerControl(control);
  let count = 0;
  let totalSize = 0;
  let idSeq = 0;
  let batch = [];
  let lastProgress = Date.now();

  const flush = () => {
    if (batch.length) {
      parentPort.postMessage({ type: 'fileFound', records: batch });
      batch = [];
    }
  };
  wc.onPause = flush;

  // ユーザー指定フォルダ解析（junkHardOnly）ではシステム領域のみ禁止。
  const blockFn = workerData.junkHardOnly
    ? (p) => guard.isHardBlocked(p)
    : (p) => guard.isBlockedForJunk(p);

  for (const job of jobs) {
    const filter = new SearchFilter(job.baseFilter, filterSpec);
    for await (const f of walkFiles([job.root], blockFn, wc)) {
      const rec = buildRecord(++idSeq, f.full, f.name, f.st, job.category);
      if (!filter.match(rec)) continue;

      count++;
      totalSize += rec.size;
      batch.push(rec);
      if (batch.length >= 300) flush();

      const now = Date.now();
      if (now - lastProgress > 120) {
        flush();
        parentPort.postMessage({ type: 'progress', count, totalSize, current: f.dir });
        lastProgress = now;
      }
    }
    if (wc.canceled) {
      flush();
      parentPort.postMessage({ type: 'canceled', count, totalSize });
      return;
    }
  }
  flush();
  parentPort.postMessage({ type: 'completed', count, totalSize });
}

/**
 * 重複検索: ルート配下を列挙し、完全一致（ハッシュ）と類似画像（知覚ハッシュ）の
 * グループを検出して逐次送信する。
 * @param {SharedArrayBuffer} control
 * @param {string[]} roots
 * @param {{exact?:boolean,similar?:boolean,threshold?:number}} options
 */
async function runDuplicateScan(control, roots, options) {
  const wc = new WorkerControl(control);
  const blockFn = (p) => guard.isHardBlocked(p); // 明示指定フォルダなのでシステム領域のみ禁止
  let lastProgress = Date.now();

  // --- フェーズ1: 列挙 ---
  const files = [];
  for await (const f of walkFiles(roots, blockFn, wc)) {
    const ext = path.extname(f.name).toLowerCase();
    files.push({
      path: f.full,
      name: f.name,
      ext,
      size: f.st.size,
      mtimeMs: f.st.mtimeMs,
      atimeMs: f.st.atimeMs,
      birthtimeMs: f.st.birthtimeMs,
    });
    if (Date.now() - lastProgress > 150) {
      parentPort.postMessage({ type: 'progress', phase: 'enumerate', count: files.length, current: f.dir });
      lastProgress = Date.now();
    }
  }
  if (wc.canceled) {
    parentPort.postMessage({ type: 'canceled', count: files.length, totalSize: 0 });
    return;
  }

  /** @type {Array<{kind:string, files:Array<object>}>} */
  const groups = [];

  // --- フェーズ2: 完全一致（サイズ一致 → 内容ハッシュ） ---
  if (options.exact !== false) {
    const bySize = new Map();
    for (const f of files) {
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }
    const candidates = [];
    for (const [size, arr] of bySize) {
      if (size > 0 && arr.length > 1) for (const f of arr) candidates.push(f);
    }

    const byHash = new Map();
    let hashed = 0;
    for (const f of candidates) {
      if (wc.wait()) {
        parentPort.postMessage({ type: 'canceled', count: files.length, totalSize: 0 });
        return;
      }
      let h;
      try {
        h = await hashFile(f.path);
      } catch (e) {
        hashed++;
        continue;
      }
      const key = f.size + ':' + h;
      if (!byHash.has(key)) byHash.set(key, []);
      byHash.get(key).push(f);
      hashed++;
      if (Date.now() - lastProgress > 150) {
        parentPort.postMessage({ type: 'progress', phase: 'hash', count: hashed, total: candidates.length });
        lastProgress = Date.now();
      }
    }
    for (const arr of byHash.values()) {
      if (arr.length > 1) groups.push({ kind: 'exact', files: arr });
    }
  }

  // --- フェーズ3: 類似画像（知覚ハッシュ dHash / ハミング距離） ---
  if (options.similar !== false) {
    const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.tif']);
    const images = files.filter((f) => SUPPORTED.has(f.ext) && f.size > 0);
    if (images.length > 1) {
      parentPort.postMessage({ type: 'progress', phase: 'phash', count: 0, total: images.length });
      const hashes = await computePerceptualHashes(
        images.map((i) => i.path),
        wc,
        (done) => {
          parentPort.postMessage({ type: 'progress', phase: 'phash', count: done, total: images.length });
        }
      );
      if (wc.canceled) {
        parentPort.postMessage({ type: 'canceled', count: files.length, totalSize: 0 });
        return;
      }
      const threshold = Number.isFinite(options.threshold) ? options.threshold : 8;
      const withHash = images
        .map((im) => ({ file: im, hash: hashes[im.path] }))
        .filter((x) => x.hash);
      // 完全一致で既に拾ったファイルは類似グループから除外し重複表示を防ぐ。
      const exactPaths = new Set();
      for (const g of groups) for (const f of g.files) exactPaths.add(f.path);

      const used = new Array(withHash.length).fill(false);
      for (let i = 0; i < withHash.length; i++) {
        if (used[i] || exactPaths.has(withHash[i].file.path)) continue;
        const grp = [withHash[i].file];
        for (let j = i + 1; j < withHash.length; j++) {
          if (used[j] || exactPaths.has(withHash[j].file.path)) continue;
          if (hamming(withHash[i].hash, withHash[j].hash) <= threshold) {
            used[j] = true;
            grp.push(withHash[j].file);
          }
        }
        if (grp.length > 1) {
          used[i] = true;
          groups.push({ kind: 'similar', files: grp });
        }
      }
    }
  }

  // --- 結果送信: まず全レコードを id 付きで構築 ---
  let idSeq = 0;
  const built = [];
  for (const g of groups) {
    const records = g.files.map((f) => {
      idSeq++;
      return {
        id: (g.kind === 'exact' ? 'D' : 'S') + idSeq,
        path: f.path,
        name: f.name,
        ext: f.ext,
        size: f.size,
        mtimeMs: f.mtimeMs,
        atimeMs: f.atimeMs,
        birthtimeMs: f.birthtimeMs,
        category: 'Duplicate',
        hidden: f.name.startsWith('.'),
        system: false,
      };
    });
    built.push({ kind: g.kind, records });
  }

  // 画像レコードにはシェルサムネイル（data URI）を添付し、表示時の本体
  // ダウンロード（OneDrive ハイドレート）を避ける。
  const imageRecs = [];
  for (const b of built) for (const r of b.records) if (IMAGE_MIME[r.ext]) imageRecs.push(r);
  if (imageRecs.length && !wc.canceled) {
    parentPort.postMessage({ type: 'progress', phase: 'thumb', count: 0, total: imageRecs.length });
    const capped = imageRecs.slice(0, 1500); // 過大ペイロード防止
    const thumbs = await generateThumbBatch(capped.map((r) => ({ id: r.id, path: r.path })), 128);
    for (const r of imageRecs) if (thumbs[r.id]) r.thumb = thumbs[r.id];
  }

  let dupCount = 0;
  for (const b of built) {
    dupCount += b.records.length;
    parentPort.postMessage({ type: 'duplicateGroup', kind: b.kind, records: b.records });
  }
  parentPort.postMessage({ type: 'duplicatesCompleted', groups: built.length, files: dupCount });
}

/**
 * Worker のエントリポイント。scan の種別で分岐する。
 * @returns {Promise<void>}
 */
async function runWorker() {
  const kind = workerData.kind || 'junk';
  try {
    if (kind === 'duplicate') {
      await runDuplicateScan(workerData.control, workerData.roots, workerData.options || {});
    } else {
      await runJunkScan(workerData.control, workerData.jobs, workerData.filterSpec);
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
}

runWorker();
