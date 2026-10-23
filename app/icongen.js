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

// 贴片图标: chips = [{ battery, charging, online, kind }]
// mode='worst': 只画电量最低设备的大号数字(无底、无图形), 托盘 16~24px 下最清晰
function drawRGBA({ chips = [], low = 20, mode = 'pair', dark = false } = {}) {
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
  // 设备图形(深灰轮廓), sc 缩放 + 加粗线宽(32px 托盘尺寸下更醒目)
  const drawGlyph = (kind, cx, cy, sc = 1) => {
    const t = Math.max(1, Math.round(sc * 1.3)); // 线宽
    const box = (w, h) => {
      const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
      return { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1, cx, cy };
    };
    const frame = (b) => {
      rect(b.x0, b.y0, b.x1, b.y0 + t - 1, GLYPH);
      rect(b.x0, b.y1 - t + 1, b.x1, b.y1, GLYPH);
      rect(b.x0, b.y0, b.x0 + t - 1, b.y1, GLYPH);
      rect(b.x1 - t + 1, b.y0, b.x1, b.y1, GLYPH);
    };
    if (kind === 'mouse') {
      const b = box(Math.round(9 * sc), Math.round(15 * sc));
      frame(b);
      const my = Math.round(b.cy);
      for (let y = b.y0 + Math.round(2 * sc); y <= b.y0 + Math.round(5 * sc); y++) rect(my, y, my + t - 1, y, GLYPH);
    } else if (kind === 'keyboard') {
      const b = box(Math.round(17 * sc), Math.round(11 * sc));
      frame(b);
      const ky = b.y0 + Math.round(4 * sc);
      for (let x = b.x0 + t + 1; x <= b.x1 - t - 1; x += Math.max(2, Math.round(2.5 * sc))) {
        rect(x, ky, Math.min(x + t - 1, b.x1 - t), ky + t - 1, GLYPH);
      }
      rect(b.x0 + Math.round(3.5 * sc), b.y1 - t - Math.round(sc), b.x1 - Math.round(3.5 * sc), b.y1 - t, GLYPH);
    } else {
      const b = box(Math.round(16 * sc), Math.round(10 * sc));
      frame(b);
      rect(b.x1 + 1, b.y0 + Math.round(3 * sc), b.x1 + t, b.y1 - Math.round(3 * sc), GLYPH);
    }
  };
  const stateColor = (d) => !d.online ? (dark ? hex('#98989F') : T_OFFLINE)
    : d.charging ? (dark ? hex('#4DA3FF') : T_CHARGING)
      : (Number.isFinite(d.battery) && d.battery <= low) ? (dark ? hex('#FF453A') : T_LOW)
        : (dark ? hex('#34D058') : T_GOOD);

  const list = chips.slice(0, 2);
  const cy = 32;

  // ---- 纯数字模式(托盘图标): 无底色无图形, 数字占满图标 ----
  if (mode === 'worst') {
    const d = list[0] || { online: false };
    const num = d.online && Number.isFinite(d.battery) ? String(Math.round(d.battery)) : '-';
    let cell = 7;
    while (cell > 3 && textW(num, cell) > S - 4) cell--;
    const tw = textW(num, cell);
    drawText(num, cell, Math.round((S - tw) / 2), cy, stateColor(d));
    return { S, px };
  }

  // ---- 贴片底 ----
  rrect(1, 1, S - 2, S - 2, 14, PILL_BG);

  if (list.length === 0) {
    drawText('-', 4, 22, cy, T_OFFLINE);
  } else if (list.length === 1) {
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
function bmpBlob(width, height, rgba) {
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
  return Buffer.concat([bih, xor, and]);
}

// 多尺寸 ICO: entries = [{ size, rgba }] — Windows 按显示尺寸挑选最合适的一张
function encodeMultiICO(entries) {
  const count = entries.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const blobs = [];
  entries.forEach((e, i) => {
    const blob = bmpBlob(e.size, e.size, e.rgba);
    const base = 6 + i * 16;
    dir[base] = e.size % 256; dir[base + 1] = e.size % 256; // 0 表示 256
    dir.writeUInt16LE(1, base + 4);  // planes
    dir.writeUInt16LE(32, base + 6); // bitCount
    dir.writeUInt32LE(blob.length, base + 8); // bytesInRes
    dir.writeUInt32LE(offset, base + 12);     // 偏移
    offset += blob.length;
    blobs.push(blob);
  });
  return Buffer.concat([dir, ...blobs]);
}

function encodeICO(width, height, rgba) {
  return encodeMultiICO([{ size: width, rgba }]);
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
// devices: [{ battery, charging, linked, ok, kind }]
// 主图规则: 只画电量最低的那台在线设备(醒目提示最需要充电的); 无在线设备则显示首台(离线色)
const cache = new Map();
function iconFor(devices, low = 20, dark = false) {
  const list = (Array.isArray(devices) ? devices : [devices]).filter((d) => d && d.present !== false);
  const online = list
    .filter((d) => d.ok && d.linked && Number.isFinite(d.battery))
    .sort((a, b) => a.battery - b.battery);
  const pick = online[0] || list[0] || null;
  const chips = pick
    ? [{ battery: pick.battery, charging: !!pick.charging, online: !!pick.ok && !!pick.linked, kind: pick.kind || null }]
    : [];
  const key = JSON.stringify([chips, low, dark, 'worst']);
  if (!cache.has(key)) {
    const { S, px } = drawRGBA({ chips, low, mode: 'worst', dark });
    // 16px + 32px 双尺寸: 托盘实际按 16~24px 显示, 给 16px 单独采样才不糊
    const ico = encodeMultiICO([
      { size: 16, rgba: downsample(px, S, 4) },
      { size: 32, rgba: downsample(px, S, 2) },
    ]);
    cache.set(key, ico.toString('base64'));
    if (cache.size > 200) cache.delete(cache.keys().next().value); // 防无限增长
  }
  return cache.get(key);
}
const kindOrder = (k) => (k === 'keyboard' ? 0 : k === 'mouse' ? 1 : 2);

// 生成 64x64 ICO（桌面快捷方式 battery.ico 用）
function fullSizeICO(state) {
  const { S, px } = drawRGBA(state);
  return encodeICO(S, S, px);
}

module.exports = { iconFor, fullSizeICO, encodePNG, encodeICO, encodeMultiICO, drawRGBA, downsample };

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
