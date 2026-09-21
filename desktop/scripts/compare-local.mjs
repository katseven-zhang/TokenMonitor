// Read-only parity probe against the repository's existing collectors.
// Prints only numeric aggregates and anonymous sample numbers, never conversation contents.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { collectCodexFile } from '../../src/collectors/codex.js';
import { collectClaudeFile } from '../../src/collectors/claude.js';
import { collectWorkbuddyFile } from '../../src/collectors/workbuddy.js';
import { collectGrokFile } from '../../src/collectors/grok.js';
import { collectPiFile } from '../../src/collectors/pi.js';
import { collectZcodeDb } from '../../src/collectors/zcode.js';
import { collectOpencodeDb } from '../../src/collectors/opencode.js';

const cache = new DatabaseSync(process.argv[2] || 'desktop/.dev-data/events-v2.sqlite', {readOnly:true});
const adapters = {'codex':collectCodexFile,'claude-code':collectClaudeFile,'ccmr':collectClaudeFile,'workbuddy':collectWorkbuddyFile,'grok':collectGrokFile,'pi':collectPiFile,'zcode':collectZcodeDb,'opencode':collectOpencodeDb};
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
cache.close();
console.log(JSON.stringify(results, null, 2));
// #82: this is a gate, so it must be able to fail. equal:false is a real parity
// break and exits non-zero; a probe that compared nothing is "not run", never green.
const compared = results.filter((r) => r.equal !== undefined);
const mismatches = compared.filter((r) => !r.equal);
console.log(`parity probe: ${compared.length} compared, ${mismatches.length} mismatched, ${results.length - compared.length} skipped`);
if (mismatches.length > 0) {
  console.error('PARITY FAILED: the desktop cache diverged from the JS collectors (see equal:false rows above).');
  process.exit(1);
}
if (compared.length === 0) {
  console.error('PARITY NOT RUN: no sample was comparable (missing cache, no indexed rows, or every sample skipped). This is not a pass.');
  process.exit(1);
}
