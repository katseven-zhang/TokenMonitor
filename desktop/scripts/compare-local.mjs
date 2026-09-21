// Read-only parity probe against the repository's existing collectors.
// Prints only numeric aggregates and anonymous sample numbers, never conversation contents.
//
// #82: the "Rust side" of this comparison is a cache that the desktop scanner
// really wrote (desktop/src-tauri/tests/parity.rs indexes the ten synthetic
// source fixtures with scanner::scan and then runs this probe over the same
// files). The probe expects to cover *every* agent that has rows in the cache:
// an agent it cannot compare is a failure, not a silent hole.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { collectCodexFile } from '../../src/collectors/codex.js';
import { collectClaudeFile } from '../../src/collectors/claude.js';
import { collectWorkbuddyFile } from '../../src/collectors/workbuddy.js';
import { collectGrokFile } from '../../src/collectors/grok.js';
import { collectPiFile } from '../../src/collectors/pi.js';
import { collectZcodeDb } from '../../src/collectors/zcode.js';
import { collectOpencodeDb } from '../../src/collectors/opencode.js';
import { collectDshFile } from '../../src/collectors/dsh.js';
import { collectAntigravity } from '../../src/collectors/antigravity.js';

const cache = new DatabaseSync(process.argv[2] || 'desktop/.dev-data/events-v2.sqlite', {readOnly:true});
const adapters = {
  'codex': collectCodexFile,
  'claude-code': collectClaudeFile,
  'ccmr': collectClaudeFile,
  'workbuddy': collectWorkbuddyFile,
  'grok': collectGrokFile,
  'pi': collectPiFile,
  'zcode': collectZcodeDb,
  'opencode': collectOpencodeDb,
  'dsh': collectDshFile,
  // Antigravity's JS collector takes the *index* db (conversation_summaries.db)
  // and enumerates sibling conversations itself, while the desktop cache indexes
  // one row per conversation db. Compare it once per agent, not once per file.
  'antigravity': collectAntigravity,
};
// sqlite sources are compared per agent for the same reason; a .db file can
// change only through the desktop scanner, so the file fingerprint check below
// does not apply to them.
const WHOLE_INDEX = new Set(['zcode', 'opencode', 'antigravity']);
// Sources whose JS collector reads a directory/index and yields events for
// several desktop rows at once must be totalled across the whole agent.
const AGENT_SCOPE = new Set(['antigravity']);
// The ONLY way a source may differ on both sides: a quantified gap, measured in
// "what the Node collector owes the desktop cache" (node = desktop + gap).
// Listing an agent here does *not* excuse the comparison — the probe still
// asserts all three numbers, so if either side changes the gap stops matching and
// the gate goes red. An unlisted or unquantified skip fails the probe outright.
const DIVERGENCES = {
  codex: {
    gap: { events: -1, tokens: -120, cached: -80 },
    reason:
      'Node 的 codex 采集器把每条会话的第一次 token_count 只当累计基线、不产事件' +
      '（src/collectors/codex.js:149，docs/ARCHITECTURE.md:55 记为该口径的设计依据），' +
      '桌面端从同一条记录的 last_token_usage 取出那次请求。同一夹具下两边必然差这一条：' +
      '-1 事件 / -120 tokens / -80 cached（黄金数与 tests/sources.rs 的 expected 表同源）。',
  },
};
// A quantified divergence is defined per agent, so that agent is compared once
// for the whole agent instead of once per file.
const agentScoped = (agent) => AGENT_SCOPE.has(agent) || Object.hasOwn(DIVERGENCES, agent);
// dsh's dedup key namespace is the parent directory name (v3 migration), not the
// file name; antigravity takes the summaries index, not the conversation db.
const sampleOf = (agent, path) => agent === 'antigravity'
  ? join(dirname(path), '..', 'conversation_summaries.db')
  : path;
const argsFor = (agent, path) => ({
  tool: agent,
  path,
  fileId: agent === 'dsh' ? basename(dirname(path)) : basename(path),
  offset: 0,
  version: 1,
});
const results = [];
const totals = (rows) => rows.reduce((a, e) => ({
  events: a.events + 1,
  tokens: a.tokens + e.tokens.input + e.tokens.cached + e.tokens.cacheWrite + e.tokens.output,
  cached: a.cached + e.tokens.cached,
}), { events: 0, tokens: 0, cached: 0 });
const indexed = cache.prepare('SELECT DISTINCT agent FROM source_files').all().map((r) => r.agent);
for (const agent of indexed) {
  const collect = adapters[agent];
  if (!collect) {
    results.push({ agent, sample: 0, state: 'no adapter for this agent', unexplained: true });
    continue;
  }
  const rows = cache.prepare(
    'SELECT path,size,mtime FROM source_files f WHERE agent=? AND EXISTS(SELECT 1 FROM raw_events e WHERE e.path=f.path AND e.agent=f.agent) ORDER BY path',
  ).all(agent);
  const files = rows.map((r) => r.path);
  const cachedSize = new Map(rows.map((r) => [r.path, r.size]));
  const cachedMtime = new Map(rows.map((r) => [r.path, r.mtime]));
  const groups = agentScoped(agent) ? [files] : files.map((p) => [p]);
  for (let sample = 0; sample < groups.length; sample++) {
    const paths = groups[sample];
    if (!paths.length) continue;
    // SQLite sources are indexed by content, not by the (WAL-shuffled) file
    // fingerprint; for the rest a file that moved under us between the desktop
    // scan and this probe is not a parity break — but it IS a source we did not
    // compare, so it is reported as an unexplained skip and fails the gate.
    let watched = [];
    try {
      watched = WHOLE_INDEX.has(agent) ? [] : paths.map((p) => [p, statSync(p)]);
    } catch (error) {
      results.push({ agent, sample, state: `source unreadable: ${error.message}`, unexplained: true });
      continue;
    }
    for (const [p, before] of watched) {
      if (before.size !== cachedSize.get(p) || Math.abs(before.mtimeMs - cachedMtime.get(p)) > 1) {
        results.push({ agent, sample, state: 'cache/source fingerprint changed since the scan; skipped', unexplained: true });
      }
    }
    if (results.some((r) => r.agent === agent && r.sample === sample && r.unexplained)) continue;
    const captured = new Map();
    const store = {
      insertEvent(e) { if (captured.has(e.dedup_key)) return 0; captured.set(e.dedup_key, e); return 1; },
      insertToolCall() { return 0; },
      saveQuota() {},
    };
    try {
      await collect(store, argsFor(agent, sampleOf(agent, paths[0])));
    } catch (error) {
      // A throwing collector is a source we could not compare; say so in the
      // JSON body instead of dying before any of it is printed.
      results.push({ agent, sample, state: `Node collector threw: ${error.message}`, unexplained: true });
      continue;
    }
    for (const [p, before] of watched) {
      const after = statSync(p);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        results.push({ agent, sample, state: 'source changed during probe; skipped', unexplained: true });
      }
    }
    const old = [...captured.values()].reduce(
      (a, e) => ({ events: a.events + 1, tokens: a.tokens + e.total_tokens, cached: a.cached + e.cached_input }),
      { events: 0, tokens: 0, cached: 0 },
    );
    const current = totals(
      paths.flatMap((p) => cache
        .prepare('SELECT data FROM raw_events WHERE path=? AND agent=?')
        .all(p, agent)
        .map((r) => JSON.parse(r.data))),
    );
    if (old.events === 0 && current.events === 0) {
      results.push({ agent, sample, state: 'collector produced nothing for this fixture', unexplained: true });
      continue;
    }
    const gap = DIVERGENCES[agent]?.gap ?? { events: 0, tokens: 0, cached: 0 };
    const expected = {
      events: current.events + gap.events,
      tokens: current.tokens + gap.tokens,
      cached: current.cached + gap.cached,
    };
    results.push({
      agent,
      sample,
      old,
      current,
      ...(DIVERGENCES[agent]
        ? { state: 'quantified divergence', reason: DIVERGENCES[agent].reason, gap, expected }
        : {}),
      equal: JSON.stringify(old) === JSON.stringify(expected),
    });
  }
}
// Any agent with rows in the cache must end up compared or explicitly listed.
for (const agent of indexed) {
  const covered = results.some((r) => r.agent === agent && r.equal !== undefined);
  if (!covered && !results.some((r) => r.agent === agent && r.unexplained)) {
    results.push({ agent, sample: 0, state: 'indexed rows were never compared', unexplained: true });
  }
}
cache.close();
console.log(JSON.stringify(results, null, 2));
// #82: this is a gate, so it must be able to fail. equal:false is a real parity
// break — including a documented divergence whose gap no longer matches — and
// exits non-zero; a probe that compared nothing, skipped a source for an
// unlisted reason, or left an indexed agent uncovered is "not run".
const compared = results.filter((r) => r.equal !== undefined);
const mismatches = compared.filter((r) => !r.equal);
const unexplained = results.filter((r) => r.unexplained);
const documented = compared.filter((r) => r.state === 'quantified divergence');
console.log(`parity probe: ${compared.length - documented.length} compared, ${documented.length} quantified divergence, ${mismatches.length} mismatched, ${unexplained.length} unexplained skipped`);
for (const d of documented) {
  console.log(`quantified divergence: ${d.agent} node=${JSON.stringify(d.old)} desktop=${JSON.stringify(d.current)} expected_node=${JSON.stringify(d.expected)} — ${d.reason}`);
}
if (mismatches.length > 0) {
  console.error('PARITY FAILED: the desktop cache diverged from the JS collectors (see equal:false rows above).');
  process.exit(1);
}
if (unexplained.length > 0) {
  console.error(`PARITY INCOMPLETE: ${unexplained.length} source(s) were skipped without a documented reason: ${[...new Set(unexplained.map((r) => r.agent))].join(', ')}`);
  process.exit(1);
}
if (compared.length === 0) {
  console.error('PARITY NOT RUN: no sample was comparable (missing cache, no indexed rows, or every sample skipped). This is not a pass.');
  process.exit(1);
}
