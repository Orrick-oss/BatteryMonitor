// toast-e2e.js — 端到端验证安装版 daemon 的 toastNotify 同款脚本(注册表 AUMID + tag 替换)
'use strict';
const { execFileSync } = require('child_process');
const AUMID = 'Orrick.BatteryMonitor';

function run(xml2, tag, extra = '') {
  const script = `
$ErrorActionPreference='Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template='ToastText02'><text id='1'>BatteryMonitor 电量提醒</text><text id='2'>${xml2}</text></binding></visual></toast>")
$t = New-Object Windows.UI.Notifications.ToastNotification $x
$t.Tag = '${tag}'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($t)
$h = [Windows.UI.Notifications.ToastNotificationManager]::History
'HISTORY=' + $h.GetHistory('${AUMID}').Count
${extra}
`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  console.log(out.trim());
}

// ① 模拟低电通知
run('AULA F87 电量低：20%（14:40 提醒）', 'bm-aula');
// ② 同 tag 充电通知 → 旧通知应被顶掉, 历史仍 1 条
run('AULA F87 正在充电：77% ⚡', 'bm-aula');
// ③ 清场(不留下测试通知)
run('清理占位', 'bm-clean',
  `$c = [Windows.UI.Notifications.ToastNotificationManager]::History\n$c.Clear('${AUMID}')\n'HISTORY-CLEARED=' + $c.GetHistory('${AUMID}').Count`);
