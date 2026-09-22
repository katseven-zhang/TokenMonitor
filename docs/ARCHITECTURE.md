# TokenMonitor 架构与数据源调研

> 本文档源自真实环境的逆向调研（2026-09），记录各数据源的本地格式、口径差异与设计决策。不含任何个人数据。

## 总体架构

```
bin/tokenmonitor.js      CLI（scan / serve / today）
src/
  config.js              数据位置/端口/离线开关；SOURCES 只是 source-registry 的 re-export
  source-registry.js     来源加载器：枚举 src/sources/*.js → 校验 manifest → 解析 roots → 绑定 collector
  sources/               每源一个 manifest（<slug>.js 即注册键）：antigravity/ccmr/claude-code/codex/
                         dsh/grok/opencode/pi/workbuddy/zcode（+ contract.js：kind 枚举、context、校验、去重）
  store.js               SQLite（node:sqlite）：events / files游标 / quota / rates / tool_calls /
                         balance_history / codex_quota_history（#45 的配额快照历史）
  scanner.js             按源类型枚举 + 增量扫描 + 文件监听 + 版本回填 + resume链模型继承
                         （监听走 platform/watch.js 的 fs.watch，不是 macOS FSEvents：
                         Windows 上 recursive 不可靠，会自动降级为目录级监听 + 周期兜底扫描）
  server.js              HTTP API + SSE + 健康计算 + Claude 5h 推算 + 每日备份
  balance.js             厂商余额轮询（DeepSeek / Kimi / GLM，三家都有连续 4xx 熔断）
  pricing.js             全源费用折算（priceOf 单一计价入口 + PEAK_SQL 峰谷 + pricedCostCny
                         单一成本公式）+ 余额对账（同一公式，#74 起两边不再各写一份）
  rates.js               WorkBuddy 积分费率自学习（最小二乘）
  models.js              模型名归一化（跨源大小写合并）
  bar.js                 `bar` 分发：macOS 胶囊 / Windows 托盘 EXE 查找与拉起
  platform/              Windows 侧运行时（runtime 日志与锁、watch 降级、windows-service 任务计划）
  collectors/            每源一个适配器（claude〔claude-code+ccmr 共用〕/ codex / zcode / dsh /
                         workbuddy / grok / pi / opencode / antigravity）。另有 lines.js 不是来源，
                         是共用的 JSONL 字节游标 reader（半行不推进、剥行尾 CR、跨块 UTF-8 安全），
                         被 claude/codex/grok/pi/workbuddy 五个采集器 import
web/                     零构建前端（vanilla JS + ECharts UMD）
menubar/                 macOS 菜单栏 App（Swift/AppKit，需 .app bundle）
windows/gui/             Windows 启动器（原生 Rust Win32，#24/#28）
windows/tray/            Windows 系统托盘（原生 Rust Win32，#9/#32）
desktop/                 Tauri 桌面版（React 前端 + Rust 后端，独立版本线）
~/.tokenmonitor/         运行时数据（库 / 备份 / pricing.json / 日志）
```

## 归一化事件模型

`(ts, tool, model, session_id, project, input_tokens[不含缓存], cached_input, cache_write, output_tokens, reasoning_tokens, total_tokens, trace_id, dedup_key UNIQUE)`

**口径**：Anthropic 系（Claude Code/ccmr/dsh/Pi/OpenCode）`input_tokens` 不含缓存，total = 四项之和；OpenAI 系（Codex/ZCode/WorkBuddy/Grok）input 已含 cached，入库拆为 新输入/缓存命中 两列。total = input + cache_write + output。

两类口径落库后是同一个公式：`total_tokens = input_tokens + cached_input + cache_write + output_tokens`。
`reasoning_tokens` 只作信息列，**任何源都不得把它再加进 total**——Pi 与 OpenCode 的 reasoning
都已含在 output 内，重复相加会凭空多算。

**相加之前必须逐项转整数**（#96）。上游 JSON 里的用量字段可能是数字，也可能是数字形态的
字符串（网关回填 usage 的常见写法），而 JS 的 `+` 遇到字符串做的是拼接：
`"123" + 0 + 0 + 456 → "12300456"`。`total_tokens` 是 INTEGER 列，SQLite 的亲和性又会把这串
文本落成整数，于是一次 579 token 的调用被记成 1230 万——不报错、不计坏行，面板上一切正常。
规则落在 `src/collectors/tokens.js tokenCount()`（claude/ccmr、dsh、grok、pi、opencode、
workbuddy、zcode 七个采集器共用；codex 的 `num()` 与 antigravity 的 `asNumber()` 早就是这个
语义），桌面端对应 `collectors.rs::number()`（此前它对字符串一律给 0，等于另一端少记），双端共享夹具见
`test/run.mjs` 的 [27] 段与 `collectors.rs::stringly_typed_usage_and_empty_model_usage_match_node`。
存量坏行：桌面端由 `COLLECTOR_REVISION` 整库重建，Node 端没有整库重建通道（`dedup_key` 没变时
重扫只会 `INSERT OR IGNORE`），因此 `store.js migrate()` 按上面那条恒等式重算一次不满足恒等式的行。

## 数据源格式笔记

### Claude Code / ccmr（同一解析器）
`~/.claude/projects/<项目目录>/<会话>.jsonl`，ccmr 用独立 `CLAUDE_CONFIG_DIR=~/.claude-gateway` 同格式。每条 type=assistant 记录的 `message.usage` 即一次 API 调用；`model="<synthetic>"` 为本地合成消息须过滤；同一 message.id+requestId 会因分片重复出现 → 全局 dedup。工具调用在 content[] 的 tool_use 块。

**一次响应被拆成多行，只有终结块带真实 output_tokens。** 一条 assistant 消息按 content block 分行写入（`apiBlockIndex` 0..n），共享同一个 `message.id`，`input_tokens`/`cache_read_input_tokens` 每行重复，而 `output_tokens` 在前置分片里全是 0，只有最后一块是真值：

```
block0 thinking   3594/47360/0
block1 text       3594/47360/0
block2 tool_use   3594/47360/0
block3 tool_use   3594/47360/309   ← 唯一带真实输出的一行
```

官方 Claude Code 每行都重复携带最终 output，取首行等于取最大，看不出问题；**ccmr 网关不写 `requestId`**（官方每行都写），dedup_key 退化成 `tool:msg.id`，四个分片塌成一行，"先到者胜"留下的正是 output=0 的首块。2026-09-16 实测当日丢掉 94.5% 的输出量。

因此 `store.insertEvent` 的去重语义是**"输出更大的后来者补齐该行"**而非纯 `INSERT OR IGNORE`：无冲突时行为不变，且能扛住分片跨增量扫描轮次落到不同批次的情况。不采用"跳过 `stop_reason == null`"，是因为那会新增一条静默丢弃路径——某个源一旦不写该字段就整源归零，正是下面 dsh 踩过的坑。

### Codex（坑最多）
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`：
- `token_count.info.total_token_usage` 是**会话累计值**，按相邻事件差分取单次用量
- **重复通知的判据两端统一为一条不变式："这一轮算不出用量就不落库"**（#75）。桌面端是落库前的
  `tokens.total() > 0`；Node 端此前看上游 `total_tokens` 的差分（`d.tt <= 0`），于是"只有
  reasoning / 只有 total_tokens 在动"的采样在 Node 端落一条五列全 0 的事件、桌面端一条不落，
  同一份日志两端事件数不同。`total()` 不含 reasoning，与 `store.insertEvent` 的落库公式同构
- **resume/fork 会话继承父线程累计基线**——若直接对"每文件终值"求和会把同一对话重复计数（实测差 9 倍），差分 + 首事件建基线天然正确
- **首个采样、累计值回落、以及缺 `total_token_usage` 的采样都不走差分**（#75）：只认
  `info.last_token_usage`（本轮真实用量）；它缺失时两端都**不记事件**，绝不退回整段累计值
  （修前桌面端退回整段累计值 → resume 会话重复计入，Node 端则把回落那一轮整条丢掉 → 少计）。
  缺 `total_token_usage` 但带 `last_token_usage` 的一条，修前 Node 端在入口 `if (!info?.total_token_usage) return`
  处**整条丢弃**、桌面端照记 —— 现在两端都记，且累计水位不动（读不到累计值就不能推进基线，
  否则下一条累计值会跟空基线比出"首个采样"、把整段历史当本轮用量计入）
- **`cache_creation_input_tokens` / `cache_write_input_tokens` 是同一个累计量的两个写法**，
  不是两个可以相加的量（#75）。规则明确为三条，两端同式
  （Node `collectors/codex.js::cacheWriteOf` ↔ 桌面端 `collectors.rs::cache_write_of`）：
  1. 只出一种 → 用它；两种都出且**数值相同** → 照用（只是重复写了一遍）。
  2. 两种都出且**数值不同** → 无法判定上游说的是哪个量，该条记录的 `cache_write` **拒读记 0**。
     旧规则 `.max()` 假设"同一 payload 只会出一种"，此前没有任何 fixture 证明过这个假设，
     而 `.max()` 等于凭空取一个上游从没说过的较大值。
  3. 相邻两条采样**各自都写了具体写法**而写法不同（codex 升级换了字段名）→ 跨写法差分必然为负、
     会被 `delta()` 的 `.max(0)` **静默清零**（那一轮的缓存写入就这么没了，也不报错），
     因此算"累计序列断了"，与回落同一条处理：改读本条的 `last_token_usage`。
     上一条"压根没写缓存字段"（或上一条因规则 2 被拒读）**不算序列断**：那条在序列上就是 0，
     字段第一次出现按普通差分读。
- `cached` 一律夹进 `[0, input]`，`input` 已含缓存命中
- 模型名版本漂移：新格式在 `thread_settings_applied.thread_settings.model`，旧格式在 `turn_context.payload.model`；续写文件两者皆无 → 按 `session_meta.parent_thread_id` 继承链回填（dedup 只防重插不更新旧行，需显式 UPDATE）
- `rate_limits` 为账号级配额快照（used_percent/window/resets_at），只保留全局最新（按 ts，与扫描顺序无关）
- 工具调用在 `response_item` 且 `payload.type` 为 `function_call` 或 `custom_tool_call`（name/call_id）；
  `custom_tool_call` 是新版 Codex 的 freeform 工具（apply_patch 一类），#85 起两端同记。
  上游没写 `call_id` 时按"当前 seq + 该 seq 内序号"定键（#85：只用 seq 会让两次采样之间的
  第二条调用与第一条共用 dedup_key，被 `INSERT OR IGNORE` 静默丢掉）
- `codex-auto-review` 是 Codex Desktop 内置自动审查子代理的模型槽位，真实用量

### ZCode
`~/.zcode/cli/db/db.sqlite`（WAL，可只读并发）：`model_usage` 表逐请求明细（rowid 水位增量；实测 computed_total=input+output 推得 input 含 cached）；`tool_usage` 表逐工具调用；`session.directory` 取项目名。**WAL 写入不改变主文件 mtime**——mtime 跳过判断对 sqlite 源无效，须每轮执行水位查询（微秒级）。

### dsh
`~/.dsh/sessions/**/session*.jsonl.zstd`（zstd 压缩，快照式：mtime 变化整体重解析 + dedup）。模型优先取记录自带的 `data.message.source.model`，回落顺序解析 `request/header.config.model`；cwd 在 `session` 记录。口径：input 不含缓存，reasoning 已含在 output 内，`total = input + cacheRead + cacheWrite + output`（v3 自带 `totalTokens`，实测 548/548 恒等）。

**两种记录结构并存，必须都认：**

| | 旧 `session.jsonl.zstd` | v3 `session.v3.jsonl.zstd` |
|---|---|---|
| 记录类型 | `assistant/chunk` + `chunk.type=='usage'` | `assistant/message` |
| usage 路径 | `data.chunk.usage` | `data.usage` |
| 字段名 | `inputTokens` / `cacheReadTokens` 等 | 不变 |

2026-08-14 dsh 切到 v3，采集器当时只认旧结构，于是**打开文件、一条也匹配不上、返回 0 且不抛错**，整源静默归零一个月（全库停在 165 条，而那之后单日就有 548 次请求 / 5,960 万 tokens）。文件发现一直是按 `.zstd` 通配的，所以表面上"扫到了文件"——没有任何一层会为"解析出 0 条"报警，这是它能瞒一个月的原因。

会话键用父目录名。迁移期新旧两个快照会并存于同一目录，因此 **v3 的 dedup_key 额外带上文件名**（`dsh:${fileId}:${file}:${seq}`），否则 seq 相同的两条互相顶掉；旧结构的键保持原样，避免历史事件在重扫时被当成新行再插一遍。

`session` 记录的 `cwd` 是绝对路径，**项目名取末段**（`path.win32.basename(cwd) || cwd`，桌面端 `project_name()` 同式）。记录的 `time` **粒度不总是毫秒**：秒级值必须经 `epochMs()` 归一（#85，与 WorkBuddy、Grok 和桌面端 `collectors.rs::timestamp()` 共用同一个 1e11 边界），否则整份快照在两个 UI 里的当日/区间合计完全不同——归一前它会落到 1970 年，Node 面板里根本没有这条事件。dsh `version` 3→4。

### WorkBuddy
`~/.WorkBuddy/projects/<目录>/<会话>.jsonl`（Electron 版 transcript）：`message.usage`（input 含 cache，
`total = input + cache_write + output`）；`providerData` 携带真实模型名（sessions 表的 model 列只是别名如 fast-model）与 traceId。
- **目录名是 `<前缀>-WorkBuddy-<项目>`**：项目名取标记之后那一段（`-WorkBuddy-(.+)$`），整名当项目名
  会让同一个仓库在两个 UI 里是两个名字（#85）
- `timestamp` 粒度不总是毫秒：秒级记录必须经 `epochMs()` 归一，否则落到 1970-01-21，Node 面板的
  "今日/本周"里根本没有它（#85；此前这里直接用原值，桌面端一直在归一）
- `cache_write` / `reasoning` 与 codex 一样有两种字段拼写（`cache_creation_input_tokens` /
  `cache_write_input_tokens`、`reasoning_output_tokens`），取 max＝有哪个读哪个；#85 之前 Node 端把
  这两列写死成 0，与桌面端逐字段对账永远对不上
- `rec.id` 缺失的行两端都不入库（没有稳定 dedup_key 的行在全量重扫时会变成重复计数）
- `workbuddy.db.session_usage` 是上下文水位表（used=最近请求 input_tokens，非累计）
- `credit_json` 键 = 轮次 traceId、值 = 该轮积分消耗 → 与事件表按 trace_id 连接可**经验性标定积分费率**（纯单模型轮次无截距最小二乘，实测残差≈两位小数舍入）；混合轮次与 <3 样本不参与
- SQLite 为 WAL 写入，transcript 与水位表同秒落盘

### Grok Build
`~/.grok/sessions/<URL编码项目目录>/<会话id>/updates.jsonl`：`turn_completed.usage` 带全量明细（含 cachedRead/reasoning/modelCalls/costUsdTicks 厂商成本刻度）与 `modelUsage` 逐模型拆分；timestamp 为 Unix 秒（#85 起秒/毫秒归一走 `collectors/tokens.js` 的 `epochMs()`，与 dsh/WorkBuddy 和桌面端 `collectors.rs::timestamp()` 共用同一个 1e11 边界，并认 ISO 字符串；此前这里自己写了一份、边界是 1e12）。工具调用在 `tool_call` 事件（title/kind）。注意 `_meta.totalTokens` 是会话上下文水位而非轮次用量，勿用。

**`grok:live` 是 Node 端独有的快照**：进行中的轮次把 `_meta.totalTokens` 最大值写成
`saveQuota('grok:live', ts, {context_tokens, session_id, project})`，供 `web/app.js` 的
"Grok 进行中"卡片显示。桌面端没有消费这个水位的界面，因此也没有对偶实现——这一条是
**已知缺口而不是漏看**，详见上一节的第 9 行。

### Pi
`~/.pi/agent/sessions/<编码cwd>/<ISO时间>_<会话uuid>.jsonl`，追加式。用量在 `type=message` 的
`message.usage`（input/output/cacheRead/cacheWrite/reasoning + **逐项 USD 成本**），工具调用在
assistant 内容的 `toolCall` 块。
- **project 只能取首行 `type=session` 的 `cwd`**：目录名把 `/` 换成了 `-`（`--Users-x-Vibing-daily-test--`），
  `daily-test` 与 `daily/test` 编码后同形，无法反推。而增量扫描从字节游标往后读、读不到首行，
  所以 project 必须随 collector state 落库带过后续轮次，否则续写的事件会是 `project=null`（静默）
- 会话 id 取文件名 `_` 之后的 uuid（实测与 session 记录的 id 一致），去重键为 `pi:<会话>:<记录id>`；
  记录 id 只有 8 位十六进制，**不带会话前缀会在数万条量级上生日碰撞**
- 模型名保留厂商原样：openrouter 通路是 `deepseek/deepseek-v4-flash-0731`，与直连的 `deepseek-v4-flash`
  是不同价格的不同路由，**不做前缀剥离合并**
- 用量全 0 的记录（空调用/中断）按 `total <= 0` 跳过，与 Grok/ZCode 一致

### OpenCode
`opencode.db`（SQLite + WAL）。库位置随 XDG 走——`$XDG_DATA_HOME` 或 `~/.local/share`，
Windows 下 `%LOCALAPPDATA%`（取自其可执行体内的字符串常量），三个候选全登记、不存在的跳过。
- 一条 assistant `message` = 一次 API 调用，用量在 `data` 列 JSON 的 `tokens`
  （实测 session 表的 `tokens_*` 聚合列恰等于各 message 之和，故 message 级不重不漏）；
  user 消息没有 `tokens`，须跳过而不是记成 0 用量事件
- 工具调用在 `part` 表 `data.type='tool'`（`tool` 为名、`callID` 去重）
- **message 按 `time_updated` 水位增量，不能按 rowid**：assistant 消息是"先插后改"——开始生成
  就插入一行（`tokens` 全 0），生成结束才原地 `UPDATE` 写入用量并刷新 `time_updated`（实测
  1.18.31，每条消息恰一个 `step-finish`，用量只写这一次）。服务监听 `-wal`，生成过程中的写入
  本身就会触发扫描，扫描几乎总落在"已插入、未完成"的窗口里：0 用量被跳过、rowid 水位却越过了它，
  完成后的更新再也读不到。1.4.2 及以前因此漏掉约八成 OpenCode 消息。按 `time_updated` 增量也
  顺带免疫了下面的 rowid 复用问题。水位每轮回看 60 秒：同库可能有多个写入方（并行子 agent、
  多开），时间戳较小的行可能晚提交
- **part 仍按 rowid 水位**：工具块插入时已带 `tool` 名，后续更新不影响采集。但 `part` 随
  `message` `ON DELETE CASCADE`，session 还带 `revert` 列——删掉最大 rowid 后 SQLite 会把该号
  让给下一条插入，新行的 rowid 就可能不大于水位而被静默跳过。故每轮先比 `MAX(rowid)`：表变短
  即说明删过行，水位退回 0 整表重读（dedup 幂等）。残留边界：若"删行"与"插新行"之间一次扫描
  都没发生，缩短信号会被错过，需靠该源 manifest（`src/sources/<slug>.js`）的 `version` 自增触发全量重扫补回
- ZCode 的 `model_usage` 只追加、不改行，rowid 水位够用——同为 sqlite 源也不能照抄增量策略，
  先确认那张表会不会删行、会不会原地更新

## 模型名归一：同一模型在两端、跨来源都只能有一行

模型标识是**大小写不敏感**的厂商 id：ZCode 记 `GLM-5.3-Flash`、WorkBuddy 记 `glm-5.3-flash`，
是同一个模型。因此归一（去首尾空白 + 小写）必须在**采集侧、落库之前**做完——价表键全小写
且两端的价格查找都是精确匹配，名字没归一就是静默不计费，面板里还会被拆成两行。

- Node：`src/models.js normalizeModel()`，10 个采集器与 `store.js` 启动期 `migrate()`（把历史
  大小写变体折进同一行）共用它
- 桌面：`desktop/src-tauri/src/model.rs normalize_model()`，`collectors.rs` 五个产事件的位置
  （JSONL / zcode / opencode / antigravity）全部走它；价表侧 `pricing.rs::parse` 对 models 与
  aliases 的键同样归一（配置写成 `"GLM-5.3-Flash"` 也能命中，不再需要手工补大小写别名），
  历史缓存由 `db.rs COLLECTOR_REVISION = 7` 整库重建
- **两处刻意不同**：① 模型名缺失时 Node 落 `NULL`（列可空），桌面落哨兵 `unknown`
  （`Event.model` 是 `String`、列 `NOT NULL`），两边各自只有一行，不参与任何黄金数；
  ② 别名路由（`deepseek-flash` 一类"这个 id 该按哪个键计费"）不在词法规则里——Node 那张表
  在 `models.js`，桌面那张在 `prices.json` 的 `aliases`，两端各自的价目表键不同，甚至对同一对
  id 路由方向相反，合并任何一侧都会让另一侧不计费
- 双端共享的黄金数（同一份记录、同一组期望）：`test/run.mjs` 的 [26] 段与
  `desktop/src-tauri/src/collectors.rs`、`desktop/src-tauri/tests/sources.rs` 的 #78 块，
  合并行 `glm-5.3-flash` = input 301200 / cached 1240000 / cache_write 60000 / output 140000
  = 1741200 token

## 桌面端 ↔ Node 端采集口径对账（#85）

同一份日志在两个 UI 里必须给出同一组数字。桌面端（`desktop/src-tauri/src/collectors.rs`）
与 Node 端（`src/collectors/*.js`）是两份独立实现，历史上漂了十处。逐条给结论：
**要么两边改到同一条规则，要么把差异写在这里**——"没文档的悄悄分叉"本身就是缺陷。
下面 1-10 是任务里点名的十处，11-13 是同一轮里顺带改到、以及**与本仓库另一条分支
互相矛盾**的三处口径（同样三选一：对齐 / 记为有意差异 / 说明为何不改），
本表因此对全部十三项给出可核对的结论。
共享夹具的两侧对应关系：`test/run.mjs` 的 [28] 段 ↔
`collectors.rs` 的 `project_model_and_tool_identity_match_node_on_one_fixture` 与
`tool_record_gate_and_line_identity_and_malformed_ts`；
`tests/sources.rs` 的 `antigravity_decoder_branches_and_project_match_node` ↔
`test/sources/antigravity/antigravity.test.mjs`；
`test/fixtures/codex-parity/rollout.jsonl` ↔
`compare_local_golden_is_what_the_desktop_collector_produces`（Rust 侧逐字段钉黄金）+
`node desktop/scripts/compare-local.mjs --fixture`（Node 侧现场跑 `collectCodexFile`）。

| # | 漂移 | 结论 |
|---|---|---|
| 1 | codex 工具活动：桌面端只看 `payload.type`，Node 端还要求 `rec.type === 'response_item'` | **已对齐（取更严的一边）**：桌面端补记录级门槛（`event_msg` 里的回放不再数第二遍）。`custom_tool_call` 是新版 Codex 的 freeform 工具（apply_patch 一类），是真实工具调用，所以补的是 Node 端那一边——桌面端此前只多在这一项上，砍掉它等于两端一起少记。codex `version` 4→5 |
| 2 | project 分组键：七个源里桌面端存整条绝对路径/原始目录名，Node 端存末段或剥掉前缀 | **已对齐**：桌面端新增 `project_name()`＝Node 的 `path.win32.basename(x) \|\| x`（`/`与`\`都是分隔符、先剥尾分隔符、无分隔符时剥 `C:` 设备前缀；刻意不用 `Path`，因为本仓库日志里两种分隔符并存，采集端必须在任何宿主上给出同一个答案）。覆盖 claude/ccmr、pi、codex、grok、opencode、zcode、antigravity、workbuddy（`<前缀>-WorkBuddy-<项目>` 取标记之后那段） |
| 3 | antigravity `workspace_uris`：桌面端只取 `v[0]`、不判 scheme、POSIX 分支丢掉根斜杠 | **已对齐**：桌面端新增 `project_from_workspace_uris()`，扫到第一个 `file://` 项才用，坏项跳过继续找下一个，percent 解码后取末段；`file:///D:/x` 只剥 Windows 多出来的那个前导斜杠，`file:///etc/x` 的根斜杠保留 |
| 4 | claude：桌面端把空模型记成 `unknown` 入库，`msg.id` 缺失时造合成键入库 | **已对齐**：`message.usage` 不是对象、或 `message.id` 缺失 → 整行不入库（与 Node 的 `if (!usage \|\| !msg?.id) return; if (!model \|\| model === '<synthetic>') return;` 同序同式，关卡都排在内容块扫描之前，所以工具调用同样不记）。同一类修正顺带补到 workbuddy（`rec.id`）与 pi（`rec.id ?? message.responseId`）：编不出稳定去重键的行**宁可少一条也不能多一条**，合成键在全量重扫时会变成重复计数 |
| 5 | 空 tool id：桌面端 `{session}:{id}` 里 id 为空时同会话的无名调用全塌成一个键互相顶掉 | **已对齐**：`tool()` 统一在 id 为空时按 `line:{行号}` 定位（Node 端各源本来就分别回落到行号/块序号/记录 id，从不产生空键）。codex 的 Node 端也补了对称缺陷：无 `call_id` 时此前只用 `st.seq` 定键，而 seq 只在 token_count 上自增，两次采样之间的第二条 `function_call` 会被 `INSERT OR IGNORE` 静默丢掉；现在同 seq 内的第二条起带 `:{序号}` 后缀，**首条仍沿用裸 seq 的原键**，存量行不位移 |
| 6 | opencode 工具调用时间：桌面端用 `part.time_created`，Node 端优先 `data.state.time.start` | **已对齐**：桌面端改成 `state.time.start` 优先、缺失才退回列上的 `time_created`；两处都读不到时计 malformed |
| 7 | antigravity 输出/时间/零用量三分支 + steps 读失败 | **已对齐**（`read_antigravity` 与 `decodeGenerationRow` 同式）：output 三分支——`f3>0` 用 `f3`，否则 `f10` 在场用 `f10+f9`，否则只剩 `f9`（旧写法用"字段在不在"判断，于是 `f3=0` 在桌面端记 0 输出）；时间**行内值优先**、缺失才回退同 idx 的 steps 时间（旧写法取 max，steps 一行覆盖多次生成，会把事件推到比真实完成时刻更晚的位置）；零用量判据 `input/output/cacheRead 全 0 → 丢` 补到桌面端。**steps 读失败两侧走不同通道但保证同一件事**：Node 端扣住水位不越过未采样的生成（#95），桌面端整份结果判失败、保留缓存里已有的行（`collect_file` 不会用读不全的结果替换缓存）——都是"读不到时间的那些生成不会永久丢失"，故不算漂移 |
| 8 | workbuddy：Node 端把 `cache_write`/`reasoning` 写死 0，且不归一秒级时间戳 | **已对齐（补 Node 端）**：`cache_creation_input_tokens`/`cache_write_input_tokens` 走与 codex **同一处** `tokens.js::cacheWriteOf`（#75 统一规则：只出一种用一种、两种相等照用、两种不等拒读记 0；桌面端 workbuddy 分支调用的 `openai()` 里就是同一条 `cache_write_of`）、`reasoning_output_tokens` 读出来、缓存命中同样认 `cached_input_tokens` 别名；请求数关卡统一到 `total <= 0`（此前只带缓存写入的一轮在 Node 端被丢、桌面端记）。秒级 `timestamp` 归一为毫秒（此前落到 1970-01-21，Node 面板的"今日/本周"里根本没有它）。workbuddy `version` 1→2 |
| 9 | grok：Node 端有进行中轮次的上下文水位快照（`saveQuota('grok:live')`），桌面端没有 | **有意保留，不在本轮补齐**：桌面端 GUI 没有任何消费这个水位的界面（`web/app.js` 的"Grok 进行中"卡片只存在于 Node 版面板里），要"对齐"就得连 UI 一起做，那不是采集口径修复而是新功能。桌面端的 `quota` 表与 `Parsed.quotas` 通道是通的（codex rate_limits 就走这条路），需要时按 `_meta.totalTokens → Quota{agent:"grok:live"}` 加即可。这一行的意义是让下一个读代码的人知道这是**已知缺口**而不是漏看 |
| 10 | `scanner.rs` 的 `seen` 去重一律 `to_lowercase()` | **已改成按平台**：Windows 路径大小写不敏感，不归一会把同一份日志采两遍（`raw_events` 主键含 path，两份都留下）；POSIX 恰好相反，`/logs/A.jsonl` 与 `/logs/a.jsonl` 是两个文件，一律 lowercase 会让后者被当成重复**静默跳过**——少一份用量且零错误。抽成 `dedup_key()`（`scanner.rs:65-72`），`to_lowercase()` 只编进 Windows 构建，非 Windows 构建原样返回 |
| 11 | 会话回放（`session_replay.rs::normalize_raw_usage`）读不到 `cache_write`：三处读者各抄一份字段名，回放那一份两种写法都不读（#75 第 3 项点名的"至多一个正确"） | **已对齐（规则只留一份）**：三个读者调同一个实现——事件缓存 `collectors.rs::openai()`、legacy `codex.js` 经 `src/collectors/tokens.js::cacheWriteOf`、回放 `normalize_raw_usage` 直接调 `collectors::cache_write_of`；没有第四份抄本，`spelling_changed`（累计序列换了写法）也只在两处按同一条判据实现。**回放的 `ModelUsage` 没有独立 cacheWrite 列，缓存写入只并进 `total_tokens`——判定：可接受，不改类型**。理由：`raw_usage.total_tokens = input + cache_write + output`（`session_replay.rs:1734/1761` 两个构造点都是这个式子），而 `input` 是上游原值（OpenAI 口径已含缓存命中），所以它和事件缓存那条 `Tokens::total() = 新输入 + 缓存命中 + cache_write + 输出` **恒等同一个数**；回放面板也不按列计价（`cost_usd` 取自日报行 `session_replay.rs:262/1061`，不由 `ModelUsage` 现算），并进 total 只少一个展示位、不产生数字分歧。给 `ModelUsage` 加字段要连动前端与日报 `models` 的键值结构，那是展示层需求而不是口径修复。**触发重开的条件写在这里**：回放一旦要单列缓存写入、或改成按列计价，这一格立即失效 |
| 12 | **跨分支矛盾**：`codex/fix-desktop-data`@6b91d98 的十源平价探针（`desktop/scripts/compare-local.mjs` 的 `DIVERGENCES.codex`）把 codex 记成量化分歧 **−1 事件 / −120 tokens / −80 cached**，理由是"Node 侧每条会话第一次 `token_count` 只建累计基线不产事件（`codex.js:149`）"；而 #75 第 1 项声称首样本已对齐 | **那条登记已经过期，删掉它——两端现在都产这一条事件，差值恒为 0**。`codex.js:149` 那一行（`if (!st.cum) { st.cum = cur; return; }`）在 `f6ed418` 里已经不是首样本的处理了：现在 Node 在"无基线/累计回落/换写法"三种情况下都改读 `info.last_token_usage` 并 `insertEvent`（键 `codex:{file}:{ts 之前}:baseline:{ts}`），与桌面端 `collectors.rs` 的 `previous.is_none() \|\| reset \|\| spelling_changed` 分支同式同落库。**谁是对的**：#75（本分支）——探针的差值是在 #75 之前的 Node 形状上量出来的，两个结论不是互相推翻，是同一件事的前后两版。**数字为什么正好是 −1/−120/−80**：那份夹具只有两条采样（`last_token_usage` = input 100 含 cached 80、output 20 → 拆列 20+80+0+20 = **120**、cached **80**；第二条累计值没变 = 重复通知，两端都不落），修前这边 0 条、桌面 1 条。**怎么保证不再回来**：同一份四条记录被两端各自钉住——Rust `collectors.rs::codex_first_sample_no_longer_diverges_from_node_parity_probe`（1 事件 / 120 / 80 / 新输入 20）与 Node `test/run.mjs` 的"跨分支对账"块（同三个数），加上既有的 `compare_local_golden_is_what_the_desktop_collector_produces` + `node desktop/scripts/compare-local.mjs --fixture`（6 事件 / 2358000 / 1250000，`equal:true`，负对照会变红）。合并那条分支时 `DIVERGENCES.codex` 必须删除：它自己的注释就写着"哪天 Node 修了首事件，这条登记就会红，逼着删掉它"——现在就是那天 |
| 13 | 非法时间字符串：一端读不出来就静默 `continue`，面板一切正常、只是少数据（"静默归零"的姊妹形态） | **已对齐到"带用量的行读不到时间就计 malformed"**：`collectors.rs:305-324` 在 `timestamp()` 三路取值全失败时判断该行是否携带用量（`message.usage` / codex `token_count` / grok `params.update.usage` / dsh `data.usage` / dsh 旧结构 `data.chunk.usage` 五种形态），带用量才 `malformed_lines += 1`，来源健康因此停在 warning；结构性没有时间的行（`session_meta`/`turn_context`/`type:"session"`）**不**算坏行——那是它们本来的样子，报坏就是噪声。秒级时间戳的归一与阈值两端共用（Node `tokens.js:39` 的 `toMs()` 用 1e11 边界，桌面 `collectors.rs:7-21` 的 `timestamp()` 同一条；dsh/workbuddy 都改走它），秒值不会再落到 1970-01-21 从"今日/本周"里消失。**回归**：桌面侧 `collectors.rs::tool_record_gate_and_line_identity_and_malformed_ts` 用 `"timestamp":"not-a-time"` 钉 `malformed_lines == 1`；Node 侧对应 `test/run.mjs` 的 workbuddy 秒级归一断言 |

**两处结构性差异，属"做不到也不该做"，登记为有意保留**：

- **逐行 malformed 信号**：桌面端有 `Parsed.malformed_lines`（来源健康因此能停 warning），
  Node 端只有文件级 `parse_errors`——collector 返回的是 `{newOffset, inserted, state}`，
  没有逐行坏计数的通道。所以上面第 4/6 条里"读不到时间的行计 malformed"只落在桌面端；
  Node 端同一行是静默 `return`。**丢的行数两端一致，差的是它有没有被数出来**。
- **`project` 的缺失形态**：Node 落 `NULL`（列可空），桌面落空串（`Event.project` 是
  `String`、列 `NOT NULL`），与 #78 的模型名哨兵 `unknown` 是同一条约定的两个实例。

## 计价：DeepSeek 的峰谷价

单价表 `~/.tokenmonitor/pricing.json` 记的是**峰时价**，`off_peak` 为谷时折扣系数（DeepSeek 为 0.5）。

峰时的官方定义（api-docs.deepseek.com/quick_start/pricing，2026-09-16 核对）是 **UTC 周一至周五 01:00-04:00 与 06:00-10:00**，其余一切时段按谷时价。三处反直觉，实现时都踩得到：

- 按 **UTC** 而非本地时区（按"北京时间半夜打折"去猜会大面积算错）
- **整个周末**都是谷时，哪怕落在窗口时刻上
- 两段峰时之间 **04:00-06:00 是空档**，属谷时

判定以 `PEAK_SQL` 片段落地而非 JS 函数，让分组与计价共用同一份定义；费用卡、按天堆叠图、余额对账三处聚合都带上它。金额表达式同样只有一份——`pricedCostCny(priceOf 的单价, {fi,ci,cw,oi}, peak)`（#74：此前费用卡与余额对账各写一份，而对账那一份漏了 `cache_write` 项，两边算的不是同一件事；`pricing.js` 里另有一个零调用、字段名早已过时的 `modelCostCny` 副本，已删除，防止再被照抄）。`off_peak` 缺失时回落种子表——老用户的 `pricing.json` 里没有这个字段，若实现成"缺失即不打折"，这个规则对他们就是个静默空操作。

## 关键机制

- **增量三策略**：jsonl 字节游标（只推进到完整行尾，写入中的半行下次重读；UTF-8 跨块安全）/ sqlite 水位（只追加的表用 rowid，会原地更新的表用 `time_updated`）/ zst 快照重解析
- **dedup 幂等**：所有事件带全局唯一 dedup_key，重复解析 INSERT OR IGNORE
- **采集器版本号**：来源 manifest 的 `version` 与 `files.state_json._v` 不符 → 自动全量重扫回填（用于采集逻辑升级，如新增工具调用提取）
- **常驻进程版本戳**：collector 必须把 `_v` 写进 state，否则常驻服务每轮全量重扫（真实踩坑）
- **健康自检**：解析错误（红）/ 文件 30 分钟内在写但无新事件（黄，格式漂移静默失败信号）/ 无数据（灰）
- **配置读侧兼容（#113）**：`settings.json` 的未知键**不报错、不致命**——它们被收进 `Settings::unknown`（`#[serde(flatten)]`），行为上忽略、`unknown_keys()` 列得出来、保存时原样带回，因此「新版写入字段 → 降级运行旧版 → 再升回来」不会丢用户写的东西。控制通道（`service::rpc`）在配置文件读不动时按「文件端口 > 本进程上次成功端口 > 内置默认端口」退回并继续连接，原因写进服务日志；错误信息一律带完整文件路径，并在失败时列出「当前顶层键：port=字符串 …」，因为 serde 只给行列不给字段名。**新增字段时的策略**：只加可选字段（`#[serde(default)]` 或带默认值），不要重新引入 `deny_unknown_fields`，也不要把 `settings()` 变成任何控制路径的前置硬条件。

## 已验证的对账方法

每源接入后用独立脚本（Python/独立 SQL）对原始文件重算比对，全部精确一致。Codex 的正确口径经"官方面板累计值 vs 本地差分值"交叉验证（差值为官方跨设备统计）。WorkBuddy 积分费率经最小二乘残差验证。

## Antigravity / antigravity-cli：一次"否定结论"被实现推翻的完整记录（2026-09）

> **状态更正（#90）**：本节原标题与正文的结论——"**当前不可接入**"——**已被实现推翻**。
> Antigravity 现在是已发货的第 10 个来源：`src/sources/antigravity.js` +
> `src/collectors/antigravity.js` + [sources/antigravity.md](./sources/antigravity.md) +
> `test/sources/antigravity/antigravity.test.mjs`（39 项断言；另对本机 23 个真实会话库 /
> 6520 行 `gen_metadata` 实跑：首轮 6460 事件入库、23 行零用量或无时间戳跳过、重扫 0 重复）。
> 原始调研全文保留在下面，因为它记录的是一次**方法上正确、推论上错误**的判定——删掉只会丢掉教训。

Google Antigravity（IDE，`com.google.antigravity` 2.3.1）与 antigravity-cli 都在本机留了数据，
但**逐请求 token 用量没有以任何可解析的形式落地**。逐项证据：

| 位置 | 形态 | 有无用量 |
|---|---|---|
| `~/.gemini/antigravity-cli/conversation_summaries.db` | SQLite，1 张表 | 无。只有 title / step_count / workspace_uris / status 等元数据 |
| `~/.gemini/antigravity-cli/conversations/*.db` | SQLite，per-conversation | `steps`、`gen_metadata` 表存在但为空；载荷列是 protobuf blob |
| `~/.gemini/antigravity-cli/conversations/*.pb` | 二进制，768KB–1.2MB | **熵 8.00 bit/byte、可打印占比 37%、文件头各不相同且无压缩魔数**（非 gzip/zstd/zlib/brotli）→ 加密，非明文 protobuf。密钥在系统钥匙串（日志里有 `keyring.go`） |
| `~/.gemini/*/brain/**/transcript.jsonl` | 可读 JSONL | 无。1628 条记录、112 个键路径里**没有一个**匹配 token/usage/cost/billing；唯一数值叶子是 `step_index` |
| `~/.gemini/*/antigravity_state.pbtxt` | 文本 protobuf | 无。相关字段只有 `last_selected_agent_model` |
| `~/Library/Application Support/Antigravity` | Electron 目录 | 无。`app_storage.json` 为空，Local Storage 里无 token 字样 |

transcript.jsonl 的顶层键是 `step_index / source / type / status / created_at / content /
tool_calls / thinking`——有完整的对话与工具调用，唯独没有 usage。直接 grep 到的 "token"
字样全部来自对话正文（本仓库本身就在讨论 token），不是字段名。

**留一个重要的保留**：实测机器的 CLI 日志反复出现 `You are not logged into Antigravity`，
会话表因此为空；5 月那批 `.pb` 确实是登录期的真实使用，但已加密。所以不能排除
"登录且活跃使用的装机会把用量写到别处"。要复核，在真正用过之后重跑调研：按上表逐个位置
确认，重点看 `conversations/*.db` 的 `gen_metadata`（列名 `data`/`size`，最像放生成元数据的地方）
是否开始有行。

**上面那张表错在哪一格**：`conversations/*.db` 那行写的是"表存在但为空"——这句话本身是对的，
错在把它读成了"这张表没有用量"。**空表 ≠ 无 schema**：表与列都在、行数为 0，只说明那台机器没登录；
而同一格的"载荷列是 protobuf blob"其实已经指到了答案上——`gen_metadata.data` 是**未加密的**
protobuf 裸格式，逐行一次 LLM 生成，token 明细就在里面。`.pb` 文件加密是真的，
"因此整源无可解析用量"的推论是错的：用量根本不在 `.pb` 里。当年那句"保留"里指明的复核入口
（看 `gen_metadata` 是否开始有行）就是后来落地这个来源时真正走通的路径。

结论修正为：**"不可接入"必须是带范围的判定（哪个数据面、哪台机器、什么状态下不可接入），
不能是源级别的永久判决**——只要还有一个可解析的数据面没被排除干净，就不能写"整源不可接"。
而"不得猜字段"这条纪律本身没有被推翻，它现在仍在生效：Antigravity 的 `steps` 表确有工具调用痕迹，
但其编码未经独立验证，所以工具调用至今**不解析**，作为已知 unsupported 记录在
[sources/antigravity.md](./sources/antigravity.md)。写一个靠猜字段凑出来的采集器，只会做出一个
永远报 0 却在健康面板显示"正常"的数据源，比不接更有害。

## 不可统计的边界

网页版聊天（ChatGPT/豆包/DeepSeek 网页、Grok Bot 等 Electron 薄壳）：token 计数在服务端，浏览器本地零留痕（实测 IndexedDB 无 usage 字段），且无公开用量 API。除非厂商开放 API 或用户接受浏览器扩展拦截（高维护成本、随改版失效），否则不可覆盖。


## ECharts calendar + custom series 的三个坑（实踩记录，2026-09）

在"GitHub 风格正方形热力图"上连续翻车的根因，贡献者改热力图前必读：

1. **`renderItem` 返回 `roundRect` 会抛空错误**（消息为空字符串，且被 ECharts 吞掉，
   图表整片空白、无 console 线索）——此构建只支持 `rect`；
2. **calendar 同时给定 `top` 与 `bottom` 时，`cellSize` 高度被归一为 `auto`**，
   行距 = 可用高度 ÷ 行数。容器高度必须精确等于 `top + 7×cell + bottom`，
   多 1px 都会被摊进行距导致栅格不对称（同理 `left`+`right` 会拉宽格子）；
3. **custom series 元素的鼠标命中检测不可靠**：`dispatchAction showTip` 正常但真实
   mousemove 不触发。解决：容器监听 mousemove + `convertFromPixel` 反查日期 +
   半格命中校验的自管理 tooltip（见 `bindHeatTooltip`）；
4. **line series 渲染不确定**（同配置时有时无，bar 的生长动画同样会挂起不落帧）——
   逐日密度曲线最终改为**纯 Canvas 手绘**（贝塞尔平滑 + 渐变填充 + 自管理悬停），
   行为完全确定。前端图表遇到玄学空白时优先考虑自绘。

相关回归防护：`test/run.mjs` 的静态断言层（safe() 调用的函数必须存在、DOM id 一致性）
与端到端冒烟层（fixtures 黄金数字、幂等、API 结构）。历史事故：误删 renderLive 导致
整页空白、roundRect 导致热力图消失——均已由测试覆盖。
