// e2probe.js — 触发 + 监听 input report 0x13 上的 E2 状态帧
// 依据: vigil-watt mchose.md §1.6 (A7 V2 Pro 真机样本) + dsh-mchose-battery 实现描述
'use strict';
const nh = require('node-hid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findIface() {
  let pref = null, fb = null;
  for (const d of nh.devices()) {
    if (![0x5253, 0x3837].includes(d.vendorId)) continue;
    if (d.usagePage === 0xff01 && d.usage === 0x0001) pref = d;
    else if (d.usagePage === 0xff0b && !fb) fb = d;
  }
  return pref || fb;
}

(async () => {
  const iface = findIface();
  if (!iface) { console.log('未找到迈从厂商接口'); process.exit(1); }
  console.log(`打开: usagePage=0x${iface.usagePage.toString(16)} if=${iface.interface}`);

  const dev = new nh.HID(iface.path);

  // 触发帧: [0]=0x11 [1]=0x06^0xFF=0xF9 其余 0xFF (即 0x06 命令取反)
  const trigger = Buffer.alloc(21, 0xff);
  trigger[0] = 0x11; trigger[1] = 0xf9;
  try {
    const n = dev.sendFeatureReport(trigger);
    console.log(`触发帧已写: ${n} 字节`);
  } catch (e) {
    console.log('触发帧写失败:', e.message);
  }

  // 监听 input 推送 6 秒
  console.log('监听 input report 6 秒……（期间请移动/点击鼠标）');
  const t0 = Date.now();
  let frames = 0;
  while (Date.now() - t0 < 6000) {
    let data;
    try { data = dev.readTimeout(500); } catch { break; }
    if (data && data.length) {
      frames++;
      const buf = Buffer.from(data);
      const hex = buf.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();
      // E2 解码: [0]=rid前缀(0x13) 不取反,其后逐字节 ^0xFF
      if (buf[0] === 0x13 && buf[1] === 0x1d) { // 0x1D = 0xE2^0xFF
        const inv = Buffer.from(buf.slice(1).map((b) => b ^ 0xff));
        console.log(`\n🎯 E2 状态帧! 原始: ${hex}`);
        console.log(`   解码: [0]=0x${inv[0].toString(16)} [3]充电=${inv[3]} [4]电量=${inv[4]}%`);
      } else {
        console.log(`  <- (${buf.length}B) ${hex}`);
      }
    }
  }
  console.log(`\n共收到 ${frames} 帧`);
  try { dev.close(); } catch { }
})();
