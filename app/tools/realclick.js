// realclick.js — 真实鼠标点击托盘图标复现卡片消失问题
// 流程: 定位托盘图标矩形 → SendInput 真实左键 → 50ms 粒度记录卡片可见性 + 前台窗口类
'use strict';
const koffi = require('koffi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');
koffi.struct('RC', { L: 'long', T: 'long', R: 'long', B: 'long' });
koffi.struct('PT', { X: 'long', Y: 'long' });
koffi.struct('NIID', { cbSize: 'uint32', hWnd: 'void *', uID: 'uint32', guid: koffi.array('uint8', 16) });

const F = {
  FindWindowW: user32.func('void *FindWindowW(str16 cls, str16 title)'),
  GetWindowRect: user32.func('int GetWindowRect(void *h, _Out_ RC *r)'),
  GetCursorPos: user32.func('int GetCursorPos(_Out_ PT *p)'),
  SetCursorPos: user32.func('int SetCursorPos(int x, int y)'),
  mouse_event: user32.func('void mouse_event(uint32 f, uint32 dx, uint32 dy, uint32 d, void *e)'),
  GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
  GetClassNameW: user32.func('int GetClassNameW(void *h, void *name, int max)'),
  IsWindowVisible: user32.func('int IsWindowVisible(void *h)'),
  Shell_NotifyIconGetRect: shell32.func('int32 Shell_NotifyIconGetRect(_In_ NIID *id, _Out_ RC *rect)'),
};

function clsOf(h) {
  if (!h) return '(none)';
  const b = Buffer.alloc(512);
  F.GetClassNameW(h, b, 256);
  const s = b.toString('utf16le').replace(/\0+$/, '');
  return s || '(?)';
}

(async () => {
  const tray = F.FindWindowW('BMTrayWnd', null);
  if (!tray) { console.log('FAIL: 无托盘窗口'); process.exit(1); }
  // 定位我们的托盘图标(先试 uID=100, 失败则 0..255 枚举取任务栏区内的矩形)
  let icon = null;
  const tryId = (u) => {
    const id = { cbSize: 40, hWnd: tray, uID: u, guid: new Array(16).fill(0) };
    const rc = { L: 0, T: 0, R: 0, B: 0 };
    if (F.Shell_NotifyIconGetRect(id, rc) === 0 && rc.R > rc.L && rc.B > rc.T && rc.T > 0) return rc;
    return null;
  };
  icon = tryId(100);
  if (!icon) for (let u = 0; u < 256 && !icon; u++) icon = tryId(u);
  if (!icon) { console.log('FAIL: 未定位到托盘图标'); process.exit(1); }
  const cx = Math.round((icon.L + icon.R) / 2), cy = Math.round((icon.T + icon.B) / 2);
  console.log(`托盘图标: (${icon.L},${icon.T})-(${icon.R},${icon.B}) 点击点 (${cx},${cy})`);

  const cur = { X: 0, Y: 0 };
  F.GetCursorPos(cur);

  const card = F.FindWindowW(null, 'BatteryMonitorCard');
  const t0 = Date.now();
  const states = [];
  const sample = () => {
    const fg = F.GetForegroundWindow();
    states.push({
      t: Date.now() - t0,
      vis: F.IsWindowVisible(card),
      fg: clsOf(fg),
    });
  };

  // 真实点击
  F.SetCursorPos(cx, cy);
  await sleep(200);
  F.mouse_event(0x0002, 0, 0, 0, null); // DOWN
  await sleep(90);
  F.mouse_event(0x0004, 0, 0, 0, null); // UP
  console.log('已真实点击托盘图标, 开始 12s 采样…');

  let lastVis = null, lastFg = '';
  for (let i = 0; i < 240; i++) {
    sample();
    const s = states[states.length - 1];
    if (s.vis !== lastVis) { console.log(`t=${String(s.t).padStart(5)}ms 卡片可见: ${lastVis} → ${s.vis}`); lastVis = s.vis; }
    if (s.fg !== lastFg) { console.log(`t=${String(s.t).padStart(5)}ms 前台: ${s.fg}`); lastFg = s.fg; }
    if (i > 40 && s.vis === 0 && lastVis === 0 && s.t > 10000) break;
    await sleep(50);
  }
  F.SetCursorPos(cur.X, cur.Y); // 恢复鼠标位置
  const shown = states.find((s) => s.vis === 1);
  const hidden = shown ? states.find((s) => s.t > shown.t && s.vis === 0) : null;
  console.log(shown ? `弹出耗时≈${shown.t}ms` : '卡片从未显示!');
  if (hidden) console.log(`⚠️ 卡片在弹出后 ${hidden.t - shown.t}ms 消失 (不符合 30s 驻留)`);
  else if (shown) console.log('卡片保持显示 >12s ✓');
  process.exit(0);
})();
