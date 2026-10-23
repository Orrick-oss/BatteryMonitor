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
// 样式: 横向圆角贴片(浅灰底) + 深色设备图形 + 彩色粗体百分比, 多设备竖线分隔,
// 参考 vigil-watt TaskbarPillRenderer 的任务栏贴片视觉。
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const PILL_BG = hex('#E9E9E7');     // 贴片底(浅灰, 深浅色任务栏上都有对比)
const GLYPH = hex('#5F5E5A');       // 设备图形深灰(vigil-watt light IconStroke)
const DIVIDER = hex('#B9B9B6');     // 分隔线
// 文字状态色(在浅底上取略深一档保证对比)
const T_GOOD = hex('#16A34A');
const T_LOW = hex('#DC2626');
const T_CHARGING = hex('#0A84FF');
const T_OFFLINE = hex('#8E8E93');

// 3x5 像素字体
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
  '%': ['110', '001', '010', '100', '011'],
  '-': ['000', '000', '111', '000', '000'],
};

// 贴片图标: chips = [{ battery, charging, online, kind }] (最多取 2 个)
function drawRGBA({ chips = [], low = 20 } = {}) {
  const S = 64;
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
  // 圆角矩形(角部像素柔化)
  const rrect = (x0, y0, x1, y1, r, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      const d = Math.hypot(dx, dy);
      if (d <= r - 1) set(x, y, c);
      else if (d <= r) set(x, y, [c[0], c[1], c[2], Math.round(c[3] * (r - d))]);
    }
  };
  // 文本绘制: 水平起点 x0, 垂直居中 cy
  const drawText = (text, cell, x0, cy, c) => {
    const dh = 5 * cell, y0 = Math.round(cy - dh / 2);
    for (const ch of text) {
      const g = DIGITS[ch];
      if (!g) { x0 += 4 * cell; continue; }
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] === '1') rect(x0 + gx * cell, y0 + gy * cell, x0 + gx * cell + cell - 1, y0 + gy * cell + cell - 1, c);
      }
      x0 += 4 * cell;
    }
  };
  const textW = (text, cell) => text.length * 4 * cell - cell;
  // 设备图形(深灰轮廓)
  const drawGlyph = (kind, cx, cy) => {
    if (kind === 'mouse') {
      // 胶囊轮廓 + 分界线
      const w = 9, h = 15, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2), x1 = x0 + w - 1, y1 = y0 + h - 1;
      for (let x = x0 + 1; x <= x1 - 1; x++) { set(x, y0, GLYPH); set(x, y1, GLYPH); }
      for (let y = y0 + 1; y <= y1 - 1; y++) { set(x0, y, GLYPH); set(x1, y, GLYPH); }
      set(x0, y0 + 1, GLYPH); set(x1, y0 + 1, GLYPH); set(x0, y1 - 1, GLYPH); set(x1, y1 - 1, GLYPH);
      for (let y = y0 + 2; y <= y0 + 5; y++) set(Math.round(cx), y, GLYPH);
    } else if (kind === 'keyboard') {
      // 外框 + 键点行 + 空格条
      const w = 17, h = 11, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2), x1 = x0 + w - 1, y1 = y0 + h - 1;
      for (let x = x0; x <= x1; x++) { set(x, y0, GLYPH); set(x, y1, GLYPH); }
      for (let y = y0; y <= y1; y++) { set(x0, y, GLYPH); set(x1, y, GLYPH); }
      for (let x = x0 + 2; x <= x1 - 2; x += 3) set(x, y0 + 3, GLYPH);
      rect(x0 + 3, y1 - 3, x1 - 3, y1 - 3, GLYPH);
    } else {
      // 其他类型: 电池轮廓 + 凸头
      const w = 16, h = 10, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2), x1 = x0 + w - 1, y1 = y0 + h - 1;
      for (let x = x0; x <= x1; x++) { set(x, y0, GLYPH); set(x, y1, GLYPH); }
      for (let y = y0; y <= y1; y++) { set(x0, y, GLYPH); set(x1, y, GLYPH); }
      rect(x1 + 1, y0 + 3, x1 + 2, y1 - 3, GLYPH);
    }
  };
  const stateColor = (d) => !d.online ? T_OFFLINE
    : d.charging ? T_CHARGING
      : (Number.isFinite(d.battery) && d.battery <= low) ? T_LOW : T_GOOD;

  // ---- 贴片底 ----
  rrect(1, 1, S - 2, S - 2, 14, PILL_BG);
  const list = chips.slice(0, 2);
  const cy = 32;

  if (list.length === 0) {
    drawText('-', 4, 22, cy, T_OFFLINE);
  } else   if (list.length === 1) {
    // 单设备: [图形] NN%
    const d = list[0];
    const num = d.online && Number.isFinite(d.battery) ? String(Math.round(d.battery)) + '%' : '-';
    const gw = 17, gap = 5;
    // 字号自适应: 优先 cell=4, 放不下降为 3/2, 保证图形+文本都在贴片内
    let cell = 4;
    while (cell > 1 && gw + gap + textW(num, cell) > S - 6) cell--;
    const tw = textW(num, cell);
    const total = gw + gap + tw;
    drawGlyph(d.kind, 1 + gw / 2, cy);
    drawText(num, cell, 1 + total + 2 - tw, cy, stateColor(d));
  } else {
    // 双设备: NN │ NN (无 % 号保证可读)
    const nums = list.map((d) => d.online && Number.isFinite(d.battery) ? String(Math.round(d.battery)) : '-');
    const cell = 3, cw = textW('00', cell);
    const gap = 7, total = cw * 2 + gap;
    let x0 = Math.round((S - total) / 2);
    drawText(nums[0], cell, x0, cy, stateColor(list[0]));
    rect(Math.round(S / 2) - 1, cy - 8, Math.round(S / 2) - 1, cy + 8, DIVIDER);
    drawText(nums[1], cell, x0 + cw + gap, cy, stateColor(list[1]));
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
// devices: [{ battery, charging, linked, ok, kind }] — 贴片最多显示 2 个设备
const cache = new Map();
function iconFor(devices, low = 20) {
  const list = Array.isArray(devices) ? devices : [devices];
  const chips = list
    .filter((d) => d && d.present !== false)
    .map((d) => ({
      battery: d.battery, charging: !!d.charging,
      online: !!d.ok && !!d.linked, kind: d.kind || null,
    }))
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
    .slice(0, 2);
  const key = JSON.stringify([chips, low]);
  if (!cache.has(key)) {
    const { S, px } = drawRGBA({ chips, low });
    // 托盘用 32x32（64 降采样更锐利），ICO 格式
    cache.set(key, encodeICO(S / 2, S / 2, downsample(px, S, 2)).toString('base64'));
  }
  return cache.get(key);
}
const kindOrder = (k) => (k === 'keyboard' ? 0 : k === 'mouse' ? 1 : 2);

// 生成 64x64 ICO（桌面快捷方式 battery.ico 用）
function fullSizeICO(state) {
  const { S, px } = drawRGBA(state);
  return encodeICO(S, S, px);
}

module.exports = { iconFor, fullSizeICO, encodePNG, encodeICO, drawRGBA, downsample };

// CLI 预览: node icongen.js → 生成 sample-*.png / sample-*.ico
if (require.main === module) {
  const fs = require('fs');
  const D = (battery, charging, kind, online = true) => ({ battery, charging, online, kind });
  const samples = [
    ['two', { chips: [D(74, false, 'keyboard'), D(90, false, 'mouse')], low: 20 }],
    ['low', { chips: [D(15, false, 'mouse'), D(90, false, 'keyboard')], low: 20 }],
    ['charging', { chips: [D(66, true, 'mouse'), D(90, false, 'keyboard')], low: 20 }],
    ['single', { chips: [D(91, false, 'mouse')], low: 20 }],
    ['offline', { chips: [D(null, false, 'mouse', false), D(90, false, 'keyboard')], low: 20 }],
    ['full', { chips: [D(100, false, 'keyboard'), D(90, false, 'mouse')], low: 20 }],
  ];
  for (const [name, s] of samples) {
    const { S, px } = drawRGBA(s);
    fs.writeFileSync(`tools/sample-${name}.png`, encodePNG(S, S, px));
    fs.writeFileSync(`tools/sample-${name}.ico`, encodeICO(S, S, px));
    console.log('生成 tools/sample-' + name + '.png / .ico');
  }
}
