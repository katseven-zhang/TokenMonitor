/**
 * Win-Service：当前用户任务计划 XML/命令。测试注入执行器，不在本机创建真实任务。
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/service.test.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildTaskXml, installWindowsAgent, uninstallWindowsAgent, WINDOWS_TASK_NAME }
  = await import(pathToFileURL(join(ROOT, 'src/platform/windows-service.js')).href);
const { buildPlist, installAgent, uninstallAgent, entryScript }
  = await import(pathToFileURL(join(ROOT, 'src/agent.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const node = 'D:\\Program Files\\nodejs\\node.exe';
const script = 'D:\\Users\\Test User\\我的 项目\\TokenMonitor\\bin\\tokenmonitor.js';

console.log('\n[xml] Hidden logon task, quoted paths, no secrets');
{
  const xml = buildTaskXml({ node, script, port: 9001 });
  ok('任务名 TokenMonitor-Server', WINDOWS_TASK_NAME === 'TokenMonitor-Server');
  ok('Hidden=true', xml.includes('<Hidden>true</Hidden>'));
  ok('LogonTrigger', xml.includes('<LogonTrigger>'));
  ok('LeastPrivilege 当前用户', xml.includes('<RunLevel>LeastPrivilege</RunLevel>') && xml.includes('InteractiveToken'));
  ok('Command 为 node 绝对路径', xml.includes(`<Command>${node.replace(/&/g, '&amp;')}</Command>`) || xml.includes(node.replace(/&/g, '&amp;')));
  ok('Arguments 含 serve 与端口', xml.includes('serve --port 9001'));
  ok('脚本路径含空格中文被引用', xml.includes('我的 项目') && xml.includes('Test User'));
  ok('不含 Token/Authorization', !/Authorization|API[_-]?KEY|TOKEN=|secret/i.test(xml));
  ok('非法端口抛错', (() => { try { buildTaskXml({ node, script, port: 0 }); return false; } catch { return true; } })());
}

console.log('\n[install/uninstall] 注入执行器，不创建真实任务');
{
  const calls = [];
  const run = (file, args) => { calls.push({ file, args: [...args] }); return 'SUCCESS'; };
  const logs = [];
  const log = (m) => logs.push(m);
  installWindowsAgent({ node, script, port: 8787, force: true, log, run });
  ok('schtasks /Create /TN 精确任务名 /F',
    calls.some((c) => c.file === 'schtasks.exe' && c.args.includes('/Create')
      && c.args.includes(WINDOWS_TASK_NAME) && c.args.includes('/F') && c.args.includes('/XML')),
    JSON.stringify(calls[0]));
  ok('XML 路径含 TokenMonitor-Server.xml', calls[0].args.some((a) => String(a).endsWith('TokenMonitor-Server.xml')));
  ok('安装后临时 XML 已清理', !existsSync(join(tmpdir(), 'TokenMonitor-Server.xml')));
  const xmlArg = calls[0].args[calls[0].args.indexOf('/XML') + 1];
  ok('不把密钥写进命令行', !/API[_-]?KEY|TOKEN=|SECRET=/i.test(calls[0].args.join(' ')));

  calls.length = 0;
  installWindowsAgent({ node, script, port: 8787, force: false, log, run });
  ok('重复安装仍 /F（幂等覆盖）', calls[0].args.includes('/F'));

  calls.length = 0;
  uninstallWindowsAgent({ log, run });
  ok('卸载只删本产品任务名',
    calls[0].file === 'schtasks.exe' && calls[0].args.includes('/Delete')
    && calls[0].args.includes(WINDOWS_TASK_NAME) && calls[0].args.includes('/F')
    && !calls[0].args.some((a) => a === '\\' || a === '*'));
}

console.log('\n[agent.js] Windows 走任务计划；macOS plist 回归仍可生成');
{
  const plist = buildPlist({ node: '/usr/local/bin/node', script: '/opt/pkg/bin/tokenmonitor.js', port: 9001, logDir: '/tmp/l' });
  ok('macOS plist 仍固化 node 与脚本', plist.includes('/usr/local/bin/node') && plist.includes('/opt/pkg/bin/tokenmonitor.js'));
  ok('macOS plist 含 serve 与 KeepAlive', plist.includes('serve') && plist.includes('KeepAlive'));
  ok('entryScript 指向 bin/tokenmonitor.js', entryScript().replaceAll('\\', '/').endsWith('bin/tokenmonitor.js'));
}

console.log('\n[cli glue] install-agent 仍在 new Store 之前');
{
  const src = readFileSync(join(ROOT, 'bin', 'tokenmonitor.js'), 'utf8');
  ok('install-agent 在 Store 前', src.indexOf("cmd === 'install-agent'") < src.indexOf('new Store(DB_PATH)'));
  ok('Windows help 不再说任务计划未实现', !/Task Scheduler \(Windows\) is not in this CLI yet/i.test(src));
}

if (failed) {
  console.error(`\nservice FAILED ${failed}`);
  process.exit(1);
}
console.log('\nservice OK');
