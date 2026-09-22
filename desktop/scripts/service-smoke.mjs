import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'TokenMonitor-中文 smoke-'));
const reservation = createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const source = join(root, 'source');
await mkdir(source);
await writeFile(join(source, 'session.jsonl'), [
  {type:'session_meta',payload:{id:'smoke',cwd:'D:\\Synthetic Project'}},
  {type:'turn_context',payload:{model:'smoke-model'}},
  {timestamp:1800000000000,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20}}}}
].map(JSON.stringify).join('\n')+'\n');
await writeFile(join(root,'settings.json'), JSON.stringify({port,refreshSeconds:86400,roots:{codex:[source],qoder:[],'xiaomi-mimo':[]},disabledAgents:[]}));
const child = spawn(resolve('dist/desktop-windows-x64/TokenMonitor.exe'), ['--service'], {env:{...process.env,TOKENMONITOR_DATA_DIR:root},windowsHide:true,stdio:'ignore'});
let terminal=false;
const exited = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{terminal=true;resolve(code);});});
exited.catch(()=>{});
async function rpc(method,args={}) {
  const token=await readFile(join(root,'service-token'),'utf8');
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port});let data='';
    socket.setTimeout(10000,()=>socket.destroy(new Error('RPC timeout')));
    socket.on('error',reject);
    socket.on('connect',()=>socket.write(JSON.stringify({token,method,args})+'\n'));
    socket.on('data',chunk=>data+=chunk);
    socket.on('end',()=>{try {const reply=JSON.parse(data);assert.equal(reply.ok,true,reply.error);resolve(reply.result);}catch(e){reject(e);}});
  });
}
async function until(check) {
  const deadline=Date.now()+30000;let last;
  while(Date.now()<deadline){if(terminal)throw new Error('Service exited before verification');try{const value=await check();if(value)return value;}catch(e){last=e;}await delay(150);}
  throw new Error('Service verification timed out',{cause:last});
}
try {
  await until(async()=> (await rpc('status')).running);
  assert.equal((await rpc('scan')).scheduled,true);
  const query={start:1800000000000,end:1800000060000,offsetMinutes:0};
  const data=await until(async()=>{const d=await rpc('dashboard',{query});return d.totals.events===1&&d;});
  assert.equal(data.totals.totalTokens,120);
  assert.equal((await rpc('stop')).stopping,true);
  const code=await Promise.race([exited,delay(15000,undefined,{ref:false}).then(()=>{throw new Error('Stop timed out');})]);
  assert.equal(code,0);
  console.log('PASS: packaged service start/status/scan/exact fixture totals/stop; isolated Unicode path');
} finally {
  if(!terminal){child.kill();await exited;}
  // Only the unique temporary fixture directory created by this script.
  await rm(root,{recursive:true,force:true});
}
