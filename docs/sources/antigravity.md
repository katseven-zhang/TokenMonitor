# Antigravity（`antigravity`）

Google Antigravity（agentic IDE / CLI，内部代号 agy）在本机落一份 SQLite 用量
数据面。来源以只读方式解析它，把每次 LLM 生成的 token 消耗计入本地面板。
`tool` 标识 `antigravity`，`kind: sqlite`，manifest 版本 1，`apiBilled` 未设置
（订阅制计量，无证据表明扣用户 API 钱包）。

## 路径发现顺序

manifest `roots(ctx)` 按以下顺序产出候选锚点（经注册器按 Windows 大小写不敏
感去重）：

1. `$ANTIGRAVITY_HOME/conversation_summaries.db`（环境变量覆盖，供测试与自定
   义安装注入）；
2. `~/.gemini/antigravity/conversation_summaries.db`（Windows IDE 默认 home，
   实机验证存在）；
3. `~/.gemini/antigravity-cli/conversation_summaries.db`、
   `~/.gemini/antigravity-acp/...`、`~/.gemini/antigravity-ide/...`（CLI / ACP
   kernel / IDE 变体 home，按第三方参考实现记录，未在实测机全部出现）。

`%APPDATA%\Antigravity` 只是 Electron 壳层（User 数据），实测无任何用量字段，
不在发现范围内。

**锚点选择的原因与边界**：会话库是 `conversations/<uuid>.db` 动态增减的多个
文件，而中央 scanner 对 `sqlite` 源要求 root 是"单个文件"，故以每个 home 的
`conversation_summaries.db`（稳定文件名）为扫描锚点；collector 被触发时自行
枚举同级 `conversations/*.db`。**已记录的限制**：若某 home 只有会话库而没有
summaries 索引库（如部分 ACP kernel 场景），该 home 无法被发现——此时不猜
测、不扫全盘，宁可漏扫（见"隐私与边界"）。

## 数据格式（实测 2026-09，Windows IDE build）

每个 home 两类 SQLite 库（WAL 模式，源只读打开，可与其并发）：

- `conversation_summaries.db`：表 `conversation_summaries(conversation_id,
  title, preview, step_count, last_modified_time, workspace_uris, ...)`。
  取 `conversation_id → workspace_uris`（JSON 数组，第一个 `file://` URI 的
  路径末段作为项目名，`%XX` 解码；无则项目记 null）。
- `conversations/<uuid>.db`：会话内表包括 `trajectory_meta`、`steps`、
  `gen_metadata`、`executor_metadata`、`trajectory_metadata_blob` 等。
  **只解析两张**：
  - `gen_metadata(idx INTEGER PRIMARY KEY, data BLOB, size)`：每行一次 LLM
    生成，`data` 为 protobuf 裸格式；
  - `steps(idx INTEGER PRIMARY KEY, metadata BLOB, ...)`：仅取与 gen 行同
    idx 的时间戳。

### gen_metadata.data 的 protobuf 字段映射

零依赖 wire-format 解码（变体字节 → 字段号），关键路径：

| 路径 | 含义 |
| --- | --- |
| `1.19`（string） | 模型 id，如 `gemini-3.8-flash`、`claude-opus-4-6-thinking` |
| `1.4.2` | 新鲜 input（不含缓存） |
| `1.4.3` | 总输出，**含 thinking**（实测 = 1.4.9 + 1.4.10，如 806=750+56、73=15+58） |
| `1.4.4` | cache 写入 |
| `1.4.5` | cache 命中 |
| `1.4.9` | thinking 输出 |
| `1.4.10` | 可见输出 |
| `1.9.4.1` / `1.9.4.2` | 完成时间秒/纳秒（2026-07 参考实现的路径） |

忽略字段：`1.4.1`（模型枚举）、`1.4.6`（provider 枚举）、`1.4.7/8/11`（请求
元数据）、外层其余字段。重复标量取最后出现值。

**版本标识与 schema 漂移**：数据侧没有显式 schema 版本号。已知两代布局：

- 参考（JingbiaoMei/Tokdash `AntigravityCLIParser`，descriptor-pinned 记录于
  2026-07-02）：完成时间在 `1.9.4.1/1.9.4.2`；
- 本机 2026-09 实测：`1.9` 变成 `{2:-1, 10:{...}}`，行内无 wall-clock 时间；
  完成时间改从**同库 `steps` 表同 idx 行**的 `metadata` 取（路径
  `1.1.1/1.1.2` = 秒/纳秒）。实测 23 库 6520 行 gen↔steps 逐一同 idx 对齐、
  6520/6520 可解出时间。

collector 同时支持两代：行内时间戳优先，缺失时回退 steps 对齐，两者皆无则
丢弃该行（无时间戳的事件无法定位时间轴）。

## token 口径

与 opencode/pi 等现有源一致：

- `input_tokens` = 1.4.2（新鲜输入，不含缓存）；
- `cached_input` = 1.4.5；`cache_write` = 1.4.4；
- `output_tokens` = 1.4.3（**含 thinking**；f3 缺席时按 f10+f9 回推）；
- `reasoning_tokens` = 1.4.9（已含在 output 内，单列供分析）；
- `total_tokens` = input + cached + cache_write + output。

模型名经 `normalizeModel` 小写归一；会话 = 会话库文件名（uuid）；项目 =
summaries `workspace_uris` 的第一个 `file://` 路径末段。

## 去重、增量与失败语义

- `dedup_key = antigravity:<会话uuid>:<idx>`：由源数据主键决定，跨重扫稳定；
  version 升级触发全量重扫时靠它幂等。
- 增量：每会话按 `gen_metadata.idx` 水位，只读新行；`MAX(idx)` 变小（删过
  行、idx 复用）时整表重读，dedup 兜底。
- 锁/占用：锚点库或会话库打开失败、查询中 SQLITE_BUSY → 本轮跳过该库，水位
  不动，不抛错（Windows 文件占用是常态）。
- 坏记录：protobuf 解码失败的行只丢该行；零用量行（input/output/cacheRead
  全 0）跳过不入库。
- WAL：主文件 mtime 不反映 WAL 写入，依赖 scanner 周期扫描兜底（架构契约
  第 4 节）。

## 工具调用

**unsupported（记录在案）**：`gen_metadata` 不含工具调用记录；`steps` 表的
`step_payload`/`render_info` 等列确有工具调用痕迹，但其编码未经过验证，按
"不得猜测格式"原则不解析。若后续取得可验证的格式文档，再作为版本 2 扩展。

## 隐私与边界

- 只读打开源库，从不写入；进程内句柄即用即关（Windows 上保证临时库可清理）。
- 只读取列级元数据：`gen_metadata.idx/data`、`steps.idx/metadata`（仅时间戳
  字段）、`conversation_summaries.conversation_id/workspace_uris`。不解码、
  不落盘任何会话正文（`title`/`preview` 都不读）。
- 测试 fixture 全部为运行时合成的最小 protobuf/SQLite，黄金数字为手造值，
  仓库不含任何真实库、uuid 或会话内容。
- 本地路径（roots）不出网：`/api/sources` 由服务端脱敏（#16 契约）。

## 测试

`TOKENMONITOR_OFFLINE=1 node test/sources/antigravity/antigravity.test.mjs`
（39 项断言：manifest 契约与大小写去重、行解码黄金数、collector 黄金数、
增量/幂等/版本重扫、EXCLUSIVE 锁跳过与水位保护、锚点缺失降级、注册表自动
发现）。

实机验证（actual，非合成）：对本机真实 `~/.gemini/antigravity`（23 会话库、
6520 行 gen_metadata）以临时 Store 跑 collector：首轮 6460 事件入库，23 行
为零用量/无时间戳跳过；水位重扫与全量重读均 0 重复；聚合出 4 个模型、3 个
项目、时间范围与真实使用窗口一致。验证脚本只在内存/临时目录聚合，未输出任
何会话内容。
