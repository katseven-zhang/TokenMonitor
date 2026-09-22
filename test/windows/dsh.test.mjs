/**
 * Win-DSH：无外部 zstd.exe 的多帧 v3/旧格式解析。
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/dsh.test.mjs
 *
 * 解压依赖：fzstd@0.1.1（MIT，纯 JS ~8kB minified）。不下载原生二进制。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { collectDshFile, decompressZstdBuffer } = await import(pathToFileURL(join(ROOT, 'src/collectors/dsh.js')).href);
const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const FIXTURES_B64 = {
  cat: 'KLUv/SAIQQAAeyJuIjoxfQootS/9IAhBAAB7Im4iOjJ9Cii1L/0gCEEAAHsibiI6M30K',
  v3: 'KLUv/SBjGQMAeyJ0eXBlIjoic2Vzc2lvbiIsInNlcSI6MSwidGltZSI6MTc3Mzc0OTk3ODAwMCwiY3dkIjoiRDpcXFVzZXJzXFxUZXN0IFVzZXJcXOaIkeeahCDpobnnm65cXHByb2pJIn0KKLUv/SBxLQMAwkUVHGBtc3g8Qm70BbdjMoWCgcKRtoqMipvNIsggwAHJ7m4iIZLiDk433hqGsSwcjcIv/dJMWTNSqmDAtQg4QAykzyxqJEg7d0Z+3tgVgLpDnD9O/xFRvwQANgUb6n6LPR8zBQUotS/9YBUAtQUAAssiH2BJ2wamsFd+ntpCxej9u0MQ9mADsZb+r77JIAAuuBOF994jMDTvwYDggSc+WdWU5xVbCYRxLWnMmzy+I2CgRLv18RTbizFASrdgEYgixxPQrhl5Zptoh3YLW2/SLdt8RHnGuH6T11Z1POcc6TiMVKSE8qusPhZ5hOXj90CZVwFops2LWZ/fJaHfBA8APEWySgWxJqOtwGmnyAwxNMnZSapzEeJ2LfW+zRixshWC3MOrnAE=',
  old: 'KLUv/SBEIQIAeyJ0eXBlIjoic2Vzc2lvbiIsInNlcSI6MSwidGltZSI6MTc3Mzc0OTk3ODAwMCwiY3dkIjoiL3dvcmsvcHJvakoifQootS/9IHEtAwDCRRUcYG1zeDxCbvQFt2MyhYKBwpG2ioyKm80iyCDAAcnubiIhkuIOTjfeGoaxLByNwi/90kxZM1KqYMC1CDhADKTPLGokSDt3Rn7e2BWAukOcP07/EVG/BAA2BRvqfos9HzMFBSi1L/0gxD0EAFKIGhpwV22oeJJY9vXLSLVWBKf/NQ7U36k8gIYgRIDWWjuWXetwKlQoqQNlkkx+qWjmEHhebRxCs2fXI7zrkswebf4R+IVYP8Jnp/JL6UAUggiUoRSB18Lqn4E3KP/eLGOSQG82L+Y8Xp9DPwoKADnpQLiWIt/GRgiHtcrGhQGfAAIeaHgVMw==',
  good: 'KLUv/SDKFQQA0gcZGnBp21SeRB5futStss2ngoAetg7DcioAFRSbxnvvfR2faNqFlrZ8hzcvkGRva6vFcKRUgiJQom7LTBNb6KYwdYftDp+d6eYYHME5CF6X6hsEr1C+uR6SWRegWTYr5jxelUXfBQoAcwhuMYTMJBqn0ZuZIUVImtLNShRU18sAoA=='
};

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'));
  const store = new Store(join(dir, 't.db'));
  store._tmpDir = dir;
  return store;
}
function closeStore(store) {
  store.close();
  rmSync(store._tmpDir, { recursive: true, force: true });
}
function eventsOf(store) {
  return store.db.prepare("SELECT * FROM events WHERE tool='dsh' ORDER BY id").all();
}

const NOW = 1773750000000;
const hasBuiltinCompress = typeof zlib.zstdCompressSync === 'function';
const zstdFrames = (lines, b64Key) => {
  if (hasBuiltinCompress) {
    return Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n'))));
  }
  if (b64Key && FIXTURES_B64[b64Key]) {
    return Buffer.from(FIXTURES_B64[b64Key], 'base64');
  }
  throw new Error('This Node cannot create zstd fixtures without builtin or precomputed fixtures');
};

console.log('\n[multi-frame] fzstd 解出全部帧，不靠 zstd.exe');
{
  const cat = zstdFrames(['{"n":1}', '{"n":2}', '{"n":3}'], 'cat');
  const text = decompressZstdBuffer(cat);
  ok('三帧全部解出', text.includes('"n":1') && text.includes('"n":2') && text.includes('"n":3'), text);
  if (typeof zlib.zstdDecompressSync === 'function') {
    const firstOnly = zlib.zstdDecompressSync(cat).toString();
    ok('对照：Node 内置只解第一帧（回归靶心）', firstOnly.includes('"n":1') && !firstOnly.includes('"n":2'));
  } else {
    ok('对照：Node 22.13 无内置 zstd，完全依赖 fzstd 解压', true);
  }
}

console.log('\n[v3 + old] 黄金数字，PATH 为空');
{
  const saved = process.env.PATH;
  process.env.PATH = '';
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-win-中文 空格-'));
  const v3dir = join(tmp, '--work-projI--', 's-dsh-v3');
  const olddir = join(tmp, '--work-projJ--', 's-dsh-old');
  mkdirSync(v3dir, { recursive: true });
  mkdirSync(olddir, { recursive: true });
  const v3 = zstdFrames([
    JSON.stringify({ type: 'session', seq: 1, time: NOW - 22000, cwd: 'D:\\Users\\Test User\\我的 项目\\projI' }),
    JSON.stringify({ type: 'request/header', seq: 2, time: NOW - 21500, data: { header: { config: { model: 'Dsh-Header-Model' } } } }),
    JSON.stringify({
      type: 'assistant/message', seq: 3, time: NOW - 21000,
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 30, totalTokens: 1480 },
        message: { role: 'assistant', source: { kind: 'model', model: 'Dsh-Test-Model' } },
      },
    }),
  ], 'v3');
  const old = zstdFrames([
    JSON.stringify({ type: 'session', seq: 1, time: NOW - 22000, cwd: '/work/projJ' }),
    JSON.stringify({ type: 'request/header', seq: 2, time: NOW - 21500, data: { header: { config: { model: 'Dsh-Header-Model' } } } }),
    JSON.stringify({
      type: 'assistant/chunk', seq: 3, time: NOW - 20500,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, reasoningTokens: 5 } } },
    }),
  ], 'old');
  writeFileSync(join(v3dir, 'session.v3.jsonl.zstd'), v3);
  writeFileSync(join(olddir, 'session.jsonl.zstd'), old);
  const store = makeStore();
  const r1 = await collectDshFile(store, { path: join(v3dir, 'session.v3.jsonl.zstd'), fileId: 's-dsh-v3' });
  const r2 = await collectDshFile(store, { path: join(olddir, 'session.jsonl.zstd'), fileId: 's-dsh-old' });
  const ev = eventsOf(store);
  ok('PATH 空仍插入 2 条', r1.inserted === 1 && r2.inserted === 1 && ev.length === 2, `${r1.inserted}/${r2.inserted}/${ev.length}`);
  const v3e = ev.find((e) => e.total_tokens === 1480);
  ok('v3 黄金 400/1000/30/50/0/1480',
    v3e && v3e.input_tokens === 400 && v3e.cached_input === 1000 && v3e.cache_write === 30
    && v3e.output_tokens === 50 && v3e.total_tokens === 1480, JSON.stringify(v3e));
  ok('v3 模型 data.message.source.model', v3e?.model === 'dsh-test-model', String(v3e?.model));
  ok('v3 project=projI（Windows cwd）', v3e?.project === 'projI', String(v3e?.project));
  const olde = ev.find((e) => e.total_tokens === 320);
  ok('旧格式 100+200+20=320，reasoning 5 不计入 total',
    olde && olde.input_tokens === 100 && olde.cached_input === 200 && olde.output_tokens === 20
    && olde.reasoning_tokens === 5 && olde.total_tokens === 320, JSON.stringify(olde));
  ok('旧格式模型回落 header', olde?.model === 'dsh-header-model');
  ok('旧格式 project=projJ', olde?.project === 'projJ');
  const again = await collectDshFile(store, { path: join(v3dir, 'session.v3.jsonl.zstd'), fileId: 's-dsh-v3' });
  ok('重复扫描幂等', again.inserted === 0 && eventsOf(store).length === 2);
  process.env.PATH = saved;
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[#79 same-seq] 旧结构同 seq、不同 turn/step 必须各自成一行');
/* 同一份记录与同样的期望数字也写在桌面端：
 * desktop/src-tauri/src/collectors.rs::dsh_legacy_chunks_sharing_seq_stay_separate（解析层）
 * desktop/src-tauri/tests/sources.rs::dsh_same_seq_legacy_chunks_are_not_overwritten_in_the_cache（落库层）
 * 期望：2 条事件，total 135 / 260，合计 395。 */
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-79-中文 空格-'));
  const dir = join(tmp, '--work-projK--', 's-dsh-79');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const lines = [
    JSON.stringify({ type: 'session', seq: 1, time: NOW - 22000, cwd: '/work/projK' }),
    JSON.stringify({ type: 'assistant/chunk', seq: 7, time: NOW - 20000,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20 } } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 7, time: NOW - 19000,
      data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 40 } } } }),
  ];
  writeFileSync(file, zstdFrames(lines));
  const store = makeStore();
  const r = await collectDshFile(store, { path: file, fileId: 's-dsh-79' });
  const ev = eventsOf(store);
  ok('#79 同 seq 的两个 step 各自入库（135 / 260）',
    r.inserted === 2 && ev.length === 2
    && ev.map((e) => e.total_tokens).sort((a, b) => a - b).join(',') === '135,260',
    JSON.stringify(ev.map((e) => [e.total_tokens, e.dedup_key])));
  ok('#79 dedup_key 带 turn/step 且互不相同',
    new Set(ev.map((e) => e.dedup_key)).size === 2
    && ev.every((e) => e.dedup_key.startsWith('dsh:s-dsh-79:7:')),
    JSON.stringify(ev.map((e) => e.dedup_key)));
  const again = await collectDshFile(store, { path: file, fileId: 's-dsh-79' });
  ok('#79 快照整体重解析仍幂等（不增行）', again.inserted === 0 && eventsOf(store).length === 2,
    String(again.inserted));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[truncated] 坏/截断帧保留已完整帧，不让进程崩');
{
  const good = hasBuiltinCompress
    ? zlib.zstdCompressSync(Buffer.from(JSON.stringify({
        type: 'assistant/message', seq: 1, time: NOW,
        data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
          message: { source: { model: 'm' } } },
      }) + '\n'))
    : Buffer.from(FIXTURES_B64.good, 'base64');
  const bad = Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])]);
  const text = decompressZstdBuffer(bad);
  ok('截断尾帧后仍解出完整帧', text.includes('"seq":1'), text.slice(0, 80));
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-trunc-'));
  const file = join(tmp, 'session.v3.jsonl.zstd');
  writeFileSync(file, bad);
  const store = makeStore();
  const r = await collectDshFile(store, { path: file, fileId: 's-trunc' });
  ok('截断文件仍采到完整记录', r.inserted === 1, String(r.inserted));
  closeStore(store);
  rmSync(tmp, { recursive: true, force: true });
}

{
  const store = makeStore();
  let threw = false;
  try {
    await collectDshFile(store, { path: join(tmpdir(), 'no-such-dsh', 'x.zstd'), fileId: 'x' });
  } catch {
    threw = true;
  }
  ok('占用/缺失抛错而不返回假成功（scanner 才不会把游标写成已处理）', threw);
  closeStore(store);
}

if (failed) {
  console.error(`\ndsh FAILED ${failed}`);
  process.exit(1);
}
console.log('\ndsh OK  node', process.version);
