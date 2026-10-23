// 狼蛛 AULA F87 / F99 Pro 2.4G 电量真机探测工具
// 协议来源: vigil-watt AulaPlugin.cs + docs/hardware/aula.md (F99 Pro 真机验证)
// 判据: VID 0x3554 (Compx) PID 0xFA09, 厂商接口 usagePage 0xFF02 / usage 0x0002
// 流程: 写开会话帧 [13 05 01] -> 4 秒内读推送 [13 0A ...] (type=0x05 电量)
'use strict';
const hid = require('node-hid');

const VID = 0x3554, PID = 0xFA09;
const REPORT_ID = 0x13, SESSION_CMD = 0x05, PUSH_CMD = 0x0A;
const PUSH_TYPE_BATTERY = 0x05, PUSH_TYPE_STATE = 0x02;
const FRAME_LEN = 20;

function checksum(frame) {
  let s = 0;
  for (let i = 0; i < FRAME_LEN - 1; i++) s = (s + frame[i]) & 0xFF;
  return s;
}

function buildFrame(cmd, param) {
  const p = Buffer.alloc(FRAME_LEN);
  p[0] = REPORT_ID; p[1] = cmd; p[2] = param;
  p[FRAME_LEN - 1] = checksum(p);
  return p;
}

// 解析 0A 推送, Windows 输入缓冲可能带 reportId 前缀, offset 0/1 都试
function parsePush(input) {
  for (const off of [0, 1]) {
    if (input.length < off + 8) continue;
    if (input[off] !== REPORT_ID || input[off + 1] !== PUSH_CMD) continue;
    const type = input[off + 5];
    const payload = input[off + 6];
    if (type === PUSH_TYPE_STATE) return { kind: 'state', payload };
    if (type !== PUSH_TYPE_BATTERY) return { kind: 'other', type, payload };
    const pct = input[off + 6], flag = input[off + 7];
    if (pct <= 1 || pct > 100) return { kind: 'invalid', pct, flag };
    return { kind: 'battery', pct, flag, charging: (flag & 0x10) !== 0 };
  }
  return null;
}

// 解析 4A 查询响应 (备用)
function parse4A(input) {
  if (input.length < FRAME_LEN) return null;
  if (input[0] !== REPORT_ID || input[1] !== 0x4A) return null;
  const pct = input[5], flag = input[6];
  if (pct <= 1 || pct > 100) return { kind: 'invalid', pct };
  return { kind: 'battery', pct, flag, charging: (flag & 0x10) !== 0 };
}

function hex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(' '); }

function main() {
  const all = hid.devices();
  const cands = all.filter(d => d.vendorId === VID && d.productId === PID
    && d.usagePage === 0xFF02 && d.usage === 0x0002);
  console.log(`== HID 总线上 3554:FA09 全部接口 ==`);
  for (const d of all.filter(d => d.vendorId === VID && d.productId === PID)) {
    console.log(`  pg=0x${(d.usagePage || 0).toString(16)} us=0x${(d.usage || 0).toString(16)} if=${d.interface} path=${(d.path || '').slice(-40)}`);
  }
  if (!cands.length) {
    console.log('\n[!] 未找到 0xFF02/0x0002 厂商接口。键盘可能未插接收器 / 关机 / 走蓝牙连接。');
    process.exit(1);
  }
  console.log(`\n[+] 找到 ${cands.length} 个候选厂商接口, 逐一尝试...\n`);

  const frame = buildFrame(SESSION_CMD, 0x01);
  for (const info of cands) {
    console.log(`--- 尝试 if=${info.interface} path=...${(info.path || '').slice(-30)}`);
    let dev;
    try { dev = new hid.HID(info.path); } catch (e) { console.log('  打开失败:', e.message); continue; }
    try {
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const n = dev.write(frame);
          console.log(`  [${attempt}] 写会话帧 ${n} 字节: ${hex(frame)}`);
        } catch (e) { console.log(`  [${attempt}] 写失败:`, e.message); }
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          let buf;
          try { buf = dev.readTimeout(300); } catch (e) { continue; }
          if (!buf || !buf.length) continue;
          console.log(`  收帧: ${hex(buf)}`);
          const push = parsePush(buf);
          const resp4a = parse4A(buf);
          if (push && push.kind === 'battery') {
            console.log(`  >>> 0A 电量推送: ${push.pct}% 充电=${push.charging} (flag=0x${push.flag.toString(16)})`);
            ok = true; break;
          }
          if (resp4a && resp4a.kind === 'battery') {
            console.log(`  >>> 4A 查询响应: ${resp4a.pct}% 充电=${resp4a.charging}`);
            ok = true; break;
          }
          if (push) console.log(`  (0A 推送 kind=${push.kind})`);
        }
      }
      if (ok) console.log('  [OK] 该接口可用\n');
      else console.log('  [X] 该接口 4 秒内无有效推送\n');
    } finally {
      try { dev.close(); } catch (_) {}
    }
  }
}

main();
