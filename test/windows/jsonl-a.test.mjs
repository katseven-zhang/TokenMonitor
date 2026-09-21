/**
 * Win-JSONL-A：Claude / ccmr / Codex 在 Windows 路径、CRLF、半行、归档搬移下的黄金数字。
 *
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/jsonl-a.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { readLinesFrom } = await import(pathToFileURL(join(ROOT, 'src/collectors/lines.js')).href);
const { collectClaudeFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/claude.js')).href);
const { collectCodexFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/codex.js')).href);
const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
const { Scanner } = await import(pathToFileURL(join(ROOT, 'src/scanner.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

function crlf(lines) {
  return lines.join('\r\n') + '\r\n';
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-a-store-'));
  const store = new Store(join(dir, 't.db'));
  store._tmpDir = dir;
  return store;
}

function closeStore(store) {
  store.close();
  rmSync(store._tmpDir, { recursive: true, force: true });
}

function eventsOf(store, tool) {
  return store.db.prepare('SELECT * FROM events WHERE tool = ? ORDER BY id').all(tool);
}

function toolsOf(store, tool) {
  return store.db.prepare('SELECT * FROM tool_calls WHERE tool = ? ORDER BY rowid').all(tool);
}

function hasAbsPath(s) {
  return /[A-Za-z]:[\\/]/.test(s) || String(s).includes('\\');
}

const NOW = Date.now();
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();

console.log('\n[static] 不得用 split("/") / lastIndexOf("/") 解析路径');
{
  const splitCall = /\.split\(\s*['"]\/['"]\s*\)/;
  const lastSlash = /\.lastIndexOf\(\s*['"]\/['"]\s*\)/;
  for (const f of ['claude.js', 'codex.js', 'lines.js']) {
    const src = readFileSync(join(ROOT, 'src/collectors', f), 'utf8');
    ok(`${f} 无 split('/') 调用`, !splitCall.test(src));
    ok(`${f} 无 lastIndexOf('/') 调用`, !lastSlash.test(src));
  }
  ok('claude.js / codex.js 使用 path.win32',
    readFileSync(join(ROOT, 'src/collectors/claude.js'), 'utf8').includes('win32')
    && readFileSync(join(ROOT, 'src/collectors/codex.js'), 'utf8').includes('win32'));
}

console.log('\n[lines] CRLF 剥 CR，半行不推进 offset');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-lines-'));
  const file = join(tmp, '中文 目录', 'a.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const a = '{"n":1}';
  const b = '{"n":2}';
  writeFileSync(file, a + '\r\n' + b.slice(0, 3), 'utf8');
  const seen = [];
  const half = await readLinesFrom(file, 0, (line) => seen.push(line));
  ok('半行只回调完整行', seen.length === 1 && seen[0] === a, JSON.stringify(seen));
  ok('半行 offset 停在 CRLF 之后', half.newOffset === Buffer.byteLength(a + '\r\n'), String(half.newOffset));
  ok('回调行不含 CR', !seen[0].includes('\r'));

  writeFileSync(file, crlf([a, b]), 'utf8');
  const rest = [];
  const full = await readLinesFrom(file, half.newOffset, (line) => rest.push(line));
  ok('补全后只再读到第二行一次', rest.length === 1 && rest[0] === b, JSON.stringify(rest));
  ok('完整文件 offset 到末尾', full.newOffset === Buffer.byteLength(crlf([a, b])), String(full.newOffset));
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[claude] Windows cwd + CRLF + 半行 + 工具调用黄金数字');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-claude-'));
  const file = join(tmp, '.claude', 'projects', '中文 项目', 's-claude.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const cwd = 'D:\\Users\\Test User\\我的 项目\\projA';
  const aMsg = (id, ts, inTok, cached, out, extra = {}) => JSON.stringify({
    timestamp: ts, type: 'assistant', requestId: 'r1', sessionId: 's-claude', cwd,
    message: {
      id, model: 'claude-opus-5',
      usage: { input_tokens: inTok, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: out },
      ...extra,
    },
  });
  const m1 = aMsg('m1', ISO(60000), 100, 500, 40, {
    content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
  });
  const m2 = aMsg('m2', ISO(30000), 10, 90, 5);
  writeFileSync(file, m1 + '\r\n' + m2.slice(0, 20), 'utf8');
  const store = makeStore();
  const half = await collectClaudeFile(store, { tool: 'claude-code', path: file, fileId: 's-claude', offset: 0 });
  ok('Claude 半行不推进 offset', half.newOffset === Buffer.byteLength(m1 + '\r\n'), String(half.newOffset));
  ok('Claude 半行已入库 m1', eventsOf(store, 'claude-code').length === 1);

  writeFileSync(file, crlf([m1, m1, m2]), 'utf8');
  await collectClaudeFile(store, { tool: 'claude-code', path: file, fileId: 's-claude', offset: half.newOffset });
  const ev = eventsOf(store, 'claude-code');
  const tc = toolsOf(store, 'claude-code');
  ok('Claude 2 事件（重复行 dedup）', ev.length === 2, String(ev.length));
  ok('Claude 总量 745（640+105）', ev.reduce((s, e) => s + e.total_tokens, 0) === 745, String(ev.reduce((s, e) => s + e.total_tokens, 0)));
  ok('m1 黄金 100/500/40/640',
    ev[0].input_tokens === 100 && ev[0].cached_input === 500 && ev[0].output_tokens === 40 && ev[0].total_tokens === 640,
    JSON.stringify(ev[0]));
  ok('project=projA（Windows cwd 末段，含空格/中文父目录）', ev.every((e) => e.project === 'projA'), ev.map((e) => e.project).join(','));
  ok('session_id=s-claude', ev.every((e) => e.session_id === 's-claude'));
  ok('模型 claude-opus-5', ev[0].model === 'claude-opus-5');
  ok('工具调用 Read ×1', tc.length === 1 && tc[0].name === 'Read', JSON.stringify(tc));
  ok('dedup_key 不含绝对路径', ev.every((e) => !hasAbsPath(e.dedup_key)));
  const again = await collectClaudeFile(store, { tool: 'claude-code', path: file, fileId: 's-claude', offset: 0 });
  ok('Claude 全量重扫幂等', again.inserted === 0 && eventsOf(store, 'claude-code').length === 2);
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[#96-6] 只写 session_id 的网关：工具行与事件行必须落在同一个会话');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-sessionid-'));
  const file = join(tmp, '.claude-gateway', 'projects', '-work-gw', 'gw-file-name.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  // 派生网关只写 snake_case 的 session_id，且它和文件名（fileId）不是一回事。
  // fileId 故意取一个和会话无关的值：修前工具行的回退链少一级，会掉到 fileId 上。
  const rec = JSON.stringify({
    timestamp: ISO(20000), type: 'assistant', requestId: 'rgw', session_id: 'gw-sess-42',
    cwd: 'Q:\\work\\gwproj',
    message: {
      id: 'mgw', model: 'claude-opus-5',
      usage: { input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 },
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tu-a', name: 'Bash', input: {} },
        { type: 'tool_use', id: 'tu-b', name: 'Read', input: {} },
      ],
    },
  });
  writeFileSync(file, crlf([rec]), 'utf8');
  const store = makeStore();
  await collectClaudeFile(store, { tool: 'ccmr', path: file, fileId: 'gw-file-name', offset: 0 });
  const ev = eventsOf(store, 'ccmr');
  const tc = toolsOf(store, 'ccmr');
  ok('事件行用上了 session_id（不是 fileId）',
    ev.length === 1 && ev[0].session_id === 'gw-sess-42', JSON.stringify(ev.map((e) => e.session_id)));
  ok('两条 tool_use 都入库', tc.length === 2, JSON.stringify(tc.map((t) => t.name)));
  ok('工具行也用上了 session_id（修前这里是 fileId）',
    tc.every((t) => t.session_id === 'gw-sess-42'), JSON.stringify(tc.map((t) => t.session_id)));
  // 用户可见的后果：按会话钻取时用量与工具活动要能join 上同一行。
  const joined = store.db.prepare(`
    SELECT e.session_id AS sid, e.total_tokens AS tok, COUNT(t.rowid) AS ntools
    FROM events e LEFT JOIN tool_calls t ON t.session_id = e.session_id
    WHERE e.tool = 'ccmr' GROUP BY e.session_id`).all();
  ok('按会话钻取：一次调用的 token 与 2 次工具落在同一会话',
    joined.length === 1 && joined[0].sid === 'gw-sess-42' && joined[0].tok === 37 && joined[0].ntools === 2,
    JSON.stringify(joined));
  ok('fileId 不再冒充会话（工具行上没有 gw-file-name）',
    !tc.some((t) => t.session_id === 'gw-file-name'), JSON.stringify(tc.map((t) => t.session_id)));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[ccmr] 多 block 终结块输出 + 模型别名');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-ccmr-'));
  const file = join(tmp, '.claude-gateway', 'projects', '-work-projB', 's-ccmr.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const block = (out, stop) => JSON.stringify({
    timestamp: ISO(48000), type: 'assistant', sessionId: 's-ccmr',
    cwd: 'D:/Users/Test User/我的 项目/projB',
    message: {
      id: 'm4', model: 'deepseek-flash', stop_reason: stop,
      usage: { input_tokens: 2000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: out },
    },
  });
  writeFileSync(file, crlf([
    JSON.stringify({
      timestamp: ISO(50000), type: 'assistant', requestId: 'r2', sessionId: 's-ccmr',
      cwd: 'D:/Users/Test User/我的 项目/projB',
      message: { id: 'm3', model: 'deepseek-flash', usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200 } },
    }),
    block(0, null),
    block(0, null),
    block(500, 'end_turn'),
  ]), 'utf8');
  const store = makeStore();
  await collectClaudeFile(store, { tool: 'ccmr', path: file, fileId: 's-ccmr', offset: 0 });
  const ev = eventsOf(store, 'ccmr');
  ok('ccmr 2 事件（4 行塌成 2 次调用）', ev.length === 2, String(ev.length));
  ok('ccmr 终结块输出 500 而非 0',
    ev.some((e) => e.output_tokens === 500), JSON.stringify(ev.map((e) => e.output_tokens)));
  ok('deepseek-flash → deepseek-v4.1-flash', ev.every((e) => e.model === 'deepseek-v4.1-flash'));
  ok('ccmr project=projB（正斜杠 Windows cwd）', ev.every((e) => e.project === 'projB'), ev.map((e) => e.project).join(','));
  ok('ccmr 总量 20700', ev.reduce((s, e) => s + e.total_tokens, 0) === 20700, String(ev.reduce((s, e) => s + e.total_tokens, 0)));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[codex] Windows cwd + 差分黄金数字 + 归档搬移不重复 + resume 继承');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-codex-'));
  const parentUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const childUuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const parentFileId = `rollout-2026-09-14T12-00-00-${parentUuid}`;
  const childFileId = `rollout-2026-09-14T13-00-00-${childUuid}`;
  const liveDir = join(tmp, '.codex', 'sessions', '2026', '09', '14');
  const archDir = join(tmp, '.codex', 'archived_sessions', '2026', '09', '14');
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(archDir, { recursive: true });
  const liveFile = join(liveDir, `${parentFileId}.jsonl`);
  const cwd = 'D:\\Users\\Test User\\我的 项目\\projC';
  const lines = [
    JSON.stringify({ timestamp: ISO(45000), type: 'session_meta', payload: { id: parentUuid, session_id: parentUuid, cwd } }),
    JSON.stringify({ timestamp: ISO(44000), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-test' } } }),
    JSON.stringify({ timestamp: ISO(43000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 } },
      rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1799999999 }, plan_type: 'testplan' } } }),
    JSON.stringify({ timestamp: ISO(30000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } } } }),
    JSON.stringify({ timestamp: ISO(29000), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call-1' } }),
  ];
  writeFileSync(liveFile, lines[0] + '\r\n' + lines[1].slice(0, 15), 'utf8');
  const store = makeStore();
  const half = await collectCodexFile(store, { path: liveFile, fileId: parentFileId, offset: 0, version: 3 });
  ok('Codex 半行不推进 offset', half.newOffset === Buffer.byteLength(lines[0] + '\r\n'), String(half.newOffset));

  writeFileSync(liveFile, crlf(lines), 'utf8');
  const r1 = await collectCodexFile(store, {
    path: liveFile, fileId: parentFileId, offset: half.newOffset, state: half.state, version: 3,
  });
  const ev1 = eventsOf(store, 'codex');
  ok('Codex 差分 1 事件 total 280', ev1.length === 1 && ev1[0].total_tokens === 280, JSON.stringify(ev1[0]));
  ok('Codex 黄金：fresh 150 / cached 100 / out 30 / reason 10',
    ev1[0].input_tokens === 150 && ev1[0].cached_input === 100 && ev1[0].output_tokens === 30 && ev1[0].reasoning_tokens === 10,
    JSON.stringify(ev1[0]));
  ok('Codex project=projC', ev1[0].project === 'projC', String(ev1[0].project));
  ok('Codex 模型 gpt-test', ev1[0].model === 'gpt-test');
  ok('Codex 工具调用 shell ×1', toolsOf(store, 'codex').length === 1 && toolsOf(store, 'codex')[0].name === 'shell');
  ok('Codex quota 42%', store.getQuota('codex')?.data?.used_percent === 42);
  ok('dedup_key 不含绝对路径', !hasAbsPath(ev1[0].dedup_key) && !hasAbsPath(toolsOf(store, 'codex')[0].dedup_key),
    ev1[0].dedup_key);

  const archFile = join(archDir, `${parentFileId}.jsonl`);
  copyFileSync(liveFile, archFile);
  const r2 = await collectCodexFile(store, { path: archFile, fileId: parentFileId, offset: 0, version: 3 });
  ok('归档搬移后 inserted=0（路径变了也不重复）', r2.inserted === 0, String(r2.inserted));
  ok('归档后事件数仍为 1', eventsOf(store, 'codex').length === 1);
  ok('归档后工具调用仍为 1', toolsOf(store, 'codex').length === 1);

  const again = await collectCodexFile(store, {
    path: liveFile, fileId: parentFileId, offset: r1.newOffset, state: r1.state, version: 3,
  });
  ok('增量游标重扫幂等', again.inserted === 0, String(again.inserted));
  const full = await collectCodexFile(store, {
    path: liveFile, fileId: parentFileId, offset: 0, version: 3,
  });
  ok('版本全量重扫幂等（seq 重来靠 dedup_key）', full.inserted === 0 && eventsOf(store, 'codex').length === 1,
    `${full.inserted}/${eventsOf(store, 'codex').length}`);

  // resume：子会话自身无模型，parent_thread_id 指向父 uuid
  const childFile = join(liveDir, `${childFileId}.jsonl`);
  writeFileSync(childFile, crlf([
    JSON.stringify({ timestamp: ISO(20000), type: 'session_meta', payload: { id: childUuid, parent_thread_id: parentUuid, cwd } }),
    JSON.stringify({ timestamp: ISO(19000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 } } } }),
    JSON.stringify({ timestamp: ISO(18000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 48 } } } }),
  ]), 'utf8');
  const child = await collectCodexFile(store, { path: childFile, fileId: childFileId, offset: 0, version: 3 });
  ok('resume 子会话 state.parent 为父 uuid', child.state.parent === parentUuid, String(child.state.parent));
  ok('resume 子会话自身无模型', child.state.model == null, String(child.state.model));
  const childEv = eventsOf(store, 'codex').filter((e) => e.session_id === childFileId);
  ok('resume 子会话差分 1 事件 total 36', childEv.length === 1 && childEv[0].total_tokens === 36, JSON.stringify(childEv[0]));
  ok('继承前子事件 model 为空', childEv[0].model == null);

  store.saveFile({
    path: liveFile, tool: 'codex', session_id: parentFileId, size: 1, mtime_ms: 1,
    offset: r1.newOffset, state_json: JSON.stringify(r1.state),
  });
  store.saveFile({
    path: childFile, tool: 'codex', session_id: childFileId, size: 1, mtime_ms: 1,
    offset: child.newOffset, state_json: JSON.stringify(child.state),
  });
  const sc = new Scanner(store, { log() {} });
  sc._inheritCodexModels();
  const after = store.db.prepare("SELECT model FROM events WHERE session_id = ?").get(childFileId);
  ok('resume 继承后子事件模型=gpt-test', after?.model === 'gpt-test', String(after?.model));

  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[#75] codex 三条跨端口径：缺 total 的采样 / 重复通知判据 / cache_write 两种写法');
{
  // 同一份期望数字的桌面端对照测试：
  // desktop/src-tauri/tests/sources.rs::codex_snapshot_without_total_usage_and_duplicate_notifications_agree
  // desktop/src-tauri/tests/sources.rs::codex_cache_write_spellings_conflict_and_switch
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-a-75-'));
  const run = async (name, records) => {
    const file = join(tmp, `${name}.jsonl`);
    writeFileSync(file, crlf(records), 'utf8');
    const store = makeStore();
    const r = await collectCodexFile(store, { path: file, fileId: `f-${name}`, offset: 0 });
    const ev = eventsOf(store, 'codex');
    closeStore(store);
    return { r, ev };
  };
  const tc = (n) => ISO(200000 - n * 1000); // 每条采样一个独立毫秒，基线键才不会互撞
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-75', cwd: 'Q:\\我的 项目\\projK' } });
  const usage = (o) => ({ input_tokens: o.i, cached_input_tokens: o.c, output_tokens: o.o, reasoning_output_tokens: o.r ?? 0, ...o.extra });
  const count = (o) => JSON.stringify({
    timestamp: tc(o.n), type: 'event_msg',
    payload: { type: 'token_count', info: { ...(o.total ? { total_token_usage: usage(o.total) } : {}), ...(o.last ? { last_token_usage: usage(o.last) } : {}) } },
  });

  // ① 只有 last_token_usage、没有 total_token_usage：修前这边整条丢弃，桌面端落库
  const noTotal = await run('no-total', [
    meta,
    count({ n: 1, last: { i: 500, c: 400, o: 60, r: 10, extra: { cache_write_input_tokens: 20 } } }),
    // ② 首个带累计值的采样：只认 last（本轮量），不拿累计值当单次用量
    count({ n: 2, total: { i: 1000, c: 800, o: 100, r: 40, extra: { cache_write_input_tokens: 30, total_tokens: 2000 } },
      last: { i: 200, c: 100, o: 40, r: 20, extra: { cache_write_input_tokens: 10 } } }),
    // 累计值一模一样 = 重复通知
    count({ n: 3, total: { i: 1000, c: 800, o: 100, r: 40, extra: { cache_write_input_tokens: 30, total_tokens: 2000 } },
      last: { i: 200, c: 100, o: 40, r: 20, extra: { cache_write_input_tokens: 10 } } }),
    // 只有 reasoning 与上游 total_tokens 在动：本轮没有可记用量，两端都不落库
    count({ n: 4, total: { i: 1000, c: 800, o: 100, r: 90, extra: { cache_write_input_tokens: 30, total_tokens: 2050 } },
      last: { i: 200, c: 100, o: 40, r: 20, extra: { cache_write_input_tokens: 10 } } }),
  ]);
  ok('#75① 缺 total_token_usage 的采样不再被丢弃', noTotal.ev.length === 2, JSON.stringify(noTotal.ev.map((e) => e.total_tokens)));
  ok('#75① 该采样按 last 落库 580（100+400+20+60）',
    noTotal.ev[0]?.total_tokens === 580 && noTotal.ev[0]?.cache_write === 20
    && noTotal.ev[0]?.input_tokens === 100 && noTotal.ev[0]?.cached_input === 400,
    JSON.stringify(noTotal.ev[0]));
  ok('#75① 首个带累计值的采样按 last 落库 250，不记整段累计',
    noTotal.ev[1]?.total_tokens === 250, JSON.stringify(noTotal.ev[1]));
  ok('#75② 重复通知与"只有 reasoning 在动"两条都不落库',
    noTotal.ev.length === 2 && noTotal.r.inserted === 2, `${noTotal.ev.length}/${noTotal.r.inserted}`);
  ok('#75② 不再产出各列全 0 的事件（修前这边会多一条，桌面端一条不落）',
    !noTotal.ev.some((e) => e.total_tokens === 0), JSON.stringify(noTotal.ev.map((e) => e.total_tokens)));

  // ③ 同一条记录里两种 cache_write 写法数值不同 → 无法判定，拒读记 0（不取较大者）
  const conflict = await run('cw-conflict', [
    meta,
    count({ n: 5, total: { i: 1000, c: 600, o: 100, r: 40, extra: { cache_creation_input_tokens: 999, cache_write_input_tokens: 10, total_tokens: 1800 } },
      last: { i: 1000, c: 600, o: 100, extra: { cache_creation_input_tokens: 999, cache_write_input_tokens: 10 } } }),
  ]);
  ok('#75③ 两种写法冲突时 cache_write 拒读记 0（既不取较大者也不相加）',
    conflict.ev.length === 1 && conflict.ev[0].cache_write === 0
    && conflict.ev[0].total_tokens === 1100, JSON.stringify(conflict.ev[0]));

  const agreed = await run('cw-same', [
    meta,
    count({ n: 6, total: { i: 1000, c: 600, o: 100, r: 40, extra: { cache_creation_input_tokens: 45, cache_write_input_tokens: 45, total_tokens: 1800 } },
      last: { i: 1000, c: 600, o: 100, extra: { cache_creation_input_tokens: 45, cache_write_input_tokens: 45 } } }),
  ]);
  ok('#75③ 两种写法数值一致则照用 45（只是重复写了一遍）',
    agreed.ev.length === 1 && agreed.ev[0].cache_write === 45
    && agreed.ev[0].total_tokens === 1145, JSON.stringify(agreed.ev[0]));

  // ③ 相邻两条采样各只写一种写法 → 累计序列断了，按回落改读本条 last；
  // 修前是跨写法差分：345 - 500 = -155 → .max(0) → 那一轮的缓存写入静默清零
  const switched = await run('cw-switch', [
    meta,
    count({ n: 7, total: { i: 1000, c: 800, o: 100, r: 40, extra: { cache_write_input_tokens: 500, total_tokens: 2500 } },
      last: { i: 1000, c: 800, o: 100, extra: { cache_write_input_tokens: 500 } } }),
    count({ n: 8, total: { i: 1400, c: 1000, o: 150, r: 60, extra: { cache_creation_input_tokens: 345, total_tokens: 3000 } },
      last: { i: 400, c: 200, o: 50, r: 20, extra: { cache_creation_input_tokens: 45 } } }),
  ]);
  ok('#75③ 换写法的那一轮按 last 记到 cache_write 45（修前被 .max(0) 清零）',
    switched.ev.length === 2 && switched.ev[1].cache_write === 45,
    JSON.stringify(switched.ev.map((e) => e.cache_write)));
  ok('#75③ 该轮总量 495 = 200+200+45+50（修前会是 450）',
    switched.ev[0].total_tokens === 1600 && switched.ev[1].total_tokens === 495,
    JSON.stringify(switched.ev.map((e) => e.total_tokens)));
  ok('#75③ 写法相同（都是 write）时相邻差分不受影响',
    switched.ev[0].cache_write === 500, String(switched.ev[0].cache_write));

  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\njsonl-a FAILED ${failed}`);
  process.exit(1);
}
console.log('\njsonl-a OK');
