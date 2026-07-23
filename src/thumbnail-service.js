/**
 * @file thumbnail-service.js
 * 一覧・プレビュー用のサムネイルをオンデマンドで生成するサービス。
 * 常駐 PowerShell プロセス（stdin/stdout の行プロトコル）を使い、
 * 起動コストを1回に抑えつつ多数のリクエストを高速に処理する。
 * シェルのサムネイル API を用いるため OneDrive クラウドのみ画像でも
 * 本体をダウンロードしない（要求サイズを取得できない場合は降順で縮退）。
 */

'use strict';

const { spawn } = require('child_process');
const { IMAGE_MIME, VIDEO_MIME } = require('./constants');
const { LruCache } = require('./lru-cache');
const { SHELL_THUMB_CS } = require('./worker/phash');
const { sendJson } = require('./http-helpers');

class ThumbnailService {
  /** @param {import('./scan-store').ScanStore} store */
  constructor(store) {
    this.store = store;
    /** @type {import('child_process').ChildProcess|null} */
    this.proc = null;
    this.buf = '';
    /** @type {Map<string,{resolve:(b:Buffer|null)=>void,timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    this.seq = 0;
    /** @type {LruCache<Buffer>} JPEG バイト列を size|path でキャッシュ。 */
    this.cache = new LruCache(400);
  }

  /** サムネイル用 PowerShell を事前起動しておく（初回リクエストの遅延解消）。 */
  warm() {
    try {
      this._ensureProc();
    } catch (e) {
      /* noop */
    }
  }

  /** 常駐プロセスを（必要なら）起動する。 */
  _ensureProc() {
    if (this.proc) return;
    const script = [
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8;',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      "$ErrorActionPreference='SilentlyContinue';",
      "Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'",
      ...SHELL_THUMB_CS,
      "'@",
      '$fmt=[System.Drawing.Imaging.ImageFormat]::Jpeg;',
      'while(($line=[Console]::In.ReadLine()) -ne $null){',
      '  if(-not $line){continue}',
      '  $parts=$line.Split([char]9);',
      '  if($parts.Length -lt 3){continue}',
      '  $rid=$parts[0]; $sz=[int]$parts[1]; $p=$parts[2];',
      '  $cands=@($sz,256,96) | Where-Object {$_ -le $sz -and $_ -ge 16} | Sort-Object -Descending -Unique;',
      '  if($cands.Count -eq 0){$cands=@($sz)}',
      "  $out='';",
      '  foreach($c in $cands){',
      '    try{',
      '      $img=[ShellThumb]::Get($p,$c);',
      '      $ms=New-Object System.IO.MemoryStream;',
      '      $img.Save($ms,$fmt); $img.Dispose();',
      '      $out=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose();',
      '      break;',
      '    }catch{}',
      '  }',
      '  [Console]::Out.WriteLine($rid+[char]9+$out);',
      '  [Console]::Out.Flush();',
      '}',
    ].join('\n');

    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      this.pending.clear();
    });
  }

  /** stdout 行を解析して pending を解決する。 */
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const t = line.indexOf('\t');
      if (t < 0) continue;
      const rid = line.slice(0, t);
      const b64 = line.slice(t + 1);
      const p = this.pending.get(rid);
      if (p) {
        this.pending.delete(rid);
        clearTimeout(p.timer);
        p.resolve(b64 ? Buffer.from(b64, 'base64') : null);
      }
    }
  }

  /**
   * サムネイル（JPEG バイト列）を取得する。失敗時は null。
   * @param {string} filePath
   * @param {number} size
   * @returns {Promise<Buffer|null>}
   */
  get(filePath, size) {
    const key = size + '|' + filePath;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      this._ensureProc();
      if (!this.proc) {
        resolve(null);
        return;
      }
      const rid = 'r' + ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve(null);
      }, 20000);
      this.pending.set(rid, {
        timer,
        resolve: (buf) => {
          if (buf) this.cache.set(key, buf);
          resolve(buf);
        },
      });
      try {
        this.proc.stdin.write(rid + '\t' + size + '\t' + filePath + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(rid);
        resolve(null);
      }
    });
  }

  /**
   * HTTP レスポンスへサムネイルを書き出す。
   * @param {string} id
   * @param {number} size
   * @param {import('http').ServerResponse} res
   */
  async handle(id, size, res) {
    const rec = this.store.get(id);
    // 画像・動画ともシェルがサムネイル（動画はポスターフレーム）を生成できる。
    if (!rec || !(IMAGE_MIME[rec.ext] || VIDEO_MIME[rec.ext])) {
      sendJson(res, 404, { error: 'no thumbnail' });
      return;
    }
    const buf = await this.get(rec.path, size);
    if (!buf) {
      sendJson(res, 404, { error: 'no thumbnail' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'max-age=3600',
    });
    res.end(buf);
  }
}

module.exports = { ThumbnailService };
