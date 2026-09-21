// Read-only parity probe against the repository's existing collectors.
// Prints only numeric aggregates and anonymous sample numbers, never conversation contents.
//
// 两种模式（#75 第 5 项）：
//   node desktop/scripts/compare-local.mjs [sqlite 路径]     真实数据（默认 desktop/.dev-data/events-v2.sqlite）
//   node desktop/scripts/compare-local.mjs --fixture          离线夹具自检，退出码即结论
//
// 真实数据模式要看的是用户机器上的桌面端缓存与 ~/.codex 日志，CI 与离线审查都跑不了。
// --fixture 把同一件事改成仓库内可判定：桌面端那一侧的数字取自
// test/fixtures/codex-parity/desktop-events.json —— 那份黄金由 cargo 测试
// `tests/sources.rs::compare_local_golden_is_what_the_desktop_collector_produces` 逐字段
// 钉在 collectors.rs 的实际产出上（改采集器不改黄金 = 红）；legacy 那一侧现场跑
// src/collectors/codex.js 解析同一份 rollout.jsonl。两条合起来才等于"codex 样本 equal:true"。
// 自检还会故意把黄金改一个 token 再跑一遍，确认这个 equal 真的会变假——不然它可能是恒真。
import { DatabaseSync } from 'node:sqlite';
import { statSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCodexFile } from '../../src/collectors/codex.js';
import { collectClaudeFile } from '../../src/collectors/claude.js';
import { collectWorkbuddyFile } from '../../src/collectors/workbuddy.js';
import { collectGrokFile } from '../../src/collectors/grok.js';
import { collectPiFile } from '../../src/collectors/pi.js';
import { collectZcodeDb } from '../../src/collectors/zcode.js';
import { collectOpencodeDb } from '../../src/collectors/opencode.js';

const args = process.argv.slice(2);
const FIXTURE = args.includes('--fixture');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ROLLOUT = join(REPO, 'test', 'fixtures', 'codex-parity', 'rollout.jsonl');
const FIXTURE_GOLDEN = join(REPO, 'test', 'fixtures', 'codex-parity', 'desktop-events.json');

// 与桌面端 db.rs::migrate 的 source_files / raw_events 两张表同构（列名与顺序都一致），
// 否则这里的 equal 与真机上跑出来的不是同一个查询。
const SCHEMA = `
  CREATE TABLE source_files(path TEXT NOT NULL,agent TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,title TEXT,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(path,agent));
  CREATE TABLE raw_events(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,project TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(path,agent,id));`;

/** 用仓库内夹具搭一个内存库：raw_events.data 就是桌面端落库的那段 Event JSON。 */
function fixtureCache(perturb) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const stat = statSync(FIXTURE_ROLLOUT);
  db.prepare('INSERT INTO source_files VALUES(?,?,?,?,?,?,?)')
    .run(FIXTURE_ROLLOUT, 'codex', stat.size, Math.round(stat.mtimeMs), null, null, Date.now());
  const insert = db.prepare('INSERT INTO raw_events VALUES(?,?,?,?,?,?,?,?)');
  for (const [index, row] of JSON.parse(readFileSync(FIXTURE_GOLDEN, 'utf8')).entries()) {
    const data = perturb && index === 0 ? { ...row, tokens: { ...row.tokens, input: row.tokens.input + 1 } } : row;
    insert.run(FIXTURE_ROLLOUT, 'codex', data.id, data.ts, data.session, data.model, data.project, JSON.stringify(data));
  }
  return db;
}

const cache = FIXTURE ? fixtureCache(false) : new DatabaseSync(args[0] || 'desktop/.dev-data/events-v2.sqlite', { readOnly: true });
const adapters = {'codex':collectCodexFile,'claude-code':collectClaudeFile,'ccmr':collectClaudeFile,'workbuddy':collectWorkbuddyFile,'grok':collectGrokFile,'pi':collectPiFile,'zcode':collectZcodeDb,'opencode':collectOpencodeDb};
async function probe(cache) {
  const results=[];
  for(const [agent,collect] of Object.entries(adapters)) {
    const samples=cache.prepare('SELECT path,size,mtime FROM source_files f WHERE agent=? AND EXISTS(SELECT 1 FROM raw_events e WHERE e.path=f.path AND e.agent=f.agent) ORDER BY mtime,path LIMIT 3').all(agent);
    for(let sample=0;sample<samples.length;sample++) {
      const f=samples[sample];const before=statSync(f.path);
      if(!['zcode','opencode'].includes(agent) && (before.size!==f.size || Math.abs(before.mtimeMs-f.mtime)>1)) {results.push({agent,sample,state:'cache/source changed; skipped'});continue;}
      const captured=new Map();
      const store={insertEvent(e){if(captured.has(e.dedup_key))return 0;captured.set(e.dedup_key,e);return 1;},insertToolCall(){return 0;},saveQuota(){}};
      await collect(store,{tool:agent,path:f.path,fileId:basename(f.path),offset:0,version:1});
      const after=statSync(f.path);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs){results.push({agent,sample,state:'source changed during probe; skipped'});continue;}
      const old=[...captured.values()].reduce((a,e)=>({events:a.events+1,tokens:a.tokens+e.total_tokens,cached:a.cached+e.cached_input}),{events:0,tokens:0,cached:0});
      const current=cache.prepare('SELECT data FROM raw_events WHERE path=? AND agent=?').all(f.path,agent).map(r=>JSON.parse(r.data)).reduce((a,e)=>({events:a.events+1,tokens:a.tokens+e.tokens.input+e.tokens.cached+e.tokens.cacheWrite+e.tokens.output,cached:a.cached+e.tokens.cached}),{events:0,tokens:0,cached:0});
      results.push({agent,sample,old,current,equal:JSON.stringify(old)===JSON.stringify(current)});
    }
  }
  return results;
}

const results = await probe(cache);
if (!FIXTURE) {
  cache.close();
  console.log(JSON.stringify(results, null, 2));
} else {
  // 负对照：黄金里改一个 token，同一个探针必须报出 equal:false，
  // 否则"equal:true"可能只是两边同时读不到数（恒真断言）。
  const control = await probe(fixtureCache(true));
  cache.close();
  const clean = results.filter((r) => r.agent === 'codex');
  const detected = control.filter((r) => r.agent === 'codex' && r.equal !== true);
  console.log(JSON.stringify({ mode: 'fixture', rollout: FIXTURE_ROLLOUT, clean, control: control.filter((r) => r.agent === 'codex') }, null, 2));
  const allEqual = clean.length > 0 && clean.every((r) => r.equal === true);
  const skipped = results.some((r) => r.state);
  console.log(`codex 夹具对账：样本 ${clean.length} 个，全部 equal=${allEqual}，负对照检出差异 ${detected.length} 个${skipped ? '，注意：有样本被跳过' : ''}`);
  process.exit(allEqual && !skipped && detected.length > 0 ? 0 : 1);
}
