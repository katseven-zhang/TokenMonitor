/**
 * UI-Sources tests (#16): source metadata API + frontend merge/fallback logic.
 *
 * Part A exercises web/lib/sources.js pure functions (imported directly, same
 * style as test/run.mjs [2b]). Part B boots the REAL server against an
 * isolated HOME and asserts the /api/sources contract (no local paths leak,
 * Host guard still applies) offline.
 *
 * Run: TOKENMONITOR_OFFLINE=1 node test/windows/ui-sources.test.mjs
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const lib = (f) => import(pathToFileURL(join(repo, 'web', 'lib', f)).href);

let passed = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? ' | ' + extra : '')); }
}

const { fallbackColorFor, hslToHex, mergeSourceMeta, displayLabelOf } = await lib('sources.js');
const { TOOL_COLORS, TOOL_LABEL } = await lib('theme.js');
const { esc } = await lib('format.js');

console.log('[A] 纯函数：回退色与元数据合并');

ok(/^#[0-9a-f]{6}$/.test(fallbackColorFor('antigravity')), '回退色是 #rrggbb 形式', fallbackColorFor('antigravity'));
ok(fallbackColorFor('antigravity') === fallbackColorFor('antigravity'), '同 tool 恒同色（确定性）');
{
  const tools = Array.from({ length: 24 }, (_, i) => 'tool-' + i);
  const distinct = new Set(tools.map(fallbackColorFor));
  ok(distinct.size >= 18, '不同 tool 的回退色充分散开', `24 个 tool 只有 ${distinct.size} 色`);
}
ok(hslToHex(0, 0, 0) === '#000000' && hslToHex(0, 0, 1) === '#ffffff', 'hslToHex 边界正确');

{
  // 内建 9 源：颜色/标签不被 API 改写
  const evil = {
    sources: [
      { tool: 'zcode', label: 'Evil <script>', color: '#000000', kind: 'sqlite' },
      { tool: 'antigravity', label: 'Antigravity', kind: 'jsonl', apiBilled: false },
      { tool: 'trae-solo-cn', label: 'Trae Solo CN', kind: 'jsonl' },
      { tool: 'hermes', label: 'Hermes', kind: 'jsonl', apiBilled: true },
      null,
      { label: 'no tool id' },
    ],
    errors: [{ tool: 'broken', error: 'manifest threw: boom (C:\\Users\\x\\src\\broken.js)' }],
  };
  const meta = mergeSourceMeta(TOOL_COLORS, TOOL_LABEL, evil);
  ok(TOOL_COLORS['zcode'] === '#f2c14e' && meta.colors['zcode'] === '#f2c14e', '内建颜色不被 API 覆盖');
  ok(meta.labels['zcode'] === 'ZCode', '内建标签不被 API 覆盖（恶意 label 无效）');
  for (const t of ['claude-code', 'ccmr', 'codex', 'zcode', 'dsh', 'workbuddy', 'grok', 'pi', 'opencode']) {
    if (meta.colors[t] !== TOOL_COLORS[t] || meta.labels[t] !== TOOL_LABEL[t]) {
      ok(false, `内建源 ${t} 保持原样`);
    }
  }
  ok(true, '9 个内建源颜色/标签全部原样');
  ok(meta.colors['antigravity'] === fallbackColorFor('antigravity'), '新来源 antigravity 获得确定性回退色');
  ok(meta.labels['antigravity'] === 'Antigravity' && meta.labels['hermes'] === 'Hermes', '新来源使用注册标签');
  ok(meta.kinds['antigravity'] === 'jsonl' && meta.billed['hermes'] === true, 'kinds/apiBilled 能力面记录');
  ok(meta.errors.length === 1 && meta.errors[0].tool === 'broken' && meta.errors[0].error.includes('boom'),
    '注册错误原样透传给前端（路径脱敏是服务端职责，在 [B] 部分断言）');

  const old = mergeSourceMeta(TOOL_COLORS, TOOL_LABEL, null);
  ok(Object.keys(old.colors).length === Object.keys(TOOL_COLORS).length && old.errors.length === 0,
    '旧服务端（无 sources 字段）安全退化为内建表');
  const hostile = mergeSourceMeta(TOOL_COLORS, TOOL_LABEL, { sources: 'not-an-array' });
  ok(Object.keys(hostile.colors).length === Object.keys(TOOL_COLORS).length, 'sources 非数组不抛错');

  // 恶意标签经 esc 后不产生 innerHTML 注入（渲染路径 = esc(displayLabelOf(...))）
  const bad = mergeSourceMeta(TOOL_COLORS, TOOL_LABEL, { sources: [{ tool: 'evil-tool', label: '<script>alert(1)</script>' }] });
  const rendered = esc(displayLabelOf(bad, 'evil-tool'));
  ok(!rendered.includes('<script>') && rendered.includes('&lt;script&gt;'), '恶意 label 经 esc 后不可注入');
}

console.log('[B] HTTP：真实 serve 的 /api/sources 契约');

function get(port, path, host) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } || {}, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

{
  const home = mkdtempSync(join(tmpdir(), 'ui-sources-home-'));
  const port = 18901;
  const child = spawn(process.execPath, [join(repo, 'bin', 'tokenmonitor.js'), 'serve', '--port', String(port)], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKENMONITOR_OFFLINE: '1' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const probe = await get(port, '/api/status', '127.0.0.1:' + port);
      up = probe.status === 200;
    }
    ok(up, '离线 serve 启动（隔离 HOME）');

    const res = await get(port, '/api/sources', '127.0.0.1:' + port);
    ok(res.status === 200, '/api/sources 返回 200');
    const payload = JSON.parse(res.body);
    const list = Array.isArray(payload.sources) ? payload.sources : [];
    const tools = new Set(list.map((s) => s.tool));
    const expected = ['claude-code', 'ccmr', 'codex', 'zcode', 'dsh', 'workbuddy', 'grok', 'pi', 'opencode'];
    ok(expected.every((t) => tools.has(t)), '9 个内建来源全部在列', `实际 ${[...tools].join(',')}`);
    ok(list.every((s) => typeof s.tool === 'string' && typeof s.label === 'string' && typeof s.kind === 'string'),
      '每个来源都有 tool/label/kind 元数据');
    ok(list.every((s) => s.color === null || /^#[0-9a-f]{6}$/i.test(s.color)), '颜色字段要么 null 要么 #rrggbb');
    ok(list.every((s) => s.capabilities && typeof s.capabilities === 'object'), 'capabilities 能力面存在');
    ok(Array.isArray(payload.errors), 'errors 字段是数组（无注册错误时为空）');
    ok(!/\broots\b/.test(res.body), '响应不包含 roots（本机路径发现策略不出网）');
    ok(!/[A-Za-z]:[\\/]/.test(res.body) && !res.body.includes(home), '响应不包含盘符路径与 HOME 路径');

    const forged = await get(port, '/api/sources', 'evil.example');
    ok(forged.status === 403, '伪造 Host 仍被拒（DNS rebinding 防护覆盖新端点）');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\nui-sources test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
