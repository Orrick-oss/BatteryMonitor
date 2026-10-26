// traywin.js — 自实现系统托盘的主线程封装
// 用法:
//   const tray = new TrayWin({ onLeftClick, onMenu, onLost, log });
//   tray.update({ icon: base64ICO, tooltip, items, recreate });
//   tray.notify(title, msg);          // 气泡通知
//   tray.kill();
// worker 退出(被杀/异常) → onLost 回调, 由 daemon 重建。
'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

class TrayWin {
  constructor(opts = {}) {
    this.log = opts.log || (() => { });
    this.onLeftClick = opts.onLeftClick || null;
    this.onMenu = opts.onMenu || null;
    this.onLost = opts.onLost || null;
    this._slot = 0;
    this._dead = false;
    this._ready = false;
    this._pending = null;
    this.w = new Worker(path.join(__dirname, 'tray-worker.js'));
    this.w.on('message', (m) => this._onMsg(m));
    this.w.on('exit', () => {
      if (!this._dead && this.onLost) { try { this.onLost(); } catch { } }
    });
    this.w.on('error', (e) => this.log('[托盘] worker 异常: ' + e.message));
  }

  _onMsg(m) {
    if (m.type === 'window') {
      // worker 窗口就绪 → 发第一条 init(含图标/菜单), worker 收到后 NIM_ADD
      this._ready = true;
      const p = this._pending;
      if (p) { this._pending = null; this.w.postMessage({ ...p, type: 'init' }); }
      else this.w.postMessage({ type: 'init' });
    } else if (m.type === 'ready') {
      const p = this._pending;
      if (p) { this._pending = null; this.update(p); }
    } else if (m.type === 'leftclick') {
      try { if (this.onLeftClick) this.onLeftClick(); } catch { }
    } else if (m.type === 'menu') {
      try { if (this.onMenu) this.onMenu(m.title); } catch { }
    } else if (m.type === 'closed') {
      this._dead = true;
    } else if (m.type === 'log') {
      this.log('[托盘] ' + m.msg);
    }
  }

  // icon: base64 ICO(可空); items: {title, tooltip?, checked?, enabled?, hidden?}[]
  update({ icon, tooltip, items, recreate }) {
    const msg = { type: recreate ? 'recreate' : 'update', tooltip, items };
    const p = this._writeIcon(icon);
    if (p) msg.iconPath = p;
    if (!this._ready) { this._pending = msg; return; }
    this.w.postMessage(msg);
  }

  _writeIcon(b64) {
    if (!b64) return null;
    try {
      this._slot ^= 1;  // 双文件交替, 避免写盘与 LoadImage 读盘撞车
      const p = path.join(os.tmpdir(), `BatteryMonitor-tray-${this._slot}.ico`);
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      return p;
    } catch (e) { this.log('[托盘] 图标写盘失败: ' + e.message); return null; }
  }

  notify(title, msg) {
    if (this._ready) this.w.postMessage({ type: 'notify', title, msg });
  }

  kill() {
    this._dead = true;
    try { this.w.postMessage({ type: 'quit' }); } catch { }
  }

  terminate() {
    this._dead = true;
    try { this.w.terminate(); } catch { }
  }
}

module.exports = { TrayWin };
