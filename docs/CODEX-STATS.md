# Codex 本地统计：能力边界与黑盒验收（#50）

状态：Codex 统计独立页面系列（#46 契约 / #48 页面 / #49 报告）的验收资产与边界文档。

## 1. 本地统计 vs codex-lb（务必区分）

TokenMonitor 的 Codex 统计**只读取本地日志**（`~/.codex/sessions` 与
`archived_sessions` 的 rollout JSONL），提供：配额窗口快照（5h/weekly/monthly 的
used_percent/reset 等）、token 吞吐（input/cached/cache-write/output/reasoning/total）、
消耗节奏与耗尽风险（burn rate / safe line / risk / ETA，纯本地推断）、
weekly API 等值金额（按本地价表估算）、请求明细 / 日报 / CSV 导出。

**不是** codex-lb，也没有移植它的任何代码。以下 codex-lb 能力在本产品中**不存在**：

- 远端账号池 / 多账号负载均衡 / 账号健康巡检
- 代理（proxy）管理与流量转发
- OAuth 登录、token 刷新、reset-credit（配额重置）等任何写操作
- 访问 OpenAI 远端 `/wham/usage` 或任何公网接口（离线模式下亦不出网）

## 2. 数据新鲜度与 unknown 限制

- 配额快照随 rollout 日志中的 `rate_limits` 记录落库，**不是实时配额**：新鲜度以
  `/api/codex/summary` 的 `freshness`（快照年龄）为准，超过 2 小时标记 `stale`。
- 样本不足（单样本）、快照陈旧（>30 分钟）、窗口刚重置、容量未知时，
  `/api/codex/pace` 返回 `state: "unknown"` + `unknown_reason`
  （`no_samples` / `single_sample` / `stale_samples` / `no_capacity` / `invalid_values` /
  `window_reset`），**绝不伪造 ETA 或风险等级**。
- 显式 0 与缺失严格区分：`used_percent: 0` 表示"刚重置"，缺失一律 `null`（UI 显示 —）。
- weekly API 等值金额是**估算**（本地 pricing.json 价表直查），页面显著标注
  「API 等值估算，不是订阅真实账单」；未配价模型不计入金额且单独列出。
- 完整周额度外推仅在样本与价格条件足够时提供，否则返回 unknown 原因。

## 3. Windows 边界（回归断言位置）

| 边界 | 行为 | 断言 |
|---|---|---|
| 中文/空格路径 | 采集、fixture、临时目录全链路可用 | run.mjs [3]/[17]/[19] |
| CRLF / 半行 | 半行不推进游标；CRLF 行尾正确 | [3] 增量组、[17] |
| 双扫描 / 版本重扫 | dedup_key 幂等，重复扫描零新增 | [3]（幂等断言）、[17] |
| 归档搬移 | 会话键+序号 dedup_key，路径变化不重复计数 | [3] 组 codex fixture |
| 窗口 reset | windowId 变化弃旧窗口样本；历史 window_id 代际切换 | [16] #47、[18] #45 |
| 坏记录（坏 JSON/缺列） | 跳过该行不抛穿；脏 state_json 全量重扫 | [11] #43、[17] #44 |
| 显式 0 / unknown | 0 保留为 0；缺失为 null + unknown_reason | [16]/[19] |
| WAL / 文件占用 | busy_timeout+重试；历史写入尽力而为不崩溃 | [18] #45 |
| 离线模式 | TOKENMONITOR_OFFLINE=1 全部测试不出网 | 全套件 |
| 覆盖式打包 | dist\windows-x64 覆盖构建，不创建时间戳目录 | scripts/build-windows.ps1（固定目录） |

## 4. 黑盒验收命令

```bash
# 离线全量回归（含 Codex 全链路断言，失败非零）
npm test

# Codex 专项（黑盒走查：起真实 serve → 首页入口 → /codex 页面 →
# 窗口卡/吞吐/pace/cost/明细/日报/CSV 全链路 API 契约 + 回归断言）
node test/windows/codex-blackbox.test.mjs
```

`codex-blackbox.test.mjs` 使用脱敏合成 fixture（临时目录，中文+空格路径），
起真实 `serve` 进程后按用户路径走查；任何一步失败即非零退出（不静默跳过）。

## 5. 打包约束

- 构建产物固定写入 `dist\windows-x64`（覆盖式，不建时间戳目录）。
- 托盘 exe 位于包内 `tray\TokenMonitorTray.exe`（Rust 原生，≤2MB）。
- 数据目录便携化：打包形态一切数据落 `<应用根>\data`。
