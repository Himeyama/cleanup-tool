/**
 * @file env.js
 * ユーザーのシェルフォルダー実パス解決と環境パス定数。
 * メイン・Worker 双方から参照される。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * レジストリ HKCU\...\User Shell Folders から実際のシェルフォルダーパスを読む。
 * `reg.exe` はコンソールの OEM コードページ（日本語環境では Shift_JIS 系）で出力するため、
 * ここで単純に UTF-8 decode すると日本語パスが文字化けする。PowerShell 側で
 * `[Console]::OutputEncoding` を UTF-8 に固定してから出力させることで確実に読み取る
 * （サムネイル生成等、他の PowerShell 連携箇所と同じ手法）。
 * OneDrive の「フォルダー バックアップ」（Known Folder Move）が有効な環境では
 * Documents/Pictures/Desktop 等が %USERPROFILE% ではなく OneDrive 配下に
 * リダイレクトされるため、固定パスをハードコードせずここで解決する。
 * 取得に失敗した場合（レジストリ読み取り不可等）は空オブジェクトを返し、
 * 呼び出し側の既定パスにフォールバックする。
 * @returns {Record<string,string>} レジストリ値名 → 展開済み絶対パス
 */
function readUserShellFolders() {
  const result = {};
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    "$k=Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';" +
    'foreach($n in $k.Property){' +
    '  $v=$k.GetValue($n);' + // REG_EXPAND_SZ は既定で環境変数展開済みの値が返る
    '  if($v){[Console]::Out.WriteLine($n+[char]9+$v)}' +
    '}';
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    for (const line of out.split(/\r?\n/)) {
      const idx = line.indexOf('\t');
      if (idx <= 0) continue;
      const val = line.slice(idx + 1).trim();
      if (val) result[line.slice(0, idx)] = val;
    }
  } catch (e) {
    /* レジストリ参照に失敗した場合は空のまま（既定パスへフォールバック） */
  }
  return result;
}

const USER_SHELL_FOLDERS = readUserShellFolders();

/**
 * シェルフォルダーの実際のパスを返す。取得できなければ fallback を返す。
 * @param {string} valueName レジストリ値名（例: 'Personal', 'My Pictures'）
 * @param {string} fallback
 * @returns {string}
 */
function shellFolder(valueName, fallback) {
  const raw = USER_SHELL_FOLDERS[valueName];
  return raw ? path.normalize(raw) : fallback;
}

/**
 * OneDrive の「フォルダー バックアップ」が有効な場合、Documents/Pictures/Music は
 * 通常の Known Folder（'Personal' 等）とは別に、OneDrive 専用の Known Folder
 * （レジストリの GUID 値）としても登録される。バックアップが無効でも 'Personal' 等の
 * 通常キーはローカルパスのまま残り続けるため、そちらだけを見ると OneDrive が
 * 設定されていても見逃してしまう。OneDrive 側のフォルダが実在すれば優先する。
 * @param {string} oneDriveGuid OneDrive 専用 Known Folder の GUID 値名
 * @param {string} registryName 通常の Known Folder 値名（'Personal' 等）
 * @param {string} fallback
 * @returns {string}
 */
function preferredFolder(oneDriveGuid, registryName, fallback) {
  const raw = USER_SHELL_FOLDERS[oneDriveGuid];
  if (raw) {
    const p = path.normalize(raw);
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      /* noop: 通常キーへフォールバック */
    }
  }
  return shellFolder(registryName, fallback);
}

const ENV = {
  WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
  TEMP: process.env.TEMP || process.env.TMP || null,
  APPDATA: process.env.APPDATA || null,
  LOCALAPPDATA: process.env.LOCALAPPDATA || null,
  USERPROFILE: process.env.USERPROFILE || os.homedir(),
};
// OneDrive のフォルダー バックアップ等で実体が移動していても正しいパスを使えるよう、
// ユーザーフォルダはレジストリ経由で解決する（失敗時は %USERPROFILE% 配下にフォールバック）。
ENV.DESKTOP = shellFolder('Desktop', path.join(ENV.USERPROFILE, 'Desktop'));
ENV.DOCUMENTS = preferredFolder(
  '{24D89E24-2F19-4534-9DDE-6A6671FBB8FE}', // FOLDERID_SkyDriveDocuments
  'Personal',
  path.join(ENV.USERPROFILE, 'Documents')
);
ENV.PICTURES = preferredFolder(
  '{339719B5-8C47-4894-94C2-D8F77ADD44A6}', // FOLDERID_SkyDrivePictures
  'My Pictures',
  path.join(ENV.USERPROFILE, 'Pictures')
);
ENV.MUSIC = preferredFolder(
  '{C3F2459E-80D6-45DC-BFEF-1F769F2BE730}', // FOLDERID_SkyDriveMusic
  'My Music',
  path.join(ENV.USERPROFILE, 'Music')
);
ENV.VIDEOS = shellFolder('My Video', path.join(ENV.USERPROFILE, 'Videos'));
ENV.DOWNLOADS = shellFolder(
  '{374DE290-123F-4565-9164-39C4925E467B}',
  path.join(ENV.USERPROFILE, 'Downloads')
);

module.exports = { ENV };
