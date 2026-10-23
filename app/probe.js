// probe.js — 枚举本机 HID 设备，定位迈从(A7 Pro)接收器的厂商接口
// 用法: node probe.js [全部输出]   不带参数时只显示迈从相关设备
const nh = require('node-hid');

const MCHOSE_VIDS = [0x3837, 0x5253, 0x41e4, 0x291d]; // 迈从各世代 + 键盘/耳机
const showAll = process.argv.includes('--all');

let list;
try {
  list = nh.devices();
} catch (e) {
  console.error('枚举 HID 失败:', e.message);
  process.exit(1);
}

console.log(`共发现 ${list.length} 个 HID 接口\n`);

const interesting = [];
const others = [];

for (const d of list) {
  const row = {
    vendorId: d.vendorId,
    productId: d.productId,
    vid: d.vendorId.toString(16).padStart(4, '0'),
    pid: d.productId.toString(16).padStart(4, '0'),
    usagePage: d.usagePage,
    usage: d.usage,
    // node-hid 不直接暴露 report 长度，这些字段在部分平台可用
    path: d.path,
    product: (d.product || '').trim(),
    manufacturer: (d.manufacturer || '').trim(),
    interface: d.interface,
    collection: d.collection,
  };
  if (MCHOSE_VIDS.includes(d.vendorId)) interesting.push(row);
  else others.push(row);
}

if (interesting.length) {
  console.log('=== 🎯 迈从相关设备 ===');
  for (const r of interesting) {
    console.log(`VID_${r.vid.toUpperCase()}&PID_${r.pid.toUpperCase()}  usagePage=0x${r.usagePage.toString(16).padStart(4, '0')} usage=0x${r.usage.toString(16).padStart(4, '0')}`);
    console.log(`  product: "${r.product}"  mfr: "${r.manufacturer}"  if: ${r.interface}  collection: ${r.collection}`);
    console.log(`  path: ${r.path}`);
    console.log('');
  }
} else {
  console.log('⚠️ 未发现迈从 VID 的设备。');
  console.log('   请确认: 1) A7 Pro 接收器已插在本机  2) 鼠标已开机');
  console.log('   下面列出全部设备，供人工辨认（有些接收器用通用 VID）：\n');
}

if (showAll || !interesting.length) {
  console.log('=== 全部 HID 接口 ===');
  for (const r of others) {
    console.log(`VID_${r.vid.toUpperCase()}&PID_${r.pid.toUpperCase()}  usagePage=0x${r.usagePage.toString(16).padStart(4, '0')} usage=0x${r.usage.toString(16).padStart(4, '0')}  "${r.product}"  if:${r.interface}`);
  }
}
