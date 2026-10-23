// e2probe2.js — 扩展版: 多种触发方式 + 15 秒监听
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

  const mk = (rid, body) => { const b = Buffer.alloc(21, 0xff); b[0] = rid; for (let i = 0; i < body.length; i++) b[i + 1] = body[i] ^ 0xff; return b; };
  const triggers = [
    ['feature 0x11 / 0x06身份', () => { try { return dev.sendFeatureReport(mk(0x11, [0x06])); } catch (e) { return 'E:' + e.message; } }],
    ['feature 0x11 / 0x58切换配置', () => { try { return dev.sendFeatureReport(mk(0x11, [0x58, 0x00])); } catch (e) { return 'E:' + e.message; } }],
    ['write   0x11 / 0x06身份', () => { try { return dev.write(mk(0x11, [0x06])); } catch (e) { return 'E:' + e.message; } }],
  ];

  console.log('监听 20 秒，每 5 秒换一种触发……（请移动/点击鼠标唤醒）');
  const t0 = Date.now();
  let phase = 0, lastTrig = 0, frames = 0;
  const order = [0, 1, 2, 0];
  while (Date.now() - t0 < 20000) {
    if (Date.now() - lastTrig > 5000) {
      const [name, fn] = [triggers[order[phase]].length ? triggers[order[phase]][0] : '', triggers[order[phase]][1]];
      const r = fn();
      console.log(`[触发${phase + 1}] ${name} -> ${r}`);
      phase = Math.min(phase + 1, 3);
      lastTrig = Date.now();
    }
    let data;
    try { data = dev.readTimeout(300); } catch { continue; }
    if (data && data.length) {
      frames++;
      const buf = Buffer.from(data);
      const hex = buf.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();
      if (buf[0] === 0x13 && buf[1] === 0x1d) {
        const inv = Buffer.from(buf.slice(1).map((b) => b ^ 0xff));
        console.log(`\n🎯 E2状态帧! 原始: ${hex}\n   解码: 充电=${inv[3]} 电量=${inv[4]}%\n`);
      } else {
        console.log(`  <- (${buf.length}B) ${hex}`);
      }
    }
  }
  console.log(`\n共收到 ${frames} 帧`);
  try { dev.close(); } catch { }
})();
