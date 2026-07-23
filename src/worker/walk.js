/**
 * @file worker/walk.js
 * ルート群配下のファイルを再帰的に列挙する非同期ジェネレータ。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * pause/cancel を尊重し、blockFn が真のパスは探索・列挙しない。
 * @param {string[]} roots
 * @param {(p:string)=>boolean} blockFn
 * @param {import('./worker-control').WorkerControl} wc
 * @returns {AsyncGenerator<{full:string,name:string,st:fs.Stats,dir:string}>}
 */
async function* walkFiles(roots, blockFn, wc) {
  const stack = roots.slice();
  while (stack.length) {
    if (wc.wait()) return;
    const dir = stack.pop();
    if (blockFn(dir)) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }

    for (const ent of entries) {
      if (Atomics.load(wc.ctrl, 0) !== 0 && wc.wait()) return;
      const full = path.join(dir, ent.name);
      if (blockFn(full)) continue;
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = await fsp.stat(full);
      } catch (e) {
        continue;
      }
      yield { full, name: ent.name, st, dir };
    }
  }
}

module.exports = { walkFiles };
