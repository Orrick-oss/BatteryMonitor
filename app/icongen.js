// icongen.js — 纯 Node 生成托盘电量图标 PNG（零依赖，内置 zlib）
'use strict';
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); // PNG 规范: 大端序
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); // PNG 规范: 大端序
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 电量图标绘制 64x64（返回 RGBA 像素） ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const OUTLINE = hex('#4b5563');
const NUB = hex('#4b5563');

function drawRGBA({ pct = 0, color = '#22c55e', charging = false, online = true, kind = null } = {}) {
  const S = 64;
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };

  if (online) {
    // 电池外框 x10-49, y18-45，圆角效果: 角上留空
    const L = 10, R = 49, T = 18, B = 45;
    for (let x = L; x <= R; x++) { rect(x, T, x, T + 2, OUTLINE); rect(x, B - 2, x, B, OUTLINE); }
    for (let y = T; y <= B; y++) { rect(L, y, L + 2, y, OUTLINE); rect(R - 2, y, R, y, OUTLINE); }
    // 正极凸头
    rect(R + 2, 27, R + 5, 36, NUB);
    // 电量填充
    if (pct > 0) {
      const ix0 = L + 4, ix1 = R - 4, iy0 = T + 4, iy1 = B - 4;
      const w = Math.round((ix1 - ix0 + 1) * Math.min(pct, 100) / 100);
      rect(ix0, iy0, ix0 + Math.max(w - 1, 1), iy1, hex(color));
    }
    // 充电闪电（覆盖在填充上）
    if (charging) {
      const Y = hex('#fde047');
      const bolt = [
        [30, 12], [32, 12], [28, 26], [33, 26], [25, 44], [23, 44], [27, 30], [22, 30],
      ];
      // 简化闪电: 两条粗折线
      const line = (x0, y0, x1, y1, t, c) => {
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let i = 0; i <= n; i++) {
          const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
          rect(x, y, x + t, y + t, c);
        }
      };
      line(33, 10, 24, 28, 2, Y);
      line(24, 28, 32, 28, 2, Y);
      line(32, 28, 24, 46, 2, Y);
      void bolt;
    }
  } else {
    // 离线: 灰色空心电池 + 斜杠
    const L = 10, R = 49, T = 18, B = 45, G = hex('#9ca3af');
    for (let x = L; x <= R; x++) { rect(x, T, x, T + 2, G); rect(x, B - 2, x, B, G); }
    for (let y = T; y <= B; y++) { rect(L, y, L + 2, y, G); rect(R - 2, y, R, y, G); }
    rect(R + 2, 27, R + 5, 36, G);
    const line = (x0, y0, x1, y1) => {
      const n = Math.abs(x1 - x0);
      for (let i = 0; i <= n; i++) rect(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 0, 0, G);
    };
    for (let d = -3; d <= 3; d++) {
      for (let y = T; y <= B; y++) {
        const x = Math.round(L + (y - T) * (R - L) / (B - T)) + d;
        set(x, y, G); set(x + 1, y, G);
      }
    }
    void line;
  }

  // ---------- 设备类型角标: 电池右下角深色圆角块 + 鼠标/键盘图形 ----------
  if (kind === 'mouse' || kind === 'keyboard') {
    const BG = hex('#1f2937'), FG = hex('#f9fafb');
    const X0 = 40, Y0 = 40, X1 = 62, Y1 = 62;
    rect(X0, Y0, X1, Y1, BG);
    // 抠角 2px 制造圆角
    for (let i = 0; i < 2; i++) {
      set(X0 + i, Y0 + i, [0, 0, 0, 0]); set(X1 - i, Y0 + i, [0, 0, 0, 0]);
      set(X0 + i, Y1 - i, [0, 0, 0, 0]); set(X1 - i, Y1 - i, [0, 0, 0, 0]);
    }
    if (kind === 'mouse') {
      // 胶囊形鼠标: 轮廓 48..54 x 43..54 + 左右键分界线
      for (let x = 48; x <= 54; x++) { set(x, 43, FG); set(x, 54, FG); }
      for (let y = 43; y <= 54; y++) { set(48, y, FG); set(54, y, FG); }
      for (let y = 44; y <= 48; y++) set(51, y, FG);
    } else {
      // 键盘: 外框 45..58 x 45..56, 两排键点 + 空格条
      for (let x = 45; x <= 58; x++) { set(x, 45, FG); set(x, 56, FG); }
      for (let y = 45; y <= 56; y++) { set(45, y, FG); set(58, y, FG); }
      for (const ry of [48, 51]) for (let x = 47; x <= 56; x += 3) set(x, ry, FG);
      rect(48, 54, 55, 54, FG);
    }
  }
  return { S, px };
}

// PNG 版本（页面/调试用）
function drawIcon(params) {
  const { S, px } = drawRGBA(params);
  return encodePNG(S, S, px);
}

// ---------- ICO 编码（经典 32bpp BMP 格式，Windows 托盘必需） ----------
// 结构: ICONDIR(6B) + ICONDIRENTRY(16B) + BITMAPINFOHEADER(40B) + XOR(BGRA 倒序) + AND 掩码(1bpp 倒序)
function encodeICO(width, height, rgba) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4); // type=1 图标, 1 张图

  const stride = width * 4;
  const xor = Buffer.alloc(stride * height);
  const maskStride = Math.ceil(width / 32) * 4; // AND 掩码行按 32bit 对齐
  const and = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // BMP 行序自底向上
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * 4;
      const di = y * stride + x * 4;
      xor[di] = rgba[si + 2];     // B
      xor[di + 1] = rgba[si + 1]; // G
      xor[di + 2] = rgba[si];     // R
      xor[di + 3] = rgba[si + 3]; // A
      if (rgba[si + 3] === 0) and[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7); // 透明位
    }
  }

  const bih = Buffer.alloc(40); // BITMAPINFOHEADER
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(width, 4);
  bih.writeInt32LE(height * 2, 8); // ICO 特有: 高度 = XOR + AND 两倍
  bih.writeUInt16LE(1, 12);  // planes
  bih.writeUInt16LE(32, 14); // bitCount
  bih.writeUInt32LE(0, 16);  // BI_RGB
  bih.writeUInt32LE(xor.length + and.length, 20); // sizeImage

  const entry = Buffer.alloc(16); // ICONDIRENTRY
  entry[0] = width % 256; entry[1] = height % 256;
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bitCount
  entry.writeUInt32LE(40 + xor.length + and.length, 8); // bytesInRes
  entry.writeUInt32LE(22, 12); // 偏移 = 6 + 16

  return Buffer.concat([dir, entry, bih, xor, and]);
}

// alpha 感知的盒式降采样（64 → 32 等）
function downsample(rgba, w, factor) {
  const nw = w / factor;
  const out = Buffer.alloc(nw * nw * 4);
  for (let y = 0; y < nw; y++) for (let x = 0; x < nw; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * w + (x * factor + dx)) * 4;
      const al = rgba[i + 3];
      r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
    }
    const o = (y * nw + x) * 4;
    if (a > 0) {
      out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / (factor * factor));
    }
  }
  return out;
}

// 状态 → 图标缓存（Windows 托盘要求 ICO 格式，见 systray2 README）
const cache = new Map();
function iconFor(state) {
  const low = Number.isFinite(state.low) ? state.low : 20; // 跟随用户自定义阈值, 不再硬编码分档
  let color = '#22c55e';
  if (!state.linked || !state.ok) color = '#9ca3af';
  else if (state.charging) color = '#3b82f6';
  else if (state.battery <= low) color = '#ef4444';
  const key = [color, state.charging ? 'c' : '', state.linked && state.ok ? 'on' : 'off', state.kind || '', low].join('|');
  if (!cache.has(key)) {
    const { S, px } = drawRGBA({ pct: state.battery, color, charging: state.charging, online: state.linked && state.ok, kind: state.kind });
    // 托盘用 32x32（64 降采样更锐利），ICO 格式
    cache.set(key, encodeICO(S / 2, S / 2, downsample(px, S, 2)).toString('base64'));
  }
  return cache.get(key);
}

// 生成 64x64 ICO（桌面快捷方式 battery.ico 用）
function fullSizeICO(state) {
  const { S, px } = drawRGBA(state);
  return encodeICO(S, S, px);
}

module.exports = { iconFor, fullSizeICO, encodePNG, encodeICO, drawRGBA, downsample };

// CLI 预览: node icongen.js → 生成 sample-*.png / sample-*.ico
if (require.main === module) {
  const fs = require('fs');
  const samples = [
    ['high', { pct: 93, color: '#22c55e', charging: false, online: true, kind: 'mouse' }],
    ['mid', { pct: 45, color: '#f59e0b', charging: false, online: true, kind: 'keyboard' }],
    ['low', { pct: 15, color: '#ef4444', charging: false, online: true, kind: 'mouse' }],
    ['charging', { pct: 66, color: '#3b82f6', charging: true, online: true, kind: 'keyboard' }],
    ['offline', { pct: 0, color: '#9ca3af', charging: false, online: false, kind: 'mouse' }],
  ];
  for (const [name, s] of samples) {
    const { S, px } = drawRGBA(s);
    fs.writeFileSync(`tools/sample-${name}.png`, encodePNG(S, S, px));
    fs.writeFileSync(`tools/sample-${name}.ico`, encodeICO(S, S, px));
    console.log('生成 tools/sample-' + name + '.png / .ico');
  }
}
