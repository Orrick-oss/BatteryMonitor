// mkshortcut.js — 生成 battery.ico + 桌面快捷方式（纯 Node, 无 COM）
'use strict';
const fs = require('fs');
const path = require('path');
const { drawIcon } = require('./icongen');

const NODE_EXE = 'C:\\Users\\admin\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe';
const APP_DIR = 'D:\\BatteryMonitor\\app';
const TARGET = APP_DIR + '\\launch.js'; // 智能启动器: 已在运行→开页面, 未运行→拉起服务
const ICO_PATH = APP_DIR + '\\battery.ico';
const LNK_PATH = 'D:\\Users\\admin\\Desktop\\A7 Pro 电量监视.lnk'; // 用户真实桌面在 D 盘

// ---- ICO (内嵌 PNG, Vista+ 支持) ----
function makeIco(pngBuf, w, h) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICON, 1 张
  const dir = Buffer.alloc(16);
  dir[0] = w >= 256 ? 0 : w; dir[1] = h >= 256 ? 0 : h;
  dir[2] = 0; dir[3] = 0;               // 调色板/保留
  dir.writeUInt16LE(1, 4);              // planes
  dir.writeUInt16LE(32, 6);             // bpp
  dir.writeUInt32LE(pngBuf.length, 8);  // 数据大小
  dir.writeUInt32LE(22, 12);            // 偏移 = 6+16
  return Buffer.concat([head, dir, pngBuf]);
}
const png = drawIcon({ pct: 93, color: '#22c55e', charging: false, online: true });
fs.writeFileSync(ICO_PATH, makeIco(png, 64, 64));
console.log('图标:', ICO_PATH, fs.statSync(ICO_PATH).size + 'B');

// ---- MS-SHLLINK .lnk ----
const unicodeString = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
function buildVolumeID() {
  const size = 18, v = Buffer.alloc(size);
  v.writeUInt32LE(size, 0); v.writeUInt32LE(3, 4); v.writeUInt32LE(0, 8); v.writeUInt32LE(0x10, 12);
  Buffer.from([0, 0]).copy(v, 16);
  return v;
}
function buildLinkInfo(localPath) {
  const localAnsi = Buffer.from(localPath, 'latin1');
  const localUni = unicodeString(localPath);
  const suffixAnsi = Buffer.from([0]);
  const suffixUni = unicodeString('');
  const vol = buildVolumeID();
  const hs = 0x24, volOff = hs, localOff = volOff + vol.length;
  const suffixOff = localOff + localAnsi.length + 1;
  const localUniOff = suffixOff + suffixAnsi.length;
  const suffixUniOff = localUniOff + localUni.length;
  const total = suffixUniOff + suffixUni.length;
  const h = Buffer.alloc(0x24);
  h.writeUInt32LE(total, 0); h.writeUInt32LE(hs, 4); h.writeUInt32LE(0x1, 8);
  h.writeUInt32LE(volOff, 12); h.writeUInt32LE(localOff, 16); h.writeUInt32LE(0, 20);
  h.writeUInt32LE(suffixOff, 24); h.writeUInt32LE(localUniOff, 28); h.writeUInt32LE(suffixUniOff, 32);
  return Buffer.concat([h, vol, localAnsi, Buffer.from([0]), suffixAnsi, localUni, suffixUni]);
}
function stringItem(s) {
  const d = Buffer.from(s, 'utf16le');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(d.length / 2 + 1, 0);
  return Buffer.concat([head, d, Buffer.from([0, 0])]);
}

const CLSID = Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
const linkFlags = 0x2 | 0x4 | 0x10 | 0x20 | 0x40 | 0x80; // +HasArguments
const args = `"${TARGET}"`;
const wd = APP_DIR;
const icon = ICO_PATH + ',0';
const nameStr = 'A7 Pro 电量监视';

const header = Buffer.alloc(76);
header.writeUInt32LE(76, 0);
CLSID.copy(header, 4);
header.writeUInt32LE(linkFlags, 20);
header.writeUInt32LE(0x20, 24);        // FileAttributes: archive
header.writeUInt32LE(0, 28); header.writeUInt32LE(0, 36); header.writeUInt32LE(0, 44);
header.writeUInt32LE(0, 52);           // FileSize
header.writeUInt32LE(0, 56);           // IconIndex
header.writeUInt32LE(7, 60);           // SW_SHOWMINNOACTIVE
header.writeUInt16LE(0, 64); header.writeUInt16LE(0, 66); header.writeUInt32LE(0, 68); header.writeUInt32LE(0, 72);

const lnk = Buffer.concat([
  header,
  buildLinkInfo(NODE_EXE),
  stringItem(nameStr),
  stringItem(wd),
  stringItem(args),
  stringItem(icon),
]);
fs.writeFileSync(LNK_PATH, lnk);
console.log('快捷方式:', LNK_PATH, lnk.length + 'B');
console.log('  目标  :', NODE_EXE);
console.log('  参数  :', args);
console.log('  工作目录:', wd);
