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
// 样式模仿 vigil-watt 托盘贴片: 状态色实心圆 + 白色粗体数字, 充电画自绘闪电,
// 离线灰色圆 + 短横线; 圆顶部保留设备类型小徽标(鼠标/键盘), 充电时让位给闪电。
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
// vigil-watt UiPalette 配色: Charging/Low/Good/Offline
const C_CHARGING = hex('#0A84FF');
const C_LOW = hex('#E2445C');
const C_GOOD = hex('#34C759');
const C_OFFLINE = hex('#8E8E93');
const WHITE = [255, 255, 255, 255];

// 3x5 像素数字字体(白色, 4px 放大)
const DIGITS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
};

function drawRGBA({ pct = null, color = '#34C759', charging = false, online = true, kind = null } = {}) {
  const S = 64;
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
  // 实心圆(带边缘锯齿柔化: 边缘圈像素半透明)
  const circle = (cx, cy, r, c) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r - 1) set(x, y, c);
        else if (d <= r) set(x, y, [c[0], c[1], c[2], Math.round(c[3] * (r - d))]); // 边缘渐隐
      }
    }
  };
  // 多边形扫描填充(even-odd, vigil-watt DrawBolt 的闪电形状)
  const polygon = (pts, c) => {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.round(xs[i]); x <= Math.round(xs[i + 1]); x++) set(x, y, c);
      }
    }
  };
  // 数字串绘制: 3x5 字形放大 cell 倍, 水平居中于 cx, 垂直居中于 cy
  const drawText = (text, cell, cx, cy, c) => {
    const dw = text.length * (3 * cell) + (text.length - 1) * cell;
    const dh = 5 * cell;
    let x0 = Math.round(cx - dw / 2), y0 = Math.round(cy - dh / 2);
    for (const ch of text) {
      const g = DIGITS[ch];
      if (!g) { x0 += 4 * cell; continue; }
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] === '1') rect(x0 + gx * cell, y0 + gy * cell, x0 + gx * cell + cell - 1, y0 + gy * cell + cell - 1, c);
      }
      x0 += 4 * cell;
    }
  };

  // ---- 圆底: 状态色 ----
  const base = online ? (charging ? C_CHARGING : hex(color)) : C_OFFLINE;
  circle(32, 32, 29, base);

  if (!online) {
    drawText('-', 5, 32, 33, WHITE); // 短横线(即 vigil-watt 的 "–")
  } else if (charging) {
    // 闪电: vigil-watt DrawBolt 多边形(w=7,h=11 归一化坐标), 白色
    const w = 20, h = 32, x = 32 - w / 2, y = 16;
    const P = (fx, fy) => [x + fx * w, y + fy * h];
    polygon([P(.58, 0), P(0, .56), P(.42, .56), P(.30, 1), P(1, .42), P(.54, .42)], WHITE);
  } else {
    const num = Number.isFinite(pct) ? String(Math.round(pct)) : '-';
    // 顶部设备类型小徽标(有类型且数字不超两位时才画, 避免拥挤)
    const showKind = (kind === 'mouse' || kind === 'keyboard') && num.length <= 2;
    const textCY = showKind ? 39 : 32;
    if (showKind) {
      if (kind === 'mouse') {
        // 胶囊轮廓 + 分界线 (x27-37, y12-26)
        for (let x = 27; x <= 37; x++) { set(x, 12, WHITE); set(x, 26, WHITE); }
        for (let y = 12; y <= 26; y++) { set(27, y, WHITE); set(37, y, WHITE); }
        for (let y = 13; y <= 19; y++) set(32, y, WHITE);
      } else {
        // 键盘轮廓 + 键点 + 空格 (x22-42, y14-24)
        for (let x = 22; x <= 42; x++) { set(x, 14, WHITE); set(x, 24, WHITE); }
        for (let y = 14; y <= 24; y++) { set(22, y, WHITE); set(42, y, WHITE); }
        for (const ry of [17, 20]) for (let x = 25; x <= 39; x += 4) set(x, ry, WHITE);
        rect(27, 22, 37, 22, WHITE);
      }
    }
    const cell = num.length >= 3 ? 4 : 5; // 100% 三位数缩小一号
    drawText(num, cell, 32, textCY, WHITE);
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
  const online = !!state.linked && !!state.ok;
  // vigil-watt 配色: 充电蓝 / ≤阈值红 / 其余绿; 离线灰由 drawRGBA 内部处理
  let color = '#34C759';
  if (online && !state.charging && state.battery <= low) color = '#E2445C';
  else if (online && state.charging) color = '#0A84FF';
  const num = online && Number.isFinite(state.battery) ? String(Math.round(state.battery)) : '-';
  const key = [num, color, state.charging ? 'c' : '', online ? 'on' : 'off', state.kind || '', low].join('|');
  if (!cache.has(key)) {
    const { S, px } = drawRGBA({ pct: state.battery, color, charging: state.charging, online, kind: state.kind });
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
    ['high', { pct: 91, color: '#34C759', charging: false, online: true, kind: 'mouse' }],
    ['mid', { pct: 45, color: '#34C759', charging: false, online: true, kind: 'keyboard' }],
    ['low', { pct: 15, color: '#E2445C', charging: false, online: true, kind: 'mouse' }],
    ['charging', { pct: 66, color: '#0A84FF', charging: true, online: true, kind: 'keyboard' }],
    ['offline', { pct: 0, color: '#8E8E93', charging: false, online: false, kind: 'mouse' }],
    ['full', { pct: 100, color: '#34C759', charging: false, online: true, kind: 'keyboard' }],
  ];
  for (const [name, s] of samples) {
    const { S, px } = drawRGBA(s);
    fs.writeFileSync(`tools/sample-${name}.png`, encodePNG(S, S, px));
    fs.writeFileSync(`tools/sample-${name}.ico`, encodeICO(S, S, px));
    console.log('生成 tools/sample-' + name + '.png / .ico');
  }
}
