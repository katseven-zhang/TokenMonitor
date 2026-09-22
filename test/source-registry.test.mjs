/**
 * Win-Core：来源 manifest 注册器与 Windows 根目录发现。
 * 运行：TOKENMONITOR_OFFLINE=1 node test/source-registry.test.mjs
 *
 * #66 重定位说明（本文件此前"既不测东西、也不会有效变红"的两处根因）：
 *
 * 1. 旧版把 9 个来源的 kind/version/apiBilled 逐条写死在 EXPECTED 表里。version 是
 *    采集逻辑升级时**必须改**的字段（CONTRIBUTING：改完 collector 把 version +1），
 *    于是 codex 从 3 升到 4 的那天这条断言就红了——而它红得毫无意义：既没抓到缺陷，
 *    也没人去跑它（当时 test/run.mjs 不引用本文件，见 #67）。
 *    现在**不再断言字面量**：kind/version/apiBilled 只断言"取值合法、且与该源 manifest
 *    自述一致"；来源清单本身改由 `src/sources/` 目录推导，所以加源、升版都不会腐烂。
 * 2. 旧版对注册表只断言 `SOURCES.length >= 9`（下限），新来源怎么漏都不会红。
 *    现在改成**双向相等**：注册表工具集必须恰好等于 `src/sources/*.js` 各 manifest
 *    自报的 tool 集合——多一条（重复注册/野文件）少一条（加载失败被 SOURCE_ERRORS
 *    静默吞掉）都红。
 *
 * 另新增"[contract]"一段（旧版完全没有）：把"注册入口只有 manifest 目录这一条路"钉住。
 * CONTRIBUTING 旧版教的"改 src/config.js 的 SOURCES 数组"已经被这段拦住——config.js 里
 * 没有 SOURCES 数组、只有注册器的 re-export，照旧文档改出来的来源不会有任何人加载。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { loadSources, SOURCES, SOURCE_ERRORS } = await import(pathToFileURL(join(ROOT, 'src/source-registry.js')).href);
const { dedupeRoots, validateManifest, defaultContext, SOURCE_KINDS } = await import(pathToFileURL(join(ROOT, 'src/sources/contract.js')).href);
const { SOURCES: REEXPORTED, SOURCE_ERRORS: REEXPORTED_ERRORS } = await import(pathToFileURL(join(ROOT, 'src/config.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const EXPECTED = [
  // version 是"存量库要不要全量重扫"的唯一凭据：采集语义一变必须 +1，否则旧文件按
  // 游标继续读，修好的逻辑永远碰不到已经读过的行。改动这里时请同时写清是哪次修复。
  { tool: 'claude-code', kind: 'jsonl', version: 2, apiBilled: false, collector: 'claude' },
  { tool: 'ccmr', kind: 'jsonl', version: 3, apiBilled: true, collector: 'claude' },
  // #58 resets_at 秒级时间戳归一（此前登记在 3 上没同步到这里）
  // #85 custom_tool_call 计入工具活动 + 无 call_id 的调用不再共用同一个去重键 → 重扫补回
  { tool: 'codex', kind: 'jsonl', version: 5, apiBilled: false, collector: 'codex' },
  { tool: 'zcode', kind: 'sqlite', version: 2, apiBilled: false, collector: 'zcode' },
  // #85 `time` 秒级粒度归一（此前秒级记录落到 1970 年，与桌面端的窗口合计完全不同）
  { tool: 'dsh', kind: 'zst', version: 4, apiBilled: true, collector: 'dsh' },
  // #96 字符串形态的用量字段被拼成大数 + `modelUsage:{}` 的轮次整条丢失 → 重扫补回
  // #85 秒/毫秒归一交给共享的 epochMs()（边界 1e12 → 1e11，并认 ISO 字符串）
  { tool: 'grok', kind: 'jsonl', version: 3, apiBilled: false, collector: 'grok' },
  // #85 `timestamp` 秒级粒度归一 + cache_write/reasoning 真的读出来（此前写死 0）
  { tool: 'workbuddy', kind: 'jsonl', version: 2, apiBilled: false, collector: 'workbuddy' },
  // #96 首行 BOM 让 project 永久为 null，必须把首行再读一遍
  { tool: 'pi', kind: 'jsonl', version: 2, apiBilled: false, collector: 'pi' },
  { tool: 'opencode', kind: 'sqlite', version: 2, apiBilled: false, collector: 'opencode' },
];

const FILES = manifestFiles();
const READ = (rel) => readFileSync(join(ROOT, rel), 'utf8');

console.log('\n[registry] 注册表 = src/sources/ 目录（双向相等，不加不减）');
{
  ok('源目录可枚举且非空', FILES.length > 0, String(FILES.length));
  ok('默认加载无来源级错误（有错误=某 manifest 静默掉册）', SOURCE_ERRORS.length === 0, JSON.stringify(SOURCE_ERRORS));
  ok('注册表条数与目录文件数相等', SOURCES.length === FILES.length, `${SOURCES.length} vs ${FILES.length}`);
  ok('无重复 tool 注册', new Set(SOURCES.map((s) => s.tool)).size === SOURCES.length,
    SOURCES.map((s) => s.tool).join(','));

  const byTool = Object.fromEntries(SOURCES.map((s) => [s.tool, s]));
  for (const name of FILES) {
    const slug = name.replace(/\.js$/, '');
    ok(`${name} 已落册且 file 字段回指自身`, byTool[slug] && byTool[slug].file === name,
      byTool[slug] ? String(byTool[slug].file) : '未注册');
  }
  for (const s of SOURCES) {
    ok(`${s.tool} 的注册键能回指目录文件（无野文件）`, FILES.includes(`${s.tool}.js`), s.file);
  }

  // 展示与健康表顺序由 order 决定，必须由加载器排好，而不是碰巧的文件系统顺序
  const ordinals = SOURCES.map((s) => s.order);
  ok('注册表按 order 升序', ordinals.every((v, i) => i === 0 || ordinals[i - 1] <= v), ordinals.join(','));
  ok('同 order 时按 tool 字典序（跨机器/跨文件系统稳定）',
    SOURCES.every((s, i) => i === 0 || SOURCES[i - 1].order < s.order
      || (SOURCES[i - 1].order === s.order && SOURCES[i - 1].tool < s.tool)),
    SOURCES.map((s) => `${s.order}:${s.tool}`).join(','));
  ok('order 为有限数（缺省由加载器补 100）', ordinals.every((v) => Number.isFinite(v)));
  ok('config.js 的 re-export 与注册器同一份引用（消费方无第二数据源）',
    REEXPORTED === SOURCES && REEXPORTED_ERRORS === SOURCE_ERRORS);
}

console.log('\n[manifest] 每个来源的自述字段合法（不断言会腐烂的字面量）');
for (const s of SOURCES) {
  const raw = (await import(pathToFileURL(join(ROOT, 'src', 'sources', s.file)).href)).default;
  ok(`${s.tool} 注册表字段与 manifest 自述一致`,
    raw.tool === s.tool && raw.label === s.label && raw.kind === s.kind
      && raw.version === s.version && !!raw.apiBilled === s.apiBilled,
    JSON.stringify({ reg: [s.kind, s.version, s.apiBilled], manifest: [raw.kind, raw.version, raw.apiBilled] }));
  ok(`${s.tool} kind 属于契约枚举`, SOURCE_KINDS.has(s.kind), s.kind);
  ok(`${s.tool} version 为正整数（升采集逻辑要 +1 触发全量重扫）`,
    Number.isInteger(s.version) && s.version >= 1, String(s.version));
  ok(`${s.tool} apiBilled 为布尔`, typeof s.apiBilled === 'boolean', String(s.apiBilled));
  ok(`${s.tool} label 非空单行`, typeof s.label === 'string' && !!s.label.trim() && !/\n/.test(s.label));
  ok(`${s.tool} roots 为非空字符串数组`,
    Array.isArray(s.roots) && s.roots.length > 0 && s.roots.every((r) => typeof r === 'string' && r.length > 0),
    JSON.stringify(s.roots));
  ok(`${s.tool} roots 无重复、无 undefined 片段`,
    new Set(s.roots).size === s.roots.length && s.roots.every((r) => !r.includes('undefined')),
    JSON.stringify(s.roots));
  // scanner 对 sqlite 源直接 stat root（WAL 并发只读），root 必须是库文件锚点而非会话目录
  ok(`${s.tool} sqlite 根为单个库文件锚点`,
    s.kind !== 'sqlite' || s.roots.every((r) => /\.(db|sqlite3?|sqlite)$/i.test(r)), JSON.stringify(s.roots));
  ok(`${s.tool} collect 已解析为函数`, typeof s.collect === 'function');
  if (typeof raw.collector === 'string') {
    ok(`${s.tool} collector 模块文件存在（src/collectors/${raw.collector}.js）`,
      existsSync(join(ROOT, 'src', 'collectors', `${raw.collector}.js`)), raw.collector);
    ok(`${s.tool} collector 字段与注册表回显一致`, s.collector === raw.collector, s.collector);
  } else {
    ok(`${s.tool} 内联 collector 函数被直接采用`, typeof raw.collector === 'function');
  }
  ok(`${s.tool} validateManifest 通过（注册器同款校验）`, validateManifest(raw, { file: s.file }).ok === true);
}

console.log('\n[contract] 注册入口只有 manifest 目录这一条路（拦"改 config.js"旧文档）');
{
  const cfg = READ('src/config.js');
  ok('config.js 不持有 SOURCES 数组字面量（改它不会造出来源）', !/export const SOURCES\s*=/.test(cfg));
  ok('config.js 只 re-export 注册器', /export \{[^}]*\bSOURCES\b[^}]*\} from '\.\/source-registry\.js'/.test(cfg));
  ok('注册器按目录加载且跳过 contract.js', /readdirSync\(sourcesDir\)[\s\S]{0,120}contract\.js/.test(READ('src/source-registry.js')));
  const scanner = READ('src/scanner.js');
  ok('scanner 从注册表取源（不写死工具名数组）',
    /from '\.\/config\.js'/.test(scanner) && !/const SOURCES\s*=\s*\[/.test(scanner));
  ok('注册表里每个 collector 名都能在 collectors 目录落地（无孤儿采集器）',
    SOURCES.every((s) => typeof s.collect === 'function'));
  ok('src/collectors 下没有从未被注册的采集器模块', (() => {
    const used = new Set([...SOURCES.map((s) => String(s.collector)), 'lines']);
    return readdirSync(join(ROOT, 'src', 'collectors'))
      .filter((n) => n.endsWith('.js') && !used.has(n.replace(/\.js$/, '')));
  })().length === 0);
  const localPathFree = [];
  for (const rel of ['src/sources', 'src/collectors']) {
    for (const n of readdirSync(join(ROOT, rel))) {
      if (!n.endsWith('.js')) continue;
      if (/[A-Za-z]:\\Users\\|[A-Za-z]:\\AgentData/.test(READ(join(rel, n)))) localPathFree.push(`${rel}/${n}`);
    }
  }
  ok('manifest 与 collector 源码不含本机盘符用户路径', localPathFree.length === 0, localPathFree.join(','));
  ok('本地路径守卫扫到了两个目录的文件（不空转）',
    readdirSync(join(ROOT, 'src', 'sources')).length > 1 && readdirSync(join(ROOT, 'src', 'collectors')).length > 1);
}

console.log('\n[roots] homedir / LOCALAPPDATA / 去重 / 空格中文反斜杠');
{
  const home = join('D:\\', 'Users', 'Test User', '我的 项目');
  const loaded = await loadSources({
    context: {
      homedir: home,
      env: { LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') },
      caseInsensitive: true,
    },
  });
  ok('注入上下文后加载无来源级错误', loaded.errors.length === 0, JSON.stringify(loaded.errors));
  ok('注入上下文与默认注册的来源集合相同', loaded.sources.length === SOURCES.length,
    `${loaded.sources.length} vs ${SOURCES.length}`);
  const byTool = Object.fromEntries(loaded.sources.map((s) => [s.tool, s]));
  ok('claude-code 根目录跟 homedir',
    byTool['claude-code'].roots[0] === join(home, '.claude', 'projects'), byTool['claude-code'].roots[0]);
  ok('路径含空格与中文', byTool['claude-code'].roots[0].includes('Test User') && byTool['claude-code'].roots[0].includes('我的 项目'));
  ok('opencode 含 LOCALAPPDATA 候选',
    byTool.opencode.roots.some((r) => r.includes(join('AppData', 'Local', 'opencode'))),
    JSON.stringify(byTool.opencode.roots));
  ok('每个来源的每一条根都落在注入 home 内（无写死的真实 home）',
    loaded.sources.every((s) => s.roots.every((r) => r.startsWith(home))),
    JSON.stringify(loaded.sources.map((s) => [s.tool, s.roots.filter((r) => !r.startsWith(home))])
      .filter(([, bad]) => bad.length)));
}

{
  const missing = await loadSources({
    context: { homedir: join('D:\\', 'Users', 'Test User', '我的 项目'), env: {}, caseInsensitive: true },
  });
  const oc = missing.sources.find((s) => s.tool === 'opencode');
  ok('LOCALAPPDATA 缺失不崩溃', !!oc && oc.roots.length >= 1, JSON.stringify(oc?.roots));
  ok('缺失 env 时仍有 ~/.local/share 候选', oc.roots.some((p) => p.includes(join('.local', 'share', 'opencode'))));
  ok('缺失 env 时没有 undefined 根', oc.roots.every((p) => p && !p.includes('undefined')));
  ok('缺 env 时全部来源仍能加载（roots 只依赖 homedir 兜底）',
    missing.errors.length === 0 && missing.sources.length === SOURCES.length, JSON.stringify(missing.errors));
}

{
  const a = join('C:\\Users\\Test User\\AppData\\Local\\Foo');
  const b = join('c:\\users\\test user\\appdata\\local\\foo');
  const d = dedupeRoots([a, b, a], { caseInsensitive: true });
  ok('Windows 大小写不敏感去重', d.length === 1 && d[0] === a, JSON.stringify(d));
  const posix = dedupeRoots(['/x/A', '/x/a'], { caseInsensitive: false });
  ok('大小写敏感平台不去掉同名异case', posix.length === 2, JSON.stringify(posix));
  ok('空/nil 根被丢弃', dedupeRoots(['', null, undefined, 'x'], {}).length === 1);
  ok('缺省 caseInsensitive 跟随当前平台（win32=true）',
    dedupeRoots([a, b], {}).length === (process.platform === 'win32' ? 1 : 2));
}

console.log('\n[errors] 非法 manifest 不让进程崩溃');
{
  const tmp = mkdtempSync(join(tmpdir(), 'src-reg-'));
  const sourcesDir = join(tmp, 'sources');
  const collectorsDir = join(tmp, 'collectors');
  mkdirSync(sourcesDir);
  mkdirSync(collectorsDir);
  // 临时目录没有 package.json，Node 会按 CJS 先解析再重解析；显式声明去掉噪音
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(collectorsDir, 'ok.js'), 'export function collect() { return { inserted: 0 }; }\n');
  writeFileSync(join(sourcesDir, 'good.js'), `
    import { join } from 'node:path';
    export default {
      tool: 'good', label: 'Good', kind: 'jsonl', version: 1, collector: 'ok',
      roots(ctx) { return [join(ctx.homedir, 'Good Data', '中文')]; }
    };
  `);
  writeFileSync(join(sourcesDir, 'bad-kind.js'), `
    export default { tool: 'badkind', label: 'X', kind: 'nope', version: 1, collector: 'ok', roots() { return ['a']; } };
  `);
  writeFileSync(join(sourcesDir, 'no-collector.js'), `
    export default { tool: 'nocol', label: 'X', kind: 'jsonl', version: 1, roots() { return ['a']; } };
  `);
  writeFileSync(join(sourcesDir, 'z-dup.js'), `
    export default { tool: 'good', label: 'Dup', kind: 'jsonl', version: 1, collector: 'ok', roots() { return ['b']; } };
  `);
  writeFileSync(join(sourcesDir, 'missing-mod.js'), `
    export default { tool: 'ghost', label: 'Ghost', kind: 'jsonl', version: 1, collector: 'nope', roots() { return ['a']; } };
  `);
  writeFileSync(join(sourcesDir, 'throws.js'), 'throw new Error("boom at module load");\n');
  writeFileSync(join(sourcesDir, 'root-throws.js'), `
    export default { tool: 'rootthrow', label: 'X', kind: 'jsonl', version: 1, collector: 'ok', roots() { throw new Error('no roots'); } };
  `);
  writeFileSync(join(sourcesDir, 'not-a-manifest.js'), 'export const nope = 1;\n');
  const r = await loadSources({
    sourcesDir, collectorsDir,
    context: { homedir: join('D:\\', 'Users', 'Test User', '我的 项目'), env: {}, caseInsensitive: true },
  });
  ok('合法源仍被加载', r.sources.some((s) => s.tool === 'good') && typeof r.sources[0].collect === 'function');
  ok('good 根目录含空格中文', r.sources.find((s) => s.tool === 'good').roots[0].includes('Good Data'));
  ok('非法 kind 记错误', r.errors.some((e) => /illegal kind/.test(e.error)));
  ok('缺失 collector 记错误', r.errors.some((e) => /missing collector/.test(e.error)));
  ok('重名 tool 记错误', r.errors.some((e) => /duplicate tool/.test(e.error)));
  ok('缺失 collector 模块记错误', r.errors.some((e) => /collector module missing/.test(e.error)));
  ok('manifest 模块抛错记错误（不让 import 炸穿进程）', r.errors.some((e) => /manifest threw/.test(e.error)));
  ok('roots() 抛错记错误', r.errors.some((e) => /roots\(\) threw/.test(e.error)));
  ok('缺 default 导出记错误', r.errors.some((e) => /invalid manifest/.test(e.error)));
  ok('每条错误都带来源文件名（面板/日志可定位）',
    r.errors.every((e) => typeof e.file === 'string' && e.file.endsWith('.js')), JSON.stringify(r.errors.map((e) => e.file)));
  ok('出错源不进注册表（错误不会伪装成一个数据源）',
    !r.sources.some((s) => ['badkind', 'nocol', 'ghost', 'rootthrow'].includes(s.tool)),
    r.sources.map((s) => s.tool).join(','));
  ok('加载器返回纯数据（不抛）', Array.isArray(r.sources) && Array.isArray(r.errors));
  const unreadable = await loadSources({ sourcesDir: join(tmp, 'no-such-dir'), collectorsDir });
  ok('源目录整体不可读时也只记错误', unreadable.sources.length === 0
    && unreadable.errors.some((e) => /sources dir unreadable/.test(e.error)), JSON.stringify(unreadable.errors));
  const v = validateManifest({ tool: 'x' });
  ok('validateManifest 缺字段不抛', v.ok === false);
  rmSync(tmp, { recursive: true, force: true });
}

{
  const ctx = defaultContext({ homedir: 'Z:\\tmp', env: { LOCALAPPDATA: 'Z:\\la', APPDATA: 'Z:\\ro', XDG_DATA_HOME: 'Z:\\xdg' } });
  ok('context 暴露 LOCALAPPDATA/APPDATA/XDG', ctx.localAppData === 'Z:\\la' && ctx.appData === 'Z:\\ro' && ctx.xdgDataHome === 'Z:\\xdg');
  ok('context 覆盖优先于真实 homedir', ctx.homedir === 'Z:\\tmp');
}

if (failed) {
  console.error(`\nsource-registry FAILED ${failed}`);
  process.exit(1);
}
console.log('\nsource-registry OK');
