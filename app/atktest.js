// atktest.js — ATK 接收器诊断（源码版；exe 版用状态页「ATK 诊断」按钮）
// 用法: 接收器插上、鼠标开机并动一下, 然后 `node atktest.js`
// 输出: 所有 VID 373B/3554 接口 + 两种协议的收发原始帧 + 结论
'use strict';
const { probeAtk } = require('./battery');

const vp = (v) => (v == null ? '-' : '0x' + Number(v).toString(16).toUpperCase());

(async () => {
  console.log('=== ATK 协议诊断 ===\n');
  const r = await probeAtk();
  console.log('【HID 设备】' + (r.devices.length ? r.devices.length + ' 个' : '无'));
  for (const d of r.devices) {
    console.log(`  ${d.vid}:${d.pid}  usagePage=${d.usagePage} usage=${d.usage}  ${d.product || '(无名)'}${d.skipped ? '  [已跳过: 狼蛛]' : ''}`);
  }
  console.log('\n【逐接口尝试】');
  for (const a of r.attempts) {
    console.log(`  · ${a.variant}  usagePage=${vp(a.usagePage)} usage=${vp(a.usage)}`);
    if (a.openError) console.log('      打开失败: ' + a.openError);
    if (a.writeError) console.log('      写失败: ' + a.writeError);
    if (a.wrote != null) console.log('      写入: ' + a.wrote + ' 字节' + (a.writeLen ? '（报文长度 ' + a.writeLen + 'B）' : ''));
    if (a.readError) console.log('      读失败: ' + a.readError);
    if (a.frames && a.frames.length) a.frames.forEach((f) => console.log('      收到: ' + f));
    else console.log('      收到: (无回帧)');
    if (a.hit) console.log(`      ✔ 命中: ${a.hit} (第 ${a.attempt} 次尝试)`);
  }
  console.log('\n【结论】' + (r.verdict || '-'));
  if (r.result) {
    console.log(`✅ ${r.result.variant}: 电量 ${r.result.battery}%${r.result.charging ? ' 充电中' : ''}`);
    console.log('   daemon 已内置该协议, 重启服务即可在状态页/托盘看到 ATK 设备。');
  } else {
    console.log('❌ 未命中 — 把上面完整输出发我, 我按原始帧加协议变体。');
  }
  process.exit(r.result ? 0 : 2);
})();
