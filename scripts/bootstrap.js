// bootstrap.js — 打包后的统一入口（Node SEA 内嵌执行）
//
// 一个可执行文件承担四个角色，按「自身文件名 / 运行位置 / 命令行参数」判定：
//   setup      安装向导（从下载目录运行时）：选择目录 → 释放程序 → 快捷方式 → 注册卸载项
//   uninstall  卸载向导（Uninstall.exe）：停止程序 → 清理快捷方式/注册表 → 删除文件
//   run        启动器（已安装目录内的主程序）：已在运行则只开状态页，否则派生常驻进程
//   daemon     常驻服务（BM_ROLE=daemon）：交给 app/daemon.js
//
// 安装后的目录结构：
//   BatteryMonitor\
//     BatteryMonitor.exe   主程序
//     Uninstall.exe        卸载程序（与主程序硬链接，不额外占空间）
//     install.json         安装信息（版本/时间）
//     app\                 程序本体（协议引擎、状态页、依赖）
//     app\config.json      用户配置
//     app\data\            电量历史与日志
//
// 命令行：
//   BatteryMonitor-Setup-x.y.z.exe [--silent] [--dir=路径] [--no-desktop] [--no-autostart] [--no-launch]
//   Uninstall.exe [--silent] [--keep-data]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const VERSION = '__BM_VERSION__';            // 构建时替换为真实版本号
const STAMP = '__BM_BUILD__';                // 版本+载荷指纹
const MAGIC = 'BMPKG2\0\0';

const APP_NAME = 'BatteryMonitor';
const UNINSTALLER = 'Uninstall.exe';
const MARKER = 'install.json';
const REPO = 'https://github.com/Orrick-oss/BatteryMonitor';

const EXE = process.execPath;
const SELF_DIR = path.dirname(EXE);
const SELF_NAME = path.basename(EXE);
const SELF_LOWER = SELF_NAME.toLowerCase();

const RAW_ARGS = process.argv.slice(1);
const hasFlag = (name) => RAW_ARGS.some((a) => {
  const s = a.toLowerCase();
  return s === name || s.startsWith(name + '=');
});
const optVal = (name) => {
  for (let i = 0; i < RAW_ARGS.length; i++) {
    const s = RAW_ARGS[i].toLowerCase();
    if (s === name) return RAW_ARGS[i + 1] || null;
    if (s.startsWith(name + '=')) return RAW_ARGS[i].slice(name.length + 1);
  }
  return null;
};

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULT_DIR = path.join(LOCALAPPDATA, 'Programs', APP_NAME);
const LEGACY_DIR = path.join(LOCALAPPDATA, APP_NAME);       // 旧版解包位置（仅用于迁移数据）
const STARTUP_VBS = path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', APP_NAME + '.vbs'); // 旧版自启方式，仅用于清理
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = APP_NAME;
const LOG_FILE = path.join(os.tmpdir(), 'BatteryMonitor-setup.log');

// ---------- 通用 ----------
function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function openUrl(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { }
}

// ---------- 内嵌载荷 ----------
function seaAsset(name) {
  try {
    const sea = require('node:sea');
    const ab = sea.getAsset(name);
    if (ab) return Buffer.from(ab);
  } catch { }
  return null;
}

let archiveCache = null;
function readArchive() {
  if (archiveCache) return archiveCache;
  const raw = seaAsset('payload.bin');
  if (!raw) throw new Error('内嵌载荷缺失');
  const buf = zlib.gunzipSync(raw);
  if (buf.slice(0, 8).toString('latin1') !== MAGIC) throw new Error('载荷格式不符');
  const count = buf.readUInt32LE(8);
  const files = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const pLen = buf.readUInt16LE(off); off += 2;
    const rel = buf.slice(off, off + pLen).toString('utf8'); off += pLen;
    const size = buf.readUInt32LE(off); off += 4;
    files.push({ rel, data: buf.slice(off, off + size) }); off += size;
  }
  archiveCache = files;
  return files;
}

function extractTo(dest, onProgress) {
  const files = readArchive();
  const keepCfg = fs.existsSync(path.join(dest, 'config.json'));
  let done = 0;
  for (const f of files) {
    const rel = f.rel.replace(/\\/g, '/');
    // 路径安全：拒绝绝对路径与 .. 穿越
    if (rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel) || /^[a-zA-Z]:/.test(rel)) continue;
    if (rel.startsWith('data/')) { done++; continue; }          // 用户数据不动
    if (keepCfg && rel === 'config.json') { done++; continue; }  // 升级保留配置
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
    if (onProgress && ++done % 25 === 0) onProgress(done / files.length);
  }
  fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
  return files.length;
}

// 内嵌的界面资源
function uiPage(name) {
  const buf = seaAsset(name);
  if (buf) return buf.toString('utf8');
  return '<!doctype html><meta charset="utf-8"><p>界面资源缺失：' + name + '</p>';
}
function iconBytes() {
  try {
    const f = readArchive().find((x) => /(^|\/)battery\.ico$/.test(x.rel));
    return f ? f.data : null;
  } catch { return null; }
}

// ---------- 安装目录判定 ----------
function markerOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}
function installedDir(dir) {
  if (markerOf(dir) && fs.existsSync(path.join(dir, 'app', 'daemon.js'))) return dir;
  return null;
}
const CURRENT_INSTALL = installedDir(SELF_DIR);

// ---------- 运行状态互操作 ----------
function readPort(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'app', 'config.json'), 'utf8'));
    if (Number.isFinite(cfg.port)) return cfg.port;
  } catch { }
  return 8787;
}

function httpJson(port, method, p, body, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: timeoutMs,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 让正在运行的程序自行退出（优先优雅退出，再兜底结束进程）
async function stopRunning(dir) {
  const port = readPort(dir);
  await httpJson(port, 'POST', '/api/quit');
  await sleep(700);
  if (SELF_LOWER !== (APP_NAME + '.exe').toLowerCase()) {
    try {
      execFileSync('taskkill', ['/IM', APP_NAME + '.exe', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } catch { /* 没在跑 */ }
  }
  await sleep(300);
}

// ---------- 安装 ----------
const state = { pct: 0, msg: '', done: false, error: null, result: null };
function step(pct, msg) { state.pct = pct; state.msg = msg; log(`[${pct}%] ${msg}`); }

const PROGRAMS_DIR = path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

// 桌面可能被重定向（如 D:\Users\xxx\Desktop），从注册表取，别假设 %USERPROFILE%\Desktop
function desktopDir() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (m) {
      const p = m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || '');
      if (p) return p;
    }
  } catch { }
  return path.join(os.homedir(), 'Desktop');
}

// ---------- 快捷方式（VBS + cscript） ----------
// 打包后的无控制台进程里 PowerShell 的 WScript.Shell COM 会死等（实测卡满 25s），
// 而 cscript 宿主正常（约 0.3s）；Node 自己写 .lnk 又缺少 TargetIDList，Shell 不认。
// 因此这里把 VBS 写成 UTF-16LE（支持中文路径）再交给 cscript 执行。
function runVbs(code, timeout = 15000) {
  const vbs = path.join(os.tmpdir(), `bm-${process.pid}-${Date.now()}.vbs`);
  try {
    fs.writeFileSync(vbs, Buffer.from('\ufeff' + code, 'utf16le'));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); try { fs.rmSync(vbs, { force: true }); } catch { } resolve(r); } };
      let child;
      try {
        child = spawn('cscript', ['//nologo', '//B', vbs], { stdio: 'ignore', windowsHide: true });
      } catch (e) { return resolve({ ok: false, err: e.message }); }
      const timer = setTimeout(() => { try { child.kill(); } catch { } finish({ ok: false, err: 'timeout' }); }, timeout);
      child.on('error', (e) => finish({ ok: false, err: e.message }));
      child.on('exit', (code) => finish({ ok: code === 0, code }));
    });
  } catch (e) {
    return Promise.resolve({ ok: false, err: e.message });
  }
}

function lnkCode(lnkPath, target, workDir, icon, desc) {
  const esc = (s) => String(s).replace(/"/g, '""');
  return `Set ws = CreateObject("WScript.Shell")\r\n` +
    `Set s = ws.CreateShortcut("${esc(lnkPath)}")\r\n` +
    `s.TargetPath = "${esc(target)}"\r\n` +
    `s.WorkingDirectory = "${esc(workDir)}"\r\n` +
    `s.IconLocation = "${esc(icon)}"\r\n` +
    `s.Description = "${esc(desc)}"\r\n` +
    `s.Save\r\n`;
}

async function writeShortcuts(dir, exe, opts) {
  const un = path.join(dir, UNINSTALLER);
  const sm = path.join(PROGRAMS_DIR, APP_NAME);
  const dk = path.join(desktopDir(), APP_NAME + '.lnk');
  // CreateShortcut 的 Save 不会自动建目录，目录不存在时静默失败
  try { fs.mkdirSync(sm, { recursive: true }); } catch { }
  try { fs.mkdirSync(path.dirname(dk), { recursive: true }); } catch { }
  const targets = [
    [path.join(sm, APP_NAME + '.lnk'), exe, '外设电量监视'],
    [path.join(sm, '卸载 ' + APP_NAME + '.lnk'), un, '卸载 ' + APP_NAME],
  ];
  if (opts.desktop) targets.push([dk, exe, '外设电量监视']);
  else try { fs.rmSync(dk, { force: true }); } catch { }

  const code = targets.map(([lnk, target, desc]) => lnkCode(lnk, target, dir, target + ',0', desc)).join('');
  const r = await runVbs(code);
  const missing = targets.filter(([lnk]) => !fs.existsSync(lnk)).map(([lnk]) => lnk);
  if (missing.length) log(`快捷方式未生成(${r.err || ('exit ' + r.code)}): ${missing.join(' | ')}`);
  return missing.length === 0;
}

function removeShortcuts() {
  try { fs.rmSync(path.join(PROGRAMS_DIR, APP_NAME), { recursive: true, force: true }); } catch { }
  try { fs.rmSync(path.join(desktopDir(), APP_NAME + '.lnk'), { force: true }); } catch { }
}

function sizeOnDisk(dir) {
  // Uninstall.exe 是主程序的硬链接，不重复计入占用
  let total = 0;
  (function walk(p) {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else if (path.basename(p).toLowerCase() !== UNINSTALLER.toLowerCase()) total += st.size;
  })(dir);
  return total;
}

function writeUninstallKey(dir, exe) {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
  const un = path.join(dir, UNINSTALLER);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const installDate = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const kb = Math.round(sizeOnDisk(dir) / 1024);
  const vals = [
    ['DisplayName', 'REG_SZ', APP_NAME + ' 外设电量监视'],
    ['DisplayVersion', 'REG_SZ', VERSION],
    ['DisplayIcon', 'REG_SZ', exe + ',0'],
    ['Publisher', 'REG_SZ', APP_NAME],
    ['InstallLocation', 'REG_SZ', dir],
    ['InstallDate', 'REG_SZ', installDate],
    ['UninstallString', 'REG_SZ', `"${un}"`],
    ['QuietUninstallString', 'REG_SZ', `"${un}" --silent`],
    ['URLInfoAbout', 'REG_SZ', REPO],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(kb)],
  ];
  for (const [name, type, data] of vals) {
    try {
      execFileSync('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'],
        { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    } catch (e) { log(`注册表写入失败 ${name}: ${e.message}`); }
  }
}

function regExe(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    return true;
  } catch { return false; }
}

function writeAutoStart(dir, exe, on) {
  // 开机自启用 HKCU 的 Run 键（主流做法）；旧版曾放 Startup 目录的 .vbs，一并清理
  // （部分安全软件会拦截向 Startup 写入脚本，Run 键不会）
  const legacyVbs = STARTUP_VBS;
  try { if (fs.existsSync(legacyVbs)) fs.unlinkSync(legacyVbs); } catch { }
  const cmd = `"${exe}" --no-open`;
  const ok = on
    ? regExe(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f'])
    : (regExe(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']) || true);
  if (!ok) log('开机自启设置失败');
}

// 旧版（解包到 %LOCALAPPDATA%\BatteryMonitor\app）的用户配置与历史迁移过来
function migrateLegacy(appDir) {
  const src = path.join(LEGACY_DIR, 'app');
  if (!fs.existsSync(src)) return [];
  const moved = [];
  const jobs = [['config.json', 'config.json'], ['data/history.jsonl', 'data/history.jsonl']];
  for (const [from, to] of jobs) {
    const s = path.join(src, from), d = path.join(appDir, to);
    if (!fs.existsSync(s) || fs.existsSync(d)) continue;
    try {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      moved.push(to);
    } catch { }
  }
  return moved;
}

async function doInstall(opts) {
  const dir = path.resolve(opts.dir);
  state.done = false; state.error = null; state.result = null;
  try {
    step(4, '准备安装目录');
    await stopRunning(dir);
    fs.mkdirSync(dir, { recursive: true });

    step(12, '写入主程序');
    const exe = path.join(dir, APP_NAME + '.exe');
    const same = path.resolve(exe).toLowerCase() === path.resolve(EXE).toLowerCase();
    if (!same) {
      try { fs.rmSync(exe, { force: true }); } catch { }
      fs.copyFileSync(EXE, exe);
    }

    step(22, '生成卸载程序');
    const un = path.join(dir, UNINSTALLER);
    try { fs.rmSync(un, { force: true }); } catch { }
    let linked = true;
    try { fs.linkSync(exe, un); } catch { linked = false; }
    if (!linked) { try { fs.copyFileSync(exe, un); } catch (e) { log('卸载程序生成失败: ' + e.message); } }

    step(30, '展开程序文件');
    const appDir = path.join(dir, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    extractTo(appDir, (p) => { state.pct = 30 + Math.round(p * 38); });
    const moved = migrateLegacy(appDir);
    if (moved.length) log('已迁移旧版数据: ' + moved.join(', '));

    step(72, '创建快捷方式');
    await writeShortcuts(dir, exe, opts);

    step(82, '注册卸载信息');
    writeUninstallKey(dir, exe);

    step(90, opts.autoStart ? '开启开机自启' : '关闭开机自启');
    writeAutoStart(dir, exe, opts.autoStart);

    step(95, '写入安装信息');
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({
      app: APP_NAME, version: VERSION, installedAt: new Date().toISOString(), build: STAMP,
    }, null, 2));

    if (opts.launchAfter) {
      step(98, '启动程序');
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dir, windowsHide: true }).unref();
      } catch (e) { log('启动失败: ' + e.message); }
    }

    step(100, '安装完成');
    state.result = { dir, version: VERSION, migrated: moved };
    state.done = true;
    log(`安装完成 → ${dir}`);
    return true;
  } catch (e) {
    state.error = e && e.message || String(e);
    log('安装失败: ' + (e && e.stack || e));
    return false;
  }
}

// ---------- 卸载 ----------
// 卸载时的自清理：本进程占着自己的 exe（Windows 不允许删除运行中的镜像），
// 因此写一个临时 .bat，等本进程退出后再删目录、最后删掉自己。
// 注意：路径通过参数传（cmd 内部按 Unicode 处理），批处理正文全 ASCII，避免中文编码问题。
function scheduleCleanup(dir, keepData) {
  const bat = path.join(os.tmpdir(), `bm-uninstall-${process.pid}.bat`);
  const body = keepData
    ? ['@echo off',
      'ping -n 4 127.0.0.1 >nul',
      'del /f /q "%~1\\BatteryMonitor.exe" "%~1\\Uninstall.exe" "%~1\\install.json" >nul 2>&1',
      'if exist "%~1\\app\\public" rd /s /q "%~1\\app\\public"',
      'if exist "%~1\\app\\node_modules" rd /s /q "%~1\\app\\node_modules"',
      'del /f /q "%~1\\app\\daemon.js" "%~1\\app\\launch.js" "%~1\\app\\hovercard.js" "%~1\\app\\icongen.js" "%~1\\app\\battery.js" "%~1\\app\\battery.ico" >nul 2>&1',
      'del /f /q "%~f0" >nul 2>&1']
    : ['@echo off',
      'ping -n 4 127.0.0.1 >nul',
      'rd /s /q "%~1" >nul 2>&1',
      'if exist "%~1" (ping -n 4 127.0.0.1 >nul & rd /s /q "%~1" >nul 2>&1)',
      'del /f /q "%~f0" >nul 2>&1'];
  try {
    fs.writeFileSync(bat, body.join('\r\n') + '\r\n');
    const child = spawn('cmd', ['/c', bat, dir], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir(),
    });
    child.unref();
    log(`已派发清理脚本: ${bat} → ${dir}`);
    return true;
  } catch (e) {
    log('清理脚本启动失败: ' + e.message);
    return false;
  }
}

async function doUninstall(opts) {
  const dir = SELF_DIR;
  state.done = false; state.error = null; state.result = null;
  try {
    step(8, '停止正在运行的程序');
    await stopRunning(dir);

    step(28, '移除开机自启');
    try { if (fs.existsSync(STARTUP_VBS)) fs.unlinkSync(STARTUP_VBS); } catch { }
    regExe(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);

    step(45, '移除快捷方式');
    removeShortcuts();

    step(62, '清除注册表信息');
    try {
      execFileSync('reg', ['delete', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`, '/f'],
        { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    } catch { }

    step(80, '删除程序文件');
    const ok = scheduleCleanup(dir, !!opts.keepData);
    if (!ok) throw new Error('无法启动清理进程');

    step(100, opts.keepData ? '已卸载，电量历史已保留' : '卸载完成');
    state.result = { dir, keepData: !!opts.keepData };
    state.done = true;
    log(`卸载完成 ${dir} keepData=${!!opts.keepData}`);
    return true;
  } catch (e) {
    state.error = e && e.message || String(e);
    log('卸载失败: ' + (e && e.stack || e));
    return false;
  }
}

// ---------- 向导（本地页面 + 浏览器） ----------
function serveWizard(kind, opts) {
  let closing = false;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url === '/' || url === '/index.html') {
      return send(200, 'text/html; charset=utf-8', uiPage(kind === 'install' ? 'setup.html' : 'uninstall.html'));
    }
    if (url === '/icon.ico') {
      const ico = iconBytes();
      if (!ico) { res.writeHead(404); return res.end(); }
      return send(200, 'image/x-icon', ico);
    }
    if (url === '/api/state') {
      const cur = kind === 'install' ? (CURRENT_INSTALL || opts.dir) : SELF_DIR;
      return send(200, 'application/json; charset=utf-8', JSON.stringify({
        kind, app: APP_NAME, version: VERSION,
        dir: cur,
        defaultDir: DEFAULT_DIR,
        installed: !!CURRENT_INSTALL,
        installedVersion: (markerOf(SELF_DIR) || {}).version || null,
        sizeMB: kind === 'uninstall' ? Math.round(sizeOnDisk(SELF_DIR) / 1048576) : null,
        legacy: fs.existsSync(path.join(LEGACY_DIR, 'app', 'data')),
      }));
    }
    if (url === '/api/progress') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(state));
    }
    if (url === '/api/install' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', async () => {
        if (state.pct > 0 && !state.done) return send(200, 'application/json', JSON.stringify({ ok: false, error: '安装进行中' }));
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { }
        const dir = (p.dir || opts.dir || DEFAULT_DIR).trim();
        state.pct = 1; state.done = false; state.error = null;
        doInstall({
          dir,
          desktop: !!p.desktop,
          autoStart: !!p.autoStart,
          launchAfter: !!p.launchAfter,
        });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url === '/api/uninstall' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', async () => {
        if (state.pct > 0 && !state.done) return send(200, 'application/json', JSON.stringify({ ok: false, error: '卸载进行中' }));
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { }
        state.pct = 1; state.done = false; state.error = null;
        doUninstall({ keepData: !!p.keepData });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url === '/api/close' && req.method === 'POST') {
      send(200, 'application/json', JSON.stringify({ ok: true }));
      closing = true;
      setTimeout(() => process.exit(0), 300);
      return;
    }
    send(404, 'text/plain; charset=utf-8', 'not found');
  });

  server.on('error', (e) => {
    log('向导服务启动失败: ' + e.message);
    process.exit(1);
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    log(`${kind} 向导: ${url}`);
    openUrl(url);
  });

  // 无人操作时（关掉浏览器）不留隐形进程
  const idle = setTimeout(() => { if (!closing) process.exit(0); }, 45 * 60 * 1000);
  idle.unref();
}

// ---------- 已安装形态：启动器 / 常驻服务 ----------
function ensureExtracted(appDir) {
  const m = markerOf(SELF_DIR);
  if (m && m.version === VERSION && fs.existsSync(path.join(appDir, 'daemon.js'))) return;
  const files = extractTo(appDir);
  try {
    fs.writeFileSync(path.join(SELF_DIR, MARKER), JSON.stringify({
      app: APP_NAME, version: VERSION, installedAt: (m && m.installedAt) || new Date().toISOString(), build: STAMP,
    }, null, 2));
  } catch { }
  log(`更新程序文件 → ${appDir} (${files} 个文件)`);
}

function isDaemonRole() {
  if (process.env.BM_ROLE === 'daemon') return true;
  return RAW_ARGS.some((a) => /(^|[\\/])daemon\.js$/i.test(a));
}

async function runApp() {
  const appDir = path.join(SELF_DIR, 'app');
  try {
    ensureExtracted(appDir);
  } catch (e) {
    log('展开程序文件失败: ' + (e && e.stack || e));
    return;
  }

  if (isDaemonRole()) {
    process.chdir(appDir);
    process.env.BM_APP_DIR = appDir;
    process.env.BM_EXE_DIR = SELF_DIR;
    process.env.BM_VERSION = VERSION;
    try {
      // SEA 内嵌脚本里的 require 只能加载内置模块，加载磁盘文件必须用 createRequire
      const { createRequire } = require('module');
      const entry = path.join(appDir, 'daemon.js');
      createRequire(entry)(entry);
    } catch (e) {
      log('daemon 启动异常: ' + (e && e.stack || e));
      process.exit(1);
    }
    return;
  }

  // 启动器：已在运行则只开状态页
  const port = readPort(SELF_DIR);
  if (await httpJson(port, 'GET', '/api/battery', null, 1500)) {
    if (!hasFlag('--no-open')) openUrl(`http://127.0.0.1:${port}`);
    return;
  }
  try {
    const child = spawn(EXE, [], {
      cwd: SELF_DIR, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, BM_ROLE: 'daemon' },
    });
    child.unref();
  } catch (e) {
    log('派生子进程失败: ' + e.message);
    process.exit(1);
  }
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await httpJson(port, 'GET', '/api/battery', null, 1200)) break;
  }
  if (!hasFlag('--no-open')) openUrl(`http://127.0.0.1:${port}`);
}

// ---------- 自检（排查 PowerShell / 目录解析，不写任何文件） ----------
function probeSpawn(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(t); resolve(`${label}: ${Date.now() - t0}ms ${r}`); } };
    let child;
    try { child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, ...opts }); }
    catch (e) { return resolve(`${label}: spawn失败 ${e.message}`); }
    const t = setTimeout(() => {
      try { child.kill(); } catch { }
      done('TIMEOUT');
    }, 12000);
    child.on('error', (e) => done('ERROR ' + e.message));
    child.on('exit', (code) => done('exit ' + code));
  });
}

async function runDiag() {
  const out = [];
  const noopVbs = path.join(os.tmpdir(), 'bm-noop.vbs');
  try { fs.writeFileSync(noopVbs, 'WScript.Quit 0\r\n'); } catch { }
  out.push('A ' + await probeSpawn('cmd echo', 'cmd', ['/c', 'echo hi>nul']));
  out.push('B ' + await probeSpawn('ps -Command', 'powershell', ['-NoProfile', '-Command', 'exit 0']));
  out.push('C ' + await probeSpawn('ps -Encoded simple', 'powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from('exit 0', 'utf16le').toString('base64')]));
  out.push('D ' + await probeSpawn('ps -Command detached', 'powershell', ['-NoProfile', '-Command', 'exit 0'], { detached: true }));
  out.push('E ' + await probeSpawn('cscript', 'cscript', ['//nologo', '//e:vbscript', path.join(os.tmpdir(), 'bm-noop.vbs')]));
  out.push('F ' + await probeSpawn('reg query', 'reg', ['query', 'HKCU\\Environment']));
  // 快捷方式自检：真的生成一个 .lnk（默认指向已安装的主程序，未安装则指向自身）
  try {
    const lnk = path.join(os.tmpdir(), 'bm-diag.lnk');
    const target = optVal('--lnk-target') || (CURRENT_INSTALL ? path.join(SELF_DIR, APP_NAME + '.exe') : EXE);
    fs.rmSync(lnk, { force: true });
    const r = await runVbs(lnkCode(lnk, target, path.dirname(target), target + ',0', 'diag'));
    const size = fs.existsSync(lnk) ? fs.statSync(lnk).size : 0;
    out.push(`G lnk: ok=${r.ok} size=${size} → ${lnk}`);
  } catch (e) { out.push('G 失败 ' + e.message); }

  const lnkTarget = optVal('--lnk');
  if (lnkTarget) {
    // 用 ShellExecute 打开指定 .lnk（验证快捷方式能否被系统正确解析）
    try {
      spawn('cmd', ['/c', 'start', '', lnkTarget], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      out.push(`H open-lnk: 已派发 ${lnkTarget}`);
    } catch (e) { out.push('H open-lnk 失败: ' + e.message); }
  }
  const text = out.join('\n');
  log('--- diag ---\n' + text);
  try { fs.writeFileSync(path.join(os.tmpdir(), 'BatteryMonitor-diag.txt'), text, 'utf8'); } catch { }
  process.exit(0);
}

// ---------- 角色判定 & 入口 ----------
function pickRole() {
  if (SELF_LOWER.startsWith('uninstall') || hasFlag('--uninstall')) return 'uninstall';
  if (hasFlag('--install') || hasFlag('--setup')) return 'install';
  if (CURRENT_INSTALL) return 'run';
  return 'install';   // 从下载目录双击 → 安装
}

(async () => {
  const role = pickRole();
  log(`启动 v${VERSION} role=${role} exe=${EXE} args=${RAW_ARGS.join(' ')}`);

  if (hasFlag('--diag')) return runDiag();

  if (role === 'uninstall') {
    if (hasFlag('--silent')) {
      const ok = await doUninstall({ keepData: hasFlag('--keep-data') });
      await sleep(300);
      process.exit(ok ? 0 : 1);
    }
    return serveWizard('uninstall', {});
  }

  if (role === 'install') {
    const opts = {
      dir: optVal('--dir') || DEFAULT_DIR,
      desktop: !hasFlag('--no-desktop'),
      autoStart: !hasFlag('--no-autostart'),
      launchAfter: !hasFlag('--no-launch'),
    };
    if (hasFlag('--silent')) {
      const ok = await doInstall(opts);
      await sleep(300);
      process.exit(ok ? 0 : 1);
    }
    return serveWizard('install', opts);
  }

  return runApp();
})();
