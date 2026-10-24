// battery.js — 多品牌外设电量查询核心库
// 已适配:
//   [mchose] 迈从(MCHOSE) A7 Pro 等 classic feature 协议
//     - FerrisPulse MchoseMouseHelper.cs + Rapou7/offline-mchose §5
//     - 本机 A7 Pro (VID_5253&PID_1021, Realtek) 2026-10-22 实采验证
//   [atk] ATK/Beken 引擎 (ATK X1 V2 / X1 Pro / F1 / A9 / VXE R1 全系)
//     - FerrisPulse UniversalGamingDeviceHelper.cs: QueryBekenWeBattery
//     - X1 V2 8K 接收器 VID_373B&PID_12E9 (设备表 2026-10-22 版)
//   [aula] 狼蛛(AULA) 2.4G 键盘 (F87 / F99 Pro, Compx 方案)
//     - vigil-watt AulaPlugin.cs + docs/hardware/aula.md (F99 Pro 真机验证)
//     - 本机 F87 接收器 VID_3554&PID_FA09 2026-10-23 实采验证 (100% 读数成功)
//
// 迈从协议要点:
//   帧格式 [0]=rid(0x11) [1]=cmd^0xFF 其余 0xFF, 21 字节; 响应有取反/原始两种形态
//   身份响应: [10]=flags(bit3在线) [11]=电量% [12]=充电(1充/2满)
// ATK/Beken 协议要点:
//   Report ID 0x08, 16 字节报文: [0]=cmd(0x04) 其余 0, 末字节校验 (0x55-Σ(rid+data))&0xFF
//   响应: [0..3]=0x04 头 [4]=len [5]=电量% [6]=充电 [7..8]=电压mV(大端)
//   接口选择: 枚举 VID 373B 全部非键盘集合, vendor usagePage 优先, 逐个尝试
'use strict';
const nh = require('node-hid');

const VIDS = [0x5253, 0x3837];
const REPORT_ID = 0x11;
const CMD_IDENTITY = 0x06;
const MODES = ['USB 有线', '2.4G 无线', '蓝牙'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCmdAt = { t: 0 };
async function pace() {
  const wait = 25 - (Date.now() - lastCmdAt.t);
  if (wait > 0) await sleep(wait);
  lastCmdAt.t = Date.now();
}

function findControlPath() {
  let pref = null, fb = null;
  for (const d of nh.devices()) {
    if (!VIDS.includes(d.vendorId)) continue;
    if (d.usagePage === 0xff01 && d.usage === 0x0001) pref = d;
    else if (d.usagePage === 0xff0b && !fb) fb = d;
  }
  return pref || fb;
}

// 从 21 字节响应里解析身份帧(自动识别取反/原始形态), 无效返回 null
function parseIdentity(resp) {
  if (!Buffer.isBuffer(resp) || resp.length < 21) return null;
  const candidates = [resp, Buffer.from(resp.map((b) => b ^ 0xff))];
  for (const c of candidates) {
    const echoOk = c[1] === (CMD_IDENTITY ^ 0xff) || c[1] === CMD_IDENTITY;
    const vid = c[2] | (c[3] << 8);
    if (!echoOk || !VIDS.includes(vid)) continue;
    const battery = c[11];
    const flags = c[10];
    const charge = c[12];
    if (battery > 100) continue;
    return {
      vid,
      pid: c[4] | (c[5] << 8),
      firmware: ((c[6] | (c[7] << 8) | (c[8] << 16) | (c[9] << 24)) >>> 0).toString(16),
      flags,
      mode: MODES[flags & 0x07] || '未知(' + (flags & 0x07) + ')',
      linked: (flags & 0x08) !== 0,
      battery,
      charge, // 0=放电 1=充电中 2=已充满(部分固件)
      raw: c.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
    };
  }
  return null;
}

async function queryBattery(maxAttempts = 8) {
  const iface = findControlPath();
  if (!iface) {
    return { ok: false, key: 'mchose', reason: 'NO_DEVICE', present: false, message: '未发现迈从接收器（VID 5253/3837）' };
  }

  let dev;
  try {
    dev = new nh.HID(iface.path);
  } catch (e) {
    return { ok: false, reason: 'OPEN_FAIL', message: '打开接口失败: ' + e.message };
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await pace();
      const req = Buffer.alloc(21, 0xff);
      req[0] = REPORT_ID;
      req[1] = CMD_IDENTITY ^ 0xff;
      try { dev.sendFeatureReport(req); } catch { await sleep(80); continue; }

      await sleep(90 + attempt * 25);

      // 连读两次: 响应可能在任意一次出现(实测两种形态都会出现)
      for (let k = 0; k < 2; k++) {
        let resp = null;
        try { resp = Buffer.from(dev.getFeatureReport(REPORT_ID, 21)); } catch { }
        if (resp) {
          const id = parseIdentity(resp);
          if (id) {
            return {
              ok: true,
              key: 'mchose',
              brand: 'MCHOSE',
              device: 'MCHOSE A7 Pro',
              kind: 'mouse',
              present: true,
              ...id,
              charging: id.charge === 1,
              full: id.charge === 2,
              lastUpdated: new Date(),
            };
          }
        }
        await sleep(60);
      }
      await sleep(70);
    }
    return {
      ok: false, key: 'mchose', reason: 'NO_RESPONSE',
      message: '接收器在线但无应答（鼠标可能深度休眠/离线）',
      donglePresent: true,
    };
  } finally {
    try { dev.close(); } catch { /* ignore */ }
  }
}


// ---------- 狼蛛 AULA 2.4G 键盘 (Compx 接收器) ----------
// 协议: report 0x13, 20 字节, 校验 = 前 19 字节之和 mod 256
// 只发开会话帧 [13 05 01], 等推送 [13 0A ...]: [5]=类型(0x05电量) [6]=电量% [7]=标志(bit4=充电中)
// vigil-watt 实测: 不发无应答的 [13 4A] 查询帧, 故同样不发
const AULA_VID = 0x3554, AULA_PID = 0xFA09;
const AULA_FRAME_LEN = 20;

function aulaChecksum(frame) {
  let s = 0;
  for (let i = 0; i < AULA_FRAME_LEN - 1; i++) s = (s + frame[i]) & 0xff;
  return s;
}

function findAulaInterface() {
  for (const d of nh.devices()) {
    if (d.vendorId === AULA_VID && d.productId === AULA_PID
      && d.usagePage === 0xff02 && d.usage === 0x0002) return d;
  }
  return null;
}

// 解析 0A 推送帧 (输入缓冲可能带 reportId 前缀, 偏移 0/1 都试)
function parseAulaPush(rx) {
  for (const off of [0, 1]) {
    if (!Buffer.isBuffer(rx) || rx.length < off + 8) continue;
    if (rx[off] !== 0x13 || rx[off + 1] !== 0x0a) continue;
    const type = rx[off + 5];
    if (type !== 0x05) return null; // 0x02=状态通知(休眠)等, 忽略
    const pct = rx[off + 6], flag = rx[off + 7];
    if (pct <= 1 || pct > 100) return null; // ≤1 视为无效(休眠帧 payload)
    return {
      battery: pct,
      charging: (flag & 0x10) !== 0,
      flag,
      raw: rx.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
    };
  }
  return null;
}

async function queryAula() {
  const iface = findAulaInterface();
  if (!iface) {
    return { ok: false, key: 'aula', reason: 'NO_DEVICE', present: false, message: '未发现狼蛛 2.4G 接收器（VID 3554）' };
  }

  const session = Buffer.alloc(AULA_FRAME_LEN);
  session[0] = 0x13; session[1] = 0x05; session[2] = 0x01;
  session[AULA_FRAME_LEN - 1] = aulaChecksum(session);

  let dev;
  try { dev = new nh.HID(iface.path); } catch (e) {
    return { ok: false, key: 'aula', reason: 'OPEN_FAIL', present: true, message: '打开狼蛛接口失败: ' + e.message };
  }

  try {
    await pace();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { dev.write(session); } catch { await sleep(120); continue; }
      // 开会话后 4 秒窗口内等 0A 电量推送 (两轮共约 5.2s)
      const deadline = Date.now() + (attempt === 0 ? 3000 : 2200);
      while (Date.now() < deadline) {
        let rx = null;
        try { rx = Buffer.from(dev.readTimeout(300)); } catch { continue; }
        if (!rx || !rx.length) continue;
        const parsed = parseAulaPush(rx);
        if (parsed) {
          return {
            ok: true,
            key: 'aula',
            brand: 'AULA',
            device: 'AULA F87',
            kind: 'keyboard',
            vid: AULA_VID,
            pid: AULA_PID,
            mode: '2.4G 无线',
            linked: true, // 能回电量推送 = 键盘在线
            present: true,
            ...parsed,
            full: !parsed.charging && parsed.battery >= 100,
            lastUpdated: new Date(),
          };
        }
      }
    }
    return {
      ok: false, key: 'aula', reason: 'NO_RESPONSE', present: true,
      message: '狼蛛接收器在线但无应答（键盘可能休眠/关机/未对码）',
    };
  } finally {
    try { dev.close(); } catch { /* ignore */ }
  }
}

// ---------- ATK / VXE / VGN 引擎 ----------
// 协议来源(公开实测协议表, 2.4G-battery-viewer / FerrisPulse):
//   A) Nordic 54L15 — usagePage 0xFF05, Output Report, ReportID 0x08, 64 字节
//      请求: 08 7D 72 02 00 01 07 01 (其余补 0)
//      应答: [08] 72 02 00 01 07 xx 电量 → 校验 +1==0x72 && +5==0x07, 电量在 0x72 之后第 6 字节
//   B) Nordic 52840 — usagePage 0xFF02, Output Report, ReportID 0x08, 17 字节
//      请求: 08 04 00×14 49 (末字节 = (0x55 - Σ) & 0xFF)
//      应答: [08] 04 … 电量在第 6 字节, 第 7 字节非 0 = 有线/充电
// ★ 关键: ATK 接收器没有 Feature Report, 只能 write() 发 Output Report + 读 Input Report。
//   早期实现用 sendFeatureReport(18 字节) → 设备不认, 表现为「接收器在线但无应答」。
const ATK_VID = 0x373B;         // ATK
const ATK_VXE_VID = 0x3554;     // VXE / VGN 同方案(需排除狼蛛 F87 的 PID FA09)
const ATK_NAMES = {
  0x12e9: 'ATK X1 V2', 0x11d9: 'ATK X1 V2',   // 0x11d9 = X1 V2 8K 接收器 "Wireless mouse 8k dongle-L"
  0x105c: 'ATK X1 V2 (有线)',                  // MAD68 = X1 V2 本体有线模式
  0x1088: 'ATK X1 Pro', 0x1089: 'ATK X1 Pro Max',
  0x1086: 'ATK F1 Pro Max', 0x1087: 'ATK F1 Ultimate 8K', 0x1279: 'ATK A9 AIR 8K',
  0x10c9: 'ATK Nearlink (A9/烈空)', 0x1085: 'VXE R1 SE/SE+', 0x1216: 'ATK/VXE 2.4G NANO 接收器',
};
const ATK_SKIP_PIDS = new Set([0xFA09]); // 狼蛛 F87 接收器, 归 AULA 引擎

function bekenChecksum(rid, data) {
  let sum = rid;
  for (const b of data) sum += b & 0xff;
  return (0x55 - (sum & 0xff)) & 0xff;
}

const hexOf = (b) => b.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();

// 两种已知协议变体: build() 出帧, parse() 校验并取电量
const ATK_VARIANTS = [
  {
    id: 'nordic54',
    label: 'Nordic 54L15 64B',
    usagePage: 0xff05,
    build() {
      const buf = Buffer.alloc(64);
      buf[0] = 0x08;
      Buffer.from([0x7d, 0x72, 0x02, 0x00, 0x01, 0x07, 0x01]).copy(buf, 1);
      return buf;
    },
    parse(f) {
      if (!Buffer.isBuffer(f)) return null;
      const off = f[0] === 0x08 ? 1 : 0;      // Windows 读回的 Input Report 首字节是 reportId
      if (f.length < off + 8) return null;
      if (f[off] !== 0x72 || f[off + 4] !== 0x07) return null;
      const battery = f[off + 6];
      if (!(battery > 0 && battery <= 100)) return null;
      return { battery, charging: false, millivolts: 0 };
    },
  },
  {
    id: 'nordic52',
    label: 'Nordic 52840 17B',
    usagePage: 0xff02,
    build() {
      const data = Buffer.alloc(15);           // 15 个数据字节: [0]=cmd 其余 0
      data[0] = 0x04;
      const buf = Buffer.alloc(17);
      buf[0] = 0x08;                           // ReportID
      data.copy(buf, 1);
      buf[16] = bekenChecksum(0x08, data);     // 校验落在最后一字节
      return buf;
    },
    parse(f) {
      if (!Buffer.isBuffer(f)) return null;
      const off = f[0] === 0x08 ? 1 : 0;
      if (f.length < off + 7) return null;
      const battery = f[off + 5];
      if (!(battery > 0 && battery <= 100)) return null;
      // 有回显 0x04 更可信; 无回显时只要电量合理也接受
      return { battery, charging: f[off + 6] !== 0, millivolts: 0 };
    },
  },
];

function isAtkVid(vid) {
  return vid === ATK_VID || vid === ATK_VXE_VID;
}

// 枚举候选接口: 排除标准键盘集合与狼蛛接收器, vendor usagePage 优先
function findAtkInterfaces() {
  const all = nh.devices().filter((d) =>
    isAtkVid(d.vendorId) &&
    !ATK_SKIP_PIDS.has(d.productId) &&
    !/\kbd$/i.test(d.path || '') &&
    !(d.usagePage === 0x01 && d.usage === 0x06)
  );
  return [...all.filter((d) => (d.usagePage || 0) >= 0xff00), ...all.filter((d) => (d.usagePage || 0) < 0xff00)];
}

// 排空陈旧输入报文, 避免拿到上一次的残留帧
function drainDev(dev) {
  for (let i = 0; i < 10; i++) {
    let d;
    try { d = dev.readTimeout(4); } catch { break; }
    if (!d || !d.length) break;
  }
}

// 在单个接口上按某变体发帧收帧; trace 供诊断页展示
async function atkTryIface(iface, variant, trace) {
  const t = trace || { variant: variant.label, path: iface.path, usagePage: iface.usagePage, usage: iface.usage, frames: [] };
  let dev;
  try {
    dev = new nh.HID(iface.path);
  } catch (e) {
    t.openError = e.message;
    return { parsed: null, trace: t };
  }
  const full = variant.build();
  // 写长度阶梯: 若描述符里的 Output Report 比我们的帧短, WriteFile 会报 0x57(参数非法),
  // 此时按更短的报文长度重试(报 ID + 前 N-1 字节), 仍能命中一部分接收器。
  const lens = [...new Set([full.length, 33, 32, 25, 20, 17, 16, 9, 8].filter((n) => n <= full.length))].sort((a, b) => b - a);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      drainDev(dev);
      await pace();
      try {
        if (!t.writeLen) {
          let err = null;
          for (const n of lens) {
            try { t.wrote = dev.write(full.subarray(0, n)); t.writeLen = n; break; }
            catch (e) { err = e.message; }
          }
          if (!t.writeLen) throw new Error(err || 'write failed');
        } else {
          dev.write(full.subarray(0, t.writeLen));
        }
      } catch (e) {
        t.writeError = e.message;
        await sleep(70);
        continue; // 可能被其它进程占用, 重试
      }
      const deadline = Date.now() + (attempt === 0 ? 650 : 420);
      while (Date.now() < deadline) {
        let rx;
        try { rx = Buffer.from(dev.readTimeout(110)); } catch (e) { t.readError = e.message; break; }
        if (!rx.length) continue;
        const hx = hexOf(rx);
        if (t.frames.length < 12 && !t.frames.includes(hx)) t.frames.push(hx);
        const parsed = variant.parse(rx);
        if (parsed) {
          t.hit = hx;
          t.attempt = attempt + 1;
          return { parsed, trace: t };
        }
      }
      await sleep(50);
    }
  } finally {
    try { dev.close(); } catch { /* ignore */ }
  }
  return { parsed: null, trace: t };
}

// 记住上次成功的组合, 后续只探测它(否则每轮都要全量试 2 变体 × 多接口)
const atkMemo = { variant: null, path: null, fails: 0, nextTry: 0, lastFail: null };

async function queryAtk() {
  const ifaces = findAtkInterfaces();
  if (!ifaces.length) {
    return { ok: false, key: 'atk', reason: 'NO_DEVICE', present: false, message: '未发现 ATK 接收器（VID 373B）' };
  }

  // 失败冷却: 鼠标休眠时别每轮都全量扫(白烧 CPU), 30s 内直接复用上次结论
  if (!atkMemo.path && atkMemo.lastFail && Date.now() < atkMemo.nextTry) {
    return { ...atkMemo.lastFail, lastUpdated: new Date(atkMemo.nextTry - 30000) };
  }

  // 快速路径: 已知可用的接口 + 变体
  if (atkMemo.path && atkMemo.variant) {
    const iface = ifaces.find((d) => d.path === atkMemo.path);
    const variant = ATK_VARIANTS.find((v) => v.id === atkMemo.variant);
    if (iface && variant) {
      const { parsed } = await atkTryIface(iface, variant);
      if (parsed) return atkResult(iface, parsed);
      if (++atkMemo.fails >= 3) { atkMemo.path = null; atkMemo.variant = null; atkMemo.fails = 0; }
    } else {
      atkMemo.path = null; atkMemo.variant = null;
    }
  }

  // 全量扫描: 变体按 usagePage 命中优先, 每个变体最多试 3 个接口, 总预算 9s
  const budget = Date.now() + 9000;
  const order = [...ATK_VARIANTS].sort((a, b) =>
    (ifaces.some((d) => d.usagePage === a.usagePage) ? 0 : 1) - (ifaces.some((d) => d.usagePage === b.usagePage) ? 0 : 1));
  for (const variant of order) {
    const list = [
      ...ifaces.filter((d) => d.usagePage === variant.usagePage),
      ...ifaces.filter((d) => d.usagePage !== variant.usagePage),
    ].slice(0, 3);
    for (const iface of list) {
      if (Date.now() > budget) break;
      const { parsed } = await atkTryIface(iface, variant);
      if (parsed) {
        atkMemo.path = iface.path; atkMemo.variant = variant.id; atkMemo.fails = 0;
        atkMemo.lastFail = null; atkMemo.nextTry = 0;
        return atkResult(iface, parsed);
      }
    }
    if (Date.now() > budget) break;
  }

  const fail = {
    ok: false, key: 'atk', reason: 'NO_RESPONSE', present: true,
    message: 'ATK 接收器在线但无应答（鼠标可能休眠/离线；动一下鼠标再试）',
  };
  atkMemo.lastFail = fail;
  atkMemo.nextTry = Date.now() + 30000;
  return fail;
}

function atkResult(iface, parsed) {
  const pidHex = (iface.productId || 0).toString(16).padStart(4, '0').toUpperCase();
  return {
    ok: true,
    key: 'atk',
    brand: 'ATK',
    device: ATK_NAMES[iface.productId] || ('ATK PID_' + pidHex),
    kind: 'mouse',
    vid: iface.vendorId,
    pid: iface.productId,
    mode: '2.4G 无线',
    linked: true,                       // 能应答电量查询 = 鼠标在线
    present: true,
    battery: parsed.battery,
    charging: !!parsed.charging,
    millivolts: parsed.millivolts || 0,
    full: !parsed.charging && parsed.battery >= 100,
    raw: null,
    lastUpdated: new Date(),
  };
}

// 诊断: 遍历所有候选接口 × 协议变体, 记录写结果与收到的每一帧(供「ATK 诊断」按钮)
async function probeAtk() {
  const all = nh.devices().filter((d) => isAtkVid(d.vendorId));
  const ifaces = findAtkInterfaces();
  const out = {
    vids: ['0x373B', '0x3554'],
    devices: all.map((d) => ({
      vid: '0x' + (d.vendorId || 0).toString(16).toUpperCase(),
      pid: '0x' + (d.productId || 0).toString(16).toUpperCase(),
      usagePage: '0x' + (d.usagePage || 0).toString(16).toUpperCase(),
      usage: '0x' + (d.usage || 0).toString(16).toUpperCase(),
      product: d.product || '', manufacturer: d.manufacturer || '',
      skipped: ATK_SKIP_PIDS.has(d.productId),
    })),
    attempts: [],
    result: null,
  };
  if (!ifaces.length) {
    out.verdict = all.length
      ? '找到 VID 命中但全部被过滤(键盘集合/狼蛛 PID)'
      : '未发现 VID 373B / 3554 的任何 HID 接口 —— 接收器未插或未被系统识别';
    return out;
  }
  const budget = Date.now() + 20000;   // 诊断最多 20s, 避免页面卡太久
  for (const variant of ATK_VARIANTS) {
    const list = [
      ...ifaces.filter((d) => d.usagePage === variant.usagePage),
      ...ifaces.filter((d) => d.usagePage !== variant.usagePage),
    ].slice(0, 4);
    for (const iface of list) {
      if (Date.now() > budget) { out.truncated = true; break; }
      const { parsed, trace } = await atkTryIface(iface, variant);
      out.attempts.push(trace);
      if (parsed) {
        out.result = { battery: parsed.battery, charging: !!parsed.charging, variant: variant.label };
        out.verdict = '协议命中: ' + variant.label + ', 电量 ' + parsed.battery + '%';
        return out;
      }
    }
  }
  const gotFrames = out.attempts.some((a) => a.frames && a.frames.length);
  out.verdict = gotFrames
    ? '有回帧但两种协议都未匹配 → 把原始帧发给我, 按帧结构新增变体'
    : (out.attempts.some((a) => a.writeError)
      ? '所有长度都写不进去(报 ID 0x08 在该接口不被接受 / 接口无写权限) → 说明接口选错, 把这段发我'
      : '写成功但零回帧 → 鼠标大概率在休眠, 动一下鼠标再诊断');
  return out;
}

// 聚合: 返回所有"接收器在场"的设备查询结果（不在场的直接过滤, 由上层决定如何显示）
async function queryAll() {
  const [mchose, atk, aula] = await Promise.all([
    queryBattery().catch((e) => ({ ok: false, key: 'mchose', reason: 'ERROR', message: e.message })),
    queryAtk().catch((e) => ({ ok: false, key: 'atk', reason: 'ERROR', message: e.message })),
    queryAula().catch((e) => ({ ok: false, key: 'aula', reason: 'ERROR', message: e.message })),
  ]);
  return [mchose, atk, aula].filter((r) => r.present !== false);
}

// CLI: node battery.js — 查询全部在场设备
if (require.main === module) {
  const t0 = Date.now();
  queryAll()
    .then((results) => {
      if (!results.length) {
        console.log('未发现任何已支持的接收器（迈从 VID 5253/3837, ATK VID 373B, 狼蛛 VID 3554）');
        process.exit(2);
      }
      for (const r of results) {
        if (!r.ok) {
          console.log(`❌ [${r.key}] ${r.message}`);
          continue;
        }
        const v = r.millivolts ? ` ${r.millivolts}mV` : '';
        console.log(`✅ [${r.key}] ${r.device} (${Date.now() - t0}ms)`);
        console.log(`   电量: ${r.battery}%${r.charging ? ' ⚡充电中' : r.full ? ' 🔋已充满' : ''}${v}`);
        console.log(`   连接: ${r.mode}${r.linked ? '' : '（休眠/离开）'}  原始帧: ${r.raw}`);
      }
    })
    .catch((e) => { console.error('异常:', e); process.exit(1); });
}

// 导出(放在文件末尾: ATK_VARIANTS 等是 const, 提前导出会踩 TDZ)
module.exports = { queryBattery, queryAtk, queryAula, queryAll, findControlPath, findAtkInterfaces, bekenChecksum, probeAtk, ATK_VARIANTS, MODES };
