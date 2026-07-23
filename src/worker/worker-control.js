/**
 * @file worker/worker-control.js
 * pause/cancel 制御。SharedArrayBuffer(Int32Array) + Atomics で
 * メインスレッドからの指示を即時に反映する。
 *   control[0]: 0=running, 1=paused, 2=canceled
 */

'use strict';

class WorkerControl {
  /** @param {SharedArrayBuffer} control */
  constructor(control) {
    this.ctrl = new Int32Array(control);
    /** @type {(() => void)|null} pause 進入時のフック（バッチ flush 等）。 */
    this.onPause = null;
  }

  /** @returns {boolean} キャンセル済みか。 */
  get canceled() {
    return Atomics.load(this.ctrl, 0) === 2;
  }

  /**
   * pause 中は待機し、cancel されたら true を返す。
   * @returns {boolean}
   */
  wait() {
    while (Atomics.load(this.ctrl, 0) === 1) {
      if (this.onPause) this.onPause();
      Atomics.wait(this.ctrl, 0, 1, 250);
      if (this.canceled) return true;
    }
    return this.canceled;
  }
}

module.exports = { WorkerControl };
