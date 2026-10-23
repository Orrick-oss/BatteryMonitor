// launch.js — 智能启动器（快捷方式/开机自启指向这里，而不是直接指向 daemon.js）
// 行为: 服务已在运行 → 直接打开状态页; 未运行 → 后台拉起 daemon(隐藏窗口) → 打开状态页
// 参数: --no-open 开机自启用，只确保服务在跑，不弹浏览器
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
// 端口与 daemon.js 的 config.json 保持一致
let PORT = 8787;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));
  if (Number.isFinite(cfg.port)) PORT = cfg.port;
} catch { }

function tryApi(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/battery', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_OPEN = process.argv.includes('--no-open');
function openBrowser() {
  if (NO_OPEN) return;
  try {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
  } catch { }
}

(async () => {
  // 1) 已在运行 → 只开页面，不重复起服务
  if (await tryApi(1500)) {
    openBrowser();
    return;
  }
  // 2) 未运行 → 隐藏窗口、脱离会话启动守护进程
  try {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'daemon.js')], {
      cwd: APP_DIR, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) {
    process.exit(1);
  }
  // 3) 等服务就绪(最多 ~12s)后打开页面
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await tryApi(1200)) { openBrowser(); return; }
  }
  // 4) 超时兜底：也把页面打开，用户能看到浏览器报错而不是毫无反应
  openBrowser();
})();
