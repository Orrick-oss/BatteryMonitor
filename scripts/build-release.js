// 打包绿色便携版: 组装 dist/BatteryMonitor/ → zip
// 用法: node scripts/build-release.js [版本号]
// 结构:
//   BatteryMonitor/
//     node/node.exe            <- 运行时(来源见 NODE_SRC)
//     app/                     <- 代码+依赖(含预编译二进制, 解压即用)
//     Start.vbs                <- 双击启动(已运行则打开状态页)
//     README.txt               <- 小白使用说明
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DIST = path.join(ROOT, 'dist');
const PKG_DIR = path.join(DIST, 'BatteryMonitor');
const VER = process.argv[2] || '1.0.0';

// node.exe 来源: WorkBuddy 自带 v22(MIT 许可, 可再分发), 可用环境变量覆盖
const NODE_SRC = process.env.NODE_EXE ||
  'C:/Users/admin/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
if (!fs.existsSync(NODE_SRC)) {
  console.error('找不到 node.exe: ' + NODE_SRC + ' (可用 NODE_EXE=路径 覆盖)');
  process.exit(1);
}

// 复制(排除模式)
function copyDir(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name, path.join(src, name))) continue;
    const s = path.join(src, name), d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

console.log('组装', PKG_DIR);
fs.rmSync(PKG_DIR, { recursive: true, force: true });

// 1. app 代码: 排除个人数据/调试存档, 保留 node_modules(预编译二进制就在里面)
copyDir(APP, path.join(PKG_DIR, 'app'), (name, full) =>
  ['data', 'config.json', 'tools', 'mkshortcut.js', 'battery.ico'].includes(name) ||
  name.endsWith('.ico'));

// 2. node 运行时
fs.mkdirSync(path.join(PKG_DIR, 'node'), { recursive: true });
fs.copyFileSync(NODE_SRC, path.join(PKG_DIR, 'node', 'node.exe'));

// 3. 双击启动器(隐藏启动; launch.js 自带"已运行则只开页面"逻辑)
fs.writeFileSync(path.join(PKG_DIR, 'Start.vbs'), [
  "' BatteryMonitor 启动器: 双击启动/已运行则打开状态页",
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
  'CreateObject("WScript.Shell").Run """" & dir & "\\node\\node.exe"" ""' +
    '" & dir & "\\app\\launch.js""", 0, False',
  '',
].join('\n'));

// 4. 小白使用说明
fs.writeFileSync(path.join(PKG_DIR, 'README.txt'), [
  '==============================',
  '  BatteryMonitor 使用说明',
  '==============================',
  '',
  '【开始使用】只需两步:',
  '  1. 把整个 BatteryMonitor 文件夹解压/放到任意位置(建议 D:\\BatteryMonitor)',
  '  2. 双击 Start.vbs',
  '  完成! 屏幕右下角任务栏会出现电池图标, 鼠标悬停显示设备电量。',
  '',
  '【日常使用】',
  '  - 左键点电池图标: 打开电量详情页面',
  '  - 右键点电池图标: 查看各设备实时读数 / 开机自启开关 / 立即刷新 / 退出',
  '  - 设备开机后插上 2.4G 接收器即自动识别, 无需任何配置',
  '',
  '【开机自启】(推荐)',
  '  右键电池图标 -> 点「开机自启: 已关闭」-> 变为已开启并弹提示。',
  '  之后每次开机自动在后台运行, 不弹任何窗口。',
  '',
  '【支持的设备】',
  '  - 迈从 MCHOSE A7 Pro / ATK X1 V2 (鼠标, 2.4G)',
  '  - 狼蛛 AULA F87 / F99 Pro (键盘, 2.4G)',
  '',
  '【常见问题】',
  '  Q: 图标不见了?',
  '  A: 点任务栏右下角的 ^ 展开隐藏图标; 若在里面, 拖到任务栏上即可。',
  '  Q: 显示"设备休眠"?',
  '  A: 设备省电休眠了, 动一动鼠标/按任意键即恢复。',
  '  Q: 电量数字和设备显示差一点?',
  '  A: 打开详情页面, 在对应设备卡片里填一个校正偏移(如 -1)。',
  '  Q: 想彻底卸载?',
  '  A: 右键电池图标 -> 退出; 右键 -> 开机自启切到已关闭; 删除本文件夹。',
  '',
  '【系统要求】Windows 10/11 x64, 无需安装任何运行环境。',
  '',
].join('\r\n'));

// 5. 压缩 zip(包内文件名全 ASCII, 避免解压乱码)
const zipPath = path.join(DIST, `BatteryMonitor-v${VER}-win-x64.zip`);
fs.rmSync(zipPath, { force: true });
execSync(`powershell -NoProfile -Command "Compress-Archive -Path 'D:\\BatteryMonitor\\dist\\BatteryMonitor' -DestinationPath 'D:\\BatteryMonitor\\dist\\BatteryMonitor-v${VER}-win-x64.zip' -CompressionLevel Optimal"`, { stdio: 'inherit' });

const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`完成: ${zipPath} (${size} MB)`);
