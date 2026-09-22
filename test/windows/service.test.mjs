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
  // installWindowsAgent 现在先 `schtasks /Query` 再 `/Create`，所以 calls 的下标不再
  // 稳定：按操作找，不按位置找。
  const findCall = (calls, op) => calls.find((c) => c.file === 'schtasks.exe' && c.args.includes(op));
  // 未注册时 schtasks /Query 返回退出码 1；模拟成抛错，此时不应误判为冲突。
  const notRegistered = () => { throw new Error('ERROR: The system cannot find the file specified.'); };

  const calls = [];
  const run = (file, args) => { calls.push({ file, args: [...args] }); return 'SUCCESS'; };
  const logs = [];
  const log = (m) => logs.push(m);
  installWindowsAgent({ node, script, port: 8787, force: true, log, run });
  const create = findCall(calls, '/Create');
  ok('schtasks /Create /TN 精确任务名 /F',
    !!create && create.args.includes(WINDOWS_TASK_NAME)
    && create.args.includes('/F') && create.args.includes('/XML'),
    JSON.stringify(calls[0]));
  ok('先查询已注册任务再创建（--force 判冲突的前提）',
    !!findCall(calls, '/Query') && calls.indexOf(findCall(calls, '/Query')) < calls.indexOf(create),
    JSON.stringify(calls.map((c) => c.args[0])));
  ok('XML 路径含 TokenMonitor-Server.xml',
    create.args.some((a) => String(a).endsWith('TokenMonitor-Server.xml')));
  ok('安装后临时 XML 已清理', !existsSync(join(tmpdir(), 'TokenMonitor-Server.xml')));
  const xmlArg = create.args[create.args.indexOf('/XML') + 1];
  ok('不把密钥写进命令行', !/API[_-]?KEY|TOKEN=|SECRET=/i.test(create.args.join(' ')));

  calls.length = 0;
  installWindowsAgent({ node, script, port: 8787, force: false, log, run });
  ok('重复安装仍 /F（幂等覆盖）', findCall(calls, '/Create')?.args.includes('/F'),
    JSON.stringify(calls.map((c) => c.args)));

  calls.length = 0;
  uninstallWindowsAgent({ log, run });
  const del = findCall(calls, '/Delete');
  ok('卸载只删本产品任务名',
    !!del && del.args.includes(WINDOWS_TASK_NAME)
    && del.args.includes('/F')
    && !del.args.some((a) => a === '\\' || a === '*'));
}

console.log('\n[#96-5] 泄露自检只认凭据形状，路径里的目录名不算命中');
{
  const install = (opts) => {
    const calls = [];
    const run = (file, args) => { calls.push({ file, args: [...args] }); return 'SUCCESS'; };
    let err = null;
    try { installWindowsAgent({ ...opts, run, log: () => {} }); } catch (e) { err = e; }
    return { err, create: calls.find((c) => c.args.includes('/Create')) };
  };
  // 旧谓词 /Authorization|API[_-]?KEY|TOKEN=|secret/i 会在这三条**纯路径**上命中：
  // 目录叫 secretpad / Authorization / Token 而已，XML 里没有任何凭据。
  for (const dir of ['secretpad', 'Authorization', 'Token']) {
    const p = `Q:\\work\\${dir}\\bin\\tokenmonitor.js`;
    const { err, create } = install({ node: 'Q:\\nodejs\\node.exe', script: p, port: 8787 });
    ok(`安装路径含目录名 ${dir} 不再被当作密钥`, err === null && !!create, String(err?.message));
  }
  // 真的像凭据时才拦，且错误点名命中的形状、不回显值本身。
  const secretValue = 'hunter2notarealkey';
  const leak = install({
    node: 'Q:\\nodejs\\node.exe',
    script: `Q:\\work\\secret=${secretValue}\\bin\\tokenmonitor.js`,
    port: 8787,
  });
  ok('名字=值 的形状仍然拦', !!leak.err, '未抛错');
  ok('错误点名命中的形状', !!leak.err && /secret=/.test(leak.err.message), leak.err?.message);
  ok('错误不回显值本身', !!leak.err && !leak.err.message.includes(secretValue), leak.err?.message);
  ok('自检拦住时不写任务', !!leak.err && !leak.create, JSON.stringify(leak.create));
}

console.log('\n[#96-10] --force 真的分叉：冲突要先判、再让 --force 决定覆不覆');
{
  const installedXml = (command, args) => `<?xml version="1.0"?>\n<Task><Actions><Exec>`
    + `<Command>${command}</Command><Arguments>${args}</Arguments>`
    + `</Exec></Actions></Task>`;
  const sameArgs = '--disable-warning=ExperimentalWarning "D:\\Users\\Test User\\我的 项目\\TokenMonitor\\bin\\tokenmonitor.js" serve --port 8787';

  const scenario = ({ query, force }) => {
    const calls = [];
    const logs = [];
    const run = (file, args) => {
      calls.push({ file, args: [...args] });
      if (args.includes('/Query')) {
        if (query instanceof Error) throw query;
        return query;
      }
      return 'SUCCESS';
    };
    let err = null;
    try { installWindowsAgent({ node, script, port: 8787, force, log: (m) => logs.push(m), run }); }
    catch (e) { err = e; }
    return { err, calls, logs, create: calls.find((c) => c.args.includes('/Create')) };
  };

  // 别的命令（旧端口/旧脚本）占着同名任务
  const conflict = installedXml('Q:\\other\\node.exe', '--disable-warning=ExperimentalWarning "Q:\\other\\tokenmonitor.js" serve --port 9999');
  const noForce = scenario({ query: conflict, force: false });
  ok('冲突且未加 --force：抛错', !!noForce.err, '未抛错');
  ok('冲突错误同时给出已注册命令与本次命令',
    !!noForce.err && noForce.err.message.includes('Q:\\other\\node.exe')
    && noForce.err.message.includes('serve --port 8787'), noForce.err?.message);
  ok('冲突错误提示 --force', !!noForce.err && /--force/.test(noForce.err.message), noForce.err?.message);
  ok('冲突且未加 --force：不落到 /Create（否则 --force 仍是空标志）', !noForce.create,
    JSON.stringify(noForce.calls.map((c) => c.args[0])));

  const withForce = scenario({ query: conflict, force: true });
  ok('冲突且 --force：真的替换（走 /Create /F）',
    !withForce.err && !!withForce.create && withForce.create.args.includes('/F'),
    JSON.stringify(withForce.calls.map((c) => c.args[0])));
  ok('--force 替换时留下可见日志',
    withForce.logs.some((m) => /--force/.test(m) && /replac/i.test(m)), JSON.stringify(withForce.logs));

  // 同一条命令：不加 --force 也应幂等覆盖，不报冲突
  const same = scenario({ query: installedXml(node, sameArgs), force: false });
  ok('同命令重复安装：不报冲突且仍 /F 覆盖',
    !same.err && !!same.create && same.create.args.includes('/F'), same.err?.message);

  // 查询失败（任务未注册）不能变成"永远装不上"
  const absent = scenario({ query: new Error('ERROR: The system cannot find the file specified.'), force: false });
  ok('未注册（查询抛错）时照常安装', !absent.err && !!absent.create, absent.err?.message);

  // /Query 返回的不是任务 XML（区域设置/编码意外）：按"无可判定的冲突"处理
  const garbled = scenario({ query: '????', force: false });
  ok('查询返回非 XML 时不误判冲突', !garbled.err && !!garbled.create, garbled.err?.message);
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
