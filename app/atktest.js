// atktest.js — ATK X1 V2 接收器真机验证工具
// 用法: 鼠标接收器插上、鼠标开机后运行 `node atktest.js`
// 输出: VID 373B 全部接口枚举 + 每个接口的 Beken 电量协议实测（原始帧 + 解析结果）
'use strict';
const nh = require('node-hid');
const { bekenChecksum, parseBekenBattery } = require('./battery');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hexdump = (b) => b.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();

function looksAtk(d) {
  return d.vendorId === 0x373b ||
    /atk|vxe|烈空/i.test(d.product || '') || /atk|vxe/i.test(d.path || '');
}

async function probeIface(iface) {
  console.log(`\n── 接口 ${iface.path ? iface.path.split('&').pop() : '?'} usagePage=0x${iface.usagePage.toString(16)} usage=0x${iface.usage.toString(16)}`);
  let dev;
  try { dev = new nh.HID(iface.path); } catch (e) { console.log('  打开失败:', e.message); return null; }
  try {
    for (let i = 0; i < 4; i++) {
      const body = Buffer.alloc(16);
      body[0] = 0x04; // BATTERY_COMMAND
      const tx = Buffer.concat([Buffer.from([0x08]), body, Buffer.from([bekenChecksum(0x08, body)])]);
      let ok = false;
      try { dev.sendFeatureReport(tx); ok = true; } catch (e) { console.log(`  #${i + 1} 写失败: ${e.message}`); }
      if (ok) {
        await sleep(60 + i * 30);
        for (const size of [17, 21, 33]) {
          let rx = null;
          try { rx = Buffer.from(dev.getFeatureReport(0x08, size)); } catch { }
          if (rx && rx.some((b) => b !== 0 && b !== 0xff)) {
            const p = parseBekenBattery(rx);
            console.log(`  #${i + 1} 读回 ${rx.length}B: ${hexdump(rx)}`);
            if (p) {
              console.log(`  🎯 解析成功: 电量 ${p.battery}% | 充电 ${p.charging ? '是' : '否'} | 电压 ${p.millivolts}mV`);
              return p;
            }
          }
        }
      }
      await sleep(80);
    }
  } finally { try { dev.close(); } catch { } }
  return null;
}

(async () => {
  console.log('=== ATK 电量协议真机验证 ===\n');
  const list = nh.devices().filter(looksAtk);
  if (!list.length) {
    console.log('❌ 未发现 ATK 接收器（VID 373B 或产品名含 ATK/VXE）');
    console.log('   请确认: ① 接收器已插上 ② 鼠标已开机（拨动底部的开关）');
    console.log('\n当前全部 HID 设备（供人工比对）:');
    for (const d of nh.devices()) {
      console.log(`  VID_${(d.vendorId || 0).toString(16).padStart(4, '0')}&PID_${(d.productId || 0).toString(16).padStart(4, '0')} usagePage=0x${(d.usagePage || 0).toString(16)} ${d.product || '(无名)'}`);
    }
    process.exit(2);
  }
  console.log(`发现 ${list.length} 个候选接口:`);
  for (const d of list) {
    console.log(`  VID_${d.vendorId.toString(16).padStart(4, '0')}&PID_${d.productId.toString(16).padStart(4, '0')} usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)} ${d.product || '(无名)'}`);
  }
  let found = null;
  for (const iface of list) {
    const r = await probeIface(iface);
    if (r) { found = r; break; }
  }
  console.log('\n=== 结论 ===');
  if (found) {
    console.log(`✅ ATK 协议适配成功: ${found.battery}% ${found.charging ? '充电中' : ''} ${found.millivolts ? found.millivolts + 'mV' : ''}`);
    console.log('   daemon 已内置此协议, 重启服务即可在状态页/托盘看到 ATK 设备。');
  } else {
    console.log('❌ 接口都在但无有效应答 — 把上面的完整输出发给我, 我按原始帧调整协议。');
  }
})();
