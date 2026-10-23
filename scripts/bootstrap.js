// bootstrap.js — 单文件 exe 的入口（Node SEA 嵌入执行）
// 职责:
//   1) 首次运行/版本变化时, 把内嵌的 app 载荷解包到 %LOCALAPPDATA%\BatteryMonitor\app
//   2) 按角色启动: 守护进程(daemon) 或 启动器(launcher, 等同 launch.js 行为)
// 为什么解包: koffi/node-hid/systray2 都含原生二进制(.node/.exe), 必须从真实磁盘路径加载。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const { spawn } = require('child_process');

const VERSION = '__BM_VERSION__';           // 构建时替换为真实版本号
const STAMP = '__BM_BUILD__';               // 版本+载荷指纹, 载荷变化即重新解包
const MAGIC = 'BMPKG2\0\0';

const BASE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'BatteryMonitor');
const APP = path.join(BASE, 'app');
const MARK = path.join(APP, '.payload-version');
const LOG_FILE = path.join(BASE, 'launcher.log');

function log(msg) {
  try {
    fs.mkdirSync(BASE, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { }
}

// ---------- 载荷解包 ----------
function readPayload() {
  const sea = require('node:sea');
  const ab = sea.getAsset('payload.bin');
  if (!ab) throw new Error('内嵌载荷缺失');
  return zlib.gunzipSync(Buffer.from(ab));
}

function parseArchive(buf) {
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
  return files;
}

function extract(force) {
  const need = force || !fs.existsSync(MARK) || fs.readFileSync(MARK, 'utf8').trim() !== STAMP;
  if (!need) return false;
  const t0 = Date.now();
  const files = parseArchive(readPayload());
  const keepConfig = fs.existsSync(path.join(APP, 'config.json'));
  for (const f of files) {
    // 路径安全: 拒绝绝对路径与 .. 穿越
    const rel = f.rel.replace(/\\/g, '/');
    if (rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel) || /^[a-zA-Z]:/.test(rel)) continue;
    const dest = path.join(APP, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 升级时保留用户配置(/api 页面设置)与历史数据
    if (keepConfig && rel === 'config.json') continue;
    if (rel.startsWith('data/')) continue;
    fs.writeFileSync(dest, f.data);
  }
  fs.mkdirSync(path.join(APP, 'data'), { recursive: true });
  fs.writeFileSync(MARK, STAMP);
  log(`解包完成 v${VERSION}: ${files.length} 个文件, ${Date.now() - t0}ms → ${APP}`);
  return true;
}

// ---------- 启动器行为(等价 launch.js) ----------
function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
    if (Number.isFinite(cfg.port)) return cfg.port;
  } catch { }
  return 8787;
}

function tryApi(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/battery', timeout: timeoutMs }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_OPEN = process.argv.includes('--no-open');

function openBrowser(port) {
  if (NO_OPEN) return;
  try {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { }
}

// ---------- 角色判定 ----------
// 兼容三种来源:
//   - 用户双击 exe            → launcher
//   - launcher 自我派生        → env BM_ROLE=daemon
//   - 旧版自启/快捷方式带路径   → 参数以 daemon.js 结尾则视为 daemon
function isDaemonRole() {
  if (process.env.BM_ROLE === 'daemon') return true;
  return process.argv.slice(1).some((a) => /(^|[\\/])daemon\.js$/i.test(a));
}

(async () => {
  try {
    extract();
  } catch (e) {
    log('解包失败: ' + (e && e.stack || e));
    return;
  }

  if (isDaemonRole()) {
    process.chdir(APP);
    process.env.BM_APP_DIR = APP;
    process.env.BM_VERSION = VERSION;
    try {
      // SEA 内嵌脚本里的 require 只能加载内置模块, 加载磁盘文件必须用 createRequire
      const { createRequire } = require('module');
      const entry = path.join(APP, 'daemon.js');
      createRequire(entry)(entry);
    } catch (e) {
      log('daemon 启动异常: ' + (e && e.stack || e));
      process.exit(1);
    }
    return;
  }

  // launcher
  const port = readPort();
  if (await tryApi(port, 1500)) { openBrowser(port); return; }
  try {
    const child = spawn(process.execPath, [], {
      cwd: APP, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, BM_ROLE: 'daemon' },
    });
    child.unref();
  } catch (e) {
    log('派生子进程失败: ' + (e && e.message));
    process.exit(1);
  }
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await tryApi(port, 1200)) { openBrowser(port); return; }
  }
  openBrowser(port);
})();
