/**
 * Win-JSONL-B：Grok / WorkBuddy / Pi 在 Windows 路径、CRLF、半行、增量幂等下的黄金数字。
 *
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/jsonl-b.test.mjs
 * 不改中央注册 / README / 前端；不读取真实用户会话。
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { collectGrokFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/grok.js')).href);
const { collectWorkbuddyFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/workbuddy.js')).href);
const { collectPiFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/pi.js')).href);
const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

function crlf(lines) {
  return lines.join('\r\n') + '\r\n';
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-b-store-'));
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
const GROK_TS_SEC = Math.floor(NOW / 1000) - 400;

console.log('\n[static] 采集器不得用 split("/") / lastIndexOf("/") 解析路径');
{
  const splitCall = /\.split\(\s*['"]\/['"]\s*\)/;
  const lastSlash = /\.lastIndexOf\(\s*['"]\/['"]\s*\)/;
  for (const f of ['grok.js', 'workbuddy.js', 'pi.js']) {
    const src = readFileSync(join(ROOT, 'src/collectors', f), 'utf8');
    ok(`${f} 无 split('/') 调用`, !splitCall.test(src));
    ok(`${f} 无 lastIndexOf('/') 调用`, !lastSlash.test(src));
    ok(`${f} 使用 path.win32`, src.includes('win32'));
  }
}

console.log('\n[grok] URL 编码 Windows 路径 + CRLF + 半行 + 黄金数字');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-grok-'));
  // 与本机 Grok 实测一致：encodeURIComponent('D:\\Users\\Test User\\我的 项目\\TokenMonitor')
  const encoded = encodeURIComponent('D:\\Users\\Test User\\我的 项目\\TokenMonitor');
  const session = 's-grok-win';
  const file = join(tmp, 'Grok Sessions', '中文 目录', encoded, session, 'updates.jsonl');
  mkdirSync(dirname(file), { recursive: true });

  const toolCall = {
    timestamp: GROK_TS_SEC - 10,
    method: 'session/update',
    params: {
      sessionId: session,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-win-1', title: 'Web search', kind: 'search' },
    },
  };
  const turn = {
    timestamp: GROK_TS_SEC,
    method: 'session/update',
    params: {
      sessionId: session,
      _meta: { totalTokens: 4096 },
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-win-1',
        usage: {
          inputTokens: 2100,
          outputTokens: 90,
          totalTokens: 2290,
          cachedReadTokens: 1500,
          cacheCreationTokens: 100,
          reasoningTokens: 20,
          modelUsage: {
            'Grok-4.6-Build': {
              inputTokens: 2000, outputTokens: 80, totalTokens: 2180,
              cachedReadTokens: 1500, cacheCreationTokens: 100, reasoningTokens: 20,
            },
            'grok-4-fast': {
              inputTokens: 100, outputTokens: 10, totalTokens: 110,
              cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
            },
          },
        },
      },
    },
  };

  // 半行：先写 tool_call 整行 + turn 的半行，offset 不得越过半行，且不得入库半行。
  const line1 = JSON.stringify(toolCall);
  const line2 = JSON.stringify(turn);
  writeFileSync(file, line1 + '\r\n' + line2.slice(0, 40), 'utf8');

  const store = makeStore();
  const half = await collectGrokFile(store, { tool: 'grok', path: file, fileId: session, offset: 0 });
  const afterHalf = eventsOf(store, 'grok');
  ok('半行不推进 offset（停在首行 CRLF 之后）', half.newOffset === Buffer.byteLength(line1 + '\r\n'), String(half.newOffset));
  ok('半行不产生 turn 事件', afterHalf.length === 0, String(afterHalf.length));
  ok('半行已记录完整 tool_call', toolsOf(store, 'grok').length === 1);

  writeFileSync(file, crlf([line1, line2, line2]), 'utf8'); // 重复 turn 行 → dedup
  const full = await collectGrokFile(store, { tool: 'grok', path: file, fileId: session, offset: half.newOffset });
  const ev = eventsOf(store, 'grok');
  const tc = toolsOf(store, 'grok');

  // 口径：inputTokens 含 cachedRead；入库 input = input - cached；total = input + cacheW + output
  // grok-4.6-build: in 2000-1500=500, cached 1500, cw 100, out 80, reason 20, total 2180
  // grok-4-fast:    in 100, cached 0, cw 0, out 10, reason 0, total 110
  ok('turn 补全后插入 2 条模型拆分事件（重复行不加倍）', ev.length === 2, String(ev.length));
  ok('inserted 计数 2', full.inserted === 2, String(full.inserted));
  const byModel = Object.fromEntries(ev.map((e) => [e.model, e]));
  ok('模型小写归一 grok-4.6-build', !!byModel['grok-4.6-build']);
  ok('第二模型 grok-4-fast', !!byModel['grok-4-fast']);
  ok('grok-4.6-build 黄金：500/1500/100/80/20/2180',
    byModel['grok-4.6-build']?.input_tokens === 500
    && byModel['grok-4.6-build']?.cached_input === 1500
    && byModel['grok-4.6-build']?.cache_write === 100
    && byModel['grok-4.6-build']?.output_tokens === 80
    && byModel['grok-4.6-build']?.reasoning_tokens === 20
    && byModel['grok-4.6-build']?.total_tokens === 2180,
    JSON.stringify(byModel['grok-4.6-build']));
  ok('grok-4-fast 黄金：100/0/0/10/0/110',
    byModel['grok-4-fast']?.input_tokens === 100
    && byModel['grok-4-fast']?.total_tokens === 110,
    JSON.stringify(byModel['grok-4-fast']));
  ok('project=TokenMonitor（URL 解码 Windows 路径末段，含空格/中文）',
    ev.every((e) => e.project === 'TokenMonitor'), ev.map((e) => e.project).join(','));
  ok('session_id 来自 params.sessionId', ev.every((e) => e.session_id === session));
  ok('秒级 timestamp 换成毫秒', ev[0].ts === GROK_TS_SEC * 1000, String(ev[0].ts));
  ok('工具调用 1 次 Web search', tc.length === 1 && tc[0].name === 'Web search', JSON.stringify(tc));
  ok('dedup_key 不含绝对路径', ev.every((e) => !hasAbsPath(e.dedup_key)) && !hasAbsPath(tc[0].dedup_key),
    ev.map((e) => e.dedup_key).join(','));

  const again = await collectGrokFile(store, { tool: 'grok', path: file, fileId: session, offset: 0 });
  ok('全量重扫幂等 inserted=0', again.inserted === 0, String(again.inserted));
  ok('全量重扫事件数仍为 2', eventsOf(store, 'grok').length === 2);

  const quota = store.getQuota('grok:live');
  ok('进行中水位写入 quota', quota?.data?.context_tokens === 4096, JSON.stringify(quota?.data));

  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[grok] POSIX 百分号编码目录仍解出末段（兼容既有夹具）');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-grok-posix-'));
  const file = join(tmp, '%2Fwork%2FprojD', 's-grok', 'updates.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, crlf([JSON.stringify({
    timestamp: GROK_TS_SEC,
    method: 'session/update',
    params: {
      sessionId: 's-grok',
      update: {
        sessionUpdate: 'turn_completed', prompt_id: 'p1',
        usage: {
          inputTokens: 2000, outputTokens: 100, totalTokens: 2100,
          cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20,
          modelUsage: {
            'grok-4.6-build': {
              inputTokens: 2000, outputTokens: 100, totalTokens: 2100,
              cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20,
            },
          },
        },
      },
    },
  })]), 'utf8');
  const store = makeStore();
  await collectGrokFile(store, { tool: 'grok', path: file, fileId: 's-grok', offset: 0 });
  const ev = eventsOf(store, 'grok');
  ok('POSIX 编码目录 project=projD', ev[0]?.project === 'projD', String(ev[0]?.project));
  ok('既有口径总量 2100', ev[0]?.total_tokens === 2100, String(ev[0]?.total_tokens));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[workbuddy] -WorkBuddy-<中文 空格> 目录 + CRLF + 工具调用');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-wb-'));
  const file = join(tmp, '.WorkBuddy', 'projects', '-WorkBuddy-我的 项目', 's-wb.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const usageLine = {
    timestamp: NOW - 30000, type: 'assistant', id: 'wb1', sessionId: 's-wb',
    providerData: { model: 'GLM-5.3-Flash', traceId: 't-win-1' },
    message: { usage: { input_tokens: 500, output_tokens: 50, total_tokens: 550, cache_read_input_tokens: 400 } },
  };
  const toolLine = {
    timestamp: NOW - 29000, type: 'function_call', id: 'wb-fc1', sessionId: 's-wb',
    name: 'bash', callId: 'tc-wb-1',
  };
  const line1 = JSON.stringify(usageLine);
  writeFileSync(file, line1 + '\r\n' + '{"id":"wb-partial"', 'utf8');
  const store = makeStore();
  const half = await collectWorkbuddyFile(store, { tool: 'workbuddy', path: file, fileId: 's-wb', offset: 0 });
  ok('WorkBuddy 半行不推进 offset', half.newOffset === Buffer.byteLength(line1 + '\r\n'), String(half.newOffset));
  ok('WorkBuddy 半行已入库完整 usage 行', eventsOf(store, 'workbuddy').length === 1);

  writeFileSync(file, crlf([line1, JSON.stringify(usageLine), JSON.stringify(toolLine)]), 'utf8');
  const rest = await collectWorkbuddyFile(store, { tool: 'workbuddy', path: file, fileId: 's-wb', offset: half.newOffset });
  const ev = eventsOf(store, 'workbuddy');
  const tc = toolsOf(store, 'workbuddy');
  ok('重复 usage 行不加倍', ev.length === 1, String(ev.length));
  ok('增量只插入工具调用（inserted=0，事件已在半行阶段入库）', rest.inserted === 0, String(rest.inserted));
  ok('WorkBuddy 黄金：input 100 / cached 400 / out 50 / total 550',
    ev[0].input_tokens === 100 && ev[0].cached_input === 400 && ev[0].output_tokens === 50 && ev[0].total_tokens === 550,
    JSON.stringify(ev[0]));
  ok('模型 glm-5.3-flash', ev[0].model === 'glm-5.3-flash', String(ev[0].model));
  ok('project=我的 项目（目录名，含空格/中文）', ev[0].project === '我的 项目', String(ev[0].project));
  ok('session_id=s-wb', ev[0].session_id === 's-wb');
  ok('trace_id=t-win-1', ev[0].trace_id === 't-win-1', String(ev[0].trace_id));
  ok('function_call 工具调用 bash ×1', tc.length === 1 && tc[0].name === 'bash' && tc[0].dedup_key === 'wb:tc:tc-wb-1',
    JSON.stringify(tc));
  ok('dedup_key 不含绝对路径', !hasAbsPath(ev[0].dedup_key) && !hasAbsPath(tc[0].dedup_key));

  const again = await collectWorkbuddyFile(store, { tool: 'workbuddy', path: file, fileId: 's-wb', offset: 0 });
  ok('WorkBuddy 全量重扫幂等', again.inserted === 0 && eventsOf(store, 'workbuddy').length === 1);
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[workbuddy] 无 -WorkBuddy- 前缀时回退为目录名本身');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-wb2-'));
  const dirName = 'c-Users-Test User-work-中文项目';
  const file = join(tmp, dirName, 's-wb.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, crlf([JSON.stringify({
    timestamp: NOW, type: 'assistant', id: 'wb2', sessionId: 's-wb2',
    providerData: { model: 'glm-5.3-flash', traceId: 't2' },
    message: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_input_tokens: 0 } },
  })]), 'utf8');
  const store = makeStore();
  await collectWorkbuddyFile(store, { tool: 'workbuddy', path: file, fileId: 's-wb2', offset: 0 });
  const ev = eventsOf(store, 'workbuddy');
  ok('回退 project=目录名', ev[0]?.project === dirName, String(ev[0]?.project));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[pi] session.cwd Windows 路径 + 跨轮次 state + CRLF/半行');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-pi-'));
  const fileId = '2026-09-16T00-00-00-000Z_s-pi-win';
  const file = join(tmp, 'Pi Data', '中文 会话', `${fileId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });

  const sessionLine = JSON.stringify({
    type: 'session', version: 3, id: 's-pi-win', timestamp: new Date(NOW - 70000).toISOString(),
    cwd: 'D:\\Users\\Test User\\我的 项目\\TokenMonitor',
  });
  const p1 = JSON.stringify({
    type: 'message', id: 'p1', timestamp: new Date(NOW - 60000).toISOString(),
    message: {
      role: 'assistant', model: 'Pi-Test-Model',
      usage: { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0, reasoning: 10, totalTokens: 1540 },
    },
  });
  const p2 = JSON.stringify({
    type: 'message', id: 'p2', timestamp: new Date(NOW - 40000).toISOString(),
    message: {
      role: 'assistant', model: 'Pi-Test-Model',
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 50, reasoning: 0, totalTokens: 170 },
      content: [{ type: 'toolCall', id: 'call_pi1', name: 'bash', arguments: '{}' }],
    },
  });

  writeFileSync(file, sessionLine + '\r\n' + p1.slice(0, 30), 'utf8');
  const store = makeStore();
  const half = await collectPiFile(store, {
    tool: 'pi', path: file, fileId, offset: 0, state: undefined, version: 1,
  });
  ok('Pi 半行不推进 offset', half.newOffset === Buffer.byteLength(sessionLine + '\r\n'), String(half.newOffset));
  ok('Pi 半行无事件（session 行不入库）', eventsOf(store, 'pi').length === 0);
  ok('Pi state.project 已从 cwd 记下 TokenMonitor', half.state?.project === 'TokenMonitor', String(half.state?.project));

  writeFileSync(file, crlf([sessionLine, p1, p1]), 'utf8');
  const round1 = await collectPiFile(store, {
    tool: 'pi', path: file, fileId, offset: half.newOffset, state: half.state, version: 1,
  });
  let ev = eventsOf(store, 'pi');
  ok('p1 入库 1 条（重复行 dedup）', ev.length === 1 && round1.inserted === 1, String(ev.length));
  ok('Pi p1 黄金：300/1200/0/40/10/1540',
    ev[0].input_tokens === 300 && ev[0].cached_input === 1200 && ev[0].cache_write === 0
    && ev[0].output_tokens === 40 && ev[0].reasoning_tokens === 10 && ev[0].total_tokens === 1540,
    JSON.stringify(ev[0]));
  ok('Pi p1 project=TokenMonitor（Windows cwd 末段）', ev[0].project === 'TokenMonitor', String(ev[0].project));
  ok('Pi session_id 来自文件名下划线后缀', ev[0].session_id === 's-pi-win', String(ev[0].session_id));
  ok('模型小写 pi-test-model', ev[0].model === 'pi-test-model');

  // 增量续写：不再重读 session 行，project 必须靠 state
  appendFileSync(file, p2 + '\r\n', 'utf8');
  const round2 = await collectPiFile(store, {
    tool: 'pi', path: file, fileId, offset: round1.newOffset, state: round1.state, version: 1,
  });
  ev = eventsOf(store, 'pi');
  const tc = toolsOf(store, 'pi');
  ok('续写插入 p2', round2.inserted === 1 && ev.length === 2, `${round2.inserted}/${ev.length}`);
  const e2 = ev.find((e) => e.dedup_key === 'pi:s-pi-win:p2');
  ok('Pi p2 黄金：100/0/50/20/0/170',
    e2?.input_tokens === 100 && e2?.cached_input === 0 && e2?.cache_write === 50
    && e2?.output_tokens === 20 && e2?.total_tokens === 170, JSON.stringify(e2));
  ok('续写事件仍带 project（state 跨轮次）', e2?.project === 'TokenMonitor', String(e2?.project));
  ok('Pi 工具调用 bash ×1', tc.length === 1 && tc[0].name === 'bash', JSON.stringify(tc));
  ok('Pi 总量 1710', ev.reduce((s, e) => s + e.total_tokens, 0) === 1710);
  ok('dedup_key 不含绝对路径', ev.every((e) => !hasAbsPath(e.dedup_key)));

  const again = await collectPiFile(store, {
    tool: 'pi', path: file, fileId, offset: 0, state: round2.state, version: 1,
  });
  ok('Pi 全量重扫幂等', again.inserted === 0 && eventsOf(store, 'pi').length === 2, String(again.inserted));

  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[pi] 正斜杠 Windows cwd 与 POSIX cwd');
{
  const tmp = mkdtempSync(join(tmpdir(), 'jsonl-b-pi2-'));
  const cases = [
    ['D:/Users/Test User/我的 项目/TokenMonitor', 'TokenMonitor'],
    ['/work/projG', 'projG'],
  ];
  for (const [cwd, want] of cases) {
    const fileId = `t_${randomBytes(4).toString('hex')}`;
    const file = join(tmp, `${fileId}.jsonl`);
    writeFileSync(file, crlf([
      JSON.stringify({ type: 'session', id: fileId, cwd }),
      JSON.stringify({
        type: 'message', id: 'm1', timestamp: new Date(NOW).toISOString(),
        message: { role: 'assistant', model: 'x', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2 } },
      }),
    ]), 'utf8');
    const store = makeStore();
    await collectPiFile(store, { tool: 'pi', path: file, fileId, offset: 0, version: 1 });
    const ev = eventsOf(store, 'pi');
    ok(`cwd ${cwd} → project=${want}`, ev[0]?.project === want, String(ev[0]?.project));
    closeStore(store);
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\njsonl-b FAILED ${failed}`);
  process.exit(1);
}
console.log('\njsonl-b OK');
