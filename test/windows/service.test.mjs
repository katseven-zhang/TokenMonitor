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

console.log('\n[uninstall-agent #86] 只有"任务确实不存在"才算无事可做；退出码 1 的一切真失败必须抛出');
{
  // schtasks 对"任务不存在""拒绝访问""服务未运行""任务受策略保护"都返回退出码 1，
  // 唯一可区分的事实是 stderr 原文。修前的 `|| err.status === 1` 把四者都说成
  // "was not present" 并静默返回 0，用户以为卸载干净、下次登录服务照样起来。
  const failWith = (stderr) => {
    const err = new Error('Command failed: schtasks.exe');
    err.status = 1;
    err.stderr = stderr;
    throw err;
  };
  const logs = [];
  const mk = (stderr) => (file, args) => {
    if (file !== 'schtasks.exe' || !args.includes('/Delete')) throw new Error('unexpected call');
    return failWith(stderr);
  };

  // 1) 任务不存在（英文系统消息）→ 正常返回，只记一行
  let threw = null;
  try { uninstallWindowsAgent({ log: (m) => logs.push(m), run: mk('ERROR: The system cannot find the file specified.\r\n') }); }
  catch (e) { threw = e; }
  ok('1 "cannot find the file specified" 视为任务本就不存在', threw === null && logs.some((l) => /was not present/.test(l)), String(threw));

  // 2) "cannot find the task" 措辞 → 同样正常返回
  threw = null; logs.length = 0;
  try { uninstallWindowsAgent({ log: (m) => logs.push(m), run: mk('ERROR: cannot find the task "TokenMonitor-Server".\r\n') }); }
  catch (e) { threw = e; }
  ok('2 "cannot find the task" 变体也视为不存在', threw === null && logs.some((l) => /was not present/.test(l)), String(threw));

  // 3) 拒绝访问 → 抛出，不再冒充"本就不存在"
  threw = null; logs.length = 0;
  try { uninstallWindowsAgent({ log: (m) => logs.push(m), run: mk('ERROR: Access is denied.\r\n') }); }
  catch (e) { threw = e; }
  ok('3 拒绝访问抛出而非静默成功', !!threw && !logs.some((l) => /was not present/.test(l)), String(threw));

  // 4) Task Scheduler 服务未运行 → 抛出
  threw = null; logs.length = 0;
  try { uninstallWindowsAgent({ log: (m) => logs.push(m), run: mk('ERROR: The Task Scheduler service is not running.\r\n') }); }
  catch (e) { threw = e; }
  ok('4 调度服务未运行抛出', !!threw && !logs.some((l) => /was not present/.test(l)), String(threw));

  // 5) 组策略锁住任务 → 抛出，且错误原文随异常带出（否则用户再也看不到原因）
  threw = null; logs.length = 0;
  try { uninstallWindowsAgent({ log: (m) => logs.push(m), run: mk('ERROR: This task is protected and cannot be deleted.\r\n') }); }
  catch (e) { threw = e; }
  ok('5 策略保护抛出并保留 schtasks 原文与任务名',
    !!threw && /protected and cannot be deleted/.test(threw.message) && threw.message.includes(WINDOWS_TASK_NAME)
    && !/was not present/.test(threw.message), String(threw));
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
