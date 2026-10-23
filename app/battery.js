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

module.exports = { queryBattery, queryAtk, queryAula, queryAll, findControlPath, findAtkInterfaces, parseBekenBattery, bekenChecksum, MODES };

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

// ---------- ATK / Beken 引擎 ----------
const ATK_VID = 0x373B;
const ATK_NAMES = {
  0x12e9: 'ATK X1 V2', 0x1088: 'ATK X1 Pro', 0x1089: 'ATK X1 Pro Max',
  0x1086: 'ATK F1 Pro Max', 0x1087: 'ATK F1 Ultimate 8K', 0x1279: 'ATK A9 AIR 8K',
  0x10c9: 'ATK Nearlink (A9/烈空)', 0x1085: 'VXE R1 SE/SE+',
};

function bekenChecksum(rid, data15) {
  let sum = rid;
  for (const b of data15) sum += b & 0xff;
  return (0x55 - (sum & 0xff)) & 0xff;
}

// 解析 17 字节 Beken 响应（FerrisPulse QueryBekenWeBattery 同款偏移）
function parseBekenBattery(rx) {
  if (!Buffer.isBuffer(rx) || rx.length < 9) return null;
  const off = rx[0] === 0x08 ? 1 : 0;
  if (rx[off] !== 0x04) return null;
  const len = rx[off + 4];
  if (len < 1) return null;
  const battery = Math.min(rx[off + 5], 100);
  if (!(battery > 0 && battery <= 100)) return null;
  return {
    battery,
    charging: len >= 2 ? rx[off + 6] !== 0 : false,
    millivolts: len >= 4 ? (rx[off + 7] << 8) | rx[off + 8] : 0,
    raw: rx.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
  };
}

// 枚举 ATK(VID 373B) 的候选接口: 排除标准键盘集合, vendor usagePage 优先
function findAtkInterfaces() {
  const all = nh.devices().filter((d) =>
    d.vendorId === ATK_VID &&
    !/\\kbd$/i.test(d.path || '') &&
    !(d.usagePage === 0x01 && d.usage === 0x06) // 标准键盘集合
  );
  return [...all.filter((d) => d.usagePage >= 0xff00), ...all.filter((d) => d.usagePage < 0xff00)];
}

async function queryAtkInterface(iface, attempts = 3) {
  let dev;
  try { dev = new nh.HID(iface.path); } catch { return null; }
  try {
    for (let i = 0; i < attempts; i++) {
      await pace();
      const body = Buffer.alloc(16);
      body[0] = 0x04; // CMD: BATTERY_COMMAND
      const tx = Buffer.concat([Buffer.from([0x08]), body, Buffer.from([bekenChecksum(0x08, body)])]);
      try { dev.sendFeatureReport(tx); } catch { await sleep(80); continue; }
      await sleep(40 + i * 30);
      let rx = null;
      try { rx = Buffer.from(dev.getFeatureReport(0x08, 17)); } catch { }
      const parsed = rx && parseBekenBattery(rx);
      if (parsed) return parsed;
      await sleep(60);
    }
  } finally {
    try { dev.close(); } catch { /* ignore */ }
  }
  return null;
}

async function queryAtk(maxIfaces = 6) {
  const ifaces = findAtkInterfaces();
  if (!ifaces.length) {
    return { ok: false, key: 'atk', reason: 'NO_DEVICE', present: false, message: '未发现 ATK 接收器（VID 373B）' };
  }
  for (const iface of ifaces.slice(0, maxIfaces)) {
    const r = await queryAtkInterface(iface);
    if (r) {
      const pidHex = iface.productId.toString(16).padStart(4, '0').toUpperCase();
      return {
        ok: true,
        key: 'atk',
        brand: 'ATK',
        device: ATK_NAMES[iface.productId] || `ATK (PID_${pidHex})`,
        kind: 'mouse',
        vid: ATK_VID,
        pid: iface.productId,
        mode: '2.4G 无线',
        linked: true, // 能应答电量查询 = 鼠标在线
        present: true,
        ...r,
        full: !r.charging && r.battery >= 100,
        lastUpdated: new Date(),
      };
    }
  }
  return { ok: false, key: 'atk', reason: 'NO_RESPONSE', present: true, message: 'ATK 接收器在线但无应答（鼠标可能休眠/离线）' };
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
