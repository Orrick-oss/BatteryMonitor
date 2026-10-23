# BatteryMonitor

Windows 外设电量常驻监视器 —— 纯 Node.js 实现，支持多品牌无线外设的实时电量查询、托盘常驻、低电量提醒与历史曲线。

当前实测支持的设备：

| 设备 | 连接 | 状态 | 协议方案 |
|---|---|---|---|
| MCHOSE 迈从 A7 Pro（鼠标） | 2.4G | ✅ 已真机验证 | Realtek 方案，feature 0x11 + 取反编码 |
| AULA 狼蛛 F87（键盘） | 2.4G | ✅ 已真机验证 | Compx 方案，report 0x13 推送帧 |
| ATK X1 V2（鼠标） | 2.4G | 代码就绪，待真机验证 | Beken 引擎，report 0x08 + 校验和 |

## 功能

- **任务栏电量贴片**：多设备并排嵌入任务栏（浅灰圆角底 + 设备图形 + 彩色百分比，参考 vigil-watt 任务栏贴片设计），每台设备颜色独立反映状态（绿=正常/红=低于阈值/蓝=充电中/灰=离线），点击打开详情页
- **多设备并行查询**：每台设备独立协议引擎，插上自动识别，拔掉自动消失
- **托盘常驻**：托盘图标保留（状态色 + 数字），右键菜单：实时读数、开机自启开关、打开状态页、立即刷新
- **本地状态页**（`http://127.0.0.1:8787`）：每设备独立卡片、电量环、按真实时间轴的历史曲线
- **低电量提醒**：阈值 1~99 自由设置，低于阈值弹 Windows 通知
- **自适应轮询**：设备齐全时 60s 慢轮询，有设备离线时 12s 快速探测，上线即识别
- **每设备校准**：读数与设备显示有偏差时可在页面单独微调
- **极低占用**：无 Electron，Node 单进程（贴片跑在同一进程内，零新进程；实测空闲 CPU ≈ 0，内存 ~70MB）

![任务栏贴片](docs/taskbar-pill.bmp)

## 下载使用

去 [Releases](https://github.com/Orrick-oss/BatteryMonitor/releases) 下载：

- **BatteryMonitor-vX.X.X-win-x64.zip**：免安装便携版。解压到任意位置 → 双击里面的 `Start.vbs` → 完成，无需任何运行环境。

启动应用后，任务栏会出现电量贴片（多设备并排），托盘区有电池图标（首次可能收在 `^` 溢出区，拖出来即可）。点击贴片或托盘图标打开详情页，右键托盘可切换开机自启、查看各设备实时读数。

## 源码运行

```bash
cd app
npm install          # node-hid + systray2 + koffi
node daemon.js       # 启动服务 + 托盘
node launch.js       # 或: 已在运行则只打开状态页
```

## 设备探测工具

协议适配/排查用的真机工具：

```bash
node probe.js        # 枚举本机全部 HID 设备
node atktest.js      # ATK Beken 协议真机探测
node aulatest.js     # AULA/Compx 协议真机探测
```

## 协议实现说明

- **MCHOSE（Realtek）**：VID 0x5253（备选 0x3837），usagePage 0xFF01/0xFF0B，SetFeature `[0x11][cmd^0xFF][0xFF填充]`（21 字节），身份命令 0x06，响应含 VID/电量/充电标志；首次写入为热身，需重试。
- **AULA（Compx）**：VID 0x3554 & PID 0xFA09（与 F99 Pro 接收器同方案），厂商接口 usagePage 0xFF02/0x0002，20 字节帧，校验和 = 前 19 字节之和；写会话帧 `13 05 01` 后读推送 `13 0A`：`[6]=电量%`，`[7] bit0x10=充电中`。注意 3554 为 Compx 共用号段，判据必须带 usagePage+usage。
- **ATK（Beken）**：VID 0x373B & PID 0x12E9（X1 V2 8K），Report ID 0x08、cmd 0x04，校验 `(0x55 - Σ(rid+data)) & 0xFF`；响应 `[6]=电量 [7]=充电 [8..9]=mV 大端`（offset 自适应 rid 前缀）。

协议细节参考了以下开源项目（仅本地对照研究，未随仓库分发）：

- [FerrisPulse 灵脉](https://github.com/Ferris-echo/FerrisPulse)（Beken/ATK 协议）
- [vigil-watt](https://github.com/evren-oct/vigil-watt)（AULA/迈从插件协议；托盘贴片图标样式亦参考其设计）
- [offline-mchose](https://github.com/Rapou7/offline-mchose)（迈从 legacy 协议文档）

## 已知限制

- F87 休眠时接收器读不到电量，页面显示「休眠」，按任意键唤醒即恢复
- 键盘固件电量为分档粗报（90~100% 都可能报 100）
- ATK X1 V2 适配代码单测通过，真机验证 pending（到手后跑 `node atktest.js`）
