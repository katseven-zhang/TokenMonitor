/**
 * Win-SQLite：ZCode / OpenCode 只读 WAL、BUSY 跳过、rowid 复用、Windows 路径黄金数字。
 *
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/sqlite-sources.test.mjs
 * 临时库建在 os.tmpdir()，测完关闭句柄再删。
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { collectZcodeDb } = await import(pathToFileURL(join(ROOT, 'src/collectors/zcode.js')).href);
const { collectOpencodeDb } = await import(pathToFileURL(join(ROOT, 'src/collectors/opencode.js')).href);
const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-src-store-'));
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

const NOW = Date.now();

function createZcodeDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const z = new DatabaseSync(file);
  z.exec('PRAGMA journal_mode = WAL');
  z.exec(`CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT,
    status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`);
  z.exec(`CREATE TABLE tool_usage (session_id TEXT, tool_name TEXT, started_at INTEGER)`);
  z.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)`);
  return z;
}

function createOpencodeDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const o = new DatabaseSync(file);
  o.exec('PRAGMA journal_mode = WAL');
  o.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT)`);
  o.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  o.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
  return o;
}

console.log('\n[zcode] 只读 + Windows cwd + 黄金数字 + 增量');
{
  const tmp = mkdtempSync(join(tmpdir(), 'sqlite-zcode-'));
  const file = join(tmp, '中文 目录', 'db.sqlite');
  const z = createZcodeDb(file);
  z.prepare(`INSERT INTO model_usage VALUES ('u1','s-zc','prov','GLM-5.3','completed',?,800,60,0,0,700,860)`).run(NOW - 20000);
  z.prepare(`INSERT INTO tool_usage VALUES ('s-zc','Bash',?)`).run(NOW - 20000);
  z.prepare(`INSERT INTO session VALUES ('s-zc',?)`).run('D:\\Users\\Test User\\我的 项目\\projF');
  z.close();

  const store = makeStore();
  const r1 = await collectZcodeDb(store, { path: file, version: 2 });
  const ev = eventsOf(store, 'zcode');
  const tc = toolsOf(store, 'zcode');
  ok('ZCode 1 事件 total 860', ev.length === 1 && ev[0].total_tokens === 860, JSON.stringify(ev[0]));
  ok('ZCode 黄金：fresh 100 / cached 700 / out 60',
    ev[0].input_tokens === 100 && ev[0].cached_input === 700 && ev[0].output_tokens === 60, JSON.stringify(ev[0]));
  ok('ZCode project=projF（Windows 路径末段）', ev[0].project === 'projF', String(ev[0].project));
  ok('ZCode 模型 glm-5.3', ev[0].model === 'glm-5.3');
  ok('ZCode 工具 Bash ×1', tc.length === 1 && tc[0].name === 'Bash');
  ok('水位推进', r1.state.maxRowid >= 1 && r1.state.toolMaxRowid >= 1, JSON.stringify(r1.state));

  const z2 = new DatabaseSync(file);
  z2.prepare(`INSERT INTO model_usage VALUES ('u2','s-zc','prov','GLM-5.3','completed',?,50,5,0,0,0,55)`).run(NOW - 10000);
  z2.close();
  const r2 = await collectZcodeDb(store, { path: file, state: r1.state, version: 2 });
  ok('WAL 追加后增量 1 条', r2.inserted === 1 && eventsOf(store, 'zcode').length === 2, String(r2.inserted));
  ok('新事件 total 55', eventsOf(store, 'zcode').some((e) => e.total_tokens === 55));

  const r3 = await collectZcodeDb(store, { path: file, state: r2.state, version: 2 });
  ok('重复扫描幂等', r3.inserted === 0 && eventsOf(store, 'zcode').length === 2);

  closeStore(store);
  ok('句柄关闭后可删临时库', (rmSync(tmp, { recursive: true, force: true }), !existsSync(file)));
}

console.log('\n[zcode] 与写入方 WAL 并发（不复制、不要求关闭）');
{
  const tmp = mkdtempSync(join(tmpdir(), 'sqlite-zcode-wal-'));
  const file = join(tmp, 'db.sqlite');
  const writer = createZcodeDb(file);
  writer.prepare(`INSERT INTO session VALUES ('s-zc',?)`).run('D:/work/projF');
  writer.prepare(`INSERT INTO model_usage VALUES ('u1','s-zc','prov','m','completed',?,10,2,0,0,0,12)`).run(NOW);
  const store = makeStore();
  const r = await collectZcodeDb(store, { path: file, version: 2 });
  ok('写入方仍打开时只读采集成功', r.skip !== true && r.inserted === 1, JSON.stringify(r));
  ok('并发读取 project=projF', eventsOf(store, 'zcode')[0]?.project === 'projF');
  writer.prepare(`INSERT INTO model_usage VALUES ('u2','s-zc','prov','m','completed',?,3,1,0,0,0,4)`).run(NOW + 1);
  const r2 = await collectZcodeDb(store, { path: file, state: r.state, version: 2 });
  ok('写入方未关闭时增量仍可见', r2.inserted === 1, String(r2.inserted));
  writer.close();
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[zcode] 缺失/占用 → skip，下一轮可恢复');
{
  const store = makeStore();
  const missing = join(tmpdir(), 'no-such-zcode-dir', 'db.sqlite');
  const r = await collectZcodeDb(store, { path: missing, version: 2 });
  ok('缺失库 skip 且不抛', r.skip === true && r.inserted === 0);

  const tmp = mkdtempSync(join(tmpdir(), 'sqlite-zcode-busy-'));
  const file = join(tmp, 'db.sqlite');
  const writer = createZcodeDb(file);
  writer.prepare(`INSERT INTO session VALUES ('s-zc','/work/projF')`).run();
  writer.exec('BEGIN EXCLUSIVE');
  const t0 = Date.now();
  const busy = await collectZcodeDb(store, { path: file, version: 2 });
  const waited = Date.now() - t0;
  ok('EXCLUSIVE 锁下 skip 或读到（不崩溃）', busy.skip === true || busy.inserted >= 0, JSON.stringify(busy));
  ok('BUSY 路径在超时窗口内返回', waited < 8000, String(waited));
  writer.exec('COMMIT');
  writer.prepare(`INSERT INTO model_usage VALUES ('u1','s-zc','prov','m','completed',?,10,1,0,0,0,11)`).run(NOW);
  writer.close();
  const after = await collectZcodeDb(store, { path: file, state: busy.state, version: 2 });
  ok('锁释放后下一轮可恢复', after.skip !== true && eventsOf(store, 'zcode').length >= 1, JSON.stringify(after));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[opencode] Windows cwd + 黄金数字 + 先插后改 + rowid 复用');
{
  const tmp = mkdtempSync(join(tmpdir(), 'sqlite-oc-'));
  const file = join(tmp, '中文 目录', 'opencode.db');
  const o = createOpencodeDb(file);
  o.prepare(`INSERT INTO session VALUES ('s-oc', ?, 'title')`).run('D:\\Users\\Test User\\我的 项目\\projH');
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

  const store = makeStore();
  const r1 = await collectOpencodeDb(store, { tool: 'opencode', path: file, version: 2 });
  const ev = eventsOf(store, 'opencode');
  const tc = toolsOf(store, 'opencode');
  ok('OpenCode 1 事件 total 700（user 无 tokens 不入库）', ev.length === 1 && ev[0].total_tokens === 700, JSON.stringify(ev[0]));
  ok('OpenCode 黄金：200/400/40/60/5',
    ev[0].input_tokens === 200 && ev[0].cached_input === 400 && ev[0].cache_write === 40
    && ev[0].output_tokens === 60 && ev[0].reasoning_tokens === 5, JSON.stringify(ev[0]));
  ok('OpenCode project=projH', ev[0].project === 'projH', String(ev[0].project));
  ok('OpenCode 模型 oc-test-model', ev[0].model === 'oc-test-model');
  ok('OpenCode 工具 webfetch ×1', tc.length === 1 && tc[0].name === 'webfetch');

  const o2 = new DatabaseSync(file);
  const t0 = Date.now();
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  o2.prepare(`INSERT INTO message VALUES ('oc-a3', 's-oc', ?, ?, ?)`).run(t0, t0, JSON.stringify({
    role: 'assistant', modelID: 'Oc-Test-Model', tokens: zero, time: { created: t0 },
  }));
  o2.close();
  const mid = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r1.state, version: 2 });
  ok('生成中途 0 用量不入库', eventsOf(store, 'opencode').length === 1, String(mid.inserted));

  const o3 = new DatabaseSync(file);
  o3.prepare(`UPDATE message SET time_updated = ?, data = ? WHERE id = 'oc-a3'`).run(t0 + 5000, JSON.stringify({
    role: 'assistant', modelID: 'Oc-Test-Model',
    tokens: { total: 456, input: 400, output: 56, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: t0, completed: t0 + 5000 },
  }));
  o3.close();
  const done = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: mid.state, version: 2 });
  ok('完成后补采 total 456', done.inserted === 1 && eventsOf(store, 'opencode').some((e) => e.total_tokens === 456));

  const o4 = new DatabaseSync(file);
  o4.exec("DELETE FROM message WHERE id = 'oc-a1'");
  const newTs = Date.now();
  o4.prepare(`INSERT INTO message VALUES ('oc-a2', 's-oc', ?, ?, ?)`).run(newTs, newTs, JSON.stringify({
    role: 'assistant', modelID: 'Oc-Test-Model',
    tokens: { total: 123, input: 100, output: 23, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: newTs },
  }));
  const reused = o4.prepare("SELECT rowid AS r FROM message WHERE id = 'oc-a2'").get().r;
  o4.close();
  ok('新消息复用了被删 rowid（或至少插入成功）', reused >= 1, String(reused));
  const afterDel = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: done.state, version: 2 });
  ok('rowid 复用后新消息仍被采到', eventsOf(store, 'opencode').some((e) => e.dedup_key === 'opencode:oc-a2' && e.total_tokens === 123),
    JSON.stringify(eventsOf(store, 'opencode').map((e) => e.dedup_key)));
  ok('被删消息的历史事件仍保留', eventsOf(store, 'opencode').some((e) => e.dedup_key === 'opencode:oc-a1'));
  ok('增量插入', afterDel.inserted === 1, String(afterDel.inserted));

  const again = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: afterDel.state, version: 2 });
  ok('OpenCode 重复扫描幂等', again.inserted === 0);

  closeStore(store);
  ok('OpenCode 句柄关闭后可删临时库', (rmSync(tmp, { recursive: true, force: true }), !existsSync(file)));
}

console.log('\n[#96-9] part 表 rowid 复用：水位所指那一行被换掉时必须整表重读');
{
  const tmp = mkdtempSync(join(tmpdir(), 'sqlite-oc-part-'));
  const file = join(tmp, '中文 目录', 'opencode.db');
  const o = createOpencodeDb(file);
  o.prepare(`INSERT INTO session VALUES ('s-oc', ?, 't')`).run('D:\\Users\\Test User\\我的 项目\\projH');
  // part 只带工具，不带 message 行：本用例只盯 part 的 rowid 水位，不与 message 的
  // time_updated 轴纠缠。
  const insPart = (db, id, ts, name, callId) => db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, 'm1', 's-oc', ts, ts, JSON.stringify({
      type: 'tool', tool: name, callID: callId, state: { status: 'completed', time: { start: ts } },
    }));
  for (let i = 1; i <= 5; i++) insPart(o, `p${i}`, NOW - 5000 + i * 100, `tool-${i}`, `call-${i}`);
  o.close();

  const store = makeStore();
  const tools = () => toolsOf(store, 'opencode');
  const names = () => tools().map((t) => t.name).join(',');
  const rowAt = (rid) => {
    const d = new DatabaseSync(file);
    const r = d.prepare('SELECT id FROM part WHERE rowid = ?').get(rid);
    const m = d.prepare('SELECT MAX(rowid) AS m FROM part').get().m;
    d.close();
    return { id: r?.id ?? null, max: m };
  };

  const r1 = await collectOpencodeDb(store, { tool: 'opencode', path: file, version: 2 });
  ok('part 首扫 5 条工具调用', tools().length === 5, names());
  ok('part 水位停在 MAX(rowid)=5 并记下那一行的主键',
    r1.state.partMaxRowid === 5 && r1.state.partMaxRowidId === 'p5', JSON.stringify(r1.state));
  ok('首扫不触发重读', r1.state.partRewinds === 0, String(r1.state.partRewinds));

  // OpenCode 的 part 随 message ON DELETE CASCADE，还带 revert：删掉的可以正是最大那条。
  const o2 = new DatabaseSync(file);
  o2.exec("DELETE FROM part WHERE id = 'p5'");
  insPart(o2, 'p6', NOW + 1000, 'tool-6', 'call-6');
  o2.close();
  const at5 = rowAt(5);
  ok('新 part 复用了被删掉的 5 号（`rowid > 水位` 一行也读不到）',
    at5.id === 'p6' && at5.max === 5, JSON.stringify(at5));
  ok('MAX(rowid) 又回到水位本身：只比 max<水位 的旧判据在此失灵',
    at5.max === r1.state.partMaxRowid, `max=${at5.max} wm=${r1.state.partMaxRowid}`);

  const r2 = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r1.state, version: 2 });
  ok('第二轮仍采到复用 rowid 的新 part', tools().some((t) => t.name === 'tool-6'), names());
  ok('整表重读不产生重复工具行（dedup_key 兜住幂等）', tools().length === 6, `${tools().length}：${names()}`);
  ok('重读被记了一次账', r2.state.partRewinds === 1, String(r2.state.partRewinds));
  ok('水位与身份成对前进',
    r2.state.partMaxRowid === 5 && r2.state.partMaxRowidId === 'p6', JSON.stringify(r2.state));

  const r3 = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r2.state, version: 2 });
  ok('无事的一轮不回看、不重复计数',
    tools().length === 6 && r3.state.partRewinds === 1 && r3.state.partMaxRowid === 5,
    JSON.stringify([tools().length, r3.state.partRewinds, r3.state.partMaxRowid]));

  // 纯删除（不补插入）：MAX(rowid) 缩短，仍是旧的那条路
  const o4 = new DatabaseSync(file);
  o4.exec("DELETE FROM part WHERE id = 'p6'");
  o4.close();
  const r4 = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r3.state, version: 2 });
  ok('只删不插时 MAX(rowid) 缩短也能触发回看', r4.state.partRewinds === 2, JSON.stringify(r4.state));
  const o5 = new DatabaseSync(file);
  insPart(o5, 'p7', NOW + 2000, 'tool-7', 'call-7');
  o5.close();
  const r5 = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r4.state, version: 2 });
  ok('缩短后补回来的 part 采到', tools().some((t) => t.name === 'tool-7'), names());
  ok('回看后水位重新对齐', r5.state.partMaxRowid === 5 && r5.state.partMaxRowidId === 'p7',
    JSON.stringify([r5.state.partMaxRowid, r5.state.partMaxRowidId]));

  // 中间行删除 + 追加：MAX 不变、水位那一行仍是原来那条 → **不该**整表重读，
  // 新行按 rowid > 水位 增量就跟得上（否则每次 revert 都要重扫整张 part 表）。
  const o6 = new DatabaseSync(file);
  o6.exec("DELETE FROM part WHERE id = 'p2'");
  insPart(o6, 'p8', NOW + 3000, 'tool-8', 'call-8');
  insPart(o6, 'p9', NOW + 4000, 'tool-9', 'call-9');
  o6.close();
  const r6 = await collectOpencodeDb(store, { tool: 'opencode', path: file, state: r5.state, version: 2 });
  const tc6 = tools();
  ok('删中间行后追加的新 part 两条都采到',
    tc6.some((t) => t.name === 'tool-8') && tc6.some((t) => t.name === 'tool-9'), names());
  ok('中间行删除不触发整表重读（只在水位那行被换掉时回看）',
    r6.state.partRewinds === r5.state.partRewinds, `${r5.state.partRewinds} -> ${r6.state.partRewinds}`);
  ok('水位只按增量前进', r6.state.partMaxRowid === 7 && r6.state.partMaxRowidId === 'p9',
    JSON.stringify([r6.state.partMaxRowid, r6.state.partMaxRowidId]));
  ok('被删 part 的历史工具行仍保留', tc6.some((t) => t.name === 'tool-2'), names());
  ok('工具行不增不减：9 条 part 各一行，被删过行的历史仍留着',
    tc6.length === 9, `${tc6.length}：${names()}`);

  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nsqlite-sources FAILED ${failed}`);
  process.exit(1);
}
console.log('\nsqlite-sources OK');
