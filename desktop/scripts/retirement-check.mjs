import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const path of ['src','web','menubar','bin','test','windows','node_modules','.github/workflows/test.yml','.github/workflows/windows.yml','scripts/verify-windows-source.ps1','desktop/scripts/compare-local.mjs']) {
  assert.equal(existsSync(resolve(root,path)),false,`Retired product path returned: ${path}`);
}
const pkg = JSON.parse(readFileSync(resolve(root,'package.json'),'utf8').replace(/^\uFEFF/,''));
assert.equal(pkg.private,true);
for (const field of ['main','bin','files','dependencies']) assert.equal(field in pkg,false,`Legacy package field: ${field}`);
for (const name of ['scan','serve','today','bar','build-bar','install-agent','uninstall-agent','prepack']) assert.equal(name in pkg.scripts,false,`Legacy script: ${name}`);
for (const dir of ['scripts','desktop/scripts']) {
  for (const name of readdirSync(resolve(root,dir))) {
    if (!/\.(mjs|ps1|py)$/.test(name) || name==='retirement-check.mjs') continue;
    const text=readFileSync(resolve(root,dir,name),'utf8');
    assert.equal(/(?:from|import)\s*['"]\.\.\/\.\.\/src\//.test(text),false,`Retired collector import in ${name}`);
    assert.equal(/bin[\\/]tokenmonitor\.js/.test(text),false,`Retired executable entry in ${name}`);
  }
}
assert.ok(existsSync(resolve(root,'.github/workflows/desktop.yml')));
assert.equal(JSON.parse(readFileSync(resolve(root,'desktop/src-tauri/tauri.conf.json'),'utf8')).bundle.active,false,'Only the verified package/install chain is published');
console.log('PASS: desktop-only repository, private root package, retired runtime/test/CI paths and imports absent');

// Surviving CI and packaging safeguards formerly checked by the retired Node suite.
const workflow = readFileSync(resolve(root,'.github/workflows/desktop.yml'),'utf8');
const actions = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map(match=>match[1]);
assert.ok(actions.length >= 3);
for (const action of actions) assert.match(action, /@[0-9a-f]{40}$/, `Unpinned action: ${action}`);
assert.match(workflow, /cancel-in-progress:\s*false/);
assert.equal((workflow.match(/RUSTFLAGS: '-Dwarnings'/g)||[]).length,3);
for (const path of ['desktop/**','scripts/**','package.json','package-lock.json','LICENSE','rust-toolchain.toml']) {
  assert.equal(workflow.split(`- '${path}'`).length-1,2, `Both path filters must include ${path}`);
}
const builder = readFileSync(resolve(root,'desktop/scripts/build-windows.ps1'),'utf8');
const inputs = builder.match(/\$fingerprintInputs = @\(([^\n]+)\)/)[1];
for (const [,path] of inputs.matchAll(/'([^']+)'/g)) assert.ok(existsSync(resolve(root,'desktop',path.replaceAll('\\','/'))), `Missing fingerprint input: ${path}`);
for (const path of ['tsconfig.json','Cargo.lock','tauri.conf.json']) assert.ok(inputs.includes(path));
assert.match(builder, /\$appVersion = \[string\]\$tauriConfig.version/);
assert.match(builder, /git rev-parse HEAD[\s\S]*?\$LASTEXITCODE -ne 0/);
console.log('PASS: pinned actions, complete path filters, warnings gates and package fingerprint inputs');

// #129：活跃文档不得引用已退役路径。历史/退役说明类文档（docs/history、docs/legacy、
// 文件名带 PLAN-/RETIRE-/INTEGRATION- 的快照）整体豁免；仍活跃的文档只有在同一行
// 明确写着"退役/已删/removed"时才允许点名这些路径（如 WINDOWS.md 的退役说明段）。
const ACTIVE_DOCS = [
  'README.md',
  'desktop/README.md',
  ...readdirSync(resolve(root, 'docs')).filter(n => n.endsWith('.md')).map(n => `docs/${n}`),
].filter(doc => !/(^|\/)(docs\/)?(history|legacy)\//.test(doc) && !/docs\/(PLAN-|RETIRE-|INTEGRATION-|RELEASE-REVIEW-|CODEX-MIGRATION-|QODER-MIMO-|PRICING-)/.test(doc));
const RETIRED_PATHS = ['windows/gui', 'windows/tray', 'test/run.mjs', 'src/server.js', 'src/scanner.js', 'web/app.js', 'menubar/'];
const RETIRED_MENTION = /退役|已删除|已移除|已随|removed|retired|deleted in|历史版本线/;
for (const doc of ACTIVE_DOCS) {
  const lines = readFileSync(resolve(root, doc), 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const path of RETIRED_PATHS) {
      if (line.includes(path) && !RETIRED_MENTION.test(line)) {
        assert.fail(`Active doc references retired path "${path}": ${doc}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
  });
}
console.log('PASS: active docs reference no retired paths outside explicit retirement notes');
