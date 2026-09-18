/**
 * TokenMonitor 回归测试（零依赖，node test/run.mjs 或 npm test）
 *
 * 三层：
 *  1. 语法层：所有 JS 过 node --check
 *  2. 静态断言层：render() 经 safe() 调用的函数必须有定义（拦"误删函数"回归）；
 *     app.js 引用的 DOM id / 图表容器必须存在于 index.html（拦"改布局漏容器"回归）
 *  3. 端到端冒烟：临时 HOME 下生成各源 fixtures（含 dedup/别名/累计差分/单位换算等
 *     易错点），scan 两次（幂等），断言 DB 黄金数字与 /api/summary 结构
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = (await import('node:module')).createRequire(import.meta.url);
// 数据源注册表是多层断言的共同基准（前端登记、健康表长度），顶层导入一次
const { SOURCES } = await import(pathToFileURL(join(ROOT, 'src/config.js')).href);
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

async function killAndWait(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill(signal);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/* ---------- 第 1 层：语法 ---------- */
console.log('\n[1] 语法检查');
{
  const { globSync } = await import('node:fs');
  const files = [
    ...globSync(join(ROOT, 'src/**/*.js')),
    ...globSync(join(ROOT, 'bin/*.js')),
    ...globSync(join(ROOT, 'web/*.js')),
    ...globSync(join(ROOT, 'web/lib/*.js')),
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    ok(`node --check ${f.replaceAll(ROOT + '/', '')}`, r.status === 0, r.stderr.slice(0, 120));
  }
}

/* ---------- 第 1b 层：import 冒烟 ----------
 * node --check 只解析语法，不解析模块图：缺失的导出、给只读导出赋值这类错误它一概看不见。
 * 真实事故就是这么来的——server.err.log 里 12 次启动崩溃全是
 * "does not provide an export named 'setOnChange'" 与 "Cannot assign to read only property"。 */
console.log('\n[1b] import 冒烟（模块级错误）');
{
  const { globSync } = await import('node:fs');
  const mods = [...globSync(join(ROOT, 'src/**/*.js')), ...globSync(join(ROOT, 'web/lib/*.js'))];
  ok('待冒烟模块非空', mods.length >= 15, `仅 ${mods.length} 个`);
  for (const f of mods) {
    const rel = f.replaceAll(ROOT + '/', '');
    try {
      await import(pathToFileURL(f).href);
      ok(`import ${rel}`, true);
    } catch (err) {
      ok(`import ${rel}`, false, err.message.slice(0, 140));
    }
  }
}

/* ---------- 第 2 层：静态断言 ---------- */
console.log('\n[2] 静态断言');
{
  const app = read(join(ROOT, 'web/app.js'));
  const html = read(join(ROOT, 'web/index.html'));

  // safe('name', () => fn(...)) 调用的函数必须有定义
  const calls = [...app.matchAll(/safe\('\w+',\s*\(\)\s*=>\s*(\w+)\(/g)].map(m => m[1]);
  ok('render() safe 列表非空', calls.length >= 8, `仅 ${calls.length} 个`);
  for (const fn of new Set(calls)) {
    ok(`函数存在: ${fn}()`, new RegExp(`function ${fn}\\(|const ${fn} =`).test(app));
  }

  // app.js 引用的 DOM id 必须在 index.html
  const ids = new Set([...app.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]));
  const chartIds = new Set([...app.matchAll(/\['\w+',\s*'([\w-]+)'\]/g)].map(m => m[1]));
  const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
  // app.js 模板字符串里动态生成的 id 同样合法（#37 的 unpriced-box 明细容器等）
  for (const m of app.matchAll(/\sid="([\w-]+)"/g)) htmlIds.add(m[1]);
  for (const id of [...ids, ...chartIds]) {
    ok(`HTML 有 id=${id}`, htmlIds.has(id));
  }

  // 悬浮框不得被图表容器裁切：.pair .panel .chart 带 overflow:hidden（挡 flex 反馈循环），
  // 而 ECharts 默认把 tooltip 挂进该容器 → 必须统一改为挂 body + 夹在视口内
  const css = read(join(ROOT, 'web/style.css'));
  ok('成对行图表容器仍 overflow:hidden', /\.pair \.panel \.chart \{[^}]*overflow:\s*hidden/.test(css));
  const tips = [...app.matchAll(/tooltip:\s*(.+)/g)].map(m => m[1].trim());
  ok('图表 tooltip 数量符合预期', tips.length === 6, `实际 ${tips.length} 个`);
  for (const t of tips) {
    ok(`tooltip 走统一配置: ${t.slice(0, 34)}`, /^\w*[Tt]ooltip\w*\(/.test(t));
  }
  // 悬浮框的挂载点与视口夹取现在由 [2b] 直接 import lib/tooltip.js 做行为断言，此处只守"都走统一配置"

  // symbol:'none' 的折线没有可命中的图元，item 触发（默认）的悬浮框永远弹不出来，
  // 必须配 trigger:'axis'。会话钻取曲线曾长期踩这个坑。
  const sessFn = app.match(/async function showSessionDetail\([\s\S]*?\n\}/)?.[0] || '';
  ok('会话钻取曲线仍是无图元折线', /symbol:\s*'none'/.test(sessFn));
  ok('无图元折线用 axis 触发悬浮框（否则永远不弹）', /trigger:\s*'axis'/.test(sessFn));

  // 后端 500 时旧 load() 会在 render() 里抛 TypeError，页面静默停在旧数据上
  const loadFn = app.match(/async function load\([\s\S]*?\n\}/)?.[0] || '';
  ok('load() 处理请求失败', /catch|res\.ok/.test(loadFn), loadFn.slice(0, 60));
  ok('加载失败有可见提示而非静默停更', /load-error/.test(app));

  // node:sqlite 在 22.13.0 之前需要 --experimental-sqlite，engines 低于此值 npx 用户会直接报错
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const mv = (pkg.engines?.node || '').match(/(\d+)\.(\d+)/);
  ok('engines.node 不低于 node:sqlite 免 flag 的 22.13',
    !!mv && (Number(mv[1]) > 22 || (Number(mv[1]) === 22 && Number(mv[2]) >= 13)), pkg.engines?.node);
  // --no-warnings 会连带吞掉未来的弃用提示，只该屏蔽实验特性警告
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  ok('不再用 --no-warnings 屏蔽全部警告', !/--no-warnings(\s|$)/.test(scripts), scripts);
}

/* ---------- 第 2b 层：前端纯函数（真实 import，不再正则抽源码） ---------- */
console.log('\n[2b] 前端纯函数（lib/）');
{
  const app = read(join(ROOT, 'web/app.js'));
  const lib = (f) => import(pathToFileURL(join(ROOT, 'web/lib', f)).href);
  const { pickSeries, assignSlots, stackTipFormatter, dayAxis, fillDays } = await lib('series.js');
  const { esc, fmt, fmtShort, ymd } = await lib('format.js');
  const { MODEL_PALETTE, TOOL_COLORS } = await lib('theme.js');
  const { chartTooltip, tooltipPosition } = await lib('tooltip.js');

  // ---- 转义：面板整页靠 innerHTML 拼接，插值来自本地目录名与各工具 transcript ----
  ok('esc 转义尖括号',
    esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', esc('<img src=x>'));
  ok('esc 转义属性上下文的引号', esc('a"b\'c') === 'a&quot;b&#39;c', esc('a"b\'c'));
  ok('esc 先转义 & 不产生双重转义', esc('a&lt;b') === 'a&amp;lt;b', esc('a&lt;b'));
  ok('esc 把 null/undefined 变空串', esc(null) === '' && esc(undefined) === '');

  // ---- 本地日期：用 UTC 的 toISOString 会让东八区凌晨算成前一天，与后端分桶对不上 ----
  ok('ymd 用本地时区各字段', ymd(new Date(2026, 8, 15, 0, 30)) === '2026-09-15', ymd(new Date(2026, 8, 15, 0, 30)));
  ok('ymd 补零', ymd(new Date(2026, 0, 5)) === '2026-01-05', ymd(new Date(2026, 0, 5)));

  // ---- 数值格式化（独立手算对照）----
  ok('fmt 万分档', fmt(12345) === '1.2 万', fmt(12345));
  ok('fmt 亿分档', fmt(123456789) === '1.23 亿', fmt(123456789));
  ok('fmtShort K/M 分档', fmtShort(1500) === '2K' && fmtShort(1500000) === '1.5M',
    `${fmtShort(1500)} ${fmtShort(1500000)}`);

  // ---- 日期轴：两个按天图共用一条轴，否则同一天落在不同的 x 上 ----
  const sparse = [{ day: '2026-09-13' }, { day: '2026-09-15' }];
  ok('dayAxis 补齐日期空洞',
    dayAxis(sparse, 90).join(',') === '2026-09-13,2026-09-14,2026-09-15', dayAxis(sparse, 90).join(','));
  ok('dayAxis 结果可复现（两图共用同一轴）',
    dayAxis(sparse, 90).join(',') === dayAxis([...sparse], 90).join(','));
  ok('dayAxis 空输入不炸', dayAxis([], 90).length === 0);
  ok('dayAxis 超长跨度不补洞',
    dayAxis([{ day: '2020-01-01' }, { day: '2026-09-15' }], 90).length === 2);
  ok('fillDays 给补出来的日子填空壳',
    fillDays(sparse, 90)[1].day === '2026-09-14' && fillDays(sparse, 90)[1].total === 0);
  // 单一事实源：消耗图走 fillDays、花费图走 dayAxis，两者必须逐日一致，否则同一天落在不同的 x 上
  ok('fillDays 与 dayAxis 产出同一条轴',
    fillDays(sparse, 90).map(r => r.day).join(',') === dayAxis(sparse, 90).join(','));

  // ---- 悬浮框只列当日真正用到的系列：0 的那些不属于"今天用了什么" ----
  const bags = [{ zcode: 100, grok: 0 }];
  const tip = stackTipFormatter(String, i => bags[i], [], '');
  const out = tip([
    { axisValue: '09-15', seriesName: 'ZCode', value: 100, marker: '*', dataIndex: 0 },
    { axisValue: '09-15', seriesName: 'Grok', value: 0, marker: '*', dataIndex: 0 },
  ]);
  ok('悬浮框不列 0 用量的系列', !out.includes('Grok') && out.includes('ZCode'), out);
  ok('悬浮框带合计', out.includes('合计'), out);
  ok('悬浮框转义系列名', stackTipFormatter(String, () => ({}), [], '')(
    [{ axisValue: 'x', seriesName: '<b>hack</b>', value: 1, marker: '*', dataIndex: 0 }]).includes('&lt;b&gt;'));

  // 「其他」段展开成员，长尾不被藏起来
  const bags2 = [{ a: 5, b: 3, c: 0 }];
  const tip2 = stackTipFormatter(String, i => bags2[i], ['b', 'c'], '其他(2)');
  const out2 = tip2([{ axisValue: '09-15', seriesName: '其他(2)', value: 8, marker: '*', dataIndex: 0 }]);
  ok('「其他」在悬浮框里展开成员', out2.includes('b 3') && !out2.includes('c 0'), out2);

  // ---- 系列选择 ----
  const rows = [
    { day: '2026-09-13', bag: { a: 10, b: 5 } },
    { day: '2026-09-14', bag: { a: 3, b: 7 } },
    { day: '2026-09-15', bag: { c: 1 } },   // c 今天首用；a、b 今天为 0
  ];
  const r1 = pickSeries(rows, r => r.bag, 8);
  // a 今天没量但 09-14 有量 → 必须保留，否则 09-14 的柱子没有图例可解释
  ok('当日为 0 但范围内用过的键仍保留', ['a', 'b', 'c'].every(k => r1.keys.includes(k)), JSON.stringify(r1));
  // c 最近使用(09-15)排最前；a、b 同为 09-14，按范围内用量降序 → a(13) 在 b(12) 前
  ok('最近使用的排最前，同日按用量降序', r1.keys.join(',') === 'c,a,b', JSON.stringify(r1.keys));
  ok('从未用过的键不返回', !r1.keys.includes('zzz') && !r1.rest.includes('zzz'));

  // 回归：曾经按花费排名 slice(0,7) 硬截断，导致新用的小额模型整条消失
  const many = [{ day: '2026-09-15', bag: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`m${i}`, i + 1])) }];
  const r2 = pickSeries(many, r => r.bag, 8);
  ok('超出色板容量时归入「其他」而非丢弃',
    r2.keys.length === 8 && r2.rest.length === 10, `keys=${r2.keys.length} rest=${r2.rest.length}`);
  ok('keys+rest 覆盖全部用过的键（一个都不丢）', new Set([...r2.keys, ...r2.rest]).size === 18);

  // ---- 配色：Color follows the entity, never its rank ----
  const st = new Map();
  const before = assignSlots(['alpha', 'beta', 'gamma'], 8, st);
  const after = assignSlots(['alpha', 'beta', 'gamma', 'minimax-m3'], 8, st);
  ok('新增模型不改变已有模型配色',
    ['alpha', 'beta', 'gamma'].every(m => before.get(m) === after.get(m)));
  ok('单次渲染内不撞色', new Set(after.values()).size === 4);
  const reordered = assignSlots(['gamma', 'beta', 'alpha'], 8, st);
  ok('顺序/排名变化不改变配色',
    ['alpha', 'beta', 'gamma'].every(m => reordered.get(m) === before.get(m)));

  // 色板本身必须是校验过的 8 槽（改色需重跑 validate_palette.js）
  ok('MODEL_PALETTE 为 8 槽', MODEL_PALETTE.length === 8, String(MODEL_PALETTE.length));
  ok('MODEL_PALETTE 使用校验过的色板', MODEL_PALETTE.join(',') ===
    '#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767', MODEL_PALETTE.join(','));
  // 与注册表交叉核对，而不是数个数：内建 9 源漏登记配色/标签，面板上就是一条
  // 无色无名的堆叠段——这种漏登记正是"加源"最容易漏的一步。此后落地的新来源
  // 走 web/lib/sources.js 的确定性回退色（#16），不再强制登记，否则每加一个源
  // 都得改 theme.js，与"新来源只带自己的文件"的边界冲突。
  const BUILTIN_TOOLS = new Set(['claude-code', 'ccmr', 'codex', 'zcode', 'dsh', 'grok', 'workbuddy', 'pi', 'opencode']);
  const { TOOL_LABEL } = await lib('theme.js');
  const unstyled = SOURCES
    .filter(s => BUILTIN_TOOLS.has(s.tool) && (!TOOL_COLORS[s.tool] || !TOOL_LABEL[s.tool]))
    .map(s => s.tool);
  ok('内建 9 源都有品牌色与标签（新来源允许回退色）', unstyled.length === 0, `缺登记: ${unstyled.join(',')}`);

  // ---- 悬浮框定位：只 appendToBody 不够，图表贴顶时会被浏览器窗口继续裁 ----
  ok('悬浮框挂到 body（脱离 overflow:hidden 的图表容器）',
    chartTooltip({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }).appendToBody === true);
  const dom = { getBoundingClientRect: () => ({ left: 100, top: 50 }) };
  const pos = tooltipPosition(dom, { innerWidth: 400, innerHeight: 300 });
  // 光标贴近右下角、悬浮框 200×150 放不下 → 必须翻转并夹进视口
  const [lx, ly] = pos([280, 230], null, null, null, { contentSize: [200, 150] });
  const vx = lx + 100, vy = ly + 50; // 图表局部坐标 → 视口坐标
  ok('悬浮框不越出视口右/下边界', vx + 200 <= 392 && vy + 150 <= 292, `${vx},${vy}`);
  ok('悬浮框不越出视口左/上边界', vx >= 8 && vy >= 8, `${vx},${vy}`);

  // 图表系列必须来自 pickSeries，不得再按花费排名硬截断
  const costFn = app.match(/function renderCostDay\([\s\S]*?\n\}/)?.[0] || '';
  const trendFn = app.match(/function renderTrend\([\s\S]*?\n\}/)?.[0] || '';
  ok('按天花费走 pickSeries 选系列', /pickSeries\(/.test(costFn));
  ok('按天消耗走 pickSeries 选系列', /pickSeries\(/.test(trendFn));
  ok('不再按花费排名截断', !/ranked\.slice\(/.test(costFn) && !/slice\(0,\s*7\)/.test(costFn));
  ok('不再硬编码 DeepSeek 保底', !/deepseek-v4\.1-flash'\s*\?\s*'#/.test(app));
  ok('「其他」在悬浮框里展开成员', /其他/.test(costFn));

  // 柱宽一致：两张按天图必须共用同一个柱宽上限、同一套绘图区边距、同一条日期轴。
  // 三者缺一，柱子的实际渲染宽度就会不同（类目数或绘图区宽不一致时 barMaxWidth 相同也没用）
  const barMax = app.match(/const BAR_MAX_W = (\d+)/);
  ok('柱宽上限为常量', !!barMax);
  ok('柱宽上限不超过 24px（dataviz 规范）', Number(barMax?.[1]) <= 24, `实际 ${barMax?.[1]}`);
  ok('两张按天图共用柱宽上限',
    (trendFn.match(/barMaxWidth: BAR_MAX_W/g) || []).length === 1
    && (costFn.match(/barMaxWidth: BAR_MAX_W/g) || []).length === 1);
  ok('两张按天图共用绘图区边距', /\.\.\.DAY_GRID/.test(trendFn) && /\.\.\.DAY_GRID/.test(costFn));
  // 单一事实源：消耗图走 fillDays、花费图直接用 dayAxis，两者必须产出同一条轴
  ok('两张按天图共用日期轴', /fillDays\(/.test(trendFn) && /dayAxis\(/.test(costFn));
  ok('不再各自硬编码绘图区边距',
    !/grid: \{ left: 50, right: 12/.test(costFn) && !/grid: \{ left: 70, right: 16/.test(trendFn));
}

/* ---------- 第 2c 层：后端健壮性（Store / 路由错误处理） ---------- */
console.log('\n[2c] 后端健壮性');
{
  const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

  // 并发读写：serve 常驻时跑 `tokenmonitor today` 会撞锁，没有 busy_timeout 就是立刻 SQLITE_BUSY
  const { Store } = await mod('src/store.js');
  const tmp = mkdtempSync(join(tmpdir(), 'tokenmonitor-store-'));
  const st = new Store(join(tmp, 'x.db'));
  const bt = Object.values(st.db.prepare('PRAGMA busy_timeout').get())[0];
  ok('Store 设置了 busy_timeout（并发读写不立刻 SQLITE_BUSY）', Number(bt) >= 1000, String(bt));
  st.close();
  rmSync(tmp, { recursive: true, force: true });

  // 路由异常必须变成 500：冒泡出去就是未处理 rejection，会直接杀掉常驻进程
  const { withErrors } = await mod('src/server.js');
  let code = 0, body = '';
  const res = {
    headersSent: false,
    writeHead(c) { code = c; this.headersSent = true; },
    end(b) { body = b || ''; },
  };
  await withErrors(() => { throw new Error('boom-secret-path'); })({ url: '/api/x' }, res);
  ok('路由异常转成 500 而非未处理 rejection', code === 500, String(code));
  ok('500 响应体为 JSON 且不外泄内部错误', /error/.test(body) && !body.includes('boom-secret-path'), body);

  // 对账：DeepSeek 按美元计价，旧实现要求 currency==='CNY' → 统计花费恒为 0，面板据此误报 ⚠
  const { computeRecon } = await mod('src/pricing.js');
  const rtmp = mkdtempSync(join(tmpdir(), 'tokenmonitor-recon-'));
  const rdb = new DatabaseSync(join(rtmp, 'r.db'));
  rdb.exec(`CREATE TABLE events (ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER,
    cached_input INTEGER, cache_write INTEGER, output_tokens INTEGER, total_tokens INTEGER);
    CREATE TABLE balance_history (ts INTEGER, provider TEXT, balance REAL);`);
  const t = Date.now();
  rdb.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)')
    .run(t - 3_600_000, 'ccmr', 'deepseek-v4.1-flash', 1_000_000, 2_000_000, 0, 100_000, 3_100_000);
  rdb.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(t - 7_200_000, 'deepseek', 130);
  rdb.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(t - 60_000, 'deepseek', 127);
  const fakeStore = { getBalances: () => [{ id: 'deepseek', provider: 'DeepSeek', balance: 127 }] };
  const usdPricing = { models: { 'deepseek-v4.1-flash': { currency: 'USD', input_miss: 0.30, input_hit: 0.006, output: 1.20, off_peak: 1 } } };
  // 余额轮询熔断：GLM 端点持续 404，真实日志两天里带着 key 重试了 85 次
  const { BalancePoller } = await mod('src/balance.js');
  const etmp = mkdtempSync(join(tmpdir(), 'tokenmonitor-env-'));
  writeFileSync(join(etmp, '.env'), 'DEEPSEEK_API_KEY=test-key-not-real\n');
  let calls = 0;
  const always404 = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  const poller = new BalancePoller({ saveQuota() {} }, {
    fetchImpl: always404, maxClientErrors: 2, envPath: join(etmp, '.env'), log: () => {},
  });
  await poller.poll();
  await poller.poll();
  await poller.poll();
  ok('连续 4xx 后熔断，不再每轮重试', calls === 2, `实际请求 ${calls} 次`);
  ok('熔断状态可见（面板能标出来）', poller.status().some(s => s.id === 'deepseek'),
    JSON.stringify(poller.status()));
  rmSync(etmp, { recursive: true, force: true });

  const ds = computeRecon(rdb, fakeStore, usdPricing, { rate: 7.0 }).find(r => r.id === 'deepseek');
  // 手算（汇率 7.0）：1.0×0.30×7 + 2.0×0.006×7 + 0.1×1.20×7 = 2.10 + 0.084 + 0.84 = 3.024
  ok('美元计价厂商的对账花费不再恒为 0', Math.abs((ds?.spend ?? -1) - 3.024) < 1e-6, String(ds?.spend));
  ok('对账仍如实报告余额变化', Math.abs((ds?.delta ?? 0) - (-3)) < 1e-9, String(ds?.delta));
  rdb.close();
  rmSync(rtmp, { recursive: true, force: true });
}

/* ---------- 第 3 层：端到端冒烟 ---------- */
console.log('\n[3] 端到端冒烟（临时 HOME + fixtures）');
const HOME = mkdtempSync(join(tmpdir(), 'tokenmonitor-test-'));
const dbFile = join(HOME, '.tokenmonitor', 'tokenmonitor.db');
let hasDsh = false; // 系统无 zstd 时 dsh 源整体跳过，相关断言随之放行
{
  // ---- fixtures（时间戳用"现在"附近，避免健康检查把过去时间的 fixture 判为 stale）----
  const NOW = Date.now();
  const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
  const w = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.join('\n') + '\n'); };

  // Claude：两行同 id+requestId（dedup）+ 一行独立
  const aMsg = (id, ts, inTok, cached, out) => JSON.stringify({
    timestamp: ts, type: 'assistant', requestId: 'r1', sessionId: 's-claude', cwd: '/work/projA',
    message: { id, model: 'claude-opus-5', usage: { input_tokens: inTok, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: out } },
  });
  w(join(HOME, '.claude/projects/-work-projA/s-claude.jsonl'), [
    aMsg('m1', ISO(60000), 100, 500, 40),
    aMsg('m1', ISO(60000), 100, 500, 40), // 重复行 → dedup
    aMsg('m2', ISO(30000), 10, 90, 5),
  ]);

  // ccmr：deepseek-flash → 别名归一为 deepseek-v4.1-flash
  // 第二条（m4）复刻网关的真实写法：不写 requestId，一次 API 响应按 content block
  // 拆成多行，input/cached 每行重复，只有终结块带真实 output_tokens，先到的行是 0。
  // 四行塌成同一个 dedup_key，若沿用"先到者胜"，输出会被永久钉死在 0。
  const ccmrBlock = (out, stop) => JSON.stringify({
    timestamp: ISO(48000), type: 'assistant', sessionId: 's-ccmr',
    message: {
      id: 'm4', model: 'deepseek-flash', stop_reason: stop,
      usage: { input_tokens: 2000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: out },
    },
  });
  w(join(HOME, '.claude-gateway/projects/-work-projB/s-ccmr.jsonl'), [
    JSON.stringify({
      timestamp: ISO(50000), type: 'assistant', requestId: 'r2', sessionId: 's-ccmr',
      message: { id: 'm3', model: 'deepseek-flash', usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200 } },
    }),
    ccmrBlock(0, null),        // thinking 块
    ccmrBlock(0, null),        // text 块
    ccmrBlock(500, 'end_turn'),// 终结块：唯一带真实输出的一行
  ]);

  // Codex：session_meta + 新格式模型 + token_count 累计差分 + rate_limits
  w(join(HOME, '.codex/sessions/2026/09/14/rollout-2026-09-14T12-00-00-fixture.jsonl'), [
    JSON.stringify({ timestamp: ISO(45000), type: 'session_meta', payload: { id: 'fixture', session_id: 'parent', cwd: '/work/projC' } }),
    JSON.stringify({ timestamp: ISO(44000), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-test' } } }),
    JSON.stringify({ timestamp: ISO(43000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 } },
      rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1799999999 }, plan_type: 'testplan' } } }),
    JSON.stringify({ timestamp: ISO(30000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } } } }),
  ]);

  // Grok：秒级时间戳 + turn_completed（modelUsage 拆分）+ tool_call
  w(join(HOME, '.grok/sessions/%2Fwork%2FprojD/s-grok/updates.jsonl'), [
    JSON.stringify({ timestamp: Math.floor(NOW / 1000) - 500, method: 'session/update', params: { sessionId: 's-grok',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Web search', kind: 'search' } } }),
    JSON.stringify({ timestamp: Math.floor(NOW / 1000) - 400, method: 'session/update', params: { sessionId: 's-grok',
      update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100, cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20,
        modelUsage: { 'grok-4.6-build': { inputTokens: 2000, outputTokens: 100, totalTokens: 2100, cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20 } } } } } }),
  ]);

  // WorkBuddy：input 含 cache + traceId
  w(join(HOME, '.WorkBuddy/projects/-WorkBuddy-projE/s-wb.jsonl'), [JSON.stringify({
    timestamp: NOW - 30000, type: 'assistant', id: 'wb1', sessionId: 's-wb',
    providerData: { model: 'GLM-5.3-Flash', traceId: 't1' },
    message: { usage: { input_tokens: 500, output_tokens: 50, total_tokens: 550, cache_read_input_tokens: 400 } },
  })]);

  // ZCode：sqlite fixtures
  const zdir = join(HOME, '.zcode/cli/db');
  mkdirSync(zdir, { recursive: true });
  {
    const z = new DatabaseSync(join(zdir, 'db.sqlite'));
    z.exec(`CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT,
      status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`);
    z.exec(`CREATE TABLE tool_usage (session_id TEXT, tool_name TEXT, started_at INTEGER)`);
    z.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)`);
    z.prepare(`INSERT INTO model_usage VALUES ('u1','s-zc','prov','GLM-5.3','completed',?,800,60,0,0,700,860)`).run(NOW - 20000);
    z.prepare(`INSERT INTO tool_usage VALUES ('s-zc','Bash',?)`).run(NOW - 20000);
    z.prepare(`INSERT INTO session VALUES ('s-zc','/work/projF')`).run();
    z.close();
  }

  // Pi：首行 session 带 cwd（project 唯一来源）+ 同 id 重复行 dedup + toolCall 块
  const piMsg = (id, tsIso, usage, extra = {}) => JSON.stringify({
    type: 'message', id, parentId: null, timestamp: tsIso,
    message: {
      role: 'assistant', api: 'openai-completions', provider: 'deepseek',
      model: 'Pi-Test-Model', timestamp: Date.parse(tsIso) - 1000, usage, ...extra,
    },
  });
  w(join(HOME, '.pi/agent/sessions/--work-projG--/2026-09-16T00-00-00-000Z_s-pi.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 's-pi', timestamp: ISO(70000), cwd: '/work/projG' }),
    piMsg('p1', ISO(60000), { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0, reasoning: 10, totalTokens: 1540 }),
    piMsg('p1', ISO(60000), { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0, reasoning: 10, totalTokens: 1540 }), // 重复行 → dedup
    piMsg('p2', ISO(40000), { input: 100, output: 20, cacheRead: 0, cacheWrite: 50, reasoning: 0, totalTokens: 170 },
      { content: [{ type: 'toolCall', id: 'call_pi1', name: 'bash', arguments: '{}' }] }),
  ]);

  // OpenCode：sqlite（message.data.tokens 逐请求；part 的 tool 块 → 工具调用）
  const ocDir = join(HOME, '.local/share/opencode');
  mkdirSync(ocDir, { recursive: true });
  {
    const o = new DatabaseSync(join(ocDir, 'opencode.db'));
    o.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT)`);
    o.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    o.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    o.prepare(`INSERT INTO session VALUES ('s-oc', '/work/projH', 'title')`).run();
    // user 消息没有 tokens：必须跳过而不是记成 0 事件
    o.prepare(`INSERT INTO message VALUES ('oc-u1', 's-oc', ?, ?, ?)`)
      .run(NOW - 25000, NOW - 25000, JSON.stringify({ role: 'user', time: { created: NOW - 25000 } }));
    o.prepare(`INSERT INTO message VALUES ('oc-a1', 's-oc', ?, ?, ?)`)
      .run(NOW - 24000, NOW - 24000, JSON.stringify({
        role: 'assistant', modelID: 'Oc-Test-Model', providerID: 'prov', cost: 0,
        tokens: { total: 700, input: 200, output: 60, reasoning: 5, cache: { read: 400, write: 40 } },
        time: { created: NOW - 24000, completed: NOW - 23000 },
      }));
    o.prepare(`INSERT INTO part VALUES ('oc-p1', 'oc-a1', 's-oc', ?, ?, ?)`)
      .run(NOW - 23500, NOW - 23500, JSON.stringify({
        type: 'tool', tool: 'webfetch', callID: 'oc-call-1',
        state: { status: 'completed', time: { start: NOW - 23500, end: NOW - 23400 } },
      }));
    o.close();
  }

  // dsh：zstd 压缩的会话快照。v3 换了记录结构（assistant/chunk → assistant/message，
  // data.chunk.usage → data.usage），旧采集器一条也匹配不上且不报错——2026-08-14
  // 起整源静默归零。两种格式各造一份，确保新格式能解析且旧格式不被改坏。
  // 需要系统 zstd；缺失时该源在生产里本就整源跳过，测试同样跳过。
  const dshLines = (model, usageRec) => [
    JSON.stringify({ type: 'session', seq: 1, time: NOW - 22000, cwd: `/work/${model}` }),
    JSON.stringify({ type: 'request/header', seq: 2, time: NOW - 21500,
      data: { header: { config: { model: 'Dsh-Header-Model' } } } }),
    usageRec,
  ];
  // dsh 是**追加式多帧**写入：每批记录压成一个独立 zstd 帧接在文件末尾，实测单个会话
  // 文件里有数千帧。夹具必须照此生成——先前用单帧夹具，于是"只解第一帧"的实现一路绿灯，
  // 真实数据上却整源归零。夹具不像真实数据，测试就只是在测自己。
  const zstd = (dir, name, lines) => {
    mkdirSync(dir, { recursive: true });
    const zlib = require('node:zlib');
    if (typeof zlib.zstdCompressSync === 'function') {   // Node ≥ 23.8 自带
      const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n')));
      writeFileSync(join(dir, name), Buffer.concat(frames));
      return true;
    }
    // 旧版 Node：逐行压成独立帧再拼接，等价于上面的多帧布局
    const parts = lines.map((l, i) => {
      const plain = join(dir, `.part${i}`);
      writeFileSync(plain, l + '\n');
      const r = spawnSync('zstd', ['-q', '-f', plain, '-o', `${plain}.zst`], { encoding: 'utf8' });
      rmSync(plain, { force: true });
      return r.status === 0 ? readFileSync(`${plain}.zst`) : null;
    });
    if (parts.some((x) => !x)) return false;
    writeFileSync(join(dir, name), Buffer.concat(parts));
    for (let i = 0; i < lines.length; i++) rmSync(join(dir, `.part${i}.zst`), { force: true });
    return true;
  };
  // v3：usage 直接挂在 data 下，模型来自 data.message.source.model（覆盖 request/header）
  hasDsh = zstd(join(HOME, '.dsh/sessions/--work-projI--/s-dsh-v3'), 'session.v3.jsonl.zstd',
    dshLines('projI', JSON.stringify({
      type: 'assistant/message', seq: 3, time: NOW - 21000,
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 30, totalTokens: 1480 },
        message: { role: 'assistant', source: { kind: 'model', model: 'Dsh-Test-Model' } },
      },
    })));
  // 旧格式：与 v3 同目录也并存过，父目录名作 fileId 会让两者 dedup_key 撞车
  if (hasDsh) zstd(join(HOME, '.dsh/sessions/--work-projJ--/s-dsh-old'), 'session.jsonl.zstd',
    dshLines('projJ', JSON.stringify({
      type: 'assistant/chunk', seq: 3, time: NOW - 20500,
      data: { turn: 1, step: 1, chunk: { type: 'usage',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, reasoningTokens: 5 } } },
    })));

  // 本地定价（离线可算费用；deepseek/glm 覆盖 fixtures 模型）
  mkdirSync(join(HOME, '.tokenmonitor'), { recursive: true });
  writeFileSync(join(HOME, '.tokenmonitor', 'pricing.json'), JSON.stringify({
    usd_to_cny: 7.0,
    models: {
      'deepseek-v4.1-flash': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      'glm-5.3-flash': { currency: 'CNY', input_miss: 1, input_hit: 0.3, output: 4 },
      'gpt-test': { currency: 'CNY', input_miss: 10, input_hit: 2, output: 30 },
      'pi-test-model': { currency: 'CNY', input_miss: 3, input_hit: 0.6, output: 9 },
      'oc-test-model': { currency: 'CNY', input_miss: 5, input_hit: 1, output: 15 },
      'dsh-test-model': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      'dsh-header-model': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      // 只被第 6 节使用。故意不写 off_peak：老用户的 pricing.json 里没有这个字段，
      // 若实现成"缺失即不打折"，峰谷价对他们就是个静默空操作
      'deepseek-v4-pro': { currency: 'CNY', input_miss: 2000, input_hit: 0, output: 0 },
    },
  }));
}

// dsh 夹具是否落地，决定其黄金数字是否计入（无 zstd 时该源整体缺席）
const DSH_T = hasDsh ? 1800 : 0, DSH_N = hasDsh ? 2 : 0;

// 离线：回归测试不该依赖公网（汇率/LiteLLM 牌价），否则断网就跑不了、时长也不可控。
// USERPROFILE 是 Windows 上 os.homedir() 认的变量，只设 HOME 在那边临时家目录不生效。
const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMONITOR_OFFLINE: '1' };
const cli = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenmonitor.js'), ...args], { encoding: 'utf8', env });

{
  const r1 = cli(['scan']);
  ok('scan 第一次退出码 0', r1.status === 0, r1.stderr.slice(0, 200));
  const r2 = cli(['scan']);
  ok('scan 第二次退出码 0（幂等路径）', r2.status === 0, r2.stderr.slice(0, 200));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql, ...a) => db.prepare(sql).all(...a);

  // 黄金数字（手算）：claude 640+105=745；ccmr 10200；codex 差分 400-120=280（in350/c100/out50 → fresh 250, cached 100, total 300）
  const byTool = Object.fromEntries(q('SELECT tool, SUM(total_tokens) t, COUNT(*) n FROM events GROUP BY tool').map(r => [r.tool, r]));
  ok('claude-code 2 事件（dedup 生效）', byTool['claude-code']?.n === 2, JSON.stringify(byTool['claude-code']));
  ok('claude-code 总量 745', byTool['claude-code']?.t === 745);
  ok('ccmr 20700（多 block 响应取到终结块的输出）', byTool.ccmr?.t === 20700, JSON.stringify(byTool.ccmr));
  ok('ccmr 2 事件（4 行塌成 2 次调用）', byTool.ccmr?.n === 2, JSON.stringify(byTool.ccmr));
  // 这条是本次回归的靶心：网关不写 requestId 时曾把输出记成 0
  ok('ccmr 终结块输出 500 而非 0',
    q("SELECT output_tokens o FROM events WHERE tool='ccmr' ORDER BY output_tokens DESC")[0]?.o === 500,
    JSON.stringify(q("SELECT output_tokens o FROM events WHERE tool='ccmr'")));
  ok('codex 差分 280', byTool.codex?.t === 280, JSON.stringify(byTool.codex));
  ok('grok 2100（秒→毫秒换算）', byTool.grok?.t === 2100);
  ok('workbuddy 550', byTool.workbuddy?.t === 550);
  ok('zcode 860', byTool.zcode?.t === 860);
  // dsh v3：usage 挂在 data 下而非 data.chunk.usage；旧采集器在这里静默收零达一个月
  if (hasDsh) {
    ok('dsh 1800（v3 1480 + 旧格式 320）', byTool.dsh?.t === 1800, JSON.stringify(byTool.dsh));
    ok('dsh 2 事件（新旧格式各一，dedup_key 不撞车）', byTool.dsh?.n === 2, JSON.stringify(byTool.dsh));
    const v3 = q("SELECT * FROM events WHERE tool='dsh' AND total_tokens=1480")[0];
    ok('dsh v3 缓存写入 30（旧实现硬编码 0）', v3?.cache_write === 30, JSON.stringify(v3));
    ok('dsh v3 模型取 data.message.source.model', v3?.model === 'dsh-test-model', String(v3?.model));
    ok('dsh v3 project=projI（session.cwd）', v3?.project === 'projI', String(v3?.project));
    const old = q("SELECT * FROM events WHERE tool='dsh' AND total_tokens=320")[0];
    ok('dsh 旧格式仍可解析（模型回落 request/header）', old?.model === 'dsh-header-model', String(old?.model));
    ok('dsh 旧格式 reasoning 5 不重复计入 total', old?.reasoning_tokens === 5 && old?.total_tokens === 320,
      JSON.stringify(old));
  } else {
    console.log('  – dsh 断言跳过（系统无 zstd，该源在生产里同样整体跳过）');
  }
  // Pi/OpenCode 口径实测：total = 新输入 + 缓存读 + 缓存写 + 输出，reasoning 已含在 output 内。
  // 若误把 reasoning 再加一遍，pi 会变成 1550、opencode 会变成 705——这两个数就是防线。
  ok('pi 1710（input 不含缓存，reasoning 不重复计入）', byTool.pi?.t === 1710, JSON.stringify(byTool.pi));
  ok('pi 2 事件（同 id 重复行 dedup）', byTool.pi?.n === 2, JSON.stringify(byTool.pi));
  ok('opencode 700（user 消息无 tokens 不入库）', byTool.opencode?.t === 700, JSON.stringify(byTool.opencode));
  ok('opencode 1 事件', byTool.opencode?.n === 1, JSON.stringify(byTool.opencode));
  const total = Object.values(byTool).reduce((s, r) => s + r.t, 0);
  ok(`全源合计 ${27645 + DSH_T}`, total === 27645 + DSH_T, String(total));

  // 模型别名与归一
  const models = Object.fromEntries(q('SELECT model, COUNT(*) n FROM events GROUP BY model').map(r => [r.model, r.n]));
  ok("deepseek-flash → deepseek-v4.1-flash", models['deepseek-v4.1-flash'] === 2 && !models['deepseek-flash']);
  ok('GLM-5.3-Flash → glm-5.3-flash（小写归一）', models['glm-5.3-flash'] === 1);

  // 幂等：二次扫描不重复
  const n2 = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  ok(`事件总数 ${11 + DSH_N}（幂等）`, n2 === 11 + DSH_N, String(n2));

  // tool_calls
  const tc = Object.fromEntries(q('SELECT tool, COUNT(*) n FROM tool_calls GROUP BY tool').map(r => [r.tool, r.n]));
  ok('grok 工具调用 1', tc.grok === 1);
  ok('zcode 工具调用 1', tc.zcode === 1);
  ok('pi 工具调用 1（assistant 内容里的 toolCall 块）', tc.pi === 1, String(tc.pi));
  ok('opencode 工具调用 1（part 表 type=tool）', tc.opencode === 1, String(tc.opencode));

  // Codex 配额快照
  const quota = JSON.parse(db.prepare(`SELECT data FROM quota WHERE tool='codex'`).get()?.data ?? 'null');
  ok('codex 配额 42%', quota?.used_percent === 42 && quota?.plan_type === 'testplan');

  // project 捕获
  const proj = Object.fromEntries(q('SELECT tool, project FROM events GROUP BY tool').map(r => [r.tool, r.project]));
  ok('codex project=projC（session_meta 顶层 type）', proj.codex === 'projC');
  ok('grok project=projD（URL 解码）', proj.grok === 'projD');
  ok('zcode project=projF（session.directory）', proj.zcode === 'projF');
  // 目录名解项目名曾用 lastIndexOf('/') / split('/')，Windows 上分隔符是反斜杠会解错
  ok('workbuddy project=projE（目录名解析，跨平台分隔符）', proj.workbuddy === 'projE', String(proj.workbuddy));
  // Pi 的目录名把 / 换成了 -，无法可靠还原（daily-test 与 daily/test 同形）；
  // 唯一可信来源是首行 session 记录的 cwd，须由 collector state 带过增量轮次。
  ok('pi project=projG（首行 session.cwd，非目录名反推）', proj.pi === 'projG', String(proj.pi));
  ok('opencode project=projH（session.directory）', proj.opencode === 'projH', String(proj.opencode));
  db.close();
}

/* ---------- 第 3b 层：源文件被删除（Claude 会话清理 / Codex 归档是常态） ---------- */
{
  const gone = join(HOME, '.claude/projects/-work-projA/s-claude.jsonl');
  rmSync(gone);
  const r = cli(['scan']);
  ok('源文件删除后 scan 退出码 0（不因 ENOENT 崩溃）', r.status === 0, r.stderr.slice(0, 300));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  ok('已删除文件的游标行被清理（不再无限堆积）',
    db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(gone).n === 0);
  ok('已删除文件的历史事件仍保留（只清游标不清数据）',
    db.prepare("SELECT COUNT(*) n FROM events WHERE tool = 'claude-code'").get().n === 2);
  ok('其余源的游标行不受影响',
    db.prepare("SELECT COUNT(*) n FROM files WHERE tool = 'ccmr'").get().n === 1);
  db.close();
}

/* ---------- API 冒烟 ---------- */
console.log('\n[4] API 冒烟');
{
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenmonitor.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  const started = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } }); });
  ok('serve 启动', started);

  if (started) {
    const res = await fetch(`http://127.0.0.1:${port}/api/summary?days=7`);
    const s = await res.json();
    ok('summary 200 且结构完整',
      res.status === 200 && s.totals?.all_time_tokens === 27645 + DSH_T && Array.isArray(s.by_day) && s.by_day.length >= 1
      && Array.isArray(s.health) && s.health.length >= 9 && s.costs && Array.isArray(s.costs.by_day)
      && Array.isArray(s.recent) && s.recent.length === 11 + DSH_N,
      `totals=${s.totals?.all_time_tokens} health=${s.health?.length} recent=${s.recent?.length}`);
    // 健康表必须随注册表一起长——曾经它是一份硬编码工具清单，加源必漏
    ok('健康表覆盖全部注册源', s.health.length === SOURCES.length, `${s.health.length} vs ${SOURCES.length}`);
    // 期望值随注册表一起长：隔离 HOME 下每个注册源要么 ok（fixture 有数据）
    // 要么 empty（该源 fixture 未造，如无 zstd CLI 时的 dsh、未落地 fixture 的
    // 新源）——出现 error/stale 才是异常（扫描崩溃或 fixture 过期）。
    const okTools = s.health.filter(h => h.status === 'ok').length;
    ok(`全部 ${s.health.length} 个注册源无 error/stale`,
      s.health.every(h => h.status === 'ok' || h.status === 'empty'),
      JSON.stringify(s.health.filter(h => (h.status !== 'ok' && h.status !== 'empty')).map(h => `${h.tool}:${h.status}`)));
    ok('费用 by_day 有值（本地定价离线可算）', s.costs.by_day.length >= 1 && s.costs.today_cny >= 0);

    // 离线模式：不发任何外网请求，用本地缓存/手动汇率/种子价继续出数
    ok('summary 标明处于离线模式', s.offline === true, String(s.offline));
    ok('离线时汇率不来自远端主机',
      ['default', 'cache', 'manual'].includes(s.costs.fx_source), String(s.costs.fx_source));
    ok('离线时费用仍可算（走本地 pricing.json）', s.costs.all_cny > 0, String(s.costs.all_cny));

    // DNS rebinding：只绑 127.0.0.1 挡不住恶意页面把自家域名解析到本机再读面板数据
    const rawGet = (path, headers) => new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path, headers }, (r) => {
        let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      rq.on('error', () => resolve({ status: 0, body: '' }));
      rq.end();
    });
    const evil = await rawGet('/api/summary?days=1', { host: 'evil.example.com' });
    ok('伪造 Host 被拒（防 DNS rebinding）', evil.status === 403, String(evil.status));
    ok('被拒响应不携带任何用量数据', !evil.body.includes('all_time_tokens'), evil.body.slice(0, 80));
    const local = await rawGet('/api/summary?days=1', { host: `127.0.0.1:${port}` });
    ok('本机 Host 正常放行', local.status === 200, String(local.status));
    const named = await rawGet('/api/summary?days=1', { host: `localhost:${port}` });
    ok('localhost 也放行（浏览器常用）', named.status === 200, String(named.status));

    // ECharts 拿不到 = app.js 在 echarts.init 处抛错 = 整页空白。1.2.0 就是这么坏的：
    // 路径写死成 <本包>/node_modules/echarts，而 npm 安装时 echarts 被提升到顶层。
    const ec = await fetch(`http://127.0.0.1:${port}/vendor/echarts.min.js`);
    ok('ECharts 能取到（取不到就整页空白）', ec.status === 200, String(ec.status));
    ok('ECharts 内容像是 JS 而非错误页',
      (ec.headers.get('content-type') || '').includes('javascript'), ec.headers.get('content-type'));
  }
  await killAndWait(child, 'SIGTERM');
}

/* ---------- 第 5 层：增量续写（Pi 的 project 必须跨轮次存活） ----------
 * Pi 的目录名把 '/' 换成了 '-'，无法反推项目名；project 的唯一可信来源是首行 session.cwd。
 * 而增量扫描是从字节游标往后读的——续写轮次根本读不到首行。若 project 不随 collector state
 * 落库，新事件就会是 project=null：面板上"按项目"从此漏掉这个源的新数据，且不报任何错。 */
console.log('\n[5] 增量续写');
{
  const piFile = join(HOME, '.pi/agent/sessions/--work-projG--/2026-09-16T00-00-00-000Z_s-pi.jsonl');
  appendFileSync(piFile, JSON.stringify({
    type: 'message', id: 'p3', timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', model: 'Pi-Test-Model',
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10 },
    },
  }) + '\n');

  const r = cli(['scan']);
  ok('续写后 scan 退出码 0', r.status === 0, r.stderr.slice(0, 200));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const row = db.prepare("SELECT project, total_tokens FROM events WHERE dedup_key = 'pi:s-pi:p3'").get();
  ok('续写事件已入库（字节游标继续推进）', row?.total_tokens === 10, JSON.stringify(row));
  ok('续写事件仍带 project（state 跨轮次存活，未退化为 null）', row?.project === 'projG', String(row?.project));
  ok('旧事件未被重复插入', db.prepare("SELECT COUNT(*) n FROM events WHERE tool = 'pi'").get().n === 3);
  db.close();
}

/* OpenCode 的 message/part 是 ON DELETE CASCADE，session 还带 revert 列——它会删消息。
 * SQLite 删掉最大 rowid 后会把该号让给下一条插入，于是新消息的 rowid 可能不大于水位，
 * 纯 rowid 水位会把它整条漏掉，且不报任何错。（ZCode 的 model_usage 只追加，没这个问题。） */
{
  const ocDb = join(HOME, '.local/share/opencode', 'opencode.db');
  {
    const o = new DatabaseSync(ocDb);
    o.exec("DELETE FROM message WHERE id = 'oc-a1'"); // 模拟一次 revert
    o.close();
  }
  ok('删行后 scan 退出码 0', cli(['scan']).status === 0);

  const newTs = Date.now();
  let reused;
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a2', 's-oc', ?, ?, ?)`).run(newTs, newTs, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 123, input: 100, output: 23, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: newTs },
    }));
    reused = o.prepare("SELECT rowid AS r FROM message WHERE id = 'oc-a2'").get().r;
    o.close();
  }
  ok('新消息确实复用了被删的 rowid（前提成立，才谈得上防护）', reused === 2, String(reused));
  ok('rowid 复用后 scan 退出码 0', cli(['scan']).status === 0);

  const db2 = new DatabaseSync(dbFile, { readOnly: true });
  ok('复用 rowid 的新消息没有被漏掉',
    db2.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a2'").get()?.t === 123,
    JSON.stringify(db2.prepare("SELECT dedup_key FROM events WHERE tool='opencode'").all()));
  ok('被删消息的历史事件仍保留（只读源消失不等于历史作废）',
    db2.prepare("SELECT COUNT(*) n FROM events WHERE dedup_key = 'opencode:oc-a1'").get().n === 1);
  db2.close();
}

/* OpenCode 的 assistant 消息是"先插后改"：开始生成时就插入一行，tokens 全 0；
 * 生成结束才原地 UPDATE 写入用量并刷新 time_updated（实测 1.18.31，每条消息恰一个 step-finish）。
 * 服务监听 -wal，生成过程中每次写入都会触发扫描——扫描几乎总落在"已插入、未完成"的窗口里。
 * 按 rowid 水位增量时，这行被当成 0 用量跳过、水位却越过了它，完成后的 UPDATE 再也读不到。 */
{
  const ocDb = join(HOME, '.local/share/opencode', 'opencode.db');
  const t0 = Date.now();
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a3', 's-oc', ?, ?, ?)`).run(t0, t0, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model', tokens: zero, time: { created: t0 },
    }));
    o.close();
  }
  ok('生成中途 scan 退出码 0', cli(['scan']).status === 0);
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`UPDATE message SET time_updated = ?, data = ? WHERE id = 'oc-a3'`).run(t0 + 5000, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 456, input: 400, output: 56, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: t0, completed: t0 + 5000 },
    }));
    o.close();
  }
  ok('生成完成后 scan 退出码 0', cli(['scan']).status === 0);
  {
    const db3 = new DatabaseSync(dbFile, { readOnly: true });
    ok('扫描落在生成中途的消息，完成后仍被采集',
      db3.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a3'").get()?.t === 456,
      JSON.stringify(db3.prepare("SELECT dedup_key, total_tokens FROM events WHERE tool='opencode'").all()));
    db3.close();
  }

  /* 已升级用户的游标早已越过漏掉的行：只修增量逻辑补不回历史，必须让旧 state 触发全量重扫。
   * 这里把 files 表还原成旧版本的真实形态（rowid 水位已越过、_v 为旧版本）来验证。 */
  const t1 = Date.now();
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a4', 's-oc', ?, ?, ?)`).run(t1, t1 + 3000, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 789, input: 700, output: 89, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: t1, completed: t1 + 3000 },
    }));
    // 水位恰好等于真实最大 rowid：比它大会触发"表变短即回退"，那就不是真实的中毒形态了
    const maxMsg = o.prepare('SELECT MAX(rowid) m FROM message').get().m;
    const maxPart = o.prepare('SELECT MAX(rowid) m FROM part').get().m;
    o.close();
    const w = new DatabaseSync(dbFile);
    w.prepare("UPDATE files SET state_json = ? WHERE tool = 'opencode'")
      .run(JSON.stringify({ maxRowid: maxMsg, partMaxRowid: maxPart, _v: 1 }));
    w.close();
  }
  ok('旧游标 scan 退出码 0', cli(['scan']).status === 0);
  {
    const db4 = new DatabaseSync(dbFile, { readOnly: true });
    ok('被旧版 rowid 水位越过的消息，升级后补回',
      db4.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a4'").get()?.t === 789,
      JSON.stringify(db4.prepare("SELECT dedup_key, total_tokens FROM events WHERE tool='opencode'").all()));
    // a1（被删但历史保留）+ a2 + a3 + a4
    ok('全量重扫不重复计数', db4.prepare("SELECT COUNT(*) n FROM events WHERE tool='opencode'").get().n === 4,
      String(db4.prepare("SELECT COUNT(*) n FROM events WHERE tool='opencode'").get().n));
    db4.close();
  }
}

/* ---------- 第 6 层：DeepSeek 峰谷价 ----------
 * 官方规则（api-docs.deepseek.com/quick_start/pricing，2026-09-16 核对）：
 *   峰时 = UTC 周一至周五 01:00-04:00 与 06:00-10:00；其余一切时段为谷时，谷时价减半。
 * 三个容易想当然的点，各自钉一条用例：按 UTC 不按本地时区、整个周末都是谷时、
 * 两段峰时之间 04:00-06:00 是空档。用固定时刻断言，否则结论随测试运行时刻漂移。
 */
console.log('\n[6] DeepSeek 峰谷价');
{
  const { PEAK_SQL } = await import(pathToFileURL(join(ROOT, 'src/pricing.js')).href);
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE events (ts INTEGER)');
  const isPeak = (iso) => {
    mem.exec('DELETE FROM events');
    mem.prepare('INSERT INTO events VALUES (?)').run(Date.parse(iso));
    return mem.prepare(`SELECT ${PEAK_SQL} AS p FROM events`).get().p === 1;
  };
  // 2026-09-14 一 / 16 三 / 18 五 / 19 六 / 20 日
  const cases = [
    ['2026-09-16T00:59:00Z', false, '峰时窗口前一分钟'],
    ['2026-09-16T01:00:00Z', true,  '第一段峰时起点'],
    ['2026-09-16T03:59:00Z', true,  '第一段峰时末尾'],
    ['2026-09-16T04:00:00Z', false, '两段峰时之间的空档'],
    ['2026-09-16T05:59:00Z', false, '空档末尾'],
    ['2026-09-16T06:00:00Z', true,  '第二段峰时起点'],
    ['2026-09-16T09:59:00Z', true,  '第二段峰时末尾'],
    ['2026-09-16T10:00:00Z', false, '峰时窗口后'],
    ['2026-09-14T02:00:00Z', true,  '周一在峰时窗口内'],
    ['2026-09-18T07:00:00Z', true,  '周五在峰时窗口内'],
    ['2026-09-19T02:00:00Z', false, '周六即便在窗口时刻也是谷时'],
    ['2026-09-20T07:00:00Z', false, '周日即便在窗口时刻也是谷时'],
  ];
  for (const [iso, want, why] of cases) {
    ok(`${iso} ${want ? '峰' : '谷'}时（${why}）`, isPeak(iso) === want);
  }
  mem.close();

  // 折扣是否真的落到金额上：同样的 token 数，只有时刻不同
  const pdb = new DatabaseSync(dbFile);
  const ins = pdb.prepare(`INSERT OR IGNORE INTO events
    (ts, tool, model, session_id, project, input_tokens, cached_input, cache_write,
     output_tokens, reasoning_tokens, total_tokens, dedup_key)
    VALUES (?, 'ccmr', 'deepseek-v4-pro', 's-peak', 'projK', 1000, 0, 0, 0, 0, 1000, ?)`);
  ins.run(Date.parse('2026-09-16T02:00:00Z'), 'peak:1'); // 峰时 → 1000/1e6 × 2000 = ¥2
  ins.run(Date.parse('2026-09-16T05:00:00Z'), 'peak:2'); // 空档 → ¥1
  ins.run(Date.parse('2026-09-19T02:00:00Z'), 'peak:3'); // 周六 → ¥1
  pdb.close();

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenmonitor.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  const up = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } }); });
  ok('serve 启动（峰谷价）', up);
  if (up) {
    const s6 = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=0`)).json();
    const m = s6.costs?.by_model?.find(x => x.model === 'deepseek-v4-pro');
    // 全按峰时算是 ¥6，正确应为 ¥2+¥1+¥1=¥4
    ok('谷时减半落到金额上（¥4 而非 ¥6）', m && Math.abs(m.cost_cny - 4) < 1e-9,
      JSON.stringify(m));
  }
  await killAndWait(child);
}

/* ---------- 第 7 层：无 zstd CLI 时仍能解 dsh ----------
 * 常驻服务由 launchd 拉起，其 PATH 是系统默认，不含 /opt/homebrew/bin，而 zstd 通常
 * 只装在那里。于是守护进程解不开 dsh 快照（报 "zstd not installed"），只有人在交互
 * shell 里手跑 scan 才正常——面板因此长期停在旧数据。清空 PATH 精确复现该环境。
 */
console.log('\n[7] 无 zstd CLI 时仍能解 dsh');
{
  const zlib = require('node:zlib');
  if (!hasDsh || typeof zlib.zstdDecompressSync !== 'function') {
    console.log('  – 跳过（无 dsh fixture 或该 Node 无内置 zstd，只能靠外部 CLI）');
  } else {
    const { collectDshFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/dsh.js')).href);
    const events = [];
    const stub = { insertEvent: (e) => { events.push(e); return 1; }, insertToolCall: () => 1 };
    const fixture = join(HOME, '.dsh/sessions/--work-projI--/s-dsh-v3/session.v3.jsonl.zstd');
    const savedPath = process.env.PATH;
    process.env.PATH = '';   // launchd 环境：CLI 一律找不到
    let err = null;
    try {
      await collectDshFile(stub, { path: fixture, fileId: 's-dsh-v3' });
    } catch (e) { err = e; }
    finally { process.env.PATH = savedPath; }
    ok('PATH 里没有 zstd 也不抛错', !err, String(err?.message));
    ok('PATH 里没有 zstd 也能解出用量', events.length === 1 && events[0].total_tokens === 1480,
      JSON.stringify(events));
  }
}

/* ---------- 第 8 层：余额对账的归属 ----------
 * recon 把"账户余额掉了多少"和"我们算出花了多少"对比。它原先写死 tool='ccmr'，
 * 但 dsh 花的是同一个 DeepSeek 账户——于是永远显示巨大缺口，而缺口的一半是自己漏算的。
 * 与之相对，workbuddy 用 deepseek 模型但走自家积分、codex 是订阅制，都不扣这个 key，
 * 光按模型前缀放开又会多算。归属只能显式声明，不能从数据猜。
 */
console.log('\n[8] 余额对账的归属');
{
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const { computeRecon } = await import(pathToFileURL(join(ROOT, 'src/pricing.js')).href);
  const st = new Store(dbFile);
  const now = Date.now();
  st.db.exec(`DELETE FROM balance_history WHERE provider='deepseek'`);
  st.db.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(now - 3_600_000, 'deepseek', 100);
  st.db.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(now - 60_000, 'deepseek', 90);
  st.db.prepare(`INSERT OR REPLACE INTO quota (tool, ts, data) VALUES ('balance:deepseek', ?, ?)`)
    .run(now, JSON.stringify({ provider: 'DeepSeek', balance: 90, currency: 'CNY' }));

  // 对账窗口是"最近 N 小时"，必须相对 now 取时刻：写死日期的用例过一天就滑出窗口、自己变红。
  // 峰谷折扣由定价里显式的 off_peak: 1 关掉，而不是靠挑一个峰时时刻（周末根本没有峰时）。
  const ev = (tool, model, key) => st.insertEvent({
    ts: now - 30 * 60_000, tool, model, session_id: 's-recon', project: 'projR',
    input_tokens: 1_000_000, cached_input: 0, cache_write: 0, output_tokens: 0,
    reasoning_tokens: 0, total_tokens: 1_000_000, dedup_key: key,
  });
  ev('ccmr', 'deepseek-recon-test', 'recon:1');      // 计入：ccmr 扣该账户
  ev('dsh', 'deepseek-recon-test', 'recon:2');       // 计入：dsh 扣同一账户 ← 本次修的
  ev('workbuddy', 'deepseek-recon-test', 'recon:3'); // 不计：走自家积分
  ev('ccmr', 'deepseek/recon-test', 'recon:4');      // 不计：OpenRouter 形态，扣的是 OpenRouter

  // 只给测试模型定价，其余模型离线查不到价会被跳过，不干扰本节
  const pricing = { models: { 'deepseek-recon-test': { currency: 'CNY', input_miss: 2, input_hit: 0, output: 0, off_peak: 1 } } };
  const r = computeRecon(st.db, st, pricing, { hours: 24, rate: 7 })
    .find(x => x.id === 'deepseek');
  ok('对账覆盖同账户的全部工具（ccmr+dsh=¥4，非仅 ccmr 的 ¥2）',
    r && Math.abs(r.spend - 4) < 1e-9, JSON.stringify(r));
  ok('余额差值照常读出（-10）', r && Math.abs(r.delta + 10) < 1e-9, String(r?.delta));
  st.db.close();
}

/* ---------- 第 9 层：LaunchAgent 生成 ----------
 * 全局安装的用户没有仓库，npm scripts 也调不到，此前没有可用的常驻方案。
 * 这里只验"生成"，绝不调用 launchctl——否则跑一次测试就在开发机上装出一个真服务。
 */
console.log('\n[9] LaunchAgent 生成');
{
  const { buildPlist, entryScript, AGENT_LABEL } = await import(pathToFileURL(join(ROOT, 'src/agent.js')).href);

  const plist = buildPlist({ node: '/usr/local/bin/node', script: '/opt/pkg/bin/tokenmonitor.js', port: 9001, logDir: '/tmp/l' });
  // launchd 的 PATH 是系统默认，不含 npm 全局 bin 也不含 homebrew；脚本 shebang 又是
  // #!/usr/bin/env node。所以 node 与脚本都必须是生成时就固化的绝对路径。
  ok('plist 固化 node 绝对路径', plist.includes('<string>/usr/local/bin/node</string>'));
  ok('plist 固化入口脚本绝对路径', plist.includes('<string>/opt/pkg/bin/tokenmonitor.js</string>'));
  ok('plist 带上端口', plist.includes('<string>--port</string>') && plist.includes('<string>9001</string>'));
  ok('plist 含 serve 与 KeepAlive', plist.includes('<string>serve</string>') && plist.includes('<key>KeepAlive</key>'));
  ok('plist 标签与文件名一致', plist.includes(`<string>${AGENT_LABEL}</string>`));

  // 家目录含 & 的用户并不罕见（公司名、姓氏）。不转义会生成非法 XML，
  // launchd 静默拒绝加载——又是一个"不报错只是不工作"的失败方式。
  const nasty = buildPlist({ node: '/n/a&b/node', script: '/s/x<y>/t.js', port: 8787, logDir: '/l/&' });
  ok('路径中的 XML 特殊字符被转义',
    nasty.includes('/n/a&amp;b/node') && nasty.includes('/s/x&lt;y&gt;/t.js') && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(nasty),
    nasty.match(/<string>[^<]*[&<][^<]*<\/string>/g)?.join(' | '));

  if (process.platform === 'darwin') {
    const f = join(HOME, 'probe.plist');
    writeFileSync(f, nasty);
    const lint = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    ok('生成的 plist 能过系统 plutil 校验', lint.status === 0, lint.stdout + lint.stderr);
  } else {
    console.log('  – plutil 校验跳过（非 macOS）');
  }

  const entry = entryScript();
  ok('入口脚本解析到真实存在的文件', existsSync(entry) && entry.replaceAll('\\', '/').endsWith('bin/tokenmonitor.js'), entry);

  // 装卸服务与数据无关。若排在 new Store 之后，仅仅装个开机自启就会在用户机器上
  // 建出数据库文件——这种副作用没人会想到要去测，只能靠顺序锁住。
  const cliSrc = read(join(ROOT, 'bin/tokenmonitor.js'));
  ok('装卸服务在创建 Store 之前分流',
    cliSrc.indexOf("cmd === 'install-agent'") < cliSrc.indexOf('new Store(DB_PATH)'));
  // README 曾指向 npm run install-agent，而全局安装的用户根本调不到 npm scripts
  ok('README 用 CLI 子命令而非 npm script 指引常驻',
    /tokenmonitor install-agent/.test(read(join(ROOT, 'README.md'))));
}

/* ---------- 第 10 层：菜单栏胶囊的分发 ----------
 * 此前 .app 只存在于仓库、且不在 files 白名单里，`npm i -g` 的用户拿不到，
 * 而 README 指的 `npm run bar` 对全局安装同样不可见。这类"声明了但没发出去"
 * 的缺陷装包前看不出来，只能在 npm pack 的实际产物上验。
 */
console.log('\n[10] 菜单栏胶囊的分发');
{
  const { barAppPath } = await import(pathToFileURL(join(ROOT, 'src/bar.js')).href);
  ok('app 路径解析在包内', barAppPath().endsWith(join('bin', 'tokenmonitor.app')), barAppPath());

  // 发布白名单必须声明它。产物本身不入 git（由 prepack 在发版前编译），
  // 所以干净克隆与 Linux CI 上盘里没有 .app，那种情况下只能验声明。
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  ok('package 只暴露 tokenmonitor CLI',
    Object.keys(pkg.bin || {}).length === 1 && pkg.bin.tokenmonitor === 'bin/tokenmonitor.js',
    JSON.stringify(pkg.bin));
  ok('files 白名单声明了菜单栏 app', (pkg.files || []).includes('bin/tokenmonitor.app/'),
    JSON.stringify(pkg.files));
  ok('prepack 会在发版前编译，避免发出陈旧或缺失的产物',
    /build.sh/.test(pkg.scripts?.prepack || ''), pkg.scripts?.prepack);

  const exe = join(barAppPath(), 'Contents', 'MacOS', 'tokenmonitor');
  if (existsSync(exe)) {
    // 光声明不够：曾经 files 里写了却因为路径写法不对而没进包
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: ROOT, encoding: 'utf8' });
    let files = [];
    try { files = JSON.parse(packed.stdout)[0].files.map((f) => f.path); } catch { /* 断言会报错 */ }
    ok('声明的 app 确实进了发布产物',
      files.some((f) => f.endsWith('tokenmonitor.app/Contents/MacOS/tokenmonitor'))
      && files.some((f) => f.endsWith('tokenmonitor.app/Contents/Info.plist')),
      files.filter((f) => f.includes('.app')).join(',') || packed.stderr?.slice(0, 120));
  } else {
    console.log('  – 打包内容检查跳过（本地尚未编译 app，执行 npm run build-bar 后可验）');
  }

  // Intel Mac 上单 arm64 产物直接无法运行，且失败时没有任何提示
  if (process.platform === 'darwin' && existsSync(exe)) {
    const archs = spawnSync('lipo', ['-archs', exe], { encoding: 'utf8' }).stdout || '';
    ok('二进制为 universal（含 arm64 与 x86_64）',
      archs.includes('arm64') && archs.includes('x86_64'), archs.trim());
  } else {
    console.log('  – 架构检查跳过（非 macOS 或尚未编译）');
  }

  const cliSrc = read(join(ROOT, 'bin/tokenmonitor.js'));
  ok('bar 在创建 Store 之前分流', cliSrc.indexOf("cmd === 'bar'") < cliSrc.indexOf('new Store(DB_PATH)'));
  // 写死端口会让 serve --port 的用户拿到一个连不上的胶囊
  ok('菜单栏源码不再写死端口', !/127\.0\.0\.1:8787/.test(read(join(ROOT, 'menubar/main.swift'))));
  ok('README 用 CLI 子命令指引菜单栏',
    /tokenmonitor bar/.test(read(join(ROOT, 'README.md'))));
}

/* ---------- [11] Scanner 健壮性（#43） ---------- */
console.log('\n[11] Scanner 健壮性（#43：脏 state_json 容错 / 当轮统计重置 / 路径 contain 判定）');
{
  const { Scanner } = await import(pathToFileURL(join(ROOT, 'src/scanner.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'scanner43 含中文 空格-'));
  const logs = join(base, 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, 'session.jsonl');
  writeFileSync(logFile, '{"model":"m1"}\n');
  // 同前缀但非子目录的干扰路径（修前 startsWith('…\\logs') 会把 logs-old 误判为子目录）
  const decoyPath = join(base, 'logs-old', 'gone.jsonl');
  mkdirSync(dirname(decoyPath), { recursive: true });
  writeFileSync(decoyPath, 'x\n');
  // 真子目录里已消失的文件行（应被 prune；文件本体不存在即可，prune 只查 db 行）
  const subGonePath = join(logs, 'sub', 'gone.jsonl');

  const store = new Store(join(base, 'test43.db'));
  store.saveFile({ path: decoyPath, tool: 'fake43', session_id: 'd1', size: 2, mtime_ms: 1, offset: 0, state_json: '{}' });
  store.saveFile({ path: subGonePath, tool: 'fake43', session_id: 's2', size: 2, mtime_ms: 1, offset: 0, state_json: '{}' });

  const collectCalls = [];
  let collectImpl = async (st, ctx) => {
    collectCalls.push({ state: ctx.state, path: ctx.path });
    return { inserted: 0, newOffset: ctx.offset ?? 0, state: ctx.state ?? {} };
  };
  const fakeSource = {
    tool: 'fake43', label: 'fake43', kind: 'jsonl', version: 1,
    roots: [logs],
    collect: (...a) => collectImpl(...a),
  };
  const scannerLogs = [];
  const scanner = new Scanner(store, { log: (m) => scannerLogs.push(m), sources: [fakeSource] });

  try {
    // --- 脏 state_json：坏 JSON 不让整轮扫描 reject，该文件按全量重扫 ---
    const s1 = statSync(logFile);
    store.saveFile({
      path: logFile, tool: 'fake43', session_id: 's1', size: s1.size, mtime_ms: s1.mtimeMs,
      offset: s1.size, state_json: '{broken json!!',
    });
    await scanner.scanAll({ quiet: true });
    ok('#43 坏 state_json 不让 scanAll reject 且文件按 state=undefined 全量重扫',
      collectCalls.length === 1 && collectCalls[0].state === undefined,
      `calls=${collectCalls.length} state=${JSON.stringify(collectCalls[0]?.state)}`);
    ok('#43 坏 state_json 记录了 warning 日志', scannerLogs.some((m) => m.includes('corrupt state_json')), scannerLogs.join(' | '));
    const fixed = JSON.parse(store.getFile(logFile).state_json);
    ok('#43 重扫后 state_json 已被合法 JSON 覆盖（_v 版本标记）', fixed._v === 1, JSON.stringify(fixed));

    // --- 当轮统计重置：files 是本轮数字；last_error 在恢复轮置回 null ---
    collectImpl = async () => { throw new Error('boom-parse'); };
    appendFileSync(logFile, '{"model":"m2"}\n'); // 改变 size，绕过 unchanged 跳过
    await scanner.scanAll({ quiet: true });
    const stErr = scanner.stats.fake43;
    ok('#43 collect 抛错计入本轮 parse_errors/last_error', stErr.parse_errors === 1 && !!stErr.last_error,
      JSON.stringify({ pe: stErr.parse_errors, le: stErr.last_error }));

    collectImpl = async (st, ctx) => ({ inserted: 0, newOffset: ctx.offset ?? 0, state: ctx.state ?? {} });
    appendFileSync(logFile, '{"model":"m3"}\n');
    await scanner.scanAll({ quiet: true });
    const stOk = scanner.stats.fake43;
    ok('#43 恢复轮 last_error 置回 null（不展示陈年错误）',
      stOk.last_error === null && stOk.parse_errors === 0,
      JSON.stringify({ pe: stOk.parse_errors, le: stOk.last_error }));
    ok('#43 files 为当轮数字而非累计（1 个文件扫 3 轮仍为 1）', stOk.files === 1, `files=${stOk.files}`);

    // --- 路径 contain 判定：同前缀不同目录不误删，真子目录被清 ---
    // （第三轮 scanAll 内部已跑过 _pruneMissingFiles：sub 行应在扫描轮被清掉，decoy 行必须保留）
    ok('#43 真子目录中已消失文件在扫描轮被 prune（isInside 判定）',
      store.getFile(subGonePath) == null, store.getFile(subGonePath) ? 'still present' : 'pruned');
    ok('#43 同前缀目录（logs-old）不被误判为子目录（行保留）', store.getFile(decoyPath) != null);
    const pruned = scanner._pruneMissingFiles('fake43', new Set([logFile]), [logs]);
    ok('#43 prune 幂等（无新增消失文件时返回 0）', pruned === 0, `pruned=${pruned}`);
  } finally {
    try { store.db.close(); } catch { /* 句柄由进程回收 */ }
    rmSync(base, { recursive: true, force: true });
  }
}

/* ---------- [12] _inheritCodexModels 写抑制（#52） ---------- */
console.log('\n[12] _inheritCodexModels 仅在真变化时写入（#52：连续无变化扫描零写入）');
{
  const { Scanner } = await import(pathToFileURL(join(ROOT, 'src/scanner.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'scanner52-'));
  const store = new Store(join(base, 'test52.db'));
  const parentUuid = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
  const parentSid = `rollout-2026-09-18-${parentUuid}`;
  const childUuid = 'f0e9d8c7-b6a5-f4e3-d2c1-b0a998877665';
  const childSid = `rollout-2026-09-18-${childUuid}`;
  // 父行已有最终模型；子行（resume 文件）无模型、带 parent 指向
  store.saveFile({ path: join(base, 'p.jsonl'), tool: 'codex', session_id: parentSid, size: 1, mtime_ms: 1, offset: 0, state_json: '{"model":"gpt-x"}' });
  store.saveFile({ path: join(base, 'c.jsonl'), tool: 'codex', session_id: childSid, size: 1, mtime_ms: 1, offset: 0, state_json: `{"parent":"${parentUuid}"}` });
  // 一条 model 为 NULL 的 codex 事件：供回填断言
  store.insertEvent({ ts: 1700000000000, tool: 'codex', model: null, session_id: childSid, project: null, dedup_key: 't52-e1' });
  const evBefore = store.db.prepare('SELECT model FROM events WHERE dedup_key = ?').get('t52-e1');

  const scanner = new Scanner(store, { sources: [] });
  let saveCalls = 0;
  const origSave = store.saveFile.bind(store);
  store.saveFile = (...a) => { saveCalls++; return origSave(...a); };

  try {
    scanner._inheritCodexModels(); // 第 1 轮：继承 + 回填 + 写盘
    const child = store.db.prepare('SELECT state_json FROM files WHERE session_id = ?').get(childSid);
    const childState = JSON.parse(child.state_json);
    const evAfter = store.db.prepare('SELECT model FROM events WHERE dedup_key = ?').get('t52-e1');
    ok('#52 resume 子行继承父模型并落盘', childState.model === 'gpt-x', child.state_json);
    ok('#52 事件回填把 NULL model 补写为继承模型',
      evBefore.model === null && evAfter.model === 'gpt-x',
      `before=${evBefore.model} after=${evAfter.model}`);
    const firstRoundSaves = saveCalls;

    saveCalls = 0;
    scanner._inheritCodexModels(); // 第 2 轮：无任何变化
    ok('#52 连续无变化轮零 saveFile（last_scan_ms 不被扰动）', saveCalls === 0, `saveCalls=${saveCalls}`);
    const childAgain = store.db.prepare('SELECT state_json, last_scan_ms FROM files WHERE session_id = ?').get(childSid);
    ok('#52 第二轮后 state_json 逐字节一致', childAgain.state_json === child.state_json);
    ok('#52 首轮确实发生过写入（对照非恒真）', firstRoundSaves >= 1, `firstRoundSaves=${firstRoundSaves}`);
  } finally {
    try { store.db.close(); } catch { /* 句柄由进程回收 */ }
    rmSync(base, { recursive: true, force: true });
  }
}

/* ---------- [13] Scanner 事务缓冲代理（#40） ---------- */
console.log('\n[13] Scanner 事务缓冲代理（#40：事务不跨 await；并发写入不卷入；批内原子）');
{
  const { Scanner } = await import(pathToFileURL(join(ROOT, 'src/scanner.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'scanner40-'));
  const logs = join(base, 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, 's.jsonl');
  writeFileSync(logFile, '{"a":1}\n{"b":2}\n{"c":3}\n');
  const store = new Store(join(base, 'test40.db'));
  let collectImpl = async (st, ctx) => ({ inserted: 0, newOffset: 0, state: {} });
  const fakeSource = {
    tool: 'fake40', label: 'fake40', kind: 'jsonl', version: 1, roots: [logs],
    collect: (...a) => collectImpl(...a),
  };
  const scanner = new Scanner(store, { sources: [fakeSource] });
  const countEvents = () => store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE tool='fake40'").get().n;

  try {
    // 场景 1：collect 中途抛错（模拟多 chunk 解析失败）——零半批提交、游标不推进
    collectImpl = async (st) => {
      st.insertEvent({ ts: 1, tool: 'fake40', dedup_key: 'k1' });
      st.insertEvent({ ts: 2, tool: 'fake40', dedup_key: 'k2' });
      throw new Error('chunk-fail');
    };
    await scanner.scanAll({ quiet: true });
    ok('#40 collect 抛错时本批事件零落库（无半批提交）', countEvents() === 0, `n=${countEvents()}`);
    const row1 = store.getFile(logFile);
    ok('#40 collect 抛错时游标不推进（下轮按旧游标重扫，dedup 兜底）', !row1 || row1.offset === 0, `offset=${row1?.offset}`);

    // 场景 2：并发写者走真 store（模拟 BalancePoller.saveQuota）——不被卷入扫描事务
    collectImpl = async (st) => {
      store.saveQuota('balance:fake40', 1700000000000, { balance: 123.45 });
      st.insertEvent({ ts: 1, tool: 'fake40', dedup_key: 'k1' });
      st.insertEvent({ ts: 2, tool: 'fake40', dedup_key: 'k2' });
      throw new Error('fail-after-concurrent-write');
    };
    appendFileSync(logFile, '{"d":4}\n');
    await scanner.scanAll({ quiet: true });
    const q = store.getQuota('balance:fake40');
    ok('#40 并发写者（saveQuota 走真 store）不被卷入扫描事务、扫描失败也不丢它',
      q && q.data.balance === 123.45, JSON.stringify(q));
    ok('#40 失败批事件仍零落库', countEvents() === 0, `n=${countEvents()}`);

    // 场景 3：成功批原子落库 + inserted 计数精确（含批内 dedup）+ 游标/状态同批推进
    collectImpl = async (st) => {
      const inserted = st.insertEvent({ ts: 1, tool: 'fake40', dedup_key: 'k1' })
        + st.insertEvent({ ts: 2, tool: 'fake40', dedup_key: 'k2' })
        + st.insertEvent({ ts: 3, tool: 'fake40', dedup_key: 'k1' }); // 批内重复 → 0
      return { inserted, newOffset: 30, state: { m: 1 } };
    };
    appendFileSync(logFile, '{"e":5}\n');
    const res = await scanner.scanAll({ quiet: true });
    ok('#40 成功批原子落库（2 条新事件，批内 dedup 不重复）', countEvents() === 2, `n=${countEvents()}`);
    ok('#40 缓冲代理 insertEvent 返回值语义保真（1+1+0 → inserted=2）', res.inserted === 2, `inserted=${res.inserted}`);
    const row3 = store.getFile(logFile);
    ok('#40 游标与状态随同一事务推进', row3 && row3.offset === 30 && JSON.parse(row3.state_json).m === 1,
      JSON.stringify(row3));
  } finally {
    try { store.db.close(); } catch { /* 句柄由进程回收 */ }
    rmSync(base, { recursive: true, force: true });
  }
}

/* ---------- [14] days=0 参数语义（#42） ---------- */
console.log('\n[14] days 查询参数语义（#42：0=全量不再被当 30；非法值回落）');
{
  const { parseDays, buildSummary } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  // 解析语义固化（AC1）
  ok('#42 未提供 → 30（默认窗口不变）', parseDays(null, 30) === 30 && parseDays(undefined, 30) === 30);
  ok('#42 空串 → 30', parseDays('', 30) === 30);
  ok('#42 显式 "0" → 0（全量；修前 Number("0")||30 塌成 30）', parseDays('0', 30) === 0);
  ok('#42 正常数值 → 原值', parseDays('7', 30) === 7 && parseDays('3650', 30) === 3650);
  ok('#42 非数字 → fallback', parseDays('abc', 30) === 30 && parseDays('1e999', 30) === 30);
  ok('#42 负数 → fallback（不产生意外窗口）', parseDays('-5', 30) === 30);
  ok('#42 超上限 clamp 到 3650', parseDays('99999', 30) === 3650);
  ok('#42 小数截断为整数天', parseDays('7.9', 30) === 7);

  // 行为级区分：40 天前的事件只在 days=0 出现（fixture 数据窗口不足 30 天时
  // 「by_day 行数对比」无法区分 0 与 7/30，直接在受控库注入老事件）
  const base = mkdtempSync(join(tmpdir(), 'days42-'));
  const store = new Store(join(base, 't42.db'));
  const now = Date.now();
  const d40 = now - 40 * 86_400_000;
  const ins = (ts, key) => store.insertEvent({ ts, tool: 'fake42', model: 'm', session_id: 's', project: null, dedup_key: key, input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  ins(now, 'now-1');
  ins(d40, 'old-1');
  ins(d40 + 60_000, 'old-2');
  try {
    const s0 = await buildSummary(store, {}, 0);
    const s7 = await buildSummary(store, {}, 7);
    const dayKeys = (s) => new Set(s.by_day.map((r) => r.day ?? r.d ?? r.date));
    const sumByDay = (s) => s.by_day.reduce((a, r) => a + r.total, 0);
    const oldKey = new Date(d40).toLocaleDateString('sv-SE');
    ok('#42 days=0 覆盖 40 天前事件（by_day 总量含老事件）',
      sumByDay(s0) > sumByDay(s7),
      `all=${sumByDay(s0)} 7d=${sumByDay(s7)}`);
    ok('#42 days=7 不含 40 天前事件（窗口语义未破坏）', !dayKeys(s7).has(oldKey));
    ok('#42 days=0 的 by_day 覆盖老事件日期', dayKeys(s0).has(oldKey), JSON.stringify([...dayKeys(s0)]));
    ok('#42 costs.by_day 同样随 days=0 扩到全量',
      s0.costs.by_day.length >= s7.costs.by_day.length && s0.costs.all_cny >= s7.costs.all_cny,
      `${s0.costs.by_day.length} vs ${s7.costs.by_day.length}`);
  } finally {
    try { store.db.close(); } catch { /* 句柄由进程回收 */ }
    rmSync(base, { recursive: true, force: true });
  }
}

/* ---------- [15] computeHealth 健康语义（#36） ---------- */
console.log('\n[15] computeHealth 单测（#36：stale/empty/error/ok 四态）');
{
  const { computeHealth } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'health36-'));
  const tool = SOURCES[0].tool; // 从注册表取真实 tool，与 computeHealth 的 tools 推导一致
  const now = Date.now();
  const statusOf = (db, st) => computeHealth(db, st).find((h) => h.tool === tool)?.status;
  const mkStore = () => new Store(join(base, `h-${Math.random().toString(36).slice(2)}.db`));
  try {
    // empty：从未采集
    const sEmpty = mkStore();
    ok('#36 无事件 → empty', statusOf(sEmpty.db, {}) === 'empty', statusOf(sEmpty.db, {}));
    sEmpty.db.close();

    // stale：文件在写（mtime 新）但最后事件旧 30 分钟以上
    const sStale = mkStore();
    sStale.insertEvent({ ts: now - 2 * 3_600_000, tool, dedup_key: 'h-stale' });
    sStale.saveFile({ path: '/x/y.jsonl', tool, session_id: 's', size: 1, mtime_ms: now, offset: 0, state_json: '{}' });
    ok('#36 mtime 新但无新事件 → stale', statusOf(sStale.db, {}) === 'stale', statusOf(sStale.db, {}));
    sStale.db.close();

    // error：本轮有解析错误
    const sErr = mkStore();
    sErr.insertEvent({ ts: now, tool, dedup_key: 'h-err' });
    ok('#36 parse_errors>0 → error', statusOf(sErr.db, { [tool]: { parse_errors: 2 } }) === 'error', statusOf(sErr.db, { [tool]: { parse_errors: 2 } }));
    sErr.db.close();

    // ok：正常使用间隔（最后事件 10 分钟前）
    const sOk = mkStore();
    sOk.insertEvent({ ts: now - 10 * 60_000, tool, dedup_key: 'h-ok' });
    ok('#36 正常使用间隔 → ok', statusOf(sOk.db, {}) === 'ok', statusOf(sOk.db, {}));
    sOk.db.close();

    const sField = mkStore();
    ok('#36 返回字段名保持 last_file_mtime（SQL 别名 max_mtime 不外泄）',
      computeHealth(sField.db, {}).every((h) => 'last_file_mtime' in h && !('max_mtime' in h)));
    sField.db.close();
  } finally {
    // Windows 上 WAL/-shm 句柄释放可能有延迟：重试并容忍清理失败（临时目录由系统回收）
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 延迟句柄 */ }
  }
}

/* ---------- [16] codex-pace 纯逻辑（#47） ---------- */
console.log('\n[16] codex-pace 消耗节奏与耗尽风险（#47：burn/EWMA/safe line/risk/ETA 契约）');
{
  const pace = await import(pathToFileURL(join(ROOT, 'src/codex-pace.js')).href);
  const H = 3_600_000;
  const s = (ts, windowId, used, capacity, resetsAt = null) => ({ ts, windowId, used, capacity, resetsAt });
  const W1 = 'w-5h-2026-09-18T10', W2 = 'w-5h-2026-09-18T15';

  // --- 固定序列精确验证（AC1） ---
  {
    // 单段：burn = 1000/h
    const r1 = pace.computePace([s(0, W1, 0, 10_000), s(H, W1, 1_000, 10_000)], H);
    ok('#47 两样本差商 → burn_rate=1000/h', r1.burn_rate_per_hour === 1000, String(r1.burn_rate_per_hour));
    ok('#47 ETA = 剩余/速率 = 9h', r1.eta_to_exhaust_ms === 9 * H, String(r1.eta_to_exhaust_ms));
    ok('#47 state ok 且 samples_used=2', r1.state === 'ok' && r1.samples_used === 2);
    // 三段 EWMA(α=0.5)：1000 → 1000+0.5*(2000-1000)=1500 → 1500+0.5*(3000-1500)=2250
    const r2 = pace.computePace([
      s(0, W1, 0, 100_000), s(H, W1, 1_000, 100_000), s(2 * H, W1, 3_000, 100_000), s(3 * H, W1, 6_000, 100_000),
    ], 3 * H);
    ok('#47 EWMA α=0.5 三段收敛于 2250/h', r2.burn_rate_per_hour === 2250, String(r2.burn_rate_per_hour));
    // safe line：cap 10000，窗口剩 1h，burn 1000/h → 预算 1250 → line 8750
    const r3 = pace.computePace([
      s(0, W1, 0, 10_000, 2 * H), s(H, W1, 1_000, 10_000, 2 * H),
    ], H);
    ok('#47 safe_usage_line = capacity - burn*剩余/0.8 = 8750', r3.safe_usage_line === 8750, String(r3.safe_usage_line));
  }

  // --- risk 分级（规则 7）：真实 5h 窗口（resetsAt = 5h），burn 1000/h ---
  {
    const mk = (used, cap = 1_000_000) => pace.computePace([s(0, W1, 0, cap), s(H, W1, used, cap, 5 * H)], H);
    ok('#47 risk low（10% 且外推不会在重置前耗尽）', mk(100_000).risk === 'low');
    // medium：used 70%（690k→700k，burn 10k/h），eta=30h > 重置剩余 4h → 不判 high
    const med = pace.computePace([s(0, W1, 690_000, 1_000_000), s(H, W1, 700_000, 1_000_000, 5 * H)], H);
    ok('#47 risk medium（70% 且外推不会在重置前耗尽）', med.risk === 'medium', `${med.risk} burn=${med.burn_rate_per_hour}`);
    ok('#47 risk high（≥85%）', mk(900_000).risk === 'high');
    // 70% 但外推将在重置前耗尽 → high（burn 70000/h，eta≈0.43h < 重置剩余 1h）
    const r = pace.computePace([s(0, W1, 0, 100_000, 2 * H), s(H, W1, 70_000, 100_000, 2 * H)], H);
    ok('#47 risk high（外推窗口内耗尽）', r.risk === 'high', `${r.risk} eta=${r.eta_to_exhaust_ms}`);
  }

  // --- reset relief（规则 8） ---
  {
    const near = pace.computePace([s(0, W1, 0, 10_000, H + 30 * 60_000), s(H, W1, 1_000, 10_000, H + 30 * 60_000)], H);
    ok('#47 reset_relief=true（重置临近 <2h）', near.reset_relief === true);
    const far = pace.computePace([s(0, W1, 0, 10_000, 100 * H), s(H, W1, 1_000, 10_000, 100 * H)], H);
    ok('#47 reset_relief=false（重置尚远）', far.reset_relief === false);
    const none = pace.computePace([s(0, W1, 0, 10_000), s(H, W1, 1_000, 10_000)], H);
    ok('#47 reset_relief=null（resetsAt 未知）', none.reset_relief === null);
  }

  // --- 窗口 reset / windowId 变化（AC2） ---
  {
    const r = pace.computePace([
      s(0, W1, 5_000, 10_000), s(H, W1, 8_000, 10_000),
      s(10 * H, W2, 100, 10_000),
    ], 10 * H);
    ok('#47 窗口 reset 后旧窗口样本弃用（used 取新窗口）', r.used === 100 && r.state === 'unknown');
    ok('#47 新窗口单样本 → unknown single_sample', r.unknown_reason === 'single_sample', r.unknown_reason);
  }

  // --- 时间倒退 / 用量回落 / 非法值（AC2/AC3） ---
  {
    // 时间倒退：时间序差商为负被丢弃 → 无可信速率段 → invalid_values
    const back = pace.computePace([s(2 * H, W1, 1_000, 10_000), s(H, W1, 2_000, 10_000)], 1.1 * H);
    ok('#47 时间倒退差商被丢弃 → unknown',
      back.state === 'unknown' && back.unknown_reason === 'invalid_values',
      back.unknown_reason);
    // 回落段（5k→2k，负差商）跳过不进 EWMA；后续段继续递归：
    // 段1 rate=5000 → ewma=5000；段2 丢弃；段3 rate=1000 → 5000+0.5*(-4000)=3000
    //（若回落段未被丢弃，ewma 会是 5000+0.5*(-3000-5000)=1000——断言值即证明）
    const drop = pace.computePace([s(0, W1, 0, 100_000), s(H, W1, 5_000, 100_000), s(2 * H, W1, 2_000, 100_000), s(3 * H, W1, 3_000, 100_000)], 3 * H);
    ok('#47 回落段不计入 burn（负差商丢弃，EWMA 跨段连续递归）',
      drop.burn_rate_per_hour === 3000, String(drop.burn_rate_per_hour));
    const bad = pace.computePace([s(0, W1, NaN, 10_000), s(H, W1, -5, 10_000)], H);
    ok('#47 NaN/负值全无效 → invalid_values 且无假 ETA',
      bad.state === 'unknown' && bad.unknown_reason === 'invalid_values' && bad.eta_to_exhaust_ms === null);
  }

  // --- 陈旧样本 / 容量缺失 / 空输入（AC3） ---
  {
    const stale = pace.computePace([s(0, W1, 1_000, 10_000), s(H, W1, 2_000, 10_000)], H + pace.STALE_SAMPLE_MS + 1);
    ok('#47 陈旧样本 → stale_samples（事实字段保留）',
      stale.unknown_reason === 'stale_samples' && stale.used === 2_000 && stale.capacity === 10_000);
    const noCap = pace.computePace([s(0, W1, 100, null), s(H, W1, 500, null)], H);
    ok('#47 容量缺失 → no_capacity（burn 照给，remaining/risk/ETA 为 null）',
      noCap.unknown_reason === 'no_capacity' && noCap.burn_rate_per_hour === 400 && noCap.remaining === null
        && noCap.risk === 'unknown' && noCap.eta_to_exhaust_ms === null,
      JSON.stringify(noCap));
    const empty = pace.computePace([], Date.now());
    ok('#47 空输入 → no_samples', empty.unknown_reason === 'no_samples');
  }

  // --- 显式 0 与缺失可区分（AC3 规则 6） ---
  {
    const zero = pace.computePace([s(0, W1, 0, 10_000), s(H, W1, 0, 10_000)], H);
    ok('#47 used=0 是合法值（刚重置）：state ok、percent=0、burn=0、无假 ETA',
      zero.state === 'ok' && zero.used === 0 && zero.used_percent === 0
        && zero.burn_rate_per_hour === 0 && zero.eta_to_exhaust_ms === null,
      JSON.stringify(zero));
    const missing = pace.computePace([s(0, W1, null, 10_000), s(H, W1, null, 10_000)], H);
    ok('#47 used 缺失为 null 而非 0', missing.used === null && missing.used_percent === null);
    const cap0 = pace.computePace([s(0, W1, 0, 0), s(H, W1, 0, 0)], H);
    ok('#47 capacity=0（容量为零）→ 直接 high', cap0.risk === 'high');
  }

  // --- 纯逻辑边界（AC4）：模块不 import 任何 IO/执行面 ---
  {
    const src47 = readFileSync(join(ROOT, 'src/codex-pace.js'), 'utf8');
    ok('#47 纯逻辑：无 node:fs/net/http/sqlite/child_process import',
      !/from ['"]node:(fs|net|http|sqlite|child_process)|from ['"]\.\//.test(src47));
    ok('#47 无网络请求/进程执行调用面', !/fetch\(|http\.request|exec\(|spawn\(/.test(src47));
  }
}

/* ---------- [17] Codex 配额窗口采集（#44） ---------- */
console.log('\n[17] Codex rate_limits 规范化（#44：三窗口/0与缺失可区分/ms 时间戳/坏字段不抛穿）');
{
  const { normalizeRateLimits, collectCodexFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/codex.js')).href);
  const T0 = Date.parse('2026-09-18T10:00:00Z');

  // --- 纯函数：normalizeRateLimits ---
  {
    const n = normalizeRateLimits({
      plan_type: 'pro',
      primary: { used_percent: 0, window_minutes: 300, resets_at: '2026-09-18T15:00:00Z', credits: 12 },
      secondary: { used_percent: 7, window_minutes: 10080, resets_at: '2026-09-25T00:00:00Z' },
      monthly: { used_percent: 3, window_minutes: 43200, resets_at: '2026-10-01T00:00:00Z', capacity: 1_500_000, remaining: 1_455_000 },
      duration_minutes: 300,
    }, T0);
    ok('#44 三窗口全部规范化', n.windows.map((w) => w.kind).join(',') === 'primary,secondary,monthly');
    ok('#44 primary 字段精确（黄金数字：pct=0 保留、credits、ms 时间戳）',
      n.windows[0].used_percent === 0 && n.windows[0].window_minutes === 300
        && n.windows[0].resets_at === '2026-09-18T15:00:00Z'
        && n.windows[0].resets_at_ms === Date.parse('2026-09-18T15:00:00Z')
        && n.windows[0].credits === 12,
      JSON.stringify(n.windows[0]));
    ok('#44 monthly 的 capacity/remaining 解析',
      n.windows[2].capacity === 1_500_000 && n.windows[2].remaining === 1_455_000);
    ok('#44 plan_type/duration/collected_at',
      n.plan_type === 'pro' && n.duration_minutes === 300 && n.collected_at === T0);
    ok('#44 字段缺失 → null（不静默变 0）',
      normalizeRateLimits({ primary: { used_percent: 42 } }, T0).windows[0].window_minutes === null);
    ok('#44 空 window 对象不产出条目；三窗口全缺 → null',
      normalizeRateLimits({ primary: {}, secondary: {} }, T0) === null);
    ok('#44 raw 非对象/空 → null（来源级可诊断）',
      normalizeRateLimits(null, T0) === null && normalizeRateLimits('x', T0) === null
        && normalizeRateLimits({}, T0) === null);
  }

  // --- 端到端：合成 fixture（中文+空格路径）→ collect → 假 store 黄金数字 ---
  {
    const base = mkdtempSync(join(tmpdir(), 'codex44 会话 目录-'));
    const file = join(base, 'rollout-2026-09-18T10-00-00-abc.jsonl');
    const lines = [
      JSON.stringify({ timestamp: '2026-09-18T10:00:00Z', type: 'session_meta', payload: { cwd: 'D:\\工作 项目\\demo' } }),
      // 首个 token_count：只建基线，不产事件
      JSON.stringify({ timestamp: '2026-09-18T10:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 150 } }, rate_limits: { plan_type: 'pro', primary: { used_percent: 42, window_minutes: 300, resets_at: '2026-09-18T15:00:00Z' } } } }),
      // 第二个：差分产出事件（新输入 = input - cached = 50；total = input+output 口径）
      JSON.stringify({ timestamp: '2026-09-18T10:05:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 90, reasoning_output_tokens: 20, total_tokens: 290 } }, rate_limits: { plan_type: 'pro', primary: { used_percent: 44, window_minutes: 300, resets_at: '2026-09-18T15:00:00Z' }, secondary: { used_percent: 7, window_minutes: 10080, resets_at: '2026-09-25T00:00:00Z' } } } }),
      // 坏 rate_limits：不抛穿
      JSON.stringify({ timestamp: '2026-09-18T10:06:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 210, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 90, reasoning_output_tokens: 20, total_tokens: 300 } }, rate_limits: 'garbage' } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    const quotas = [];
    const events = [];
    const seenKeys = new Set();
    const fakeStore = {
      saveQuota: (tool, ts, data) => quotas.push({ tool, ts, data }),
      insertEvent: (e) => {
        if (seenKeys.has(e.dedup_key)) return 0;
        seenKeys.add(e.dedup_key);
        events.push(e);
        return 1;
      },
      insertToolCall: () => 1,
    };
    const ctx = { path: file, fileId: 'abc', offset: 0, state: null, version: 3 };
    const r1 = await collectCodexFile(fakeStore, ctx);
    // 黄金数字（第 2 行差分）：新输入 = Δinput-Δcached = 100-40 = 60；total = Δinput+Δoutput = 140
    //（第 3 行差分 input 210-200=10 → 另有一条 input=10 的小事件）
    ok('#44 端到端：差分事件黄金数字（新输入=60/cached=40/output=40/total=140）',
      events.length === 2 && events[0].input_tokens === 60 && events[0].cached_input === 40
        && events[0].output_tokens === 40 && events[0].reasoning_tokens === 10 && events[0].total_tokens === 140,
      JSON.stringify(events[0]));
    ok('#44 端到端：最新配额快照含规范化窗口（primary+secondary）',
      quotas.length === 2 && quotas[1].data.windows.length === 2
        && quotas[1].data.windows[0].used_percent === 44
        && quotas[1].data.windows[1].kind === 'secondary' && quotas[1].data.windows[1].used_percent === 7,
      JSON.stringify(quotas.at(-1)));
    ok('#44 兼容字段保留（used_percent/window_minutes/resets_at/plan_type 顶层）',
      quotas[1].data.used_percent === 44 && quotas[1].data.plan_type === 'pro');
    ok('#44 坏 rate_limits 不抛穿（事件照常产出）',
      events.length === 2 && r1.state.cum.tt === 300, `cum=${r1.state.cum?.tt}`);
    // 幂等：增量重扫（offset 从 newOffset 继续、state 恢复）→ 零新事件
    const r2 = await collectCodexFile(fakeStore, { ...ctx, offset: r1.newOffset, state: r1.state });
    ok('#44 增量重扫幂等（游标恢复，inserted=0）', r2.inserted === 0 && events.length === 2, `inserted=${r2.inserted}`);
    rmSync(base, { recursive: true, force: true });
  }
}

/* ---------- [18] Codex 配额快照历史存储（#45） ---------- */
console.log('\n[18] Codex 配额历史（#45：幂等迁移/去重/0 与 NULL/getQuota 兼容/读取边界）');
{
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'codex45 中文 目录-'));
  const dbPath = join(base, 't45.db');
  // 与 #44 契约一致的规范化快照
  const snap = (ts, pct, resets) => ({
    ts,
    data: {
      used_percent: pct, plan_type: 'pro',
      windows: [
        { kind: 'primary', used_percent: pct, window_minutes: 300, resets_at_ms: resets, resets_at: new Date(resets).toISOString() },
        { kind: 'secondary', used_percent: pct / 2, window_minutes: 10080, resets_at_ms: resets + 7 * 86_400_000, resets_at: new Date(resets + 7 * 86_400_000).toISOString() },
      ],
    },
  });

  try {
    // 全新库
    const s1 = new Store(dbPath);
    const t1 = 1_700_000_000_000, t2 = t1 + 60_000, reset1 = t1 + 3 * 3_600_000;
    s1.saveQuota('codex', t1, snap(t1, 42, reset1).data);
    s1.saveQuota('codex', t2, snap(t2, 44, reset1).data);
    ok('#45 每窗口一行历史（2 窗口 × 2 采样 = 4 行）',
      s1.getCodexQuotaHistory().length === 4, String(s1.getCodexQuotaHistory().length));
    // 同一采集点重复写入不产生重复样本
    s1.saveQuota('codex', t2, snap(t2, 44, reset1).data);
    ok('#45 同点重复写入去重（仍 4 行）', s1.getCodexQuotaHistory().length === 4);
    // used 推导：capacity 未知 → NULL（不伪造）；显式 0 保留
    const rowUsed = s1.getCodexQuotaHistory({ windowKind: 'primary', limit: 1 })[0];
    ok('#45 capacity 缺失时 used=NULL（绝不伪造样本）', rowUsed.used === null && rowUsed.used_percent === 44);
    s1.saveQuota('codex', t2 + 1, { windows: [{ kind: 'primary', used_percent: 0, capacity: 1000, resets_at_ms: reset1 }] });
    const zeroRow = s1.getCodexQuotaHistory({ windowKind: 'primary', limit: 1 })[0];
    ok('#45 显式 0 保留（used_percent=0、used=0）',
      zeroRow.used_percent === 0 && zeroRow.used === 0, JSON.stringify(zeroRow));
    // 窗口 reset 切换：resets_at_ms 变化 → window_id 变化
    const reset2 = reset1 + 5 * 3_600_000;
    s1.saveQuota('codex', t2 + 2, snap(t2 + 2, 5, reset2).data);
    const ids = [...new Set(s1.getCodexQuotaHistory({ windowKind: 'primary' }).map((r) => r.window_id))];
    ok('#45 重置后 window_id 切换（两个窗口代际）', ids.length === 2, JSON.stringify(ids));
    // getQuota('codex') 兼容
    const q = s1.getQuota('codex');
    ok('#45 getQuota(codex) 仍返回最新兼容快照', q && q.data.used_percent === 5 && Array.isArray(q.data.windows));
    // 读取边界：sinceTs/untilTs/limit、降序
    const bounded = s1.getCodexQuotaHistory({ windowKind: 'primary', sinceTs: t2, untilTs: t2 + 1 });
    ok('#45 时间边界过滤（t2 与 t2+1 两行）', bounded.length === 2, String(bounded.length));
    const limited = s1.getCodexQuotaHistory({ limit: 2 });
    ok('#45 limit 生效且 ts 降序',
      limited.length === 2 && limited[0].ts >= limited[1].ts);
    // 打开失败恢复：历史表被删后 saveQuota 不崩溃（尽力而为），重开 Store 后恢复可用
    s1.db.exec('DROP TABLE codex_quota_history');
    let threw = false;
    try { s1.saveQuota('codex', t2 + 3, snap(t2 + 3, 6, reset2).data); } catch { threw = true; }
    ok('#45 历史异常不崩溃（saveQuota 不传播错误）', !threw);
    s1.db.close();
    // 旧库重开：迁移补表（幂等），既有数据未破坏
    const s2 = new Store(dbPath);
    ok('#45 旧库重开迁移补表且既有 events/quota 未破坏',
      Array.isArray(s2.getCodexQuotaHistory({ limit: 1 })) && s2.getQuota('codex') != null);
    s2.db.close();
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 延迟句柄 */ }
  }
}

/* ---------- [19] /api/codex/* 只读契约（#46） ---------- */
console.log('\n[19] /api/codex/* 契约（#46：窗口/吞吐/pace/cost/明细/日报/CSV；降级不 500）');
{
  const { startServer } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const base = mkdtempSync(join(tmpdir(), 'codex46-'));
  const store = new Store(join(base, 't46.db'));
  // 种子：codex 事件（含中文项目名）+ 配额快照（带历史）
  const now = Date.now();
  store.insertEvent({ ts: now - 3_600_000, tool: 'codex', model: 'glm-5.3-flash', session_id: 'sess-中文 1', project: '工作 项目A', dedup_key: 'c46-1', input_tokens: 1000, cached_input: 200, cache_write: 50, output_tokens: 300, reasoning_tokens: 80, total_tokens: 1300 });
  store.insertEvent({ ts: now - 60_000, tool: 'codex', model: null, session_id: 'sess-2', project: null, dedup_key: 'c46-2', input_tokens: 500, cached_input: 0, cache_write: 0, output_tokens: 100, reasoning_tokens: null, total_tokens: 600 });
  store.saveQuota('codex', now - 30_000, {
    used_percent: 40, plan_type: 'pro',
    windows: [
      { kind: 'primary', used_percent: 40, window_minutes: 300, resets_at_ms: now + 3_600_000, resets_at: new Date(now + 3_600_000).toISOString() },
      { kind: 'secondary', used_percent: 10, window_minutes: 10080, resets_at_ms: now + 5 * 86_400_000, resets_at: new Date(now + 5 * 86_400_000).toISOString(), capacity: 1_000_000, remaining: 900_000 },
    ],
  });
  const { EventEmitter } = await import('node:events');
  const fakeScanner = Object.assign(new EventEmitter(), { stats: {} });
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const server = await startServer({ store, scanner: fakeScanner, port, log: () => {} });
  await new Promise((r) => setTimeout(r, 600)); // listen 就绪
  const get = async (path) => { const res = await fetch(`http://127.0.0.1:${port}${path}`); return { status: res.status, body: await res.json(), res }; };

  try {
    const sum = await get('/api/codex/summary');
    ok('#46 summary：两窗口 + plan + freshness（不 500）',
      sum.status === 200 && sum.body.windows.length === 2 && sum.body.plan_type === 'pro'
        && sum.body.freshness?.stale === false && sum.body.state === 'ok',
      JSON.stringify(sum.body).slice(0, 120));
    const thr = await get('/api/codex/throughput?days=7');
    ok('#46 throughput：breakdown + by_day/by_hour/by_model',
      thr.status === 200 && thr.body.totals.requests === 2 && thr.body.totals.total === 1900
        && thr.body.by_day.length >= 1 && thr.body.by_model.length >= 1,
      JSON.stringify(thr.body.totals));
    const thr0 = await get('/api/codex/throughput?days=0');
    ok('#46 throughput days=0 全量（与 7 天等价或更大）',
      thr0.status === 200 && thr0.body.totals.total >= thr.body.totals.total);
    const pace = await get('/api/codex/pace');
    ok('#46 pace：序列化 #47 computePace 输出（单样本历史 → unknown 优雅降级）',
      pace.status === 200 && pace.body.pace && typeof pace.body.pace.state === 'string'
        && pace.body.pace.state === 'unknown' && pace.body.sample_count === 1,
      JSON.stringify(pace.body.pace).slice(0, 120));
    const cost = await get('/api/codex/cost?window=weekly');
    ok('#46 cost：disclaimer/models/unpriced_models/fx 字段齐备',
      cost.status === 200 && typeof cost.body.disclaimer === 'string'
        && Array.isArray(cost.body.models) && Array.isArray(cost.body.unpriced_models)
        && 'usd_to_cny' in cost.body.fx,
      JSON.stringify(cost.body).slice(0, 140));
    const ev = await get(`/api/codex/events?model=${encodeURIComponent('glm-5.3-flash')}`);
    ok('#46 events：按 model 筛选（中文 session/project 原样返回）',
      ev.status === 200 && ev.body.count === 1 && ev.body.events[0].session_id === 'sess-中文 1'
        && ev.body.events[0].project === '工作 项目A');
    const rep = await get('/api/codex/report');
    ok('#46 report：by_model + reasoning known/unknown coverage',
      rep.status === 200 && rep.body.by_model.length === 2
        && rep.body.reasoning_coverage.known === 1 && rep.body.reasoning_coverage.unknown === 1,
      JSON.stringify(rep.body.reasoning_coverage));
    const csvRes = await fetch(`http://127.0.0.1:${port}/api/codex/export.csv?day=${new Date(now).toLocaleDateString('sv-SE')}`);
    const csvBuf = await csvRes.arrayBuffer();
    const csvText = new TextDecoder('utf-8').decode(csvBuf);
    // WHATWG text() 会剥 BOM，故检查原始字节 EF BB BF（Excel 兼容的 UTF-8 BOM 契约）
    const hasBom = csvBuf.byteLength >= 3
      && new Uint8Array(csvBuf.slice(0, 3)).join(',') === '239,187,191';
    ok('#46 CSV：UTF-8 BOM + 中文/逗号转义可解析',
      csvRes.status === 200 && hasBom
        && csvText.includes('sess-中文 1') && (csvText.match(/\n/g) || []).length === 3,
      `bom=${hasBom} nl=${(csvText.match(/\n/g) || []).length}`);
    // 旧库降级：无快照的空库不 500
    const emptyStore = new Store(join(base, 'empty46.db'));
    const port2 = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const server2 = await startServer({ store: emptyStore, scanner: Object.assign(new EventEmitter(), { stats: {} }), port: port2, log: () => {} });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const e1 = await fetch(`http://127.0.0.1:${port2}/api/codex/summary`);
      const e1b = await e1.json();
      ok('#46 空库 summary 优雅降级（200 + unknown_reason）',
        e1.status === 200 && e1b.state === 'unknown' && e1b.unknown_reason === 'no_quota_snapshot');
      const e2 = await fetch(`http://127.0.0.1:${port2}/api/codex/pace`);
      ok('#46 空库 pace 优雅降级（no_samples）',
        e2.status === 200 && (await e2.json()).pace.unknown_reason === 'no_samples');
    } finally {
      server2.close();
      try { emptyStore.db.close(); } catch { /* 句柄 */ }
    }
    // 隐私：响应不含 token/OAuth/代理凭据样式
    const all = JSON.stringify([sum.body, thr.body, pace.body, cost.body, ev.body, rep.body]);
    ok('#46 无凭据泄漏（sk-/Bearer/oauth 字样零出现）',
      !/sk-[A-Za-z0-9]|Bearer\s|oauth/i.test(all));
  } finally {
    server.close();
    try { store.db.close(); } catch { /* 句柄 */ }
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 延迟句柄 */ }
  }
}

/* ---------- [20] 共享 CNY/USD 展示层（#38） ---------- */
console.log('\n[20] 共享货币展示层（#38：唯一换算入口/USD=¥÷汇率/余额原币种）');
{
  const money = await import(pathToFileURL(join(ROOT, 'web/lib/money.js')).href);
  const appSrc = read(join(ROOT, 'web/app.js'));
  const htmlSrc = read(join(ROOT, 'web/index.html'));
  money.initMoney({ usd_to_cny: 7.2, fx_source: 'cache', fx_ts: 1700000000000 });

  ok('#38 默认 CNY 且 ¥ 两位小数', money.getCurrency() === 'CNY' && money.formatMoney(1.234) === '¥1.23');
  money.setCurrency('USD');
  ok('#38 USD=CNY÷同一份汇率（$ 前缀 2 位）', money.formatMoney(7.2) === '$1.00' && money.formatMoney(36) === '$5.00');
  { // 模拟汇率从未就绪：cache-bust 重载一个全新模块实例（initMoney 合法值才覆盖，单例不可清空）
    const fresh = await import(pathToFileURL(join(ROOT, 'web/lib/money.js')).href + '?fresh=1');
    fresh.setCurrency('USD');
    ok('#38 汇率未就绪时 USD 显示 —（不假装换算）', fresh.formatMoney(7.2) === '—', fresh.formatMoney(7.2));
  }
  money.initMoney({ usd_to_cny: 7.2 });
  money.setCurrency('CNY');
  ok('#38 非数值 → —（缺失不伪装成 0）；显式 0 保留',
    money.formatMoney(null) === '—' && money.formatMoney(undefined) === '—' && money.formatMoney(0) === '¥0.00');
  money.setCurrency('EUR');
  ok('#38 非法货币值回 CNY', money.getCurrency() === 'CNY');
  ok('#38 轴标签精简版存在（整数位）', money.formatMoneyAxis(36.7) === '¥37');
  ok('#38 getFx 透传来源/时间（切换时说明仍可见的数据源）',
    money.getFx().fx_source === 'cache' && money.getFx().usd_to_cny === 7.2 && money.getFx().fx_ts === 1700000000000);
  money.initMoney({ usd_to_cny: -1 });
  ok('#38 initMoney 拒绝非法汇率（<=0 不覆盖）', money.getFx().usd_to_cny === 7.2);

  // 结构断言：全站金额走共享层
  ok('#38 app.js 金额经 formatMoney（模板字符串硬编码 ¥ 已移除）',
    /formatMoney/.test(appSrc) && !/`¥\$\{/.test(appSrc) && !/'¥' \+ v/.test(appSrc));
  ok('#38 厂商余额卡与对账行保持原币种（不经 money.js）',
    appSrc.includes('¥ ${Number(b.balance).toFixed(2)}') && appSrc.includes('余额 ${rc.delta.toFixed(2)} ¥'));
  ok('#38 index.html 提供 CNY/USD 切换控件', /id="currency"/.test(htmlSrc) && htmlSrc.includes('value="USD"'));
  ok('#38 切换经 setCurrency + load() 重渲染',
    /setCurrency\(sel\.value\)/.test(appSrc) && /initMoney\(data\.costs \|\| data\)/.test(appSrc));
}

/* ---------- [21] 未配价可操作 + 改价即时生效（#37） ---------- */
console.log('\n[21] 未配价明细/模板 + loadPricing mtime 失效（#37）');
{
  const { loadPricing, isPriced } = await import(pathToFileURL(join(ROOT, 'src/pricing.js')).href);
  const { startServer } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
  const { utimesSync, copyFileSync } = await import('node:fs');
  const appSrc = read(join(ROOT, 'web/app.js'));
  const pricingSrc = read(join(ROOT, 'src/pricing.js'));

  // --- loadPricing mtime/size 失效（临时路径注入，不碰真实 pricing.json） ---
  {
    const base = mkdtempSync(join(tmpdir(), 'pricing37 中文-'));
    const pf = join(base, 'pricing.json');
    writeFileSync(pf, JSON.stringify({ _note: 'v1', models: { 'model-a': { currency: 'USD', input_miss: 1, input_hit: 0.1, output: 2 } } }));
    const p1 = await loadPricing(pf);
    ok('#37 初次加载读到 model-a', p1.models['model-a']?.input_miss === 1);
    // 改文件：内容不同（size 变化）+ utimes 强制 mtime 变化
    writeFileSync(pf, JSON.stringify({ _note: 'v2', models: { 'model-a': { currency: 'USD', input_miss: 9, input_hit: 0.1, output: 2 } } }));
    const now = new Date();
    utimesSync(pf, now, new Date(now.getTime() - 5_000));
    const p2 = await loadPricing(pf);
    ok('#37 修改后不重启即生效（mtime/size 失效缓存）', p2.models['model-a']?.input_miss === 9, String(p2.models['model-a']?.input_miss));
    // 未变化：缓存命中（mtime/size 相同时不再读盘——行为一致即可，不监测 IO 次数）
    const p3 = await loadPricing(pf);
    ok('#37 未变化时返回缓存（内容一致）', p3.models['model-a']?.input_miss === 9);
    rmSync(base, { recursive: true, force: true });
  }

  // --- isPriced：与 priceOf 同源 ---
  {
    const table = { 'm-local': { currency: 'USD', input_miss: 1, input_hit: 0, output: 1 } };
    ok('#37 isPriced：本地表命中 true / 表外 null false', isPriced('m-local', table) === true && isPriced('no-such-model-xyz', table) === false);
  }

  // --- /api/unpriced 与模板路由（端到端） ---
  {
    const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
    const base = mkdtempSync(join(tmpdir(), 'unpriced37-'));
    const store = new Store(join(base, 't37.db'));
    const now = Date.now();
    // 一个未配价模型 + 一个 seed 表内模型（deepseek-v4-pro）
    store.insertEvent({ ts: now - 60_000, tool: 'fake37', model: 'totally-unpriced-model-xyz', dedup_key: 'u1', input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    store.insertEvent({ ts: now - 30_000, tool: 'fake37', model: 'deepseek-v4-pro', dedup_key: 'u2', input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    const fakeScanner = Object.assign(new (await import('node:events')).EventEmitter(), { stats: {} });
    const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const server = await startServer({ store, scanner: fakeScanner, port, log: () => {} });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/unpriced`);
      const body = await res.json();
      ok('#37 /api/unpriced 只列未配价（tokens 降序，配价模型被过滤）',
        res.status === 200 && body.count === 1 && body.models[0].model === 'totally-unpriced-model-xyz'
          && body.models[0].tokens === 150 && body.models[0].calls === 1 && Number.isFinite(body.models[0].last_ts),
        JSON.stringify(body));
      const tpl = await fetch(`http://127.0.0.1:${port}/api/unpriced/template`);
      const tplText = await tpl.text();
      const tplJson = JSON.parse(tplText);
      ok('#37 模板：含 _readme 说明 + 全部未配价模型名 + 待填字段',
        tpl.status === 200 && typeof tplJson._readme === 'string' && tplJson._readme.includes('每百万')
          && tplJson.models['totally-unpriced-model-xyz']?.input_miss === 0
          && !tplJson.models['deepseek-v4-pro'],
        tplText.slice(0, 120));
      ok('#37 模板响应带 attachment 头',
        (tpl.headers.get('content-disposition') || '').includes('pricing-template.json'));
    } finally {
      server.close();
      try { store.db.close(); } catch { /* 句柄 */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* 延迟 */ }
    }
  }

  // --- 结构断言 ---
  ok('#37 _note 与真实行为一致（保存即自动重载）',
    pricingSrc.includes('保存即自动重载') && !cachedNoteStale(pricingSrc));
  ok('#37 app.js：未配价提示可点开（details + 明细表 + 模板下载链接）',
    appSrc.includes('id="unpriced-box"') && appSrc.includes('/api/unpriced/template')
      && appSrc.includes('fillUnpriced'));
}

function cachedNoteStale(src) {
  // 旧文案「编辑后即时生效」且无「自动重载」说明视为未修正
  return !src.includes('自动重载');
}

/* ---------- [22] 单应用×每模型明细（#35） ---------- */
console.log('\n[22] source×model 聚合与应用选择器（#35）');
{
  const { startServer } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const { EventEmitter } = await import('node:events');
  const base = mkdtempSync(join(tmpdir(), 'sm35-'));
  const store = new Store(join(base, 't35.db'));
  const now = Date.now();
  store.insertEvent({ ts: now - 60_000, tool: 'srcA', model: 'glm-5.3-flash', dedup_key: 's35-1', input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  store.insertEvent({ ts: now - 50_000, tool: 'srcA', model: 'kimi-k3', dedup_key: 's35-2', input_tokens: 200, output_tokens: 20, total_tokens: 220 });
  store.insertEvent({ ts: now - 40_000, tool: 'srcB', model: 'glm-5.3-flash', dedup_key: 's35-3', input_tokens: 5, output_tokens: 5, total_tokens: 10 });
  const fakeScanner = Object.assign(new EventEmitter(), { stats: {} });
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const server = await startServer({ store, scanner: fakeScanner, port, log: () => {} });
  await new Promise((r) => setTimeout(r, 500));
  try {
    const a = await (await fetch(`http://127.0.0.1:${port}/api/source-model?tool=srcA&days=30`)).json();
    ok('#35 srcA 明细 tokens 降序（kimi 220 > glm 150）',
      a.models.length === 2 && a.models[0].model === 'kimi-k3' && a.models[0].tokens === 220
        && a.models[0].calls === 1 && Number.isFinite(a.models[0].last_ts),
      JSON.stringify(a));
    const b = await (await fetch(`http://127.0.0.1:${port}/api/source-model?tool=srcB&days=0`)).json();
    ok('#35 srcB 只含自己的模型（days=0 全量）', b.models.length === 1 && b.models[0].tokens === 10);
    const empty = await (await fetch(`http://127.0.0.1:${port}/api/source-model`)).json();
    ok('#35 未指定 tool → 空列表（不 500）', empty.models.length === 0);
    // 全局聚合不受影响
    const sum = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=30`)).json();
    ok('#35 全局 by_model/by_tool 不被新路由破坏',
      Array.isArray(sum.by_model) && sum.by_model.length === 2 && Array.isArray(sum.by_tool));
    // 前端结构：选择器来自注册表，无硬编码来源名单
    const appSrc = read(join(ROOT, 'web/app.js'));
    const htmlSrc = read(join(ROOT, 'web/index.html'));
    ok('#35 前端有应用选择器且选项来自 /api/sources（无硬编码名单）',
      /id="model-source"/.test(htmlSrc) && appSrc.includes('buildModelSourceFilter')
        && appSrc.includes('SOURCE_META.labels') && /\/api\/source-model/.test(appSrc));
    ok('#35 切换逻辑：空值恢复全局 by_model，选中拉明细',
      appSrc.includes('renderModel(lastSummary.by_model)'));
  } finally {
    server.close();
    try { store.db.close(); } catch { /* 句柄 */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* 延迟 */ }
  }
}

/* ---------- [23] Codex 独立页（#48） ---------- */
console.log('\n[23] /codex 独立页（#48：路由/入口/状态保持/契约消费/免责声明）');
{
  const appSrc = read(join(ROOT, 'web/app.js'));
  const htmlSrc = read(join(ROOT, 'web/index.html'));
  const codexHtml = read(join(ROOT, 'web/codex.html'));
  const codexJs = read(join(ROOT, 'web/codex.js'));
  const serverSrc = read(join(ROOT, 'src/server.js'));

  // 服务端稳定路由
  ok('#48 /codex 稳定可书签路由（serveFile codex.html）',
    serverSrc.includes("p === '/codex' || p === '/codex/'") && serverSrc.includes("codex.html"));
  // 首页入口（唯一改动）
  ok('#48 首页有进入 Codex 详细页的入口', /id="codex-entry" href="\/codex"/.test(htmlSrc));
  // 资源同族（#53 一套 CSP 可覆盖两页）
  ok('#48 codex.html 资源加载与首页同族（本地 css/echarts/module）',
    codexHtml.includes('href="/style.css"') && codexHtml.includes('src="/vendor/echarts.min.js"')
      && codexHtml.includes('type="module" src="/codex.js"') && !codexHtml.includes('http://') && !codexHtml.includes('https://'));
  // 契约消费：只吃 #46 接口；金额只经 #38；前端零 burn 算法
  ok('#48 codex.js 只消费 /api/codex/* 契约',
    codexJs.includes('/api/codex/summary') && codexJs.includes('/api/codex/throughput')
      && codexJs.includes('/api/codex/pace') && codexJs.includes('/api/codex/cost'));
  ok('#48 金额只经 #38 money.js（页面内无第二套货币换算）',
    codexJs.includes("from './lib/money.js'") && !codexJs.includes('¥')
      && !codexJs.includes('usd_to_cny *') && !codexJs.includes('/ usd_to_cny'));
  ok('#48 pace 只展示 #47 结果（引用字段做展示属合法；无本地重算函数）',
    !codexJs.includes('EWMA') && !codexJs.includes('function computePace')
      && !codexJs.includes('eta_to_exhaust_ms =') && codexJs.includes('pace.burn_rate_per_hour'));
  ok('#48 免责声明：API 等值估算不是订阅账单',
    codexJs.includes('API 等值估算，不是订阅真实账单'));
  ok('#48 monthly 缺失显式提示（null 不是 0，布局不跳动）',
    codexJs.includes('monthly') && codexJs.includes('null，不是 0'));
  // 返回导航 + 首页状态保持（R5 陷阱）
  ok('#48 页面内返回（history.back 优先、书签进入兜底跳 /）',
    codexJs.includes('history.back()') && codexJs.includes("history.length > 1"));
  ok('#48 首页 days 用 sessionStorage 保持（返回后不被重置回 7）',
    appSrc.includes("sessionStorage.getItem('tm.days')") && appSrc.includes('persistDays()'));
  // DOM/资源证据（AC8）：真实服务下页面与全部资源可达
  {
    const { startServer } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
    const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
    const { EventEmitter } = await import('node:events');
    const base48 = mkdtempSync(join(tmpdir(), 'codex48-'));
    const s48 = new Store(join(base48, 't.db'));
    const fakeScanner = Object.assign(new EventEmitter(), { stats: {} });
    const p48 = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const srv = await startServer({ store: s48, scanner: fakeScanner, port: p48, log: () => {} });
    await new Promise((r) => setTimeout(r, 400));
    try {
      const page = await fetch(`http://127.0.0.1:${p48}/codex`);
      const html = await page.text();
      const containers = ['codex-cards', 'codex-quota', 'codex-day', 'codex-hour', 'codex-pace', 'codex-cost', 'codex-breakdown', 'back-home'];
      const jsRes = await fetch(`http://127.0.0.1:${p48}/codex.js`);
      ok('#48 /codex 真实服务 200、全部容器 id 存在、codex.js 可达（DOM 证据）',
        page.status === 200 && (page.headers.get('content-type') || '').includes('html')
          && containers.every((id) => html.includes(id)) && jsRes.status === 200,
        `page=${page.status} js=${jsRes.status}`);
    } finally {
      srv.close();
      try { s48.db.close(); } catch { /* 句柄 */ }
      try { rmSync(base48, { recursive: true, force: true }); } catch { /* 延迟 */ }
    }
  }
}

/* ---------- 清理 ---------- */
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

function read(p) { return readFileSync(p, 'utf8'); }
import { readFileSync, statSync } from 'node:fs';
