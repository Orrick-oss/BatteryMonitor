// traye2e.js — 托盘左键→卡片 e2e 验证(v1.0.15)
// 检查点:
//   A. PostMessage 模拟左键 → 卡片窗口出现
//   B. 卡片可见 >5s(超过挂起检测阈值)期间 SendMessageTimeout 一直成功 → 未被系统判定"未响应"
//   C. t≈10s 仍可见(1.0.14 曾出现"来不及点就消失", 驻留已延长到 30s)
//   D. ~31s 后自动收起
'use strict';
const koffi = require('koffi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const F = {
  FindWindowW: user32.func('void *FindWindowW(str16 cls, str16 title)'),
  IsWindowVisible: user32.func('int IsWindowVisible(void *h)'),
  PostMessageW: user32.func('int PostMessageW(void *h, uint32 msg, uint64 wp, int64 lp)'),
  SendMessageTimeoutW: user32.func('int64 SendMessageTimeoutW(void *h, uint32 msg, uint64 wp, int64 lp, uint32 flags, uint32 timeout, _Out_ uint64 *result)'),
};

function responsive(hwnd) {
  const out = [0];
  // WM_NULL=0, SMTO_BLOCK|SMTO_ABORTIFHUNG = 0x1|0x2
  const r = F.SendMessageTimeoutW(hwnd, 0, 0, 0, 0x3, 1500, out);
  return r !== 0;
}

(async () => {
  const card = F.FindWindowW(null, 'BatteryMonitorCard');
  if (!card) { console.log('FAIL: 卡片窗口不存在'); process.exit(1); }
  const tray = F.FindWindowW('BMTrayWnd', null);
  if (!tray) { console.log('FAIL: 托盘窗口不存在'); process.exit(1); }

  console.log('初始卡片可见(应0):', F.IsWindowVisible(card));

  // A. 模拟左键
  if (!F.PostMessageW(tray, 0x8001, 0, 0x0202)) { console.log('FAIL: PostMessage 失败'); process.exit(1); }
  await sleep(800);
  const visA = F.IsWindowVisible(card);
  const respA = responsive(card);
  console.log(`A. 左键后卡片可见=${visA} 响应=${respA}`);

  // B. 可见期间持续探活(覆盖 >5s 挂起阈值)
  let allResp = true;
  for (let t = 1000; t <= 7000; t += 1000) {
    await sleep(1000);
    const vis = F.IsWindowVisible(card);
    const resp = responsive(card);
    if (!resp) allResp = false;
    console.log(`B. t≈${t}s 可见=${vis} 响应=${resp}`);
  }

  // C. 30s 驻留内不应提前收起
  await sleep(3000);
  const visC = F.IsWindowVisible(card);
  console.log(`C. ~10s 仍可见(应1)=${visC}`);

  // D. 30s 驻留 + 0.5s 宽限后自动收起
  await sleep(22000);
  const visD = F.IsWindowVisible(card);
  console.log(`D. ~33s 后可见(应0)=${visD}`);

  const pass = visA === 1 && respA && allResp && visC === 1 && visD === 0;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})();
