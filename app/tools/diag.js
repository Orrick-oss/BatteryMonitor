// diag.js — 诊断迈从控制通道：多种写法 + 原始回包 dump
'use strict';
const nh = require('node-hid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collectVendorIfaces() {
  const out = [];
  for (const d of nh.devices()) {
    if (![0x5253, 0x3837].includes(d.vendorId)) continue;
    if ([0xff01, 0xff0b, 0xff02, 0xff04].includes(d.usagePage)) out.push(d);
  }
  return out;
}

async function tryDev(d) {
  console.log('='.repeat(70));
  console.log(`接口 usagePage=0x${d.usagePage.toString(16)} usage=0x${d.usage.toString(16)} if=${d.interface}`);
  let dev;
  try { dev = new nh.HID(d.path); } catch (e) { console.log('  打开失败:', e.message); return; }

  const body = [0x06]; // CMD_IDENTITY

  // node-hid v3: sendFeatureReport(data) 单参数，data[0]=report ID
  const frame = Buffer.alloc(21, 0xff); frame[0] = 0x11; frame[1] = body[0] ^ 0xff;

  const trials = [['sendFeatureReport(21B帧, rid=0x11)', frame]];

  for (const [name, data] of trials) {
    try {
      const n = dev.sendFeatureReport(data);
      console.log(`  [${name}] 写入 ${n} 字节`);
    } catch (e) {
      console.log(`  [${name}] 写失败: ${e.message}`);
      continue;
    }
    await sleep(120);
    for (const len of [21, 65]) {
      try {
        const resp = Buffer.from(dev.getFeatureReport(0x11, len));
        console.log(`     读(${len}): ${resp.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim()}`);
      } catch (e) {
        console.log(`     读(${len})失败: ${e.message}`);
      }
      await sleep(60);
    }
    await sleep(120);
  }

  try { dev.close(); } catch { }
}

(async () => {
  const ifaces = collectVendorIfaces();
  console.log(`待测厂商接口: ${ifaces.length} 个\n`);
  for (const d of ifaces) await tryDev(d);
  console.log('\n提示: 诊断期间请拨动/移动鼠标唤醒它，然后重跑。');
})();
