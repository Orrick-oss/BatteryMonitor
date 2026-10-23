// 任务栏电量贴片: 真嵌进任务栏(Shell_TrayWnd 子窗口), 分层窗口 UpdateLayeredWindow 提交
// GDI+ 抗锯齿 ARGB 位图。实现要点参考 vigil-watt TaskbarPillWindow (MIT):
//   - SetParent + WS_CHILD 化 + WS_EX_LAYERED 三道锁
//   - Win11 会吃掉子窗口鼠标消息 → 轮询 GetAsyncKeyState 检测点击
//   - explorer 重建任务栏时子窗口随之销毁 → tick 里检查并整体重建
// 本实现: koffi 3(预编译 FFI, 免编译器) + GDI+ 扁平 API, 跑在 daemon 进程内(零新进程),
// 数据直接来自 daemon 内存。
// koffi 3 用法要点: 结构体参数直接传普通 JS 对象(出参会被原地填充); 回调用
// koffi.register(fn, koffi.pointer(proto)); ARGB 像素格式才接受外部 scan0。
'use strict';
let koffi = null;
try { koffi = require('koffi'); } catch { koffi = null; }

// ---------- 状态色 (vigil-watt UiPalette) ----------
const COL = {
  goodLight: 0xFF16A34A, goodDark: 0xFF4ADE80,
  redLight: 0xFFDC2626, redDark: 0xFFF87171,
  blue: 0xFF0A84FF, gray: 0xFF8E8E93,
  bgLight: 0xEBE9E9E7, bgDark: 0xE12B2B2B,
  glyphLight: 0xFF5F5E5A, glyphDark: 0xFFDDDDDD,
  sepLight: 0x789CA3AF, sepDark: 0x8C777777,
};
const PXF_ARGB = 0x0026200A;
const UnitPixel = 2, StyleBold = 1, SmoothingAA = 4, TextAA = 3, FillAlternate = 0;

let S = null;        // 初始化后的句柄集合
let tickTimer = null;
let prevDown = false;

function log(msg) {
  try {
    require('fs').appendFileSync(require('path').join(__dirname, 'data', 'pill.log'),
      new Date().toISOString() + ' ' + msg + '\n');
  } catch { }
}

function init(opts) {
  if (!koffi) { log('koffi 不可用, 贴片禁用'); return false; }
  try { return setup(opts); } catch (e) { log('初始化失败: ' + (e && e.message)); return false; }
}

function setup(opts) {
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const shell32 = koffi.load('shell32.dll');
  const gdiplus = koffi.load('gdiplus.dll');
  const advapi32 = koffi.load('advapi32.dll');

  koffi.struct('PillRECT', { L: 'long', T: 'long', R: 'long', B: 'long' });
  koffi.struct('PillPOINT', { X: 'long', Y: 'long' });
  koffi.struct('PillRectF', { X: 'float', Y: 'float', W: 'float', H: 'float' });
  // 不注册自定义窗口类(RegisterClassW 在 koffi 下嵌回调指针会段错误),
  // 直接用系统 Static 类 —— 本实现不处理任何窗口消息, 全靠直接 API 调用。

  const F = {
    RegisterClassW: null,
    CreateWindowExW: user32.func('void *CreateWindowExW(uint32 ex, str16 cls, str16 name, uint32 style, int32 x, int32 y, int32 w, int32 h, void *parent, void *menu, void *inst, void *param)'),
    FindWindowW: user32.func('void *FindWindowW(str16 cls, str16 title)'),
    FindWindowExW: user32.func('void *FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
    IsWindow: user32.func('int IsWindow(void *h)'),
    DestroyWindow: user32.func('int DestroyWindow(void *h)'),
    SetParent: user32.func('void *SetParent(void *child, void *parent)'),    GetWindowLongW: user32.func('int32 GetWindowLongW(void *h, int32 idx)'),
    SetWindowLongW: user32.func('int32 SetWindowLongW(void *h, int32 idx, int32 val)'),
    SetWindowPos: user32.func('int SetWindowPos(void *h, void *after, int32 x, int32 y, int32 w, int32 hh, uint32 flags)'),
    GetWindowRect: user32.func('int GetWindowRect(void *h, _Out_ PillRECT *r)'),
    GetClientRect: user32.func('int GetClientRect(void *h, _Out_ PillRECT *r)'),
    MapWindowPoints: user32.func('int32 MapWindowPoints(void *from, void *to, _Inout_ PillRECT *r, uint32 n)'),
    ShowWindow: user32.func('int ShowWindow(void *h, int32 cmd)'),
    UpdateLayeredWindow: user32.func('int UpdateLayeredWindow(void *h, void *hdcDst, void *pptDst, _In_ void *size, void *hdcSrc, _In_ void *ptSrc, uint32 crKey, _In_ void *blend, uint32 flags)'),
    GetDC: user32.func('void *GetDC(void *h)'),
    ReleaseDC: user32.func('int32 ReleaseDC(void *h, void *hdc)'),
    GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int32 key)'),
    GetCursorPos: user32.func('int GetCursorPos(_Out_ PillPOINT *p)'),
    SetProcessDPIAware: user32.func('int SetProcessDPIAware()'),
    ShellExecuteW: shell32.func('void *ShellExecuteW(void *h, str16 verb, str16 file, str16 args, str16 dir, int32 show)'),
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
    // 测量用 GDI(GdipMeasureString 在本机构建上段错误, DrawString 正常; GDI 度量误差 1px 级可接受)
    CreateFontW: gdi32.func('void *CreateFontW(int32 h, int32 w, int32 esc, int32 ori, int32 weight, uint32 italic, uint32 under, uint32 strike, uint32 charset, uint32 outp, uint32 clipp, uint32 quality, uint32 pitch, str16 face)'),
    GetTextExtentPoint32W: gdi32.func('int GetTextExtentPoint32W(void *hdc, str16 str, int32 len, _Out_ void *size)'),
    RegGetValueW: advapi32.func('int32 RegGetValueW(uintptr hkey, str16 sub, str16 value, uint32 flags, void *type, _Out_ uint32 *data, _Out_ uint32 *size)'),
  };
  const G = {
    Startup: gdiplus.func('int32 GdiplusStartup(_Out_ void **token, _In_ void *input, void *out)'),
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
    DeleteFont: gdiplus.func('int32 GdipDeleteFont(void *font)'),
    StringFormatGetGenericDefault: gdiplus.func('int32 GdipStringFormatGetGenericDefault(_Out_ void **fmt)'),
    DrawString: gdiplus.func('int32 GdipDrawString(void *gfx, str16 str, int32 len, void *font, _In_ PillRectF *layout, void *format, void *brush)'),
  };
  Object.assign(F, G);

  try { F.SetProcessDPIAware(); } catch { }

  // GdiplusStartupInput(32B: version=1, 其余空)
  const gpIn = Buffer.alloc(32);
  gpIn.writeUInt32LE(1, 0);
  const token = [null];
  if (G.Startup(token, gpIn, null) !== 0) { log('GdiplusStartup 失败'); return false; }

  // 主题: AppsUseLightTheme — 用 reg query 读取(koffi 注册表出参不可靠), 失败默认深色
  let light = false;
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme', { timeout: 3000 }).toString();
    const m = out.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) light = parseInt(m[1], 16) === 1;
  } catch { }

  S = { fn: F, G, light, opts, hwnd: null, taskbar: null, hdcScreen: null, hdcMem: null, fontFamily: null, font: null, fontPx: 0, strFormat: null, measureBmp: null, measureGfx: null };

  if (!EnsureWindow()) { log('窗口创建失败(任务栏未找到)'); return false; }
  tickTimer = setInterval(Tick, 300);
  log('贴片已启动 light=' + light);
  return true;
}

function EnsureWindow() {
  const F = S.fn;
  if (S.hwnd && F.IsWindow(S.hwnd) && S.taskbar && F.IsWindow(S.taskbar)) return true;
  try { if (S.hwnd) F.DestroyWindow(S.hwnd); } catch { }
  S.hwnd = null;
  S.taskbar = F.FindWindowW('Shell_TrayWnd', null);
  if (!S.taskbar || !F.IsWindow(S.taskbar)) return false;

  // 清理可能存在的孤儿窗口(上次异常退出残留)
  for (let i = 0; i < 5; i++) {
    const orphan = F.FindWindowExW(S.taskbar, null, 'Static', 'BatteryMonitorPill');
    if (!orphan) break;
    try { F.DestroyWindow(orphan); } catch { break; }
  }

  const WS_POPUP = 0x80000000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000;
  const WS_EX_LAYERED = 0x80000, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
  const hwnd = F.CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    'Static', 'BatteryMonitorPill', WS_POPUP,
    0, 0, 1, 1, null, null, null, null);
  if (!hwnd) return false;
  F.SetParent(hwnd, S.taskbar);
  let style = F.GetWindowLongW(hwnd, -16);
  style = (style & 0x7FFFFFFF) | WS_CHILD | WS_VISIBLE; // 去 WS_POPUP(高位), 换 WS_CHILD
  F.SetWindowLongW(hwnd, -16, style);
  S.hwnd = hwnd;
  F.ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
  return true;
}

function Tick() {
  if (!S) return;
  if (!EnsureWindow()) return;
  const F = S.fn;
  // 点击检测(Win11 吃掉子窗口鼠标消息, 只能轮询): 左键按下沿 + 光标在贴片内 → 打开状态页
  const wr = { L: 0, T: 0, R: 0, B: 0 }; F.GetWindowRect(S.hwnd, wr);
  const cp = { X: 0, Y: 0 }; F.GetCursorPos(cp);
  const down = (F.GetAsyncKeyState(0x01) & 0x8000) !== 0;
  if (down && !prevDown && cp.X >= wr.L && cp.X <= wr.R && cp.Y >= wr.T && cp.Y <= wr.B) {
    try { F.ShellExecuteW(null, 'open', S.opts.url || 'http://127.0.0.1:8787', null, null, 1); } catch { }
  }
  prevDown = down;

  // 状态签名: 数据/托盘位置/任务栏高度 任一变化才重画(空闲时几乎零开销)
  let tnL = -1, tbB = 0;
  const tn = F.FindWindowExW(S.taskbar, null, 'TrayNotifyWnd', null);
  if (tn) { const t = { L: 0, T: 0, R: 0, B: 0 }; F.GetWindowRect(tn, t); tnL = t.L; }
  const tb = { L: 0, T: 0, R: 0, B: 0 }; F.GetWindowRect(S.taskbar, tb);
  tbB = tb.B - tb.T;
  let sig = tnL + '|' + tbB + '|' + S.light + '|';
  for (const d of (S.opts.getData() || [])) {
    sig += (d.key || '') + ',' + (d.ok ? 1 : 0) + ',' + (d.linked ? 1 : 0) + ',' + (d.charging ? 1 : 0) + ',' + d.battery + ';';
  }
  if (sig === S.lastSig) return;
  S.lastSig = sig;
  Render();
}

// ---------- 渲染 ----------
function Render() {
  if (!S || !S.hwnd) return;
  const F = S.fn;

  const tb = { L: 0, T: 0, R: 0, B: 0 }, cb = { L: 0, T: 0, R: 0, B: 0 };
  F.GetWindowRect(S.taskbar, tb);
  F.GetClientRect(S.taskbar, cb);
  if ((tb.R - tb.L) < (tb.B - tb.T)) { F.SetWindowPos(S.hwnd, null, 0, 0, 0, 0, 0x14); return; } // 竖排任务栏不显示
  const pillH = Math.max(22, Math.min(44, cb.B - 8));

  // 数据(直接来自 daemon 内存)
  const raw = (S.opts.getData() || []);
  const devs = raw.map((d) => ({
    kind: d.kind || '',
    online: !!d.ok && !!d.linked,
    charging: !!d.charging,
    battery: d.ok && d.linked && Number.isFinite(d.battery) ? Math.round(d.battery) : -1,
  }));
  const low = S.opts.getLow ? S.opts.getLow() : 20;
  const shown = devs.slice(0, 3);
  const extra = devs.length > 3 ? '+' + (devs.length - 3) : null;
  if (!shown.length) shown.push({ kind: '', online: false, charging: false, battery: -1 });

  const fs = pillH * 0.52, gs = pillH * 0.52;
  const pad = pillH * 0.30, gap = pillH * 0.14, sep = pillH * 0.30;
  ensureFont(fs);
  if (!S.font) return;

  // hdcMem 提前创建(GDI 测量要用它选字体)
  if (!S.hdcScreen) S.hdcScreen = F.GetDC(null);
  if (!S.hdcMem) S.hdcMem = F.CreateCompatibleDC(S.hdcScreen);
  if (!S.hdcMem) return;
  let x = pad;
  const widths = [];
  for (const d of shown) {
    const t = d.battery >= 0 ? d.battery + '%' : '--';
    const w = Measure(null, t);
    widths.push(w);
    x += gs + gap + w + sep * 2;
  }
  if (extra) x += Measure(null, extra);
  const pillW = Math.max(Math.ceil(x - sep * 2 + pad), pillH + 8);

  // 定位: TrayNotifyWnd 左侧(子窗口坐标 = 任务栏客户区坐标; 客户区原点即任务栏屏幕原点)
  const tr = { L: 0, T: 0, R: 0, B: 0 };
  const trayH = F.FindWindowExW(S.taskbar, null, 'TrayNotifyWnd', null);
  let px;
  if (trayH) { F.GetWindowRect(trayH, tr); px = tr.L - tb.L - pillW - 6; }
  else px = cb.R - pillW - 6;
  const py = Math.floor((cb.B - pillH) / 2);
  F.SetWindowPos(S.hwnd, null, px, py, pillW, pillH, 0x14); // SWP_NOZORDER|SWP_NOACTIVATE

  // ---- GDI+ 绘制 ARGB 位图 ----
  const stride = pillW * 4;
  const buf = Buffer.alloc(stride * pillH); // 全透明底, 保持引用到 render 结束
  const bmp = [null], gfx = [null];
  if (F.CreateBitmapFromScan0(pillW, pillH, stride, PXF_ARGB, buf, bmp) !== 0) return;
  if (F.GetImageGraphicsContext(bmp[0], gfx) !== 0) { F.DisposeImage(bmp[0]); return; }
  F.SetSmoothingMode(gfx[0], SmoothingAA);
  F.SetTextRenderingHint(gfx[0], TextAA);

  const light = S.light;
  const bgC = light ? COL.bgLight : COL.bgDark;
  const glyphC = light ? COL.glyphLight : COL.glyphDark;
  const sepC = light ? COL.sepLight : COL.sepDark;
  const cGood = light ? COL.goodLight : COL.goodDark;
  const cRed = light ? COL.redLight : COL.redDark;

  // 胶囊底
  const path = [null];
  if (F.CreatePath(FillAlternate, path) === 0) {
    RoundRectPath(F, path[0], 0.5, 0.5, pillW - 1, pillH - 1, pillH * 0.34);
    const b = [null];
    if (F.CreateSolidFill(bgC, b) === 0) { F.FillPath(gfx[0], b[0], path[0]); F.DeleteBrush(b[0]); }
    F.DeletePath(path[0]);
  }

  // 设备
  x = pad;
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    DrawGlyph(F, gfx[0], d.kind, x, (pillH - gs) / 2, gs, glyphC);
    x += gs + gap;
    const t = d.battery >= 0 ? d.battery + '%' : '--';
    const tc = !d.online ? COL.gray : d.charging ? COL.blue : (d.battery <= low ? cRed : cGood);
    DrawText(F, gfx[0], t, x, pillH / 2, tc);
    x += widths[i];
    if (i < shown.length - 1) {
      x += sep;
      const p = [null];
      if (F.CreatePen1(sepC, 1, UnitPixel, p) === 0) {
        F.DrawLine(gfx[0], p[0], x, pillH * 0.26, x, pillH * 0.74);
        F.DeletePen(p[0]);
      }
      x += 1 + sep;
    }
  }
  if (extra) DrawText(F, gfx[0], extra, x, pillH / 2, glyphC);

  // 提交 ULW (SIZE/POINT/BLENDFUNCTION 用手工 Buffer, 布局最稳)
  const hbm = [null];
  if (F.CreateHBITMAPFromBitmap(bmp[0], hbm, 0) === 0) {
    const old = F.SelectObject(S.hdcMem, hbm[0]);
    const size = Buffer.alloc(8); size.writeInt32LE(pillW, 0); size.writeInt32LE(pillH, 4);
    const src = Buffer.alloc(8); // 0,0
    const blend = Buffer.alloc(4); blend[0] = 0xAC; blend[1] = 1; blend[2] = 255; blend[3] = 1;
    F.UpdateLayeredWindow(S.hwnd, S.hdcScreen, null, size, S.hdcMem, src, 0, blend, 2 /*ULW_ALPHA*/);
    F.SelectObject(S.hdcMem, old);
    F.DeleteObject(hbm[0]);
  }
  F.DeleteGraphics(gfx[0]);
  F.DisposeImage(bmp[0]);
}

function RoundRectPath(F, path, x, y, w, h, r) {
  const d = r * 2;
  F.AddPathArc(path, x, y, d, d, 180, 90);
  F.AddPathArc(path, x + w - d, y, d, d, 270, 90);
  F.AddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
  F.AddPathArc(path, x, y + h - d, d, d, 90, 90);
  F.CloseFigure(path);
}

function DrawGlyph(F, gfx, kind, x, y, s, color) {
  const pen = [null];
  if (F.CreatePen1(color, Math.max(1.1, s * 0.10), UnitPixel, pen) !== 0) return;
  if (kind === 'mouse') {
    const bw = s * 0.44, bh = s * 0.92, bx = x + (s - bw) / 2, by = y + s * 0.04;
    const p = [null];
    if (F.CreatePath(FillAlternate, p) === 0) {
      RoundRectPath(F, p[0], bx, by, bw, bh, bw / 2);
      F.DrawPath(gfx, pen[0], p[0]);
      F.DeletePath(p[0]);
    }
    F.DrawLine(gfx, pen[0], bx + bw / 2, by + s * 0.10, bx + bw / 2, by + s * 0.36);
  } else if (kind === 'keyboard') {
    const bw = s, bh = s * 0.62, bx = x, by = y + s * 0.19;
    const p = [null];
    if (F.CreatePath(FillAlternate, p) === 0) {
      RoundRectPath(F, p[0], bx, by, bw, bh, s * 0.10);
      F.DrawPath(gfx, pen[0], p[0]);
      F.DeletePath(p[0]);
    }
    const br = [null];
    if (F.CreateSolidFill(color, br) === 0) {
      for (let row = 0; row < 2; row++)
        for (let k = 0; k < 4; k++) {
          const kx = bx + bw * (0.14 + k * 0.20), ky = by + bh * (0.20 + row * 0.26);
          F.FillRectangle(gfx, br[0], kx, ky, s * 0.08, s * 0.08);
        }
      F.FillRectangle(gfx, br[0], bx + bw * 0.24, by + bh * 0.74, bw * 0.52, s * 0.07);
      F.DeleteBrush(br[0]);
    }
  } else {
    // 未知类型: 电池轮廓
    const bw = s * 0.9, bh = s * 0.6, bx = x + s * 0.05, by = y + s * 0.20;
    const p = [null];
    if (F.CreatePath(FillAlternate, p) === 0) {
      RoundRectPath(F, p[0], bx, by, bw, bh, s * 0.10);
      F.DrawPath(gfx, pen[0], p[0]);
      F.DeletePath(p[0]);
    }
    F.DrawLine(gfx, pen[0], bx + bw + 0.04 * s, by + bh * 0.30, bx + bw + 0.04 * s, by + bh * 0.70);
  }
  F.DeletePen(pen[0]);
}

function ensureFont(px) {
  const F = S.fn;
  if (S.fontPx === px && S.font) return;
  if (S.font) { F.DeleteFont(S.font); S.font = null; }
  if (S.gdiFont) { F.DeleteObject(S.gdiFont); S.gdiFont = null; }
  if (!S.fontFamily) {
    const fam = [null];
    if (F.CreateFontFamilyFromName('Segoe UI', null, fam) === 0) S.fontFamily = fam[0];
  }
  if (S.fontFamily) {
    const fnt = [null];
    if (F.CreateFont(S.fontFamily, px, StyleBold, UnitPixel, fnt) === 0) S.font = fnt[0];
  }
  // GDI 测量字体(同字族同字号加粗)
  S.gdiFont = F.CreateFontW(-px, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 5, 0, 'Segoe UI');
  S.fontPx = px;
}

function Measure(gfx, t) {
  // GDI 测量(需 DC + 字体): 用 hdcMem
  if (!S.hdcMem || !S.gdiFont) return t.length * S.fontPx * 0.6;
  const oldF = S.fn.SelectObject(S.hdcMem, S.gdiFont);
  const sz = Buffer.alloc(8);
  S.fn.GetTextExtentPoint32W(S.hdcMem, t, t.length, sz);
  S.fn.SelectObject(S.hdcMem, oldF);
  return sz.readInt32LE(0);
}

function DrawText(F, gfx, t, x, cy, argb) {
  const w = Measure(gfx, t);
  const h = S.fontPx * 1.4;
  const layout = { X: x, Y: cy - h / 2, W: w + 4, H: h };
  const b = [null];
  if (F.CreateSolidFill(argb, b) === 0) {
    F.DrawString(gfx, t, t.length, S.font, layout, null, b[0]);
    F.DeleteBrush(b[0]);
  }
}

module.exports = {
  init,
  notify() { if (S && tickTimer) setImmediate(Render); },
  stop() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; },
};
