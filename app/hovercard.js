// hovercard.js — 托盘图标悬浮卡片(醒目小卡片, 显示全部设备电量)
// 独立顶层分层窗口 + GDI+ 绘制; 状态无变化不重画, 隐藏时不占 CPU。
// ⚠ 绝不 SetParent 到任务栏: 跨进程父子窗口会强制共享输入队列, node 一停顿 explorer 就挂死。
'use strict';

const DWELL = 380;   // 悬停多久弹出(ms)
const GRACE = 300;   // 离开后多久收起(ms)
const TICK_MS = 180;
const CARD_W = 296;  // 卡片宽(不含阴影留白)
const HEAD_H = 38;
const ROW_H = 56;
const FOOT_H = 30;
const M = 10;        // 阴影留白

const COL = {
  light: {
    bg: '#FFFFFF', border: '#00000018', title: '#6E6E73', name: '#1C1C1E', sub: '#86868B',
    barBg: '#EBEBEF', foot: '#9A9A9F', rowLow: '#DC262614', rowChg: '#0A84FF10',
    glyphBg: '#F1F1F0', glyph: '#57565A', shadowA: 14,
  },
  dark: {
    bg: '#1F1F23', border: '#FFFFFF20', title: '#A6A6AD', name: '#F2F2F7', sub: '#9C9CA3',
    barBg: '#35353C', foot: '#8A8A90', rowLow: '#FF453A1C', rowChg: '#4DA3FF16',
    glyphBg: '#2C2C31', glyph: '#D9D9DF', shadowA: 40,
  },
};
const STATE = {
  light: { good: '#16A34A', low: '#DC2626', charging: '#0A84FF', offline: '#8E8E93' },
  dark: { good: '#34D058', low: '#FF453A', charging: '#4DA3FF', offline: '#98989F' },
};
const KIND_LABEL = { mouse: '鼠标', keyboard: '键盘', headset: '耳机' };
const BRAND = { mchose: '迈从', aula: '狼蛛', atk: 'ATK' };

// 宽度估算截断(不调 GDI+ MeasureString: 本机构建上该接口会段错误)
function fit(str, maxW, px) {
  const w = (s) => [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? px : px * 0.56), 0);
  if (w(str) <= maxW) return str;
  let out = '';
  for (const ch of str) {
    if (w(out + ch + '…') > maxW) break;
    out += ch;
  }
  return out + '…';
}

let S = null;

// ---------- 颜色 ----------
function argb(s) {
  const h = s.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return (((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
}

// ---------- Win32 / GDI+ ----------
function loadLibs() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const gdiplus = koffi.load('gdiplus.dll');
  const shell32 = koffi.load('shell32.dll');
  koffi.struct('HC_RECT', { L: 'long', T: 'long', R: 'long', B: 'long' });
  koffi.struct('HC_POINT', { X: 'long', Y: 'long' });
  koffi.struct('HC_RECTF', { X: 'float', Y: 'float', W: 'float', H: 'float' });
  const F = {
    CreateWindowExW: user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)'),
    FindWindowW: user32.func('void *FindWindowW(str16 cls, str16 title)'),
    FindWindowExW: user32.func('void *FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
    IsWindow: user32.func('int IsWindow(void *h)'),
    DestroyWindow: user32.func('int DestroyWindow(void *h)'),
    SetWindowPos: user32.func('int SetWindowPos(void *h, void *after, int32 x, int32 y, int32 w, int32 hh, uint32 flags)'),
    GetWindowRect: user32.func('int GetWindowRect(void *h, _Out_ HC_RECT *r)'),
    ShowWindow: user32.func('int ShowWindow(void *h, int32 cmd)'),
    UpdateLayeredWindow: user32.func('int UpdateLayeredWindow(void *h, void *hdcDst, void *pptDst, void *size, void *hdcSrc, void *ptSrc, uint32 crKey, void *blend, uint32 flags)'),
    GetDC: user32.func('void *GetDC(void *h)'),
    GetCursorPos: user32.func('int GetCursorPos(_Out_ HC_POINT *p)'),
    GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int32 key)'),
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    GetDpiForSystem: user32.func('uint32 GetDpiForSystem()'),
    SetProcessDPIAware: user32.func('int SetProcessDPIAware()'),
    // uintptr_t 版本: 需要把句柄写进 Shell_NotifyIconGetRect 的参数, 要数值形式
    FindWindowPtr: koffi.load('user32.dll').func('uintptr_t FindWindowW(str16 cls, str16 title)'),
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
    GdiplusStartup: gdiplus.func('int32 GdiplusStartup(_Out_ void **token, _In_ void *input, void *out)'),
    CreateBitmapFromScan0: gdiplus.func('int32 GdipCreateBitmapFromScan0(int32 w, int32 h, int32 stride, int32 fmt, void *scan0, _Out_ void **bmp)'),
    GetImageGraphicsContext: gdiplus.func('int32 GdipGetImageGraphicsContext(void *img, _Out_ void **gfx)'),
    CreateHBITMAPFromBitmap: gdiplus.func('int32 GdipCreateHBITMAPFromBitmap(void *bmp, _Out_ void **hbm, uint32 bg)'),
    DisposeImage: gdiplus.func('int32 GdipDisposeImage(void *img)'),
    DeleteGraphics: gdiplus.func('int32 GdipDeleteGraphics(void *gfx)'),
    SetSmoothingMode: gdiplus.func('int32 GdipSetSmoothingMode(void *gfx, int32 mode)'),
    SetTextRenderingHint: gdiplus.func('int32 GdipSetTextRenderingHint(void *gfx, int32 mode)'),
    CreateSolidFill: gdiplus.func('int32 GdipCreateSolidFill(uint32 argb, _Out_ void **brush)'),
    DeleteBrush: gdiplus.func('int32 GdipDeleteBrush(void *brush)'),
    CreatePen1: gdiplus.func('int32 GdipCreatePen1(uint32 argb, float width, int32 unit, _Out_ void **pen)'),
    DeletePen: gdiplus.func('int32 GdipDeletePen(void *pen)'),
    CreatePath: gdiplus.func('int32 GdipCreatePath(int32 fillmode, _Out_ void **path)'),
    AddPathArc: gdiplus.func('int32 GdipAddPathArc(void *path, float x, float y, float w, float h, float start, float sweep)'),
    CloseFigure: gdiplus.func('int32 GdipClosePathFigure(void *path)'),
    DeletePath: gdiplus.func('int32 GdipDeletePath(void *path)'),
    FillPath: gdiplus.func('int32 GdipFillPath(void *gfx, void *brush, void *path)'),
    DrawPath: gdiplus.func('int32 GdipDrawPath(void *gfx, void *pen, void *path)'),
    FillRectangle: gdiplus.func('int32 GdipFillRectangle(void *gfx, void *brush, float x, float y, float w, float h)'),
    DrawLine: gdiplus.func('int32 GdipDrawLine(void *gfx, void *pen, float x1, float y1, float x2, float y2)'),
    CreateFontFamilyFromName: gdiplus.func('int32 GdipCreateFontFamilyFromName(str16 name, void *collection, _Out_ void **family)'),
    CreateFont: gdiplus.func('int32 GdipCreateFont(void *family, float size, int32 style, int32 unit, _Out_ void **font)'),
    // 托盘图标矩形(systray2 助手的左键事件不吐给 Node, 左键弹卡片只能自己检测)
    ShellNotifyIconGetRect: shell32.func('int32 Shell_NotifyIconGetRect(void *id, _Out_ HC_RECT *r)'),
    DeleteFont: gdiplus.func('int32 GdipDeleteFont(void *font)'),
    StringFormatGetGenericDefault: gdiplus.func('int32 GdipStringFormatGetGenericDefault(_Out_ void **fmt)'),
    CreateStringFormat: gdiplus.func('int32 GdipCreateStringFormat(int32 flags, int32 lang, _Out_ void **fmt)'),
    SetStringFormatAlign: gdiplus.func('int32 GdipSetStringFormatAlign(void *fmt, int32 align)'),
    SetStringFormatLineAlign: gdiplus.func('int32 GdipSetStringFormatLineAlign(void *fmt, int32 align)'),
    DrawString: gdiplus.func('int32 GdipDrawString(void *gfx, str16 str, int32 len, void *font, _In_ HC_RECTF *layout, void *format, void *brush)'),
  };
  return F;
}

// ---------- 状态 ----------
function log(msg) { try { if (S && S.opts.log) S.opts.log('[卡片] ' + msg); } catch { } }
const rectOf = (h) => { const r = { L: 0, T: 0, R: 0, B: 0 }; S.fn.GetWindowRect(h, r); return r; };
const cursor = () => { const p = { X: 0, Y: 0 }; S.fn.GetCursorPos(p); return p; };
const inRect = (p, r) => p.X >= r.L && p.X <= r.R && p.Y >= r.T && p.Y <= r.B;

function init(opts) {
  if (S) return true;
  let F;
  try { F = loadLibs(); } catch (e) { return false; }
  const input = Buffer.alloc(32); input.writeUInt32LE(1, 0); // GdiplusStartupInput, version 1
  const token = [null];
  if (F.GdiplusStartup(token, input, null) !== 0) return false;
  try { F.SetProcessDPIAware(); } catch { }
  let scale = 1;
  try { scale = Math.max(1, (F.GetDpiForSystem() || 96) / 96); } catch { }

  S = {
    fn: F, opts, scale, hwnd: null, taskbar: null, hdcc: null, hdcm: null,
    visible: false, hoverAt: 0, leaveAt: 0, prevDown: false, topTick: 0,
    pinnedUntil: 0, lastOpen: 0,
    iconRect: null, iconUid: -1, iconTick: 99,
    rect: { L: 0, T: 0, R: 0, B: 0 }, fonts: new Map(), fmts: new Map(), family: null,
    lastSig: '', timer: null,
  };
  // 字体族: 优先微软雅黑 UI(中英混排都清晰)
  for (const name of ['Microsoft YaHei UI', 'Segoe UI']) {
    const fam = [null];
    if (F.CreateFontFamilyFromName(name, null, fam) === 0) { S.family = fam[0]; break; }
  }
  if (!S.family) { S = null; return false; }

  if (!ensureWindow()) { S = null; return false; }
  S.timer = setInterval(tick, TICK_MS);
  if (S.timer.unref) S.timer.unref();
  log('已启动 scale=' + scale);
  return true;
}

function ensureWindow() {
  const F = S.fn;
  if (S.hwnd && F.IsWindow(S.hwnd)) return true;
  S.taskbar = F.FindWindowW('Shell_TrayWnd', null);
  if (!S.taskbar) return false;
  // 清理上次异常退出的孤儿窗口
  for (let i = 0; i < 5; i++) {
    const orphan = F.FindWindowW(null, 'BatteryMonitorCard');
    if (!orphan) break;
    try { if (!F.DestroyWindow(orphan)) break; } catch { break; }
  }
  const WS_POPUP = 0x80000000;
  const WS_EX_LAYERED = 0x80000, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000, WS_EX_TOPMOST = 0x8;
  const hwnd = F.CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
    'Static', 'BatteryMonitorCard', WS_POPUP, -32000, -32000, 1, 1, null, null, null, null);
  if (!hwnd) return false;
  S.hwnd = hwnd;
  if (!S.hdcc) S.hdcc = F.GetDC(null);
  if (!S.hdcm) S.hdcm = F.CreateCompatibleDC(S.hdcc);
  return true;
}

// ---------- 绘制基础 ----------
function fontOf(px, bold) {
  const key = px + (bold ? 'b' : '');
  if (S.fonts.has(key)) return S.fonts.get(key);
  const f = [null];
  const style = bold ? 1 : 0; // FontStyleBold
  const r = S.fn.CreateFont(S.family, px, style, 2 /*UnitPixel*/, f);
  const val = r === 0 ? f[0] : null;
  S.fonts.set(key, val);
  return val;
}
function fmtOf(align) {
  if (S.fmts.has(align)) return S.fmts.get(align);
  // 注意: GdipStringFormatGetGenericDefault 返回的是全局共享对象,
  // 直接对它 SetStringFormatAlign 会污染其它文本 → 必须自建实例
  const f = [null];
  const ok = S.fn.CreateStringFormat(0, 0, f) === 0;
  const val = ok ? f[0] : null;
  if (val) {
    S.fn.SetStringFormatAlign(val, align || 0);
    S.fn.SetStringFormatLineAlign(val, 0);
  }
  S.fmts.set(align, val);
  return val;
}
function roundPath(x, y, w, h, r) {
  const F = S.fn;
  const path = [null];
  if (F.CreatePath(0, path) !== 0) return null;
  const rr = Math.min(r, w / 2, h / 2);
  F.AddPathArc(path[0], x, y, rr * 2, rr * 2, 180, 90);
  F.AddPathArc(path[0], x + w - rr * 2, y, rr * 2, rr * 2, 270, 90);
  F.AddPathArc(path[0], x + w - rr * 2, y + h - rr * 2, rr * 2, rr * 2, 0, 90);
  F.AddPathArc(path[0], x, y + h - rr * 2, rr * 2, rr * 2, 90, 90);
  F.CloseFigure(path[0]);
  return path[0];
}
function fillRound(gfx, x, y, w, h, r, color) {
  if (w <= 0 || h <= 0) return;
  const F = S.fn;
  const p = roundPath(x, y, w, h, r);
  if (!p) return;
  const b = [null];
  if (F.CreateSolidFill(argb(color), b) === 0) { F.FillPath(gfx, b[0], p); F.DeleteBrush(b[0]); }
  F.DeletePath(p);
}
function strokeRound(gfx, x, y, w, h, r, color, width) {
  const F = S.fn;
  const p = roundPath(x, y, w, h, r);
  if (!p) return;
  const pen = [null];
  if (F.CreatePen1(argb(color), width, 2, pen) === 0) { F.DrawPath(gfx, pen[0], p); F.DeletePen(pen[0]); }
  F.DeletePath(p);
}
function text(gfx, str, x, y, w, h, px, color, bold, align) {
  const F = S.fn;
  const font = fontOf(px, bold), fmt = fmtOf(align || 0);
  if (!font) return;
  const b = [null];
  if (F.CreateSolidFill(argb(color), b) !== 0) return;
  F.DrawString(gfx, str, str.length, font, { X: x, Y: y, W: w, H: h }, fmt, b[0]);
  F.DeleteBrush(b[0]);
}
function glyph(gfx, kind, cx, cy, color) {
  const F = S.fn;
  const pen = [null];
  if (F.CreatePen1(argb(color), 1.7, 2, pen) !== 0) return;
  const brush = [null];
  F.CreateSolidFill(argb(color), brush);
  try {
    if (kind === 'mouse') {
      const p = roundPath(cx - 5, cy - 8, 10, 16, 5);
      if (p) { F.DrawPath(gfx, pen[0], p); F.DeletePath(p); }
      F.DrawLine(gfx, pen[0], cx, cy - 7, cx, cy - 1);
    } else if (kind === 'keyboard') {
      const p = roundPath(cx - 8, cy - 5, 16, 10, 2);
      if (p) { F.DrawPath(gfx, pen[0], p); F.DeletePath(p); }
      if (brush[0]) {
        for (let i = -1; i <= 1; i++) F.FillRectangle(gfx, brush[0], cx + i * 3.6 - 1, cy - 2, 2, 2);
        F.FillRectangle(gfx, brush[0], cx - 4, cy + 2, 8, 1.6);
      }
    } else {
      const p = roundPath(cx - 7.5, cy - 5, 13, 10, 2);
      if (p) { F.DrawPath(gfx, pen[0], p); F.DeletePath(p); }
      if (brush[0]) F.FillRectangle(gfx, brush[0], cx + 6, cy - 2, 2, 4);
    }
  } finally {
    F.DeletePen(pen[0]);
    if (brush[0]) F.DeleteBrush(brush[0]);
  }
}

// ---------- 渲染 ----------
function render() {
  const F = S.fn;
  const dark = !!S.opts.getTheme();
  const C = dark ? COL.dark : COL.light;
  const T = dark ? STATE.dark : STATE.light;
  const low = S.opts.getLow() || 20;
  const all = (S.opts.getData() || []).filter((d) => d.present !== false);
  const score = (d) => (d.ok && d.linked && Number.isFinite(d.battery) ? d.battery : 999);
  const devs = all.slice().sort((a, b) => score(a) - score(b));
  const rows = devs.slice(0, 4);
  const extra = devs.length - rows.length;

  const cardH = HEAD_H + Math.max(rows.length, 1) * ROW_H + FOOT_H + (extra > 0 ? 16 : 0);
  const W = CARD_W + M * 2, H = cardH + M * 2;
  const buf = Buffer.alloc(W * H * 4); // 全透明
  const bmp = [null], gfx = [null];
  if (F.CreateBitmapFromScan0(W, H, W * 4, 0x0026200A /*ARGB*/, buf, bmp) !== 0) return;
  if (F.GetImageGraphicsContext(bmp[0], gfx) !== 0) { F.DisposeImage(bmp[0]); return; }
  F.SetSmoothingMode(gfx[0], 4);      // AntiAlias
  F.SetTextRenderingHint(gfx[0], 4);  // AntiAliasGridFit

  // 阴影(多层半透明圆角矩形, 由外到内叠加 ≈ 柔和投影)
  const shHex = '#000000' + C.shadowA.toString(16).padStart(2, '0');
  for (let i = 5; i >= 1; i--) {
    fillRound(gfx[0], M - i, M - i + 3, CARD_W + i * 2, cardH + i * 2, 12 + i, shHex);
  }
  // 卡片主体
  fillRound(gfx[0], M, M, CARD_W, cardH, 12, C.bg);
  strokeRound(gfx[0], M + 0.5, M + 0.5, CARD_W - 1, cardH - 1, 12, C.border, 1);

  // ---- 头部 ----
  const worst = rows[0];
  const worstState = !worst ? 'offline'
    : !(worst.ok && worst.linked) ? 'offline' : worst.charging ? 'charging'
      : (Number.isFinite(worst.battery) && worst.battery <= low) ? 'low' : 'good';
  const dot = [null];
  if (F.CreateSolidFill(argb(T[worstState]), dot) !== 0) {
    const p = roundPath(M + 18, M + 14, 8, 8, 4);
    if (p) { F.FillPath(gfx[0], dot[0], p); F.DeletePath(p); }
    F.DeleteBrush(dot[0]);
  }
  text(gfx[0], '电量监控', M + 33, M + 10, 120, 18, 12, C.title, true, 0);
  const d = new Date();
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  text(gfx[0], '更新 ' + hhmm, M + CARD_W - 130, M + 11, 116, 16, 10.5, C.foot, false, 2);

  // ---- 设备行 ----
  const bodyTop = M + HEAD_H;
  if (!rows.length) {
    text(gfx[0], '未发现已支持的设备', M, bodyTop + 16, CARD_W, 24, 13, C.sub, false, 1);
  }
  rows.forEach((dv, i) => {
    const y = bodyTop + i * ROW_H;
    const online = !!(dv.ok && dv.linked);
    const bat = Number.isFinite(dv.battery) ? Math.round(dv.battery) : null;
    const st = !online ? 'offline' : dv.charging ? 'charging' : (bat !== null && bat <= low) ? 'low' : 'good';
    const col = T[st];
    if (st === 'low') fillRound(gfx[0], M + 8, y + 3, CARD_W - 16, ROW_H - 8, 9, C.rowLow);
    else if (dv.charging) fillRound(gfx[0], M + 8, y + 3, CARD_W - 16, ROW_H - 8, 9, C.rowChg);
    fillRound(gfx[0], M + 16, y + 12, 30, 30, 9, C.glyphBg);
    glyph(gfx[0], dv.kind, M + 31, y + 27, C.glyph);
    // 名称(离线时用品牌名兜底)
    const name = fit(dv.device || BRAND[dv.key] || dv.key || '设备', 128, 13);
    text(gfx[0], name, M + 56, y + 7, 130, 20, 13, C.name, true, 0);
    // 状态副标题
    const sub = !online
      ? (dv.present === false ? '接收器未连接' : dv.linked ? '无应答' : '离线/休眠')
      : dv.charging ? '充电中' : dv.full ? '已充满' : '在线';
    text(gfx[0], fit((KIND_LABEL[dv.kind] || '设备') + ' · ' + sub, 128, 10.5), M + 56, y + 25, 130, 14, 10.5, C.sub, false, 0);
    // 电量条(与副标题留出间距)
    fillRound(gfx[0], M + 56, y + 41, 108, 4.5, 2.2, C.barBg);
    if (bat !== null) fillRound(gfx[0], M + 56, y + 41, Math.max(6, Math.round(108 * Math.min(100, bat) / 100)), 4.5, 2.2, col);
    // 百分比(右对齐大号)
    text(gfx[0], bat !== null ? String(bat) + '%' : '--', M + CARD_W - 106, y + 11, 90, 28, 22, col, true, 2);
  });

  // ---- 底部 ----
  const footY = bodyTop + Math.max(rows.length, 1) * ROW_H + (extra > 0 ? 16 : 0);
  if (extra > 0) text(gfx[0], '还有 ' + extra + ' 台设备…', M, footY - 16, CARD_W, 14, 10, C.foot, false, 1);
  const linePen = [null];
  if (F.CreatePen1(argb(C.border), 1, 2, linePen) === 0) {
    F.DrawLine(gfx[0], linePen[0], M + 16, footY + 1, M + CARD_W - 16, footY + 1);
    F.DeletePen(linePen[0]);
  }
  text(gfx[0], '点击卡片打开详情页', M, footY + 7, CARD_W, 16, 10.5, C.foot, false, 1);

  // ---- 提交 ----
  const hbm = [null];
  if (F.CreateHBITMAPFromBitmap(bmp[0], hbm, 0) !== 0) { F.DeleteGraphics(gfx[0]); F.DisposeImage(bmp[0]); return; }
  const old = F.SelectObject(S.hdcm, hbm[0]);

  const tb = rectOf(S.taskbar);
  let px = tb.R - 10 - CARD_W - M;
  let py = tb.T - 6 - cardH - M;
  if (tb.T < 80) py = tb.B + 6 - M;              // 任务栏在顶部时改放下方
  if (px < 8) px = 8;
  if (py < 8) py = 8;

  F.SetWindowPos(S.hwnd, null, px, py, W, H, 0x14); // SWP_NOZORDER|SWP_NOACTIVATE
  // SIZE / POINT / BLENDFUNCTION 用手工 Buffer
  const size = Buffer.alloc(8); size.writeInt32LE(W, 0); size.writeInt32LE(H, 4);
  const ptDst = Buffer.alloc(8); ptDst.writeInt32LE(px, 0); ptDst.writeInt32LE(py, 4);
  const ptSrc = Buffer.alloc(8);
  const blend = Buffer.alloc(4); blend[0] = 0; blend[1] = 0; blend[2] = 255; blend[3] = 1;
  F.UpdateLayeredWindow(S.hwnd, S.hdcc, ptDst, size, S.hdcm, ptSrc, 0, blend, 2 /*ULW_ALPHA*/);

  F.SelectObject(S.hdcm, old);
  F.DeleteObject(hbm[0]);
  F.DeleteGraphics(gfx[0]);
  F.DisposeImage(bmp[0]);

  S.rect = { L: px, T: py, R: px + W, B: py + H };
  S.lastSig = sig();
}

function sig() {
  const low = S.opts.getLow() || 20;
  return JSON.stringify([
    S.opts.getTheme() ? 1 : 0, low,
    (S.opts.getData() || []).map((d) => [d.key, d.device, d.battery, d.charging, d.full, d.linked, d.ok, d.present, d.kind]),
    rectOf(S.taskbar),
  ]);
}

// ---------- 显隐 ----------
function show() {
  if (!ensureWindow()) return;
  S.visible = true;
  S.fn.ShowWindow(S.hwnd, 4); // SW_SHOWNOACTIVATE
  render();
}
function hide() {
  if (!S || !S.hwnd) return;
  S.visible = false;
  S.hoverAt = 0;
  S.leaveAt = 0;
  S.pinnedUntil = 0;
  try { S.fn.ShowWindow(S.hwnd, 0); } catch { }
}

// ---------- 托盘图标位置 ----------
// systray2 助手(Go, 窗口类 SystrayClass)左键不发消息给 Node → 左键弹卡片只能自己检测。
// 用 Shell_NotifyIconGetRect 拿图标的精确矩形(命中过的 uID 记住, 下次先试它)。
function resolveIconRect() {
  const F = S.fn;
  const h = F.FindWindowPtr('SystrayClass', null);
  if (!h) return null;
  const uids = [];
  if (S.iconUid >= 0) uids.push(S.iconUid);
  for (let u = 0; u <= 255; u++) if (u !== S.iconUid) uids.push(u);
  for (const uid of uids) {
    const id = Buffer.alloc(40);
    id.writeUInt32LE(40, 0);              // cbSize
    id.writeBigUInt64LE(BigInt(h), 8);    // hWnd
    id.writeUInt32LE(uid, 16);            // uID
    const r = { L: 0, T: 0, R: 0, B: 0 };
    if (F.ShellNotifyIconGetRect(id, r) === 0 && r.R > r.L && r.B > r.T) {
      const w = r.R - r.L, hh = r.B - r.T;
      if (w > 8 && w < 96 && hh > 8 && hh < 96) { S.iconUid = uid; return r; }
    }
  }
  return null;
}

function openUrl() {
  // ⚠ 不能用 ShellExecuteW: Node 主线程没有初始化 COM, 点击触发会崩掉整个进程。
  // 走 daemon 注入的 onOpen(cmd /c start, 托盘菜单同款, 稳定)。
  try { if (S.opts.onOpen) S.opts.onOpen(); } catch { }
}

// ---------- 主循环 ----------
function tick() {
  if (!S || !S.hwnd) return;
  const F = S.fn;
  if (!S.taskbar || !F.IsWindow(S.taskbar)) {
    S.taskbar = F.FindWindowW('Shell_TrayWnd', null);
    if (!S.taskbar) { hide(); return; }
  }
  const tb = rectOf(S.taskbar);
  const cp = cursor();

  // 全屏应用 → 收起(不打扰)
  let fs = false;
  const fg = F.GetForegroundWindow();
  if (fg) {
    const fr = rectOf(fg);
    if (fr.L <= tb.L && fr.T <= tb.T && fr.R >= tb.R && fr.B >= tb.B) fs = true;
  }

  // 悬停区: 托盘图标区(排除右侧时钟)
  let hoverTray = false;
  const tn = F.FindWindowExW(S.taskbar, null, 'TrayNotifyWnd', null);
  if (tn) {
    const tr = rectOf(tn);
    const clockW = Math.round(84 * S.scale);
    hoverTray = cp.X >= tr.L + 2 && cp.X <= tr.R - clockW && cp.Y >= tr.T && cp.Y <= tr.B;
  }
  const overCard = S.visible && inRect(cp, S.rect);
  const now = Date.now();
  const want = !fs && (hoverTray || overCard || now < (S.pinnedUntil || 0));

  if (want) {
    S.leaveAt = 0;
    if (!S.hoverAt) S.hoverAt = now;
  } else {
    S.hoverAt = 0;
    if (S.visible && !S.leaveAt) S.leaveAt = now;
  }
  if (!S.visible && S.hoverAt && now - S.hoverAt >= DWELL) show();
  else if (S.visible && !want && S.leaveAt && now - S.leaveAt >= GRACE) hide();

  // 左键检测: MSB=正按着; LSB=自上次查询以来按过(快速点击不漏检)
  const lv = F.GetAsyncKeyState(0x01);
  const lDown = ((lv & 0x8000) | (lv & 0x0001)) !== 0;

  // 图标矩形: 每 ~5s 刷新(托盘重建/移动), 解析失败则 2s 后重试
  S.iconTick++;
  if (S.iconRect ? S.iconTick >= 28 : S.iconTick >= 11) {
    S.iconTick = 0;
    S.iconRect = resolveIconRect();
  }

  // 托盘图标左键 → 弹卡片
  if (lDown && !S.prevDown && !fs && S.iconRect && inRect(cp, S.iconRect)) reveal();

  // 卡片内点击 → 打开详情页(去抖: 一次点击只开一次)
  if (S.visible && lDown && !S.prevDown && overCard && Date.now() - (S.lastOpen || 0) > 1500) {
    S.lastOpen = Date.now();
    openUrl();
  }
  S.prevDown = lDown;

  // 数据/主题变化 → 重绘(仅在可见时)
  if (S.visible && sig() !== S.lastSig) render();

  // 周期重申置顶(explorer 会把自己顶回最上层)
  if (S.visible && ++S.topTick >= 16) {
    S.topTick = 0;
    try { F.SetWindowPos(S.hwnd, -1, 0, 0, 0, 0, 0x13); } catch { }
  }
}

// 左键托盘图标 → 直接弹出卡片(短暂驻留, 鼠标离开后照常收起)
function reveal() {
  if (!S) return;
  S.pinnedUntil = Date.now() + 2500;
  show();
}

function dispose() {
  if (!S) return;
  try { clearInterval(S.timer); } catch { }
  try { if (S.hwnd) S.fn.DestroyWindow(S.hwnd); } catch { }
  S = null;
}

// 数据更新时调用: 可见则重绘
function notify() {
  if (!S || !S.visible) return;
  try { render(); } catch { }
}

module.exports = { init, notify, dispose, hide, reveal };
