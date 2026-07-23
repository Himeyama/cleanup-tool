/**
 * @file sse-hub.js
 * SSE 接続を束ね、名前付きイベントを全クライアントへ配信する。
 */

'use strict';

class SseHub {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set();
    // 接続維持のためのハートビート
    this.timer = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          /* noop */
        }
      }
    }, 15000);
    this.timer.unref();
  }

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
  add(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  /**
   * 名前付きイベントを配信する。
   * @param {string} event
   * @param {object} data
   */
  send(event, data) {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch (e) {
        /* noop */
      }
    }
  }
}

module.exports = { SseHub };
