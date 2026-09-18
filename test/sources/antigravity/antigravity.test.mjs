/**
 * Antigravity 来源专属测试（#20）。
 *
 * fixture 全部为运行时合成的最小 SQLite/protobuf（无任何真实会话数据）；
 * 黄金数字见各断言。覆盖：manifest 契约与路径去重、行解码（含 f10 缺席回退、
 * 重复字段取最后）、collector 黄金数、增量水位、重扫幂等（dedup）、文件锁
 * 跳过、锚点缺失降级、注册表自动发现。
 *
 * 运行：TOKENMONITOR_OFFLINE=1 node test/sources/antigravity/antigravity.test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TOKENMONITOR_OFFLINE = '1';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

let failed = 0;
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const { default: manifest } = await import(pathToFileURL(join(repo, 'src/sources/antigravity.js')).href);
const { collectAntigravity, decodeGenerationRow } = await import(pathToFileURL(join(repo, 'src/collectors/antigravity.js')).href);
const { validateManifest, dedupeRoots } = await import(pathToFileURL(join(repo, 'src/sources/contract.js')).href);
const { Store } = await import(pathToFileURL(join(repo, 'src/store.js')).href);
const { normalizeModel } = await import(pathToFileURL(join(repo, 'src/models.js')).href);
const { loadSources } = await import(pathToFileURL(join(repo, 'src/source-registry.js')).href);

/* ---------- 合成 protobuf 编码（与真实 wire format 同构的最小编码器） ---------- */
const varint = (n) => {
  const out = [];
  let v = n;
  do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return out;
};
const tag = (f, w) => varint(f * 8 + w);
const vfield = (f, n) => [...tag(f, 0), ...varint(n)];
const lfield = (f, bytes) => [...tag(f, 2), ...varint(bytes.length), ...bytes];
const sfield = (f, s) => lfield(f, [...Buffer.from(s, 'utf8')]);
const msg = (...parts) => Uint8Array.from([].concat(...parts));

/**
 * gen_metadata.data：外层 f1 = Generation{ f4 = ModelUsageStats, [f9 = 完成时间],
 * f19 = 模型 }。ModelUsageStats：f2=input f3=总输出 f4=cache写 f5=cache读
 * f9=thinking f10=可见输出。
 */
function genRow({ model, input, outTotal, cacheWrite = 0, cacheRead = 0, thinking = 0, visible = null, ts = null }) {
  const usage = msg(
    vfield(2, input),
    vfield(3, outTotal),
    cacheWrite ? vfield(4, cacheWrite) : [],
    cacheRead ? vfield(5, cacheRead) : [],
    thinking ? vfield(9, thinking) : [],
    visible != null ? vfield(10, visible) : [],
  );
  const gen = msg(
    lfield(4, usage),
    ts ? lfield(9, msg(lfield(4, msg(vfield(1, ts.sec), vfield(2, ts.nanos))))) : [],
    sfield(19, model),
  );
  return msg(lfield(1, gen));
}
/** steps.metadata：f1 = { f1 = 秒, f2 = 纳秒 }（本机 build 的生成时间来源）。 */
const stepMeta = (sec, nanos) => msg(lfield(1, msg(vfield(1, sec), vfield(2, nanos))));

/* ---------- fixture 库构造 ---------- */
function newHome(home) {
  mkdirSync(join(home, 'conversations'), { recursive: true });
  const summaries = new DatabaseSync(join(home, 'conversation_summaries.db'));
  summaries.exec(`CREATE TABLE conversation_summaries (
    conversation_id text, title text, workspace_uris text)`);
  summaries.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)')
    .run('conv-aaa', '标题 A', JSON.stringify(['file:///D:/work/my%20proj']));
  summaries.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)')
    .run('conv-bbb', '标题 B', '[]');
  summaries.close();
}

function newConvDb(path, { wal = true } = {}) {
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE gen_metadata (
    idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))`);
  db.exec(`CREATE TABLE steps (
    idx integer, metadata blob, PRIMARY KEY (idx))`);
  return db;
}

const SEC0 = 1726000000;
const SEC1 = 1726000100;

/* =================================================================== */

console.log('\n[manifest] 契约与路径发现');
{
  const v = validateManifest(manifest);
  ok('validateManifest 通过', v.ok, v.error || '');
  ok('tool/kind/version/collector', manifest.tool === 'antigravity' && manifest.kind === 'sqlite'
    && manifest.version === 1 && manifest.collector === 'antigravity', JSON.stringify(manifest));
  ok('apiBilled 未设置（订阅计量，无 API 钱包证据）', manifest.apiBilled === undefined);

  const home = join('D:\\', 'Users', 'Test User', '我的 项目');
  const roots = manifest.roots({
    homedir: home,
    env: { ANTIGRAVITY_HOME: 'Z:\\Agy Home' },
    caseInsensitive: true,
  });
  ok('ANTIGRAVITY_HOME 候选排第一', roots[0] === join('Z:\\Agy Home', 'conversation_summaries.db'), roots[0]);
  ok('homedir 候选含空格与中文', roots.some((r) => r.includes('Test User') && r.includes('我的 项目')), JSON.stringify(roots));
  ok('覆盖 -cli/-acp/-ide 变体', ['cli', 'acp', 'ide'].every((v) => roots.some((r) => r.includes(`antigravity-${v}`))), JSON.stringify(roots));
  ok('不含 undefined 根', roots.every((r) => r && !r.includes('undefined')));

  // 注册器级大小写不敏感去重（Windows）
  const dupRoots = manifest.roots({
    homedir: home,
    env: { ANTIGRAVITY_HOME: join(home, '.gemini', 'antigravity') }, // 与 homedir 候选仅大小写不同也去重：构造同路径
    caseInsensitive: true,
  });
  const deduped = dedupeRoots(dupRoots, { caseInsensitive: true });
  ok('去重后无大小写变体重复', deduped.length === new Set(deduped.map((p) => p.toLowerCase())).size, JSON.stringify(deduped));
}

console.log('\n[decode] 行解码黄金数');
{
  const d = decodeGenerationRow(genRow({
    model: 'gemini-3.8-flash', input: 120, outTotal: 40, cacheWrite: 5, cacheRead: 50,
    thinking: 10, visible: 30, ts: { sec: SEC0, nanos: 500000000 },
  }));
  ok('input/cacheRead/cacheWrite', d.input === 120 && d.cacheRead === 50 && d.cacheWrite === 5, JSON.stringify(d));
  ok('output 主口径 f3=40（含 thinking；实测 f3=f9+f10）', d.output === 40, `output=${d.output}`);
  ok('reasoning=10', d.reasoning === 10);
  ok('行内时间戳 1726000000500', d.ts === 1726000000500, String(d.ts));

  const fb = decodeGenerationRow(genRow({ model: 'claude-opus-4-6-thinking', input: 200, outTotal: 90, thinking: 40 }));
  ok('f3 存在即主口径（output=90）', fb.output === 90, `output=${fb.output}`);
  const noF3 = decodeGenerationRow(genRow({ model: 'm', input: 10, outTotal: 0, thinking: 10, visible: 30 }));
  ok('f3 缺席回退 f10+f9=40', noF3.output === 40, `output=${noF3.output}`);

  const rep = decodeGenerationRow(msg(
    lfield(1, msg(lfield(4, msg(vfield(2, 1), vfield(2, 7))), sfield(19, 'm'))),
  ));
  ok('重复标量字段取最后一个（7）', rep.input === 7, String(rep.input));

  let threw = false;
  try { decodeGenerationRow(Uint8Array.from([0xff, 0xff, 0xff])); } catch { threw = true; }
  ok('坏记录抛错（由 collector 按行跳过）', threw);
}

console.log('\n[collector] 黄金数 / 增量 / 幂等 / 锁');
{
  const tmp = mkdtempSync(join(tmpdir(), 'agy-test-'));
  const home = join(tmp, '.gemini', 'antigravity');
  newHome(home);
  const store = new Store(join(tmp, 'store.db'));

  const conv1 = newConvDb(join(home, 'conversations', 'conv-aaa.db'));
  conv1.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(0, Buffer.from(genRow({
    model: 'Gemini-3.8-Flash', input: 120, outTotal: 40, cacheWrite: 5, cacheRead: 50, thinking: 10, visible: 30,
  })));
  conv1.prepare('INSERT INTO steps VALUES (?, ?)').run(0, Buffer.from(stepMeta(SEC0, 500000000)));
  conv1.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(1, Buffer.from(genRow({
    model: 'gemini-3.8-flash', input: 0, outTotal: 0, thinking: 0,
  })));
  conv1.prepare('INSERT INTO steps VALUES (?, ?)').run(1, Buffer.from(stepMeta(SEC0, 600000000)));
  conv1.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(2, Buffer.from([0xff, 0xff, 0xff])); // 坏记录
  conv1.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(3, Buffer.from(genRow({
    model: 'claude-opus-4-6-thinking', input: 200, outTotal: 90, thinking: 40,
  })));
  conv1.prepare('INSERT INTO steps VALUES (?, ?)').run(3, Buffer.from(stepMeta(SEC1, 0)));
  conv1.close();

  const conv2 = newConvDb(join(home, 'conversations', 'conv-bbb.db'));
  conv2.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(0, Buffer.from(genRow({
    model: 'gemini-3.1-pro-low', input: 10, outTotal: 2, thinking: 1,
    ts: { sec: 1726000200, nanos: 250000000 },
  })));
  conv2.close(); // 行内自带时间戳：无需 steps 行

  const anchor = join(home, 'conversation_summaries.db');
  const r1 = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: undefined, version: 1 });
  ok('首轮 inserted=3（零用量/坏记录跳过）', r1.inserted === 3, String(r1.inserted));

  const ev = (idx) => store.db.prepare(
    "SELECT * FROM events WHERE tool='antigravity' AND dedup_key = ?"
  ).get(`antigravity:conv-aaa:${idx}`);
  const e0 = ev(0);
  ok('conv-aaa#0 模型归一小写', e0 && e0.model === 'gemini-3.8-flash', JSON.stringify(e0));
  ok('conv-aaa#0 token 黄金数 120/50/5/40/10/215',
    e0.input_tokens === 120 && e0.cached_input === 50 && e0.cache_write === 5
    && e0.output_tokens === 40 && e0.reasoning_tokens === 10 && e0.total_tokens === 215, JSON.stringify(e0));
  ok('conv-aaa#0 时间戳来自 steps 1726000000500', e0.ts === 1726000000500, String(e0.ts));
  ok('conv-aaa#0 项目取 workspace 末段（含 %20 解码）', e0.project === 'my proj', String(e0.project));
  ok('conv-aaa#0 会话=库干', e0.session_id === 'conv-aaa');
  const e3 = ev(3);
  ok('conv-aaa#3 output=f3=90（含 thinking）、total=290',
    e3 && e3.output_tokens === 90 && e3.reasoning_tokens === 40 && e3.total_tokens === 290, JSON.stringify(e3));
  const eB = store.db.prepare("SELECT * FROM events WHERE dedup_key = 'antigravity:conv-bbb:0'").get();
  ok('conv-bbb#0 行内时间戳 1726000200250、项目 null',
    eB && eB.ts === 1726000200250 && eB.project === null && eB.total_tokens === 12, JSON.stringify(eB));

  // 增量：conv-aaa 追加 idx=4；conv-bbb 不动
  const c1b = new DatabaseSync(join(home, 'conversations', 'conv-aaa.db'));
  c1b.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(4, Buffer.from(genRow({
    model: 'gemini-3.8-flash', input: 7, outTotal: 3, thinking: 1, visible: 2,
  })));
  c1b.prepare('INSERT INTO steps VALUES (?, ?)').run(4, Buffer.from(stepMeta(SEC1, 700000000)));
  c1b.close();
  const r2 = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: r1.state, version: 1 });
  ok('增量只读新行：inserted=1', r2.inserted === 1, String(r2.inserted));
  ok('新行入库', !!store.db.prepare("SELECT 1 FROM events WHERE dedup_key='antigravity:conv-aaa:4'").get());

  // 幂等：同 state 重扫 / 全量重读（清空 state）都不重复计数
  const r3 = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: r2.state, version: 1 });
  const r4 = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: { conv: {} }, version: 1 });
  ok('水位重扫 inserted=0', r3.inserted === 0, String(r3.inserted));
  ok('全量重读 dedup 幂等 inserted=0', r4.inserted === 0, String(r4.inserted));
  ok('版本升级触发全量重扫也不重复', (await collectAntigravity(store, {
    tool: 'antigravity', path: anchor, state: { ...r2.state, _v: 0 }, version: 2,
  })).inserted === 0);

  // 锁：非 WAL 库 + 他方 EXCLUSIVE 事务 → 该会话本轮跳过，水位不动
  const locked = newConvDb(join(home, 'conversations', 'conv-ccc.db'), { wal: false });
  locked.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(0, Buffer.from(genRow({
    model: 'gemini-3.8-flash', input: 9, outTotal: 1, ts: { sec: 1726000300, nanos: 0 },
  })));
  locked.close();
  const anchorState = r2.state;
  const writer = new DatabaseSync(join(home, 'conversations', 'conv-ccc.db'));
  writer.exec('BEGIN EXCLUSIVE');
  writer.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(1, Buffer.from(genRow({ model: 'x', input: 1, outTotal: 1 })));
  const before = store.db.prepare("SELECT COUNT(*) n FROM events WHERE tool='antigravity'").get().n;
  const rLock = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: anchorState, version: 1 });
  const after = store.db.prepare("SELECT COUNT(*) n FROM events WHERE tool='antigravity'").get().n;
  ok('EXCLUSIVE 锁下不抛错且跳过被锁会话', before === after, `${before} -> ${after}`);
  ok('被锁会话水位未推进', rLock.state.conv['conv-ccc'] === undefined || rLock.state.conv['conv-ccc'] === 0, JSON.stringify(rLock.state.conv));
  writer.exec('ROLLBACK');
  writer.close();
  const rUnlocked = await collectAntigravity(store, { tool: 'antigravity', path: anchor, state: rLock.state, version: 1 });
  ok('锁释放后补采（水位从未推进）', rUnlocked.inserted === 1, String(rUnlocked.inserted));

  // 锚点缺失：manifest 指向的 summaries 库不存在 → skip，不抛
  const miss = await collectAntigravity(store, {
    tool: 'antigravity', path: join(tmp, 'nope', 'conversation_summaries.db'), state: undefined, version: 1,
  });
  ok('锚点缺失 skip:true / inserted 0', miss.skip === true && miss.inserted === 0, JSON.stringify(miss));

  store.close();
  ok('临时目录可清理（只读句柄已关）', existsSync(join(tmp, 'store.db')));
}

console.log('\n[registry] 自动发现');
{
  const loaded = await loadSources({
    context: {
      homedir: join('D:\\', 'Users', 'Test User', '我的 项目'),
      env: {},
      caseInsensitive: true,
    },
  });
  const agy = loaded.sources.find((s) => s.tool === 'antigravity');
  ok('注册表自动发现 antigravity', !!agy, JSON.stringify(loaded.errors));
  ok('collect 已解析为函数', typeof agy?.collect === 'function');
  ok('无来源级注册错误', loaded.errors.length === 0, JSON.stringify(loaded.errors));
  ok('根目录落在注入的 homedir 下（测试可隔离）',
    !!agy && agy.roots.every((r) => r.startsWith(join('D:\\', 'Users', 'Test User', '我的 项目'))), JSON.stringify(agy?.roots));
  ok('normalizeModel 输出小写', normalizeModel('Gemini-3.8-Flash') === 'gemini-3.8-flash');
}

console.log(`\nantigravity ${passed} 项通过${failed ? `，FAILED ${failed}` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
