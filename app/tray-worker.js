// tray-worker.js — 自实现系统托盘的 worker 线程
// 替换 systray2: 其 Go 助手把「左键」也渲染成菜单, 与「左键弹卡片」天然冲突, 且二进制不可改。
// 这里全部原生: 隐藏窗口 + Shell_NotifyIconW + 消息循环(阻塞本 worker 无妨);
// 左键 → 事件给主线程(弹卡片), 右键 → 原生 TrackPopupMenu, 气泡通知也由它发。
'use strict';

const { parentPort } = require('worker_threads');
const koffi = require('koffi');

koffi.struct('TW_POINT', { X: 'long', Y: 'long' });
// 窗口类结构(必须先于 F 的 func 声明注册)
const BMTrayProc = koffi.proto('int64 BMTrayProc(uintptr_t hwnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const ProcPtr = koffi.pointer(BMTrayProc);
const WNDCLASSW = koffi.struct('BM_WNDCLASSW', {
  style: 'uint32',
  lpfnWndProc: ProcPtr,
  cbClsExtra: 'int32',
  cbWndExtra: 'int32',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'str16',
  lpszClassName: 'str16',
});

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');
const kernel32 = koffi.load('kernel32.dll');

const F = {
  GetModuleHandleW: kernel32.func('void *GetModuleHandleW(str16 name)'),
  RegisterClassW: user32.func('uint16 RegisterClassW(_In_ BM_WNDCLASSW *wc)'),
  CreateWindowExW: user32.func('uintptr_t CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int32 x, int32 y, int32 w, int32 h, uintptr_t parent, uintptr_t menu, void *inst, uintptr_t param)'),
  DefWindowProcW: user32.func('int64 DefWindowProcW(uintptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  GetMessageW: user32.func('int32 GetMessageW(_Out_ void *msg, uintptr_t h, uint32 min, uint32 max)'),
  PeekMessageW: user32.func('int32 PeekMessageW(_Out_ void *msg, uintptr_t h, uint32 min, uint32 max, uint32 remove)'),
  DispatchMessageW: user32.func('int64 DispatchMessageW(_In_ void *msg)'),
  PostQuitMessage: user32.func('void PostQuitMessage(int32 code)'),
  DestroyWindow: user32.func('int DestroyWindow(uintptr_t h)'),
  UnregisterClassW: user32.func('int UnregisterClassW(str16 cls, void *inst)'),
  PostMessageW: user32.func('int PostMessageW(uintptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  SetForegroundWindow: user32.func('int SetForegroundWindow(uintptr_t h)'),
  GetCursorPos: user32.func('int GetCursorPos(_Out_ TW_POINT *p)'),
  CreatePopupMenu: user32.func('uintptr_t CreatePopupMenu()'),
  AppendMenuW: user32.func('int AppendMenuW(uintptr_t menu, uint32 flags, uintptr_t id, str16 text)'),
  TrackPopupMenu: user32.func('int32 TrackPopupMenu(uintptr_t menu, uint32 flags, int32 x, int32 y, int32 reserved, uintptr_t h, void *rect)'),
  DestroyMenu: user32.func('int DestroyMenu(uintptr_t menu)'),
  LoadImageW: user32.func('uintptr_t LoadImageW(uintptr_t inst, str16 name, uint32 type, int32 cx, int32 cy, uint32 flags)'),
  DestroyIcon: user32.func('int DestroyIcon(uintptr_t icon)'),
  ShellNotifyIcon: shell32.func('int Shell_NotifyIconW(uint32 msg, void *nid)'),
};

const WM_NULL = 0, WM_DESTROY = 2;
const WM_APP_TRAY = 0x8001;                  // WM_APP+1, NOTIFYICONDATA 回调消息
const WM_LBUTTONUP = 0x0202, WM_RBUTTONUP = 0x0205;
const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2;
const NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4, NIF_INFO = 0x10;
const NIIF_INFO = 1;
const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10;
const MF_GRAYED = 1, MF_CHECKED = 8, MF_SEPARATOR = 0x800;
const TPM_RETURNCMD = 0x100, TPM_RIGHTBUTTON = 2, TPM_NONOTIFY = 0x80;
const WS_OVERLAPPED = 0;

// NOTIFYICONDATAW (x64) 手工布局, 总 976:
//  0 cbSize      8 hWnd        16 uID          20 uFlags        24 uCallbackMessage
// 32 hIcon      40 szTip[128w] 296 dwState    300 dwStateMask  304 szInfo[256w]
// 816 uVersion 820 szInfoTitle[64w] 948 dwInfoFlags 952 guidItem[16] 968 hBalloonIcon
const NID = Buffer.alloc(976);
NID.writeUInt32LE(976, 0);
NID.writeUInt32LE(1, 16);                    // uID
NID.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20);
NID.writeUInt32LE(WM_APP_TRAY, 24);

let hwnd = 0, hicon = 0, started = false, quitting = false;
let tip = '', items = [];
const send = (m) => { try { parentPort.postMessage(m); } catch { } };

// 往 NOTIFYICONDATAW 的 UTF-16 字段写字符串
function putStr(off, capBytes, s) {
  NID.fill(0, off, off + capBytes);
  if (s) Buffer.from(String(s).slice(0, capBytes / 2 - 1), 'utf16le').copy(NID, off);
}

// ---- 窗口类类型已在文件头注册(BMTrayProc / WNDCLASSW), 此处只建回调 ----
const wndProc = koffi.register((hwndP, msg, wp, lp) => {
  try {
    if (msg === WM_APP_TRAY) {
      const mouse = Number(BigInt.asUintN(32, BigInt(lp)));
      if (mouse === WM_LBUTTONUP) send({ type: 'leftclick' });
      else if (mouse === WM_RBUTTONUP) showMenu();
    } else if (msg === WM_DESTROY) {
      F.PostQuitMessage(0);
    }
  } catch (e) { send({ type: 'log', msg: 'WndProc 异常: ' + e.message }); }
  return F.DefWindowProcW(hwndP, msg, wp, lp);
}, ProcPtr);

function showMenu() {
  try {
    const pt = { X: 0, Y: 0 };
    F.GetCursorPos(pt);
    const hm = F.CreatePopupMenu();
    if (!hm) return;
    const idTitle = {};
    let id = 1;
    for (const it of items || []) {
      if (!it || it.hidden) continue;
      if (it.title === '<SEPARATOR>') { F.AppendMenuW(hm, MF_SEPARATOR, 0, '-'); continue; }
      let fl = 0;
      if (it.enabled === false) fl |= MF_GRAYED;
      if (it.checked) fl |= MF_CHECKED;
      const title = String(it.title == null ? '' : it.title);
      F.AppendMenuW(hm, fl, id, title);
      idTitle[id] = title;
      id++;
    }
    // SetForegroundWindow 是标准做法: 否则点击菜单外菜单不消失
    F.SetForegroundWindow(hwnd);
    const cmd = F.TrackPopupMenu(hm, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, pt.X, pt.Y, 0, hwnd, 0);
    F.PostMessageW(hwnd, WM_NULL, 0, 0);
    F.DestroyMenu(hm);
    if (cmd && idTitle[cmd]) send({ type: 'menu', title: idTitle[cmd] });
  } catch (e) { send({ type: 'log', msg: 'menu 失败: ' + e.message }); }
}

function applyIcon(p) {
  const h = F.LoadImageW(0, p, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
  if (!h) { send({ type: 'log', msg: 'LoadImage 失败: ' + p }); return false; }
  NID.writeBigUInt64LE(BigInt(h), 32);
  if (hicon) { try { F.DestroyIcon(hicon); } catch { } }
  hicon = h;
  return true;
}
function trayAdd() {
  NID.writeBigUInt64LE(BigInt(hwnd), 8);
  return F.ShellNotifyIcon(NIM_ADD, NID) !== 0;
}

function applyUpdate(m) {
  if (m.items) items = m.items;
  let touched = false;
  if (m.iconPath) touched = applyIcon(m.iconPath) || touched;
  if (m.tooltip != null && m.tooltip !== tip) { tip = m.tooltip; putStr(40, 256, tip); touched = true; }
  if (started && touched) F.ShellNotifyIcon(NIM_MODIFY, NID);
}

// 气泡通知(NIF_INFO): 代替原来的 PowerShell NotifyIcon 方案
function balloon(title, msg) {
  if (!started) return;
  const flags = NID.readUInt32LE(20);
  NID.writeUInt32LE(flags | NIF_INFO, 20);
  putStr(304, 512, msg);      // szInfo
  putStr(820, 128, title);    // szInfoTitle
  NID.writeUInt32LE(NIIF_INFO, 948);
  F.ShellNotifyIcon(NIM_MODIFY, NID);
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'init' || m.type === 'recreate') {
      items = m.items || items;
      if (m.tooltip != null) { tip = m.tooltip; putStr(40, 256, tip); }
      if (m.iconPath) applyIcon(m.iconPath);
      if (m.type === 'recreate' && started) {
        F.ShellNotifyIcon(NIM_DELETE, NID);
        started = trayAdd();
        send({ type: 'ready', ok: started });
        return;
      }
      started = trayAdd();
      send({ type: 'ready', ok: started });
    } else if (m.type === 'update') {
      applyUpdate(m);
    } else if (m.type === 'notify') {
      balloon(m.title, m.msg);
    } else if (m.type === 'quit') {
      if (started) {
        F.ShellNotifyIcon(NIM_DELETE, NID);
        started = false;
        if (hwnd) F.DestroyWindow(hwnd);
      }
      try { F.UnregisterClassW('BMTrayWnd', null); } catch { }
      quitting = true;   // step 轮询检测到后发 closed 并停止, worker 随之退出
    }
  } catch (e) { send({ type: 'log', msg: e.message }); }
});

// ---- 主入口: 注册窗口类 + 创建隐藏窗口 + 消息循环 ----
(function main() {
  try {
    const hInst = F.GetModuleHandleW(null);
    const ok = F.RegisterClassW({
      style: 0,
      lpfnWndProc: wndProc,
      cbClsExtra: 0, cbWndExtra: 0,
      hInstance: hInst, hIcon: null, hCursor: null, hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: 'BMTrayWnd',
    });
    // 窗口类是进程级的: 同进程重建托盘时同名类已存在, RegisterClass 会失败 —— 属预期, 继续创建
    if (!ok) send({ type: 'log', msg: 'RegisterClass 返回 0(同名类已注册, 继续用已有类)' });
    hwnd = F.CreateWindowExW(0, 'BMTrayWnd', 'BatteryMonitorTray', WS_OVERLAPPED, 0, 0, 0, 0, 0, 0, hInst, 0);
    if (!hwnd) { send({ type: 'log', msg: 'CreateWindow 失败' }); return; }
    send({ type: 'window' });
    // ⚠ 不能用阻塞的 GetMessageW: 它会把 worker 的 JS 事件循环堵死,
    // parentPort 消息(init/update/quit)将永远收不到。用 PeekMessage 轮询 + 定时让出。
    const PM_REMOVE = 1;
    const MSG = Buffer.alloc(64);
    const step = () => {
      if (quitting) { send({ type: 'closed' }); return; }
      try {
        while (F.PeekMessageW(MSG, 0, 0, 0, PM_REMOVE) > 0) F.DispatchMessageW(MSG);
      } catch (e) { send({ type: 'log', msg: 'peek 异常: ' + e.message }); }
      setTimeout(step, 50);   // 事件延迟 ≤50ms, 足够流畅
    };
    step();
  } catch (e) {
    send({ type: 'log', msg: 'worker 主循环异常: ' + (e.stack || e.message) });
  }
})();
