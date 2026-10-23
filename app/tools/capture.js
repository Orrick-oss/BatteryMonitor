// capture.js — 系统性采集 0x06 身份命令的响应，双解码对照
'use strict';
const nh = require('node-hid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();

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
  if (!iface) { console.log('未找到接口'); process.exit(1); }
  const dev = new nh.HID(iface.path);
  console.log(`接口 usagePage=0x${iface.usagePage.toString(16)} if=${iface.interface}\n`);

  for (let round = 1; round <= 4; round++) {
    // 触发（取反编码, 21B 总长）
    const req = Buffer.alloc(21, 0xff);
    req[0] = 0x11; req[1] = 0x06 ^ 0xff;
    let w = -1;
    try { w = dev.sendFeatureReport(req); } catch (e) { console.log(`R${round} 写失败: ${e.message}`); }
    await sleep(90);

    const r1 = (() => { try { return dev.getFeatureReport(0x11, 21); } catch (e) { return ['读失败:' + e.message]; } })();
    await sleep(70);
    const r2 = (() => { try { return dev.getFeatureReport(0x11, 21); } catch (e) { return ['读失败:' + e.message]; } })();

    console.log(`--- R${round} (写=${w}) ---`);
    console.log('  读1:', hex(r1));
    console.log('  读2:', hex(r2));
    if (r1.length === 21) {
      const inv1 = Buffer.from(r1.map((b) => b ^ 0xff));
      console.log('  读1取反解码:', hex(inv1));
    }
    await sleep(300);
  }

  // 顺带试 0x12 配置读
  const req12 = Buffer.alloc(65, 0xff);
  req12[0] = 0x12; req12[1] = 0x67 ^ 0xff;
  try {
    dev.sendFeatureReport(req12);
    await sleep(120);
    const c1 = dev.getFeatureReport(0x12, 65);
    console.log('\n0x12配置读:', hex(c1));
    console.log('0x12取反解码:', hex(Buffer.from(c1.map((b) => b ^ 0xff))));
  } catch (e) { console.log('\n0x12 配置读失败:', e.message); }

  try { dev.close(); } catch { }
})();
