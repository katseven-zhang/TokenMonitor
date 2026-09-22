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
