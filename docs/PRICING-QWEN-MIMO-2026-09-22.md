# Qwen 与 MiMo 价格补充（2026-09-22）

单位：人民币元 / 百万 tokens。采用官方国内实时 API 标价，供本地 API 等价成本估算；不代表 Qoder credits、Token Plan 订阅或促销的实际账单。新增价格作为基础快照用于已有记录，未伪造历史调价日期。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 |
|---|---:|---:|---:|---:|
| Qwen3.8-Max | 12 | 1.5 | 15 | 36 |
| Qwen3.7-Max | 12 | 2.4 | 15 | 36 |
| Qwen3.8-Flash | 0.8 | 0.1 | 1.25 | 2.7 |
| MiMo-V2.5-Pro / V2.6-Pro | 3 | 0.025 | 0 | 6 |
| MiMo-V2.5（Flash）/ V2.6-Flash | 1 | 0.02 | 0 | 2 |

依据：[Qwen3.8-Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)、[Qwen3.7-Max](https://help.aliyun.com/zh/model-studio/qwen3-7-max)、[Qwen3.8-Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[MiMo 官方 API 定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)。

- Qwen 缓存读取隐式缓存价格；显式缓存命中可有不同价格，当前事件格式无法区分。缓存写取官方显式缓存创建价格。Qwen3.8-Flash 官方详情页明确列为 1.25，不根据输入价另行推算。
- MiMo 官方明确缓存写入限时免费，本快照填 0；未来结束优惠需更新。Pro 两代同价，Flash 两代同价，Pro 与 Flash 不同价。
- 2.5 Flash 的官方模型 ID 为 `mimo-v2.5`；`mimo-v2.5-flash` 和对应显示名作为别名。2.6 使用 `mimo-v2.6-flash`。
- 本机 Qoder 日志出现 `qmodel_38max` 与 `qfmodel`。前者按名称映射 `qwen3.8-max`；后者无法从公开资料或本机公开 SDK 字符串确认具体型号，因此不强行映射。`mimo-auto` 也保留未定价。多模型累计用量的 `unknown` 不变。
- 保留其它模型价格、汇率、显示币种、免费模型与现有历史记录。本地更新之前保留一份固定名称价格备份。
