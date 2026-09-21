# 贡献指南

感谢关注 TokenMonitor！这是一个本地多源 AI Agent 用量统计工具，最容易也最有价值的贡献方向是**接入新的数据源**。

## 添加一个新数据源

前提：该工具在本机留有含 token 用量的本地记录（transcript/数据库）。网页版应用（服务端计数的）无法接入。

0. **先做可行性判定**：逐请求用量必须以**可解析**的形式落地。找不到就不要接——一个靠猜字段写出来的
   采集器会变成"永远报 0 却在健康面板显示正常"的假数据源，比不接更有害。
   判定要**可复核**：Antigravity 在 2026-09 一度被判"载荷加密、不可接入"（`conversations/*.pb`
   熵 8.00、非任何压缩魔数），后来在同一数据面的 **SQLite `gen_metadata.data`（protobuf 裸格式）**
   里找到了可解析的逐请求用量，如今是已发货的第 10 个来源（[docs/sources/antigravity.md](docs/sources/antigravity.md)）。
   教训不是"Antigravity 不能接"，而是**一次调研的否定结论必须写清证据范围并留复核入口**——
   加密的 `.pb` 是真的，"因此整源无可解析用量"的推论是错的。

1. **调研格式**：找到数据文件，确认 usage 字段位置、口径（input 是否含缓存、reasoning 是否已含在 output 内）、
   模型名字段、时间戳格式与单位。口径结论要用原始数据验证，例如逐条核对
   `total == input + cacheRead + cacheWrite + output` 是否成立
2. **写来源 manifest**（`src/sources/<slug>.js`，`<slug>` 就是注册键 / `tool` 名）：

```js
export default {
  tool: '<slug>', label: '展示名', kind: 'jsonl' | 'sqlite' | 'zst',
  version: 1, collector: '<collector-id>', order: 10, apiBilled: false,
  roots(ctx) { return [join(ctx.homedir, '.<slug>', 'sessions')]; },
};
```

   要点：路径一律从 `ctx.homedir` / `ctx.localAppData` / `ctx.appData` / `ctx.xdgDataHome` 拼，
   **禁止写死盘符或用户名**（注册表测试会拦）；`kind: 'sqlite'` 的 root 必须是**单个库文件**
   （scanner 对它直接 stat），会话库随性增减时以索引库之类的稳定文件作锚点。

3. **写 collector**（`src/collectors/<slug>.js`），实现统一接口：

```js
export async function collectXxxFile(store, { tool, path, fileId, offset, state, version }) {
  // 返回 { newOffset, inserted, state }
  // 事件：store.insertEvent({ ts, tool, model, session_id, project,
  //   input_tokens, cached_input, cache_write, output_tokens, reasoning_tokens,
  //   total_tokens, dedup_key })
  // 工具调用：store.insertToolCall({ ts, tool, name, session_id, dedup_key })
}
```

   要点：模型名过 `normalizeModel()`；`dedup_key` 全局唯一且重放幂等；若用 state 保存跨次解析状态，**必须写入 `_v = version`**（否则常驻服务每轮全量重扫）

4. **注册＝什么都不用改**。加载由中心注册器 [src/source-registry.js](src/source-registry.js) 完成：它按目录枚举
   `src/sources/*.js`（跳过 `contract.js`），逐个 `validateManifest` → 解析 roots → 按 `collector` 字段
   动态 import `src/collectors/<collector>.js`，非法/抛错的 manifest 只记进 `SOURCE_ERRORS`，不让进程崩。
   [src/config.js](src/config.js) 里没有 `SOURCES` 数组，只有 `export { SOURCES, SOURCE_ERRORS } from './source-registry.js'`。
   ⚠️ **旧版本文档曾教"在 `src/config.js` 的 `SOURCES` 里登记"——照做会得到一个没有任何人加载的采集器**：
   `config.js` 里根本没有这个数组，你以为加了，面板上永远是零，而且不报错。这段已经改过来了。

5. **前端登记（可选）**：新来源会自动拿到 `/api/sources` 元数据 + `web/lib/sources.js` 的确定性回退色
   与 label（#16），零改动即可显示。只有想要**品牌色**时才在 `web/lib/theme.js` 的
   `TOOL_COLORS`/`TOOL_LABEL` 登记并在 `web/style.css` 加 badge 配色；配色别凭眼挑，新色要在深色底上与
   既有各色算 CIEDE2000（含红盲/绿盲模拟），标准是**加入后全集的最差配对不比现状更差**。
   内建 9 源必须有色有标签（`test/run.mjs` 有断言会拦），新来源不强制——否则每加一个源都得改 `theme.js`，
   与"新来源只带自己的文件"的边界冲突。（健康列表不用管，它从 `SOURCES` 推导。）
6. **补测试**（`test/sources/<slug>/<slug>.test.mjs`，一个能独立跑、能独立红的文件）：
   ```
   TOKENMONITOR_OFFLINE=1 node test/sources/<slug>/<slug>.test.mjs
   ```
   该目录下的 `*.test.mjs` 由 [test/run.mjs](test/run.mjs) **自动发现并逐个执行**（#67），新增文件不需要改任何
   运行器；漏接线会被"孤儿测试守卫"直接判红。fixture 全部运行时合成（不落真实数据），断言黄金数字、
   dedup 幂等、project 归属、增量/续写、锁占用降级。跨源共同的端到端黄金数字仍可加进 `test/run.mjs` 的
   `[3]` fixtures 段。判断测试是否够格的办法是把实现改坏一行，看它会不会变红——不会变红的测试等于没写。
7. **对账**：写独立脚本（Python 等）直接重算原始文件，与 `tokenmonitor scan` 后的库内数字精确比对，
   把结果贴进 PR。数量对不上要能解释清楚（例如全 0 用量的空调用被 `total <= 0` 跳过）

## 采集逻辑升级（已有源）

改完 collector 后把 `src/sources/<slug>.js` 里对应源的 `version` +1——版本机制会自动对存量文件全量重扫回填（dedup 保证幂等）。

### 上游换了格式：最隐蔽的一类故障

采集器**不会**因为解析不出东西而报错。上游改了记录类型或字段路径，表现是"扫描正常、退出码 0、
入库 0 条"——面板上那个源就是一条平线，看起来像"最近没用"。dsh 曾这样静默归零整整一个月
（详见 `docs/ARCHITECTURE.md` 的 dsh 段）。文件发现通常按扩展名通配，所以连"找不到文件"
都不会发生，日志里一切正常。

排查与防范：

- 怀疑时先跑一次 `SELECT tool, MAX(ts), COUNT(*) FROM events GROUP BY tool`。某个源的
  `MAX(ts)` 停在一个整齐的时间点，基本就是那天上游改了格式
- 到数据目录对比新旧文件名与 `mtime`：并存的新旧两份文件里，旧的冻结时刻就是断点
- 改完务必让**新旧两种结构各有一份 fixture**，旧格式那份是防止"修好新的、改坏旧的"
- 新结构的 `dedup_key` 要与旧结构隔开命名空间。迁移期两份文件常并存于同一目录，而会话键
  多为父目录名，序号撞上就会互相顶掉；旧结构的键则须保持原样，否则重扫时历史事件会被
  当成新行再插一遍

### sqlite 源：先问这张表会不会原地更新

rowid 水位只对"只追加"的表成立。上游若先插入占位行、完成后再 `UPDATE` 填值（OpenCode 的
assistant 消息就是如此），扫描一旦落在两次写入之间，占位行被跳过、水位越过它，之后的更新永远
读不到——同样是退出码 0、只是少数据。服务监听 WAL 写入，恰恰最容易在"写到一半"时扫描。

- 写采集器前先在真实库里比 `time_created` 与 `time_updated`：两者不等的行就是被改过的
- 会改行的表按 `time_updated` 增量，并留回看窗口兜住多写入方的乱序提交
- fixture 要覆盖"先扫到占位行、再更新"的两轮扫描，单轮 fixture 抓不到这类问题

## 测试怎么被跑起来（#67）：加文件不用改 runner，但也不能指望"放进目录就算数"

`npm test` 跑的是手写的 [test/run.mjs](test/run.mjs)，它**过去**不扫描目录，所以历史上出现过一个
真实事故面：`test/windows/` 下 13 个套件（本机 426 条断言）和 `test/source-registry.test.mjs`
都不在任何 runner 里——CI 全绿，而 source-registry 那条一直红着没人看见。现在 `[26]` 段做了三件事：

| 档 | 覆盖什么 | 怎么跑 |
|---|---|---|
| A | `test/*.test.mjs`、`test/sources/**` | 全平台由 `npm test` 直接执行 |
| B | `test/windows/**`（不依赖构建产物） | Windows 上由 `npm test` 执行；Linux/macOS 上由 windows-latest 的 `npm test` job 执行 |
| C | `test/windows/gui.test.mjs`、`tray.test.mjs` | **不由 `npm test` 跑**：它们启动真 exe 且靠命名互斥量保证单实例，机器上只要有一个实例没退（含上一轮漏下的）就会假红。由 `windows.yml` 里"先 `build.ps1` 构建产物、再执行该套件"的专属 job 独占跑；本机要验就照 [docs/WINDOWS.md](docs/WINDOWS.md) 的证据表单跑 |

对贡献者的三条硬规则：
- **新增 `test/**/*.test.mjs` 会自动被接线**，不需要改 run.mjs；反过来说，放一个不进任何档的文件也过不了守卫。
- **一个套件必须自己报出断言**：`[26]` 对每个被跑的文件断言 `exit 0` **且** `✓` 计数 ≥10 **且** `✗` 计数 =0。
  把断言删空、或者写一个只 `console.log` 不做判定的文件，都会红。红的时候 runner 会把子套件的 `✗` 行原样打出来。
- **不得新增"没有产物就当通过"的路径**：`SKIP_GUI_ARTIFACT` / `SKIP_TRAY_ARTIFACT` 只允许本地临时放行，
  C 档守卫会拦住任何把它们写进 workflow 的 job；同样禁止给测试 job 加 `continue-on-error: true`。
  这些守卫本身也带负例自检（`#67 自检·…`），证明它们真的会红。

CI 侧：`test.yml`（三平台 × 两 Node 版本的 `npm test` + 安装冒烟 + import 冒烟）、
`windows.yml`（Windows 源码烟测 / `npm test` / gui 构建+行为 / tray 构建+行为）、
`desktop.yml`（桌面版，含 `workflow_dispatch` 的三个故障探针，用来证明门能红）。

## CI 与仓库卫生守卫（#102 / #74）：门要能红，还要有人守着它别变哑

workflow 和打包脚本本身也是会被改坏的东西，所以 `test/run.mjs` 的 `[27]`（#102）与
`[28]`（#74）两段把 `.github/workflows/*.yml` 与 `desktop/scripts/build-windows.ps1`
当成被测对象：

| 守卫 | 规则 | 为什么 |
|---|---|---|
| `[27]` | 每个 job 都有 `timeout-minutes`（1–90） | 卡住的 job 永远停在"运行中"，比红更糟 |
| `[27]` | 每个 workflow 显式声明顶层 `permissions` | 不吃组织默认值；默认一放宽，验证用的 workflow 就静默拿到写仓库的权限 |
| `[27]` | 每个 `uses:` 固定到 40 位 commit SHA，且行尾注明版本号 | 浮标签下上游一次 force-push 就能换掉这里执行的代码。第三方 action 写在 `- name:` 下面另起一行，只认 `- uses:` 同行的正则会被静默漏掉，所以守卫自己也要按行数对账 |
| `[27]` | 禁止 `continue-on-error: true`、`npm ci` 后面接 `\|\| npm install`、测试接 `\|\| true` | 这类兜底把故障吃成绿 |
| `[27]` | 不许写死回环端口与本机用户目录 | 固定端口撞车时 curl 打到的是别人的服务，那种绿是假的 |
| `[27]` | 缓存 `workspaces` 路径不含空白且指向仓库里真实存在的目录 | 路径带空格时缓存 key 永不命中（#102 的原始缺陷），job 只是变慢，所以没人会去修 |
| `[28]` | 桌面打包指纹的输入表覆盖每个会改变产物的输入（含 `tsconfig.json`），且每一项真实存在 | 漏一项＝改了编译配置后 `-SkipBuild` 仍认为源码没动，旧 exe 会被当成新配置的产物打包发布；表里的路径被改名时 `Get-ChildItem` 只会静默少算 |
| `[28]` | 跟踪的 `*.md` 里不得出现未登记的本机绝对路径 | 既是隐私也是可移植性：一条作者机器的路径让人分不清通用步骤和偶然事实。教学用的占位示例要逐条登记理由，登记项过期同样判红 |

改 workflow 或打包输入表之前先跑 `TOKENMONITOR_OFFLINE=1 npm test`：`[27]`/`[28]` 的每条
规则都配了负例自检（`#102 自检·…`、`#74 自检·…`），它们存在的意义就是证明这些门真的会红，
而不是把断言删空之后变绿。根 `.gitignore` 现在也在库里（#74）：新增"下载的外部源码"目录时
顺手补一行，别让整棵目录树出现在 `git status` 里等人手动规避。

## 其他约定

- 零依赖原则：后端只用 Node 内置模块（`node:sqlite`/`node:http`/`node:fs`）；前端零构建（vanilla JS + ECharts UMD）
- 提交信息用中文或英文均可，说清"改了什么、为什么"即可
- 新源请注意隐私：只读、不上传、统计库不存对话内容
