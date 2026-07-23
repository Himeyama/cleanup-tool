/**
 * @file worker/phash.js
 * 知覚ハッシュ（dHash）とサムネイル生成をシェル（PowerShell + .NET）経由で行う。
 * npm 非依存で、OneDrive クラウドのみ画像でも本体をダウンロードしない
 * （IShellItemImageFactory 経由のシェルサムネイルを使用するため）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/**
 * シェルのサムネイル API（IShellItemImageFactory）を定義する C# ソース。
 * これによりファイル本体を読まずにサムネイルを取得でき、OneDrive の
 * クラウドのみ（ファイルオンデマンド）画像でもハイドレートを起こさない。
 * ※ Add-Type で実行時コンパイルするため ASCII のみ・コメントは英語で記述。
 * @type {string[]}
 */
const SHELL_THUMB_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Drawing;',
  'using System.Threading;',
  'public static class ShellThumb {',
  '  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }',
  '  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; public SIZE(int x,int y){cx=x;cy=y;} }',
  '  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]',
  '  static extern void SHCreateItemFromParsingName(string p, IntPtr b, ref Guid riid, out IShellItemImageFactory ppv);',
  '  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);',
  '  const int E_PENDING = unchecked((int)0x8000000A);',
  '  const int SIIGBF_THUMBNAILONLY = 0x8;',
  '  public static Bitmap Get(string path, int size) {',
  '    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");',
  '    IShellItemImageFactory f; SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out f);',
  '    IntPtr hbm = IntPtr.Zero; int hr = 0;',
    '    for (int i=0;i<50;i++){ hr = f.GetImage(new SIZE(size,size), SIIGBF_THUMBNAILONLY, out hbm); if(hr!=E_PENDING) break; Thread.Sleep(150); }',
  '    if (hr != 0) throw new COMException("thumb", hr);',
  '    try { return Image.FromHbitmap(hbm); } finally { DeleteObject(hbm); }',
  '  }',
  '}',
];

/**
 * PowerShell を起動して ASCII スクリプトを実行する共通ヘルパー。
 * @param {string} script
 * @param {(stdout:string)=>void} onDone
 */
function runPowerShell(script, onDone) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 300000, maxBuffer: 96 * 1024 * 1024, encoding: 'utf8' },
    (err, stdout) => onDone(stdout || '')
  );
}

/**
 * 画像バッチの dHash を計算する。デコードはシェルのサムネイルを用いるため、
 * OneDrive クラウドのみ画像でも本体をダウンロードしない。
 * @param {string[]} paths
 * @returns {Promise<Record<string,string>>}
 */
function runPhashBatch(paths) {
  return new Promise((resolve) => {
    const listFile = path.join(
      os.tmpdir(),
      'cleanup-phash-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt'
    );
    try {
      fs.writeFileSync(listFile, paths.join('\r\n'), 'utf8');
    } catch (e) {
      resolve({});
      return;
    }
    const esc = listFile.replace(/'/g, "''");
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      "$ErrorActionPreference='SilentlyContinue';",
      "Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'",
      ...SHELL_THUMB_CS,
      "'@",
      "$items=Get-Content -LiteralPath '" + esc + "' -Encoding UTF8;",
      'foreach($p in $items){',
      '  if(-not $p){continue}',
      '  try{',
      '    $img=[ShellThumb]::Get($p,96);',
      '    $bmp=New-Object System.Drawing.Bitmap 9,8;',
      '    $g=[System.Drawing.Graphics]::FromImage($bmp);',
      "    $g.InterpolationMode='HighQualityBicubic';",
      '    $g.DrawImage($img,0,0,9,8);',
      '    $g.Dispose();$img.Dispose();',
      '    $sb=New-Object System.Text.StringBuilder;',
      '    for($y=0;$y -lt 8;$y++){',
      '      for($x=0;$x -lt 8;$x++){',
      '        $a=$bmp.GetPixel($x,$y);$b=$bmp.GetPixel($x+1,$y);',
      '        $la=$a.R*0.299+$a.G*0.587+$a.B*0.114;',
      '        $lb=$b.R*0.299+$b.G*0.587+$b.B*0.114;',
      "        if($la -gt $lb){[void]$sb.Append('1')}else{[void]$sb.Append('0')}",
      '      }',
      '    }',
      '    $bmp.Dispose();',
      '    [Console]::Out.WriteLine($p+[char]9+$sb.ToString());',
      '  }catch{}',
      '}',
    ].join('\n');

    runPowerShell(script, (stdout) => {
      fs.unlink(listFile, () => {});
      const map = {};
      for (const line of stdout.split(/\r?\n/)) {
        const idx = line.lastIndexOf('\t');
        if (idx > 0) {
          const p = line.slice(0, idx);
          const bits = line.slice(idx + 1).trim();
          if (bits.length === 64) map[p] = bits;
        }
      }
      resolve(map);
    });
  });
}

/**
 * 画像群の知覚ハッシュ（dHash 64bit ビット文字列）をバッチで計算する。
 * バッチ間で pause/cancel を確認できる。
 * @param {string[]} paths
 * @param {import('./worker-control').WorkerControl} wc
 * @param {(done:number)=>void} onProgress
 * @returns {Promise<Record<string,string>>}
 */
async function computePerceptualHashes(paths, wc, onProgress) {
  const result = {};
  const BATCH = 150;
  let done = 0;
  for (let i = 0; i < paths.length; i += BATCH) {
    if (wc.wait()) return result;
    const slice = paths.slice(i, i + BATCH);
    const map = await runPhashBatch(slice);
    for (const k in map) result[k] = map[k];
    done += slice.length;
    if (onProgress) onProgress(done);
  }
  return result;
}

/**
 * 画像レコードのサムネイル（JPEG data URI）をバッチ生成する。
 * こちらもシェルサムネイルを使うため OneDrive 本体をダウンロードしない。
 * 結果カードの表示に用いる。
 * @param {Array<{id:string,path:string}>} items
 * @param {number} size 一辺のピクセル
 * @returns {Promise<Record<string,string>>} id -> data URI
 */
function generateThumbBatch(items, size) {
  return new Promise((resolve) => {
    if (!items.length) {
      resolve({});
      return;
    }
    const listFile = path.join(
      os.tmpdir(),
      'cleanup-thumb-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt'
    );
    try {
      fs.writeFileSync(listFile, items.map((it) => it.id + '\t' + it.path).join('\r\n'), 'utf8');
    } catch (e) {
      resolve({});
      return;
    }
    const esc = listFile.replace(/'/g, "''");
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      "$ErrorActionPreference='SilentlyContinue';",
      "Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'",
      ...SHELL_THUMB_CS,
      "'@",
      "$lines=Get-Content -LiteralPath '" + esc + "' -Encoding UTF8;",
      'foreach($ln in $lines){',
      '  if(-not $ln){continue}',
      '  $t=$ln.IndexOf([char]9); if($t -lt 0){continue}',
      '  $id=$ln.Substring(0,$t); $p=$ln.Substring($t+1);',
      '  try{',
      '    $img=[ShellThumb]::Get($p,' + size + ');',
      '    $ms=New-Object System.IO.MemoryStream;',
      '    $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg); $img.Dispose();',
      '    $b64=[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose();',
      '    [Console]::Out.WriteLine($id+[char]9+$b64);',
      '  }catch{}',
      '}',
    ].join('\n');

    runPowerShell(script, (stdout) => {
      fs.unlink(listFile, () => {});
      const map = {};
      for (const line of stdout.split(/\r?\n/)) {
        const idx = line.indexOf('\t');
        if (idx > 0) {
          const id = line.slice(0, idx);
          const b64 = line.slice(idx + 1).trim();
          if (b64) map[id] = 'data:image/jpeg;base64,' + b64;
        }
      }
      resolve(map);
    });
  });
}

module.exports = {
  SHELL_THUMB_CS,
  runPowerShell,
  runPhashBatch,
  computePerceptualHashes,
  generateThumbBatch,
};
