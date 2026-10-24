// atktest.js — ATK 接收器诊断 CLI（开发工具，不进安装包）
// 用法: app 目录下 `node atktest.js`（接收器插上、鼠标开机并动一下）
// 输出: 所有 VID 373B/3554 接口 + 两种协议的收发原始帧 + 结论。
// 遇到新机型协议不通时，把本命令的完整输出发回来即可定位。
'use strict';
const hid = require('node-hid');
const {
  findAtkInterfaces, atkTryIface, ATK_VARIANTS,
} = require('./battery');

const ATK_SKIP_PIDS = new Set([0xFA09]);          // 狼蛛 F87, 归 AULA 引擎
const isAtkVid = (vid) => vid === 0x373B || vid === 0x3554;
const vp = (v) => (v == null ? '-' : '0x' + Number(v).toString(16).toUpperCase());

// 诊断: 遍历所有候选接口 × 协议变体, 记录写结果与收到的每一帧
async function probeAtk() {
  const all = hid.devices().filter((d) => isAtkVid(d.vendorId));
  const ifaces = findAtkInterfaces();
  const out = {
    vids: ['0x373B', '0x3554'],
    devices: all.map((d) => ({
      vid: vp(d.vendorId), pid: vp(d.productId),
      usagePage: vp(d.usagePage), usage: vp(d.usage),
      product: d.product || '', manufacturer: d.manufacturer || '',
      skipped: ATK_SKIP_PIDS.has(d.productId),
    })),
    attempts: [], result: null,
  };
  if (!ifaces.length) {
    out.verdict = all.length
      ? '找到 VID 命中但全部被过滤(键盘集合/狼蛛 PID)'
      : '未发现 VID 373B / 3554 的任何 HID 接口 —— 接收器未插或未被系统识别';
    return out;
  }
  const budget = Date.now() + 20000;
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

(async () => {
  console.log('=== ATK 协议诊断 ===\n');
  const r = await probeAtk();
  console.log('结论: ' + r.verdict);
  console.log('探测 VID: ' + r.vids.join(' / '));
  console.log('\n【HID 设备】' + (r.devices.length ? r.devices.length + ' 个' : '无'));
  for (const d of r.devices) {
    console.log(`  ${d.vid}:${d.pid}  usagePage=${d.usagePage} usage=${d.usage}  ` +
      (d.product || '(无名)') + (d.manufacturer ? ' / ' + d.manufacturer : '') + (d.skipped ? '  [已跳过: 狼蛛]' : ''));
  }
  console.log('\n【逐接口尝试】');
  for (const a of r.attempts) {
    console.log('  · ' + a.variant + '  usagePage=' + vp(a.usagePage));
    if (a.openError) console.log('      打开失败: ' + a.openError);
    if (a.writeError) console.log('      写失败: ' + a.writeError);
    if (a.wrote != null) console.log('      写入: ' + a.wrote + ' 字节' + (a.writeLen ? '（报文长度 ' + a.writeLen + 'B）' : ''));
    if (a.readError) console.log('      读失败: ' + a.readError);
    if (a.frames && a.frames.length) for (const f of a.frames) console.log('      收到: ' + f);
    else console.log('      收到: (无回帧)');
    if (a.hit) console.log('      ✔ 命中: ' + a.hit + ' (第 ' + a.attempt + ' 次尝试)');
  }
  process.exit(0);
})();
