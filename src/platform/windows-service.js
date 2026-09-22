import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PORT } from '../config.js';

/** 当前用户任务计划中的稳定名称。uninstall 只删这一条。 */
export const WINDOWS_TASK_NAME = 'TokenMonitor-Server';

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => XML_ESC[c]);
const XML_UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (v) => String(v).replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_UNESC[e]);

/**
 * 任务动作的参数串。单独抽出来是因为 `--force` 要判断"已注册的那条命令是不是同一条"，
 * 比较的两边必须出自同一个定义（#96）。
 */
export function taskArguments({ script, port = DEFAULT_PORT }) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port '${port}' (expected 1-65535)`);
  }
  return `--disable-warning=ExperimentalWarning "${script}" serve --port ${n}`;
}

/**
 * 当前用户登录触发、最低权限、隐藏窗口。动作写死 node + 入口脚本 + serve --port。
 * 不写入 Token / 环境秘密。
 */
export function buildTaskXml({ node, script, port = DEFAULT_PORT }) {
  const args = taskArguments({ script, port });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>TokenMonitor local token usage panel (current user, no admin)</Description>
    <URI>\\${esc(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(node)}</Command>
      <Arguments>${esc(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true });
}

/**
 * 泄露自检（#96 第 5 条）：这里要拦的是"本模块把凭据写进了任务定义"，不是"用户目录名里有个
 * 看起来像密钥的词"。旧写法拿 `Authorization|API[_-]?KEY|TOKEN=|secret` 扫整份 XML，
 * 而 XML 里必然带着 `node` 与 `script` 两条**路径**——于是 `D:\work\secretpad\...` 或
 * `C:\Users\x\Authorization\...` 这类普通安装目录会让 install-agent 抛"任务定义看起来
 * 包含密钥"，报的原因和真实原因毫无关系，用户完全无从下手。
 * 改成只认凭据的**形状**：`名字:` / `名字=` 后面跟 8 位以上非空白值，外加 `sk-…` 与
 * `Bearer …` 两种公认样式。单纯的路径分段名（`secret`、`Authorization`、`Token` 后面
 * 既不是 `:`/`=` 也不是这些前缀）不再算命中。
 *
 * 命中时错误消息**点名命中的形状**（`secret=` / `sk-` / `bearer`）但不回显值本身——
 * 值正是我们要防泄露的东西，抄进错误消息等于把它再抄一份进 stdout 与日志。
 */
const SECRET_SHAPES = [
  {
    re: /\b(api[_-]?key|access[_-]?key|authorization|secret|pass(?:word|wd)?|token)(\s*[:=]\s*)\S{8,}/i,
    nameOf: (m) => `${m[1]}${m[2].trim()}`,
    label: '凭据赋值（名字后跟 8 位以上的值）',
  },
  {
    re: /\b(sk-)[A-Za-z0-9_-]{8,}/i,
    nameOf: (m) => m[1],
    label: 'sk- 前缀密钥',
  },
  {
    re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/i,
    nameOf: (m) => m[1],
    label: 'Bearer 令牌',
  },
];

/** 命中则返回 `{ matched, label }`（`matched` 只含凭据名/前缀，不含值），否则 null。 */
function leakedSecretShape(text) {
  for (const { re, nameOf, label } of SECRET_SHAPES) {
    const m = re.exec(text);
    if (m) return { matched: nameOf(m), label };
  }
  return null;
}

/**
 * 已经注册的那条命令是什么。`--force` 在帮助里承诺"替换一个冲突的 agent"，
 * 那么"冲突"必须先可判定：旧实现把 `/F` 无条件传给 schtasks，`--force` 是个空标志，
 * 帮助文字与行为不符（#96）。查不到、查询失败或返回的不是任务 XML 时按 null 处理
 * （"没有可判定的冲突对象"），让 /Create 自己去报真实的错。
 */
function queryInstalledTask(run) {
  let out;
  try {
    out = run('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAME, '/XML']);
  } catch {
    return null;
  }
  const text = String(out ?? '');
  const grab = (tag) => {
    const m = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? unesc(m[1]).trim() : null;
  };
  const command = grab('Command');
  if (command === null) return null;
  return { command, arguments: grab('Arguments') ?? '' };
}

export function installWindowsAgent({
  node = process.execPath,
  script,
  port = DEFAULT_PORT,
  force = false,
  log = console.log,
  run = defaultRun,
} = {}) {
  if (!script) throw new Error('install-agent requires the TokenMonitor entry script path');
  const args = taskArguments({ script, port });
  const xml = buildTaskXml({ node, script, port });
  const leak = leakedSecretShape(xml);
  if (leak) {
    throw new Error('refusing to write a task definition that looks like it contains secrets'
      + `: matched ${leak.matched} (${leak.label}). `
      + 'The matched value is deliberately not echoed; move the install path out of it'
      + ' or point --port/--script at a plain directory.');
  }
  const installed = queryInstalledTask(run);
  if (installed && (installed.command !== node || installed.arguments !== args)) {
    if (!force) {
      throw new Error(
        `task ${WINDOWS_TASK_NAME} already points at a different command `
        + `(now: ${installed.command} ${installed.arguments}; `
        + `this run would use: ${node} ${args}). `
        + 'Re-run with --force to replace it.');
    }
    log(`--force: replacing the command already registered for ${WINDOWS_TASK_NAME}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-task-'));
  const xmlPath = join(dir, 'TokenMonitor-Server.xml');
  try {
    const bom = Buffer.from([0xFF, 0xFE]);
    writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, 'utf16le')]));
    // /F：重复安装是覆盖更新。冲突与否由上面的 queryInstalledTask 判定，
    // --force 决定"确认要覆盖一条不属于本命令的任务"，两者都落到这一条 /F 上。
    const create = ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', xmlPath, '/F'];
    try {
      log(run('schtasks.exe', create) || `installed ${WINDOWS_TASK_NAME}`);
    } catch (err) {
      const detail = String(err.stderr || err.message || err).trim();
      throw new Error(`Failed to register ${WINDOWS_TASK_NAME} (current-user Task Scheduler, no admin): ${detail}`);
    }
    log(`Windows logon task ${WINDOWS_TASK_NAME} -> ${node} serve --port ${port} (hidden, current user)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function uninstallWindowsAgent({
  log = console.log,
  run = defaultRun,
} = {}) {
  try {
    log(run('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']) || `removed ${WINDOWS_TASK_NAME}`);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    if (/cannot find|cannot find the file|ERROR: The system cannot find/i.test(msg)
      || /The specified task name/.test(msg)
      || err.status === 1) {
      log(`task ${WINDOWS_TASK_NAME} was not present`);
      return;
    }
    throw err;
  }
}
