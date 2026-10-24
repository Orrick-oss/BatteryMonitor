// 构建发行版可执行文件: 内嵌 app 载荷 + Node 运行时 (Node SEA)
// 用法: node scripts/build-exe.js [版本号]
// 产物: dist/BatteryMonitor.exe               主程序（安装目录内运行的那一个）
//       dist/BatteryMonitor-Setup-<ver>.exe   安装包（双击进入安装向导）
// 同一份二进制按「文件名 / 运行位置」自动切换角色，见 scripts/bootstrap.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'stage');
const DIST = path.join(ROOT, 'dist');
const VER = process.argv[2] || JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;

const NODE_SRC = process.env.NODE_EXE ||
  'C:/Users/admin/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
const TOOLS_JS = path.join(BUILD, 'tools', 'node_modules');
const CLI = {
  resedit: path.join(TOOLS_JS, 'resedit-cli', 'dist', 'cli.js'),
  postject: path.join(TOOLS_JS, 'postject', 'dist', 'cli.js'),
};

const MAGIC = 'BMPKG2\0\0';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function copyDir(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name)) continue;
    const s = path.join(src, name), d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, skip);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

// ---------- 1. 组装载荷 ----------
console.log(`[1/6] 组装载荷 v${VER}`);
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 代码文件(排除开发用脚本/运行时数据)
const CODE = ['daemon.js', 'launch.js', 'hovercard.js', 'icongen.js', 'battery.js',
  'package.json', 'config.json', 'battery.ico'];
for (const f of CODE) {
  const src = path.join(APP, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
}
// config.json 属本地用户配置(不入库), 缺失时给一份默认值
if (!fs.existsSync(path.join(STAGE, 'config.json'))) {
  fs.writeFileSync(path.join(STAGE, 'config.json'), JSON.stringify({
    port: 8787, pollMs: 60000, batteryOffset: 0, lowThreshold: 20, autoOpen: false, offsets: {},
  }, null, 2));
}
copyDir(path.join(APP, 'public'), path.join(STAGE, 'public'));

// 依赖(剔除其它平台的预编译二进制, 只留 win32-x64)
copyDir(path.join(APP, 'node_modules'), path.join(STAGE, 'node_modules'), (name) => name === '.bin');
function prunePrebuilds(base, keepRe) {
  if (!fs.existsSync(base)) return;
  for (const d of fs.readdirSync(base)) {
    if (!keepRe.test(d)) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  }
}
prunePrebuilds(path.join(STAGE, 'node_modules', 'node-hid', 'prebuilds'), /^HID-win32-x64$/);
prunePrebuilds(path.join(STAGE, 'node_modules', 'koffi', 'prebuilds'), /^win32_x64$/);
// systray2 只留 Windows 托盘程序(darwin/linux 各 ~4MB)
const TRAYBIN = path.join(STAGE, 'node_modules', 'systray2', 'traybin');
if (fs.existsSync(TRAYBIN)) {
  for (const d of fs.readdirSync(TRAYBIN)) {
    if (!/^tray_windows/i.test(d)) fs.rmSync(path.join(TRAYBIN, d), { force: true });
  }
}
// 文档类文件不进包
(function pruneDocs(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { pruneDocs(p); continue; }
    if (/\.(md|markdown|map|ts)$/i.test(name) || name === '.package-lock.json') fs.rmSync(p, { force: true });
  }
})(path.join(STAGE, 'node_modules'));

// 体积统计
let fileCount = 0, rawSize = 0;
(function count(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) count(p);
    else { fileCount++; rawSize += st.size; }
  }
})(STAGE);
console.log(`      文件 ${fileCount} 个, 原始 ${(rawSize / 1048576).toFixed(1)}MB`);

// ---------- 2. 打包 + 压缩 ----------
console.log('[2/6] 生成内嵌载荷 payload.bin');
function makeArchive(dir) {
  const files = [];
  (function walk(rel) {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? rel + '/' + name : name;
      const p = path.join(dir, r);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.push({ rel: r, data: fs.readFileSync(p) });
    }
  })('');
  const head = Buffer.alloc(12);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(files.length, 8);
  const parts = [head];
  for (const f of files) {
    const relBuf = Buffer.from(f.rel, 'utf8');
    const h = Buffer.alloc(2); h.writeUInt16LE(relBuf.length, 0);
    const s = Buffer.alloc(4); s.writeUInt32LE(f.data.length, 0);
    parts.push(h, relBuf, s, f.data);
  }
  return Buffer.concat(parts);
}
const archive = makeArchive(STAGE);
const payload = zlib.gzipSync(archive, { level: 9 });
fs.writeFileSync(path.join(BUILD, 'payload.bin'), payload);
console.log(`      压缩后 ${(payload.length / 1048576).toFixed(1)}MB (压缩率 ${(100 - payload.length / archive.length * 100).toFixed(0)}%)`);

// ---------- 3. 生成引导程序 + SEA 配置 ----------
console.log('[3/6] 生成 SEA 引导程序');
const stamp = `${VER}-${payload.length}`;
const bootstrap = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8')
  .replace('__BM_VERSION__', VER)
  .replace('__BM_BUILD__', stamp);
const bootstrapOut = path.join(BUILD, 'bootstrap.out.js');
fs.writeFileSync(bootstrapOut, bootstrap);

const seaConfig = path.join(BUILD, 'sea-config.json');
const UI = path.join(__dirname, 'ui');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bootstrapOut,
  output: path.join(BUILD, 'sea-prep.blob'),
  assets: {
    'payload.bin': path.join(BUILD, 'payload.bin'),
    'setup.html': path.join(UI, 'setup.html'),
    'uninstall.html': path.join(UI, 'uninstall.html'),
  },
  disableExperimentalSEAWarning: true,
}, null, 2));

if (!fs.existsSync(NODE_SRC)) {
  console.error('找不到 node.exe: ' + NODE_SRC);
  process.exit(1);
}

// ---------- 4. 生成 SEA blob ----------
console.log('[4/6] 生成 SEA blob');
sh(process.execPath, ['--experimental-sea-config', seaConfig]);

// ---------- 5. 拼装 exe (图标/版本信息/注入) ----------
console.log('[5/6] 拼装 exe');
fs.mkdirSync(DIST, { recursive: true });
const OUT = path.join(DIST, 'BatteryMonitor.exe');

// 5a. 先写资源(图标+版本信息) —— 在干净的 node.exe 上做, 避免破坏 SEA 资源
sh(process.execPath, [CLI.resedit,
  '--in', NODE_SRC, '--out', OUT,
  '--icon', '1,' + path.join(APP, 'battery.ico'),
  '--product-name', 'BatteryMonitor',
  '--company-name', 'BatteryMonitor',
  '--file-version', VER + '.0',
  '--product-version', VER + '.0',
  '--ignore-signed',
]);

// 5b. 注入 SEA blob
sh(process.execPath, [CLI.postject,
  OUT, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

// 5c. PE 子系统 console(3) → windows(2): 双击不弹黑框
const fd = fs.openSync(OUT, 'r+');
const head = Buffer.alloc(64);
fs.readSync(fd, head, 0, 64, 0);
const peOff = head.readUInt32LE(0x3C);
const sub = Buffer.alloc(2);
fs.readSync(fd, sub, 0, 2, peOff + 0x5C);
if (sub.readUInt16LE(0) === 3) {
  sub.writeUInt16LE(2, 0);
  fs.writeSync(fd, sub, 0, 2, peOff + 0x5C);
  console.log('      子系统: console → windows (无黑框)');
} else {
  console.log('      子系统已是 ' + sub.readUInt16LE(0) + ' (跳过)');
}
fs.closeSync(fd);

// 5d. UPX 压缩运行时: 93MB → ~28MB。必须在 resedit/postject/子系统补丁全部之后
// (UPX 会重写 PE 节布局, 压缩后无法再注入)。postject 注入的节点与资源实测兼容。
const UPX = process.env.UPX_EXE || 'D:/Tools/upx/upx-5.0.2-win64/upx.exe';
if (fs.existsSync(UPX)) {
  console.log('      UPX 压缩…');
  sh(UPX, ['--best', '--lzma', '--force', OUT]);
} else {
  console.log('      未找到 UPX, 跳过压缩 (体积较大)');
}

// ---------- 6. 汇总 ----------
const setupOut = path.join(DIST, `BatteryMonitor-Setup-${VER}.exe`);
fs.copyFileSync(OUT, setupOut);
const finalSize = fs.statSync(OUT).size;
console.log(`[6/6] 完成`);
console.log(`      安装包 ${setupOut}  ${(finalSize / 1048576).toFixed(1)}MB`);
console.log(`      主程序 ${OUT}`);
fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(path.join(BUILD, 'sea-prep.blob'), { force: true });
fs.rmSync(path.join(BUILD, 'payload.bin'), { force: true });
