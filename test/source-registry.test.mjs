/**
 * Win-Core：来源 manifest 注册器与 Windows 根目录发现。
 * 运行：TOKENMETER_OFFLINE=1 node test/source-registry.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TOKENMETER_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { loadSources, SOURCES, SOURCE_ERRORS } = await import(pathToFileURL(join(ROOT, 'src/source-registry.js')).href);
const { dedupeRoots, validateManifest, defaultContext } = await import(pathToFileURL(join(ROOT, 'src/sources/contract.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const EXPECTED = [
  { tool: 'claude-code', kind: 'jsonl', version: 2, apiBilled: false, collector: 'claude' },
  { tool: 'ccmr', kind: 'jsonl', version: 3, apiBilled: true, collector: 'claude' },
  { tool: 'codex', kind: 'jsonl', version: 3, apiBilled: false, collector: 'codex' },
  { tool: 'zcode', kind: 'sqlite', version: 2, apiBilled: false, collector: 'zcode' },
  { tool: 'dsh', kind: 'zst', version: 3, apiBilled: true, collector: 'dsh' },
  { tool: 'grok', kind: 'jsonl', version: 1, apiBilled: false, collector: 'grok' },
  { tool: 'workbuddy', kind: 'jsonl', version: 1, apiBilled: false, collector: 'workbuddy' },
  { tool: 'pi', kind: 'jsonl', version: 1, apiBilled: false, collector: 'pi' },
  { tool: 'opencode', kind: 'sqlite', version: 2, apiBilled: false, collector: 'opencode' },
];

console.log('\n[compat] 内建 9 个来源');
{
  ok('默认加载无来源级错误', SOURCE_ERRORS.length === 0, JSON.stringify(SOURCE_ERRORS));
  // 内建 9 源必须逐一在册；之后按“新来源只带自己的文件”边界落地的新来源
  // 也允许出现在注册表里（UI 走 #16 的确定性回退色），因此只下限断言。
  ok('内建 9 源全部在册（允许新来源落册）', SOURCES.length >= 9, String(SOURCES.length));
  const byTool = Object.fromEntries(SOURCES.map((s) => [s.tool, s]));
  for (const e of EXPECTED) {
    const s = byTool[e.tool];
    ok(`${e.tool} kind/version/apiBilled/collector`,
      s && s.kind === e.kind && s.version === e.version && !!s.apiBilled === e.apiBilled && s.collector === e.collector,
      JSON.stringify(s && { kind: s.kind, version: s.version, apiBilled: s.apiBilled, collector: s.collector }));
    ok(`${e.tool} collect 已解析`, typeof s?.collect === 'function');
  }
  ok('manifest 源文件不含本机盘符用户路径', (() => {
    const dir = join(ROOT, 'src', 'sources');
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.js')) continue;
      const t = readFileSync(join(dir, n), 'utf8');
      if (/[A-Za-z]:\\Users\\|[A-Za-z]:\\AgentData/.test(t)) return false;
    }
    return true;
  })());
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
  const byTool = Object.fromEntries(loaded.sources.map((s) => [s.tool, s]));
  ok('claude-code 根目录跟 homedir',
    byTool['claude-code'].roots[0] === join(home, '.claude', 'projects'), byTool['claude-code'].roots[0]);
  ok('路径含空格与中文', byTool['claude-code'].roots[0].includes('Test User') && byTool['claude-code'].roots[0].includes('我的 项目'));
  ok('opencode 含 LOCALAPPDATA 候选',
    byTool.opencode.roots.some((r) => r.includes(join('AppData', 'Local', 'opencode'))),
    JSON.stringify(byTool.opencode.roots));
}

{
  const missing = await loadSources({
    context: { homedir: join('D:\\', 'Users', 'Test User', '我的 项目'), env: {}, caseInsensitive: true },
  });
  const oc = missing.sources.find((s) => s.tool === 'opencode');
  ok('LOCALAPPDATA 缺失不崩溃', !!oc && oc.roots.length >= 1, JSON.stringify(oc?.roots));
  ok('缺失 env 时仍有 ~/.local/share 候选', oc.roots.some((p) => p.includes(join('.local', 'share', 'opencode'))));
  ok('缺失 env 时没有 undefined 根', oc.roots.every((p) => p && !p.includes('undefined')));
}

{
  const a = join('C:\\Users\\Test User\\AppData\\Local\\Foo');
  const b = join('c:\\users\\test user\\appdata\\local\\foo');
  const d = dedupeRoots([a, b, a], { caseInsensitive: true });
  ok('Windows 大小写不敏感去重', d.length === 1 && d[0] === a, JSON.stringify(d));
}

console.log('\n[errors] 非法 manifest 不让进程崩溃');
{
  const tmp = mkdtempSync(join(tmpdir(), 'src-reg-'));
  const sourcesDir = join(tmp, 'sources');
  const collectorsDir = join(tmp, 'collectors');
  mkdirSync(sourcesDir);
  mkdirSync(collectorsDir);
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
  ok('loadSources 不抛', true);
  const v = validateManifest({ tool: 'x' });
  ok('validateManifest 缺字段不抛', v.ok === false);
  rmSync(tmp, { recursive: true, force: true });
}

{
  const ctx = defaultContext({ homedir: 'Z:\\tmp', env: { LOCALAPPDATA: 'Z:\\la', APPDATA: 'Z:\\ro', XDG_DATA_HOME: 'Z:\\xdg' } });
  ok('context 暴露 LOCALAPPDATA/APPDATA/XDG', ctx.localAppData === 'Z:\\la' && ctx.appData === 'Z:\\ro' && ctx.xdgDataHome === 'Z:\\xdg');
}

if (failed) {
  console.error(`\nsource-registry FAILED ${failed}`);
  process.exit(1);
}
console.log('\nsource-registry OK');
