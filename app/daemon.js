// daemon.js — BatteryMonitor 常驻服务（多设备版）
// 职责: 轮询多设备电量 → 历史(JSONL) → HTTP API/状态页(127.0.0.1) → 托盘图标 → 低电量提醒
// 已支持: [mchose] 迈从 A7 Pro · [atk] ATK X1 V2 等全系 (见 battery.js)
// 运行: node daemon.js [--no-tray] [--open]   端口等配置在 config.json
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { queryAll } = require('./battery');
const { iconFor } = require('./icongen');
const hovercard = require('./hovercard');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CFG_PATH = path.join(ROOT, 'config.json');
const HIST_PATH = path.join(DATA_DIR, 'history.jsonl');
const LOG_PATH = path.join(DATA_DIR, 'daemon.log');
const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 日志 ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { }
  console.log(line);
}
// 启动时留进程痕迹, 退出时记录原因
log(`daemon 启动 pid=${process.pid}`);
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => {
    log(`退出(${sig}): ${e && e.stack ? e.stack.split('\n')[0] : e || ''}`);
    try { systray && systray.kill(true); } catch { }
    process.exit(sig === 'SIGINT' || sig === 'SIGTERM' ? 0 : 1);
  });
}

// ---------- 配置 ----------
const DEFAULT_CFG = { port: 8787, pollMs: 60000, batteryOffset: 0, lowThreshold: 20, autoOpen: false, offsets: {} };
let cfg = { ...DEFAULT_CFG };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))); } catch { }
cfg.offsets = { ...DEFAULT_CFG.offsets, ...(cfg.offsets || {}) };
const saveCfg = () => fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
saveCfg();

// 每设备校准偏移: cfg.offsets[key] 优先, 旧版全局 batteryOffset 仅作用于 mchose
function offsetFor(key) {
  if (Number.isFinite(cfg.offsets[key])) return cfg.offsets[key];
  return key === 'mchose' ? (cfg.batteryOffset || 0) : 0;
}

// ---------- 历史 ----------
function loadHistory() {
  try {
    const lines = fs.readFileSync(HIST_PATH, 'utf8').trim().split('\n');
    return lines.slice(-2000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
let history = loadHistory();
let histFlushTimer = null;
const histQueue = [];
// 每设备上次记录时间: 变化才记录之外, 最多 10 分钟补一个点(曲线需要时间参照)
const lastRecordT = new Map();
function record(rec) {
  rec.t = Date.now();
  history.push(rec);
  if (history.length > 5000) history = history.slice(-4000);
  // 合并写盘: 500ms 内的多条合一次 flush
  histQueue.push(rec);
  clearTimeout(histFlushTimer);
  histFlushTimer = setTimeout(() => {
    const lines = histQueue.splice(0).map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFile(HIST_PATH, lines, () => { });
  }, 500);
}

// ---------- 状态（多设备） ----------
// state.devices: Map(key → { key, brand, device, ok, battery, charging, full, mode, linked, error, lastOk, lowAlerted })
const state = { devices: new Map(), lastTry: null };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deviceList = () => [...state.devices.values()];
// 主设备: 第一个在线的, 否则第一个在场的
function primaryDevice() {
  const l = deviceList();
  return l.find((d) => d.ok) || l[0] || null;
}

function tooltipText() {
  const l = deviceList();
  if (!l.length) return 'BatteryMonitor: 未发现已支持的接收器';
  return l.map((d) => {
    if (d.ok && d.battery !== null) {
      const tag = d.charging ? ' ⚡' : d.full ? ' 🔋' : '';
      const link = d.linked ? '' : '（休眠）';
      return `${d.device} ${d.battery}%${tag}${link}`;
    }
    return `${d.device || d.key}: ${d.error || '未知'}`;
  }).join(' | ');
}

// 托盘图标取"最值得展示"的设备: 在线 > 成功读数 > 第一个在场
function checkLowBattery(ds) {
  const active = ds.ok && ds.linked && !ds.charging && !ds.full && ds.battery !== null;
  if (active && ds.battery <= cfg.lowThreshold && !ds.lowAlerted) {
    ds.lowAlerted = true;
    notify(`${ds.device} 电量低：${ds.battery}%`, '请尽快充电');
  } else if (!active || ds.battery > cfg.lowThreshold + 5) {
    ds.lowAlerted = false;
  }
}

function notify(title, msg) {
  console.log(`\x07 [提醒] ${title} — ${msg}`);
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
      '$n = New-Object System.Windows.Forms.NotifyIcon; ' +
      '$n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true; ' +
      `$n.ShowBalloonTip(8000, '${title}', '${msg}', [System.Windows.Forms.ToolTipIcon]::Warning); ` +
      'Start-Sleep -Seconds 9; $n.Dispose()'], { stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* 提醒失败不影响主流程 */ }
}

// ---------- 轮询 ----------
let polling = false;
async function poll(trigger = 'timer') {
  if (polling) return;
  polling = true;
  state.lastTry = Date.now();
  try {
    const results = await queryAll();
    const seen = new Set();
    for (const r of results) {
      const key = r.key;
      if (!key) continue; // 查询结果必须自带 key, 否则无法归档
      seen.add(key);
      if (!state.devices.has(key)) state.devices.set(key, { key, lowAlerted: false });
      const ds = state.devices.get(key);
      if (r.ok) {
        const battery = clamp(r.battery + offsetFor(key), 0, 100);
        const charging = !!r.charging, full = !!r.full;
        const changed = ds.battery !== battery || ds.charging !== charging || ds.full !== full || ds.linked !== r.linked;
        const patch = {
          ok: true, device: r.device, brand: r.brand, present: true,
          battery, charging, full, mode: r.mode, linked: r.linked,
          millivolts: r.millivolts, error: null, lastOk: Date.now(),
        };
        if (r.kind) patch.kind = r.kind; // 鼠标/键盘, 托盘角标和页面卡片用
        Object.assign(ds, patch);
        const lastT = lastRecordT.get(key) || 0;
        if (changed || trigger === 'manual' || trigger === 'boot' || Date.now() - lastT > 10 * 60 * 1000) {
          lastRecordT.set(key, Date.now());
          record({ d: key, ok: 1, b: battery, c: charging ? 1 : 0, f: full ? 1 : 0, m: r.mode, l: r.linked ? 1 : 0 });
        }
        checkLowBattery(ds);
      } else {
        Object.assign(ds, { ok: false, linked: false, present: true, error: r.message });
        record({ d: key, ok: 0, err: r.reason });
      }
    }
    // 本轮未出现的设备: 标记接收器未连接
    for (const ds of state.devices.values()) {
      if (!seen.has(ds.key)) Object.assign(ds, { ok: false, linked: false, present: false, error: '接收器未连接' });
    }
  } catch (e) {
    console.log('[轮询异常]', e.message);
  } finally {
    polling = false;
  }
  updateTray();
  hovercard.notify(); // 悬浮卡片数据随轮询刷新
}

// 自适应轮询: 全部设备在线读数正常 → 60s 慢轮询; 有设备离线/休眠/未发现 → 12s 快速探测
// (设备一上线/唤醒, 最迟 12s 内被识别; 全正常时保持极低唤醒频率)
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const l = deviceList();
  const missing = !l.length || l.some((d) => !d.ok || !d.linked);
  pollTimer = setTimeout(async () => { await poll('auto'); schedulePoll(); }, missing ? 12000 : cfg.pollMs);
}

// ---------- 开机自启（HKCU Run 键，托盘菜单可切换） ----------
// 早先用「启动文件夹 + .vbs」实现，但部分安全软件会拦截向 Startup 写脚本（实测 EPERM），
// 改为写入 Run 键（主流做法，无需脚本、无黑框）。
const os = require('os');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'BatteryMonitor';
const LEGACY_STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.userInfo().homedir, 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LEGACY_VBS = [
  path.join(LEGACY_STARTUP_DIR, 'BatteryMonitor.vbs'),
  path.join(LEGACY_STARTUP_DIR, 'A7 Pro 电量监视.vbs'),
];
// 安装版(bootstrap 注入 BM_VERSION)直接指向主程序; 源码版指向 launch.js
const IS_SEA = !!process.env.BM_VERSION || !/node\.exe$/i.test(process.execPath);
function startupCommand() {
  return IS_SEA
    ? `"${process.execPath}" --no-open`
    : `"${process.execPath}" "${path.join(ROOT, 'launch.js')}" --no-open`;
}
function reg(args) {
  try {
    return require('child_process').execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } catch { return ''; }
}
function readAutoStart() {
  const m = reg(['query', RUN_KEY, '/v', RUN_VALUE]).match(/REG_SZ\s+(.+)/);
  return m ? m[1].trim() : '';
}
let autoStartOn = false;
function refreshAutoStart() {
  for (const v of LEGACY_VBS) {
    try {
      if (fs.existsSync(v)) { fs.unlinkSync(v); log('[自启] 已移除旧启动脚本 ' + path.basename(v)); }
    } catch { }
  }
  const cur = readAutoStart();
  const want = startupCommand();
  if (cur && cur !== want) {   // 程序被移动/换版本后自愈
    reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', want, '/f']);
    log('[自启] 已更新启动命令');
  }
  autoStartOn = !!readAutoStart();
}
function setStartup(on) {
  if (on) reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', startupCommand(), '/f']);
  else reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  autoStartOn = !!readAutoStart();
  log('[自启] ' + (on ? '已开启' : '已关闭') + ' (' + RUN_KEY + '\\' + RUN_VALUE + ')');
}

// ---------- 托盘 ----------
let systray = null;
const KIND_LABEL = { mouse: '鼠标', keyboard: '键盘', headset: '耳机' };
// 安装目录(展示"打开程序目录"、卸载入口用); 源码运行时退化为 app 目录的上级
const INSTALL_DIR = process.env.BM_EXE_DIR || (IS_SEA ? path.dirname(process.execPath) : path.dirname(ROOT));
const APP_VERSION = process.env.BM_VERSION || (() => {
  try { return require('./package.json').version; } catch { return ''; }
})();
function openFolder(dir) {
  try { spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { }
}
const ACTION_ITEMS = [
  { title: '打开状态页', tooltip: '在浏览器打开电量页' },
  { title: '立即刷新', tooltip: '马上查询一次电量' },
  { title: '打开程序目录', tooltip: INSTALL_DIR },
  { title: '退出', tooltip: '退出 BatteryMonitor' },
];
// 任务栏明暗主题(托盘图标数字配色 + 悬浮卡片配色都跟随)
let darkTheme = false;
function refreshTheme() {
  try {
    const out = require('child_process').execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme',
      { timeout: 3000, windowsHide: true }).toString();
    const m = out.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) darkTheme = parseInt(m[1], 16) === 0;
  } catch { }
}

function buildMenu() {
  // 每台在场设备一行实时读数(灰色不可点), 中间是可勾选的设置, 下面才是操作项
  // 图标: 横向贴片(全部在场设备并排, 见 icongen.js)
  const rows = deviceList().filter((d) => d.present !== false).map((d) => ({
    title: d.ok && d.battery !== null
      ? `${KIND_LABEL[d.kind] || '设备'} · ${d.device}  ${d.battery}%${d.charging ? ' ⚡' : d.full ? ' 🔋' : ''}`
      : `${d.device || d.key}: ${d.error || '离线'}`,
    tooltip: d.device || d.key,
    checked: false, enabled: false,
  }));
  const toggle = {
    title: `开机自启：${autoStartOn ? '已开启' : '已关闭'}`,
    tooltip: '点击切换开机自动启动',
    checked: autoStartOn, enabled: true,
  };
  return { icon: iconFor(deviceList(), cfg.lowThreshold, darkTheme), title: 'BatteryMonitor', tooltip: tooltipText(), items: [...rows, toggle, ...ACTION_ITEMS] };
}
function initTray() {
  if (process.argv.includes('--no-tray')) return;
  try {
    const Systray = require('systray2').default;
    systray = new Systray({ menu: buildMenu(), debug: false, copyDir: false });
    lastIconKey = ''; // (重建后强制刷新一次)
    systray.onClick((action) => {
      const t = action.item && action.item.title;
      if (!t) return;                           // 左键图标: 由 hovercard 自行检测(托盘助手不发左键事件)
      if (t === '打开状态页') openBrowser();
      else if (t === '立即刷新') poll('manual');
      else if (t === '打开程序目录') openFolder(INSTALL_DIR);
      else if (t === '开机自启' || (t && t.startsWith('开机自启：'))) {
        const on = !autoStartOn;
        setStartup(on);
        // 即时反馈: Windows 气泡通知
        notify(`开机自启已${on ? '开启' : '关闭'}`, on ? '开机后将自动启动电量监视' : '开机后将不再自动启动');
        // update-menu 在 Windows 上刷不动菜单项文字, 整个托盘重建才可靠
        // kill(false): 只退出托盘二进制, 不退出 Node 进程(默认 true 会 process.exit 带崩 daemon)
        try { systray.kill(false); } catch { }
        systray = null;
        setTimeout(initTray, 400);
      }
      else if (t === '退出') { try { systray.kill(true); } catch { } process.exit(0); }
    });
    // Win11 默认把新托盘图标折叠进隐藏区，启动后自动提升为常显
    scheduleTrayPromote();
    startTrayWatchdog();
  } catch (e) {
    log('[托盘] 初始化失败(不影响其它功能): ' + e.message);
    systray = null;
  }
}

// 看门狗: 托盘二进制意外退出时自动重建（30s 周期）
let trayWatchdogTimer = null;
function startTrayWatchdog() {
  clearInterval(trayWatchdogTimer);
  trayWatchdogTimer = setInterval(() => {
    if (!systray) return;
    try {
      const out = require('child_process')
        .execSync('tasklist /FI "IMAGENAME eq tray_windows_release.exe" /NH', { encoding: 'utf8', windowsHide: true });
      if (!/tray_windows_release/i.test(out)) {
        log('[看门狗] 托盘进程消失，重建…');
        try { systray.kill(false); } catch { }
        systray = null;
        setTimeout(() => { initTray(); updateTray(); }, 800);
      }
    } catch { /* 检测失败下轮再试 */ }
  }, 30000);
}

// 把 NotifyIconSettings 中托盘二进制的 IsPromoted 置 1（尽力而为，失败不影响主流程）
// Win11 默认把新托盘图标折叠进隐藏区(^)。写 NotifyIconSettings\IsPromoted=1 可让其常显,
// 但该值只在图标"注册那一刻"读取 —— 所以写完必须重建一次托盘才生效。
let trayPromoteRestarted = false;
function promoteTrayIconOnce() {
  if (process.platform !== 'win32') return false;
  const { execFileSync } = require('child_process');
  let out = '';
  try {
    out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\NotifyIconSettings', '/s', '/v', 'ExecutablePath'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } catch { return false; }
  const helperDir = path.join(ROOT, 'node_modules', 'systray2', 'traybin').toLowerCase();
  const keys = [];
  let cur = null;
  for (const raw of out.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^HKEY_/i.test(t)) { cur = t; continue; }
    if (cur && /tray_windows_release\.exe/i.test(t) && t.toLowerCase().includes(helperDir)) keys.push(cur);
  }
  let changed = false;
  for (const k of keys) {
    try {
      const v = execFileSync('reg', ['query', k, '/v', 'IsPromoted'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (/0x1$|REG_DWORD\s+1$/m.test(v)) continue; // 已是常显
    } catch { } // 值不存在 → 需要写
    try {
      execFileSync('reg', ['add', k, '/v', 'IsPromoted', '/t', 'REG_DWORD', '/d', '1', '/f'],
        { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      changed = true;
    } catch { }
  }
  return changed;
}
function restartTray() {
  try { systray.kill(false); } catch { }
  systray = null;
  setTimeout(initTray, 400);
}
// 首次运行时注册表项可能还没生成, 多次重试; 一旦写入成功就重建托盘让它立刻可见
function scheduleTrayPromote() {
  for (const delay of [2500, 7000, 15000]) {
    setTimeout(() => {
      if (trayPromoteRestarted) return;
      if (promoteTrayIconOnce()) {
        trayPromoteRestarted = true;
        log('[托盘] 已把图标从折叠区提升为常显');
        restartTray();
      }
    }, delay);
  }
}
let lastIconKey = '';
function updateTray() {
  if (!systray) return;
  refreshTheme();
  const key = JSON.stringify([
    deviceList().map((d) => [d.key, d.battery, d.charging, d.full, d.linked, d.ok, d.kind]),
    tooltipText(),
    cfg.lowThreshold,
    autoStartOn,
    darkTheme,
  ]);
  if (key === lastIconKey) return;
  lastIconKey = key;
  try { systray.sendAction({ type: 'update-menu', menu: buildMenu() }); } catch { }
}

// ---------- HTTP ----------
function json(res, obj) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/battery') {
    const p = primaryDevice();
    return json(res, {
      ok: !!(p && p.ok), device: p ? p.device : null, battery: p ? p.battery : null,
      charging: p ? !!p.charging : false, full: p ? !!p.full : false, mode: p ? p.mode : '',
      linked: p ? !!p.linked : false, error: p ? p.error : '未发现已支持的接收器',
      lastOk: p ? p.lastOk : null, lastTry: state.lastTry,
      primaryKey: p ? p.key : null,
      devices: deviceList(),
      offset: cfg.batteryOffset, offsets: cfg.offsets, lowThreshold: cfg.lowThreshold,
    });
  }
  if (url === '/api/history') return json(res, history);
  if (url === '/api/appinfo') {
    return json(res, {
      app: 'BatteryMonitor', version: APP_VERSION, installDir: INSTALL_DIR,
      appDir: ROOT, autoStart: autoStartOn, platform: process.platform, pid: process.pid,
    });
  }
  if (url === '/api/open-folder' && req.method === 'POST') {
    openFolder(INSTALL_DIR);
    return json(res, { ok: true, dir: INSTALL_DIR });
  }
  if (url === '/api/quit' && req.method === 'POST') {    // 安装/卸载程序通过它让常驻服务优雅退出(先回包再退, 避免连接被重置)
    json(res, { ok: true });
    setTimeout(() => { try { systray && systray.kill(true); } catch { } process.exit(0); }, 150);
    return;
  }
  if (url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const p = JSON.parse(body || '{}');
        if (p.key && Number.isFinite(p.offset)) {
          // 每设备校准偏移: { key: 'mchose'|'atk'|'aula', offset: -20..20 }
          cfg.offsets[p.key] = clamp(Math.round(p.offset), -20, 20);
        }
        if (Number.isFinite(p.batteryOffset)) {
          cfg.batteryOffset = clamp(Math.round(p.batteryOffset), -20, 20);
          cfg.offsets.mchose = cfg.batteryOffset; // 旧版页面偏移输入框兼容
        }
        if (Number.isFinite(p.lowThreshold)) cfg.lowThreshold = clamp(Math.round(p.lowThreshold), 1, 99); // 完全自定义, 不再限定 5-50
        saveCfg();
        for (const ds of state.devices.values()) ds.lowAlerted = false;
        poll('manual');
        json(res, { ok: true, cfg });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
  }
  res.writeHead(404); res.end('not found');
});

// ---------- 启动 ----------
function openBrowser() {
  const url = `http://127.0.0.1:${cfg.port}`;
  log('[状态页] 打开浏览器 → ' + url);
  try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch { }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[BatteryMonitor] 端口 ' + cfg.port + ' 已被占用——程序可能已经在运行，本次退出。');
    process.exit(1);
  }
  throw e;
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(`状态页: http://127.0.0.1:${cfg.port}  (轮询 ${cfg.pollMs / 1000}s, 低电量阈值 ${cfg.lowThreshold}%)`);
  refreshAutoStart(); // 先读自启状态(含旧启动项迁移), 菜单首建时勾选态才正确
  initTray();
  hovercard.init({
    getData: deviceList,
    getLow: () => cfg.lowThreshold,
    getTheme: () => darkTheme,
    onOpen: openBrowser,
    log,
  });
  poll('boot').then(() => {
    if (cfg.autoOpen || process.argv.includes('--open')) openBrowser();
    schedulePoll();
  });
});
