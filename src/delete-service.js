/**
 * @file delete-service.js
 * 削除サービス。TrashDelete（ゴミ箱＝既定）と PermanentDelete（完全削除）を提供。
 * 削除対象は「スキャン済み id かつ危険領域でないパス」に限定する。
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

class DeleteService {
  /**
   * @param {import('./scan-store').ScanStore} store
   * @param {import('./safety-guard').SafetyGuard} safety
   */
  constructor(store, safety) {
    this.store = store;
    this.safety = safety;
  }

  /**
   * 対象をチャンク単位で削除し、進捗をコールバックへ通知する。
   * @param {string[]} ids
   * @param {'trash'|'permanent'} mode
   * @param {(p:{done:number,total:number,deleted:number,freed:number})=>void} [onProgress]
   * @returns {Promise<{results:Array<{id:string,ok:boolean,reason?:string}>,deleted:number,freed:number,total:number}>}
   */
  async delete(ids, mode, onProgress) {
    /** @type {Array<{id:string,path:string,size:number}>} 検証を通過した対象。 */
    const targets = [];
    const results = [];

    for (const id of ids) {
      const rec = this.store.get(id);
      if (!rec) {
        results.push({ id, ok: false, reason: 'unknown id' });
        continue;
      }
      if (this.safety.isHardBlocked(rec.path)) {
        results.push({ id, ok: false, reason: 'protected path' });
        continue;
      }
      targets.push({ id, path: rec.path, size: rec.size });
    }

    const total = targets.length;
    let done = 0;
    let deleted = 0;
    let freed = 0;
    const report = () => {
      if (onProgress) onProgress({ done, total, deleted, freed });
    };

    // 実削除は「完了確認」とセットでチャンク処理し、逐次進捗を通知する。
    const verifyChunk = (chunk) => {
      for (const t of chunk) {
        done++;
        if (!fs.existsSync(t.path)) {
          deleted++;
          freed += t.size;
          this.store.delete(t.id);
          results.push({ id: t.id, ok: true });
        } else {
          results.push({ id: t.id, ok: false, reason: 'delete failed' });
        }
      }
    };

    report(); // 開始（0件）

    // 進捗の粒度がおおよそ 30 ステップになるチャンクサイズ（最小1・最大200）。
    const chunkSize = Math.min(200, Math.max(1, Math.ceil(total / 30)));
    for (let i = 0; i < total; i += chunkSize) {
      const chunk = targets.slice(i, i + chunkSize);
      if (mode === 'permanent') {
        await this._permanent(chunk);
      } else {
        await this._trash(chunk.map((t) => t.path));
      }
      verifyChunk(chunk);
      report();
    }

    report(); // 最終
    return { results, deleted, freed, total };
  }

  /** 完全削除（fs.rm）。 */
  async _permanent(targets) {
    for (const t of targets) {
      try {
        await fsp.rm(t.path, { force: true });
      } catch (e) {
        /* 存在確認フェーズで失敗として扱う */
      }
    }
  }

  /**
   * ゴミ箱へ移動（PowerShell + Microsoft.VisualBasic）。
   * パス一覧を一時ファイルに書き出し、PowerShell 側でループ削除する。
   * @param {string[]} paths
   * @returns {Promise<void>}
   */
  _trash(paths) {
    return new Promise((resolve) => {
      const listFile = path.join(
        os.tmpdir(),
        'cleanup-del-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt'
      );
      try {
        fs.writeFileSync(listFile, paths.join('\r\n'), 'utf8');
      } catch (e) {
        resolve();
        return;
      }
      const script = [
        "$ErrorActionPreference='SilentlyContinue';",
        'Add-Type -AssemblyName Microsoft.VisualBasic;',
        "$items = Get-Content -LiteralPath '" + listFile.replace(/'/g, "''") + "' -Encoding UTF8;",
        'foreach($p in $items){',
        '  if($p -and (Test-Path -LiteralPath $p)){',
        "    try{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }catch{}",
        '  }',
        '}',
      ].join('\n');

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 120000 },
        () => {
          fs.unlink(listFile, () => {});
          resolve();
        }
      );
    });
  }
}

module.exports = { DeleteService };
