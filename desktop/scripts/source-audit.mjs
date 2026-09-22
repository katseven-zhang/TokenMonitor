// Explicit independent reference for locally installed Qoder CN / Xiaomi MiMo.
// Opens only usage DB/transcripts and installed SDK; emits aggregate counts only.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, win32 } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
if (!process.argv.includes('--local-readonly')) throw Error('requires explicit --local-readonly');
const zero=()=>({input:0,cached:0,cacheWrite:0,output:0,reasoning:0});
const add=(a,b)=>{for(const k of Object.keys(a))a[k]+=b[k]||0;};
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):e.isFile()?[join(p,e.name)]:[]);
function reference() {
  const mimo={events:0,tokens:zero(),creditsRequests:0,credits:0,errors:0,malformed:0};
  const db=new DatabaseSync(join(homedir(),'.local/share/mimocode/mimocode.db'),{readOnly:true});
  try {
    for(const row of db.prepare('SELECT data FROM message').iterate()) {
      let v;try{v=JSON.parse(row.data);}catch{mimo.malformed++;continue;}
      if(v.role!=='assistant'||!v.tokens)continue;
      const t=v.tokens;if(!Number.isSafeInteger(t.input)||!Number.isSafeInteger(t.output)||t.input<0||t.output<0){mimo.malformed++;continue;}
      const normalized={input:t.input,cached:t.cache?.read||0,cacheWrite:t.cache?.write||0,output:t.output+(t.reasoning||0),reasoning:t.reasoning||0};
      const total=normalized.input+normalized.cached+normalized.cacheWrite+normalized.output;
      if(t.total>0)assert.equal(total,t.total,'MiMo reported total contract changed');
      if(total>0){mimo.events++;add(mimo.tokens,normalized);}
    }
  } finally {db.close();}
  const qoder={events:0,tokens:zero(),creditsRequests:0,credits:0,errors:0,malformed:0};
  const runtime=readFileSync(join(process.env.ProgramFiles,'Qoder CN/resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs'),'utf8');
  const match=/nBl\s*=\s*Buffer\.from\(\[([\d,\s]+)\]\)/.exec(runtime);assert(match,'Unsupported Qoder SDK format');
  const key=Buffer.from(match[1].split(',').map(Number));assert.equal(key.length,32);
  const files=walk(join(homedir(),'.qoder-cn/projects'));const requests=new Map();const sessions=new Map();
  for(const path of files.filter(p=>p.endsWith('.jsonl'))) {
    for(const line of readFileSync(path,'utf8').split('\n')) {
      let r;try{r=JSON.parse(line);}catch{continue;}
      const u=r.message?.usage; if(r.type!=='assistant'||r.message?.model==='<synthetic>'||!Number.isFinite(u?.credits)||u.credits<0)continue;
      const id=u.request_id||r.requestTokenAnchor?.requestId;if(!id){qoder.malformed++;continue;}
      const ts=typeof r.timestamp==='number'?r.timestamp:Date.parse(r.timestamp);if(!Number.isFinite(ts))continue;
      if(!requests.has(id)||requests.get(id).ts>ts)requests.set(id,{ts,credits:u.credits});
    }
  }
  for(const path of files.filter(p=>basename(p)==='state.json')) {
    const s=JSON.parse(readFileSync(path,'utf8'));if(!s.sessionId)continue;
    try {
      let payload=s;const cwds=new Set([s.cwd,s.data?.cwd].filter(Boolean));
      if(s.items){
        const transcript=join(dirname(dirname(path)),basename(dirname(path))+'.jsonl');
        for(const line of readFileSync(transcript,'utf8').split('\n')) {try{const r=JSON.parse(line);if(r.cwd&&(!r.sessionId||r.sessionId===s.sessionId))cwds.add(r.cwd);}catch{}}
        const item=s.items.s0;payload=null;
        for(const cwd of cwds) {
          const projectHash=createHash('sha256').update(win32.resolve(cwd).replaceAll('\\','/').toLowerCase()).digest('hex');
          for(const aad of [{sessionId:s.sessionId,projectHash,segmentKey:'s0'},{sessionId:s.sessionId,projectHash}]) {
            try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(item.n,'base64'));cipher.setAuthTag(Buffer.from(item.t,'base64'));cipher.setAAD(Buffer.from(JSON.stringify(aad)));payload=JSON.parse(Buffer.concat([cipher.update(Buffer.from(item.p,'base64')),cipher.final()]));break;}catch{}
          }
          if(payload)break;
        }
        assert(payload,'state authentication failed');
      }
      const t=payload.total||payload.usage;assert(t&&Number.isFinite(t.input_tokens));
      const normalized={input:t.input_tokens-(t.cache_read_input_tokens||0),cached:t.cache_read_input_tokens||0,cacheWrite:t.cache_creation_input_tokens||0,output:t.output_tokens||0,reasoning:t.reasoning_output_tokens||0};
      const ts=Date.parse(payload.updatedAt||s.updatedAt);
      if(!sessions.has(s.sessionId)||sessions.get(s.sessionId).ts<ts)sessions.set(s.sessionId,{ts,tokens:normalized});
    }catch{qoder.errors++;}
  }
  for(const s of sessions.values()){if(s.tokens.input+s.tokens.cached+s.tokens.cacheWrite+s.tokens.output>0){qoder.events++;add(qoder.tokens,s.tokens);}}
  qoder.creditsRequests=requests.size;qoder.credits=[...requests.values()].reduce((n,r)=>n+r.credits,0);
  return {qoder,'xiaomi-mimo':mimo};
}
const before=reference();
const actual=JSON.parse(execFileSync('cargo',['run','--offline','--locked','--quiet','--no-default-features','--manifest-path','desktop/src-tauri/Cargo.toml','--example','audit_sources','--','--local-readonly'],{encoding:'utf8',windowsHide:true}));
const after=reference();assert.deepEqual(before,after,'Sources changed during audit; run again');
for(const value of [after,actual])for(const source of Object.values(value))source.credits=Math.round(source.credits*1e6)/1e6;
assert.deepEqual(actual,after,'Independent local aggregate mismatch');
assert.equal(actual.qoder.errors,0,'Qoder state files failed authentication');
assert.equal(actual['xiaomi-mimo'].errors,0);
console.log(JSON.stringify({verified:true,aggregates:actual},null,2));
