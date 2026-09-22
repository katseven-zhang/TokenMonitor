# TokenMonitor 2.1：Qoder 独立审计与 MiMo 接入

2026-09-22。用户直接授权修复和接入，不新建 Room 任务。工作基于 legacy 退役提交 8044840，分支 `codex/qoder-mimo-2.1`；没有合并或推送 main。

## Qoder #105 审计结果

检查了 `codex/feat-qoder-source` 的 desktop 实现，并仅移入桌面代码。发现原 Rust 适配器只接受明文，不解密真实安装的状态；因此此前通过验收不能证明桌面端真实 token 可用。另外，原实现每文件汇总 credits、跳过全部 sidechain、查询前截断 100 条，重复归档与时间筛选会导致误计；累计状态按最新时间全量替换会移动历史。

现已修复认证解密、持久水位增量、跨文件请求去重、范围筛选、解密失败保留缓存，以及旧设置补齐新来源。credits 与 token/货币分开。首次扫描前的逐请求时间分布仍不可恢复，界面与 README 已说明；不能从多模型累计状态推算模型比例。SDK 新格式不可识别时显示错误，不输出格式常量、解密载荷或认证信息。

## Xiaomi MiMo Desktop

实机 Xiaomi MiMo 26.922.220226 的用量位于 `~/.local/share/mimocode/mimocode.db`，并非 Electron 外壳设置库。消息表为 token 来源；工具活动取 part，忽略 step-finish 重复用量。已验证 reasoning 在原始 output 之外，统一输出包含 reasoning。只读 SQLite/WAL 事务；未查询账号、控制账号或认证表。新来源标识 `xiaomi-mimo`。

## 独立本机比对

`node desktop/scripts/source-audit.mjs --local-readonly` 用 Node crypto/SQLite 独立计算，与 Rust 扫描到隔离临时缓存后的聚合比较，并在扫描前后校验源数据稳定。只输出聚合，临时缓存退出后删除。

| 来源 | 有效记录 | 新输入 | 缓存读 | 缓存写 | 输出（含 reasoning） | 合计 |
|---|---:|---:|---:|---:|---:|---:|
| Qoder CN | 9 份会话基线 | 19,179,771 | 892,711,599 | 0 | 2,367,397 | 914,258,767 |
| Xiaomi MiMo | 740 条消息 | 3,612,482 | 105,233,472 | 2,037,167 | 679,025 | 111,562,146 |

Qoder 8,720 个唯一 credits 请求，5,189.042808 credits。MiMo reasoning 197,717，已经包含在输出，未重复加到总量。两源错误/畸形记录均为 0。以上为本次审计时点的本地历史聚合，不代表实时余额或账单。

合成回归覆盖：两版 AAD、篡改/跨 session/cwd 认证拒绝、累计推进/重置/迟到副本、失败保留与重试、跨父子代理归档请求去重、超过 100 请求的完整汇总、半开时间范围与模型/会话/项目筛选、MiMo reasoning/WAL/重复数据库/step-finish、旧配置迁移与禁用保留。构建固定覆盖 `dist/desktop-windows-x64` 及 ZIP，版本为 2.1.0。
