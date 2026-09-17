import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PORT } from '../config.js';

/** 当前用户任务计划中的稳定名称。uninstall 只删这一条。 */
export const WINDOWS_TASK_NAME = 'TokenMonitor-Server';

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => XML_ESC[c]);

/**
 * 当前用户登录触发、最低权限、隐藏窗口。动作写死 node + 入口脚本 + serve --port。
 * 不写入 Token / 环境秘密。
 */
export function buildTaskXml({ node, script, port = DEFAULT_PORT }) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port '${port}' (expected 1-65535)`);
  }
  const args = `--disable-warning=ExperimentalWarning "${script}" serve --port ${n}`;
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

export function installWindowsAgent({
  node = process.execPath,
  script,
  port = DEFAULT_PORT,
  force = false,
  log = console.log,
  run = defaultRun,
} = {}) {
  if (!script) throw new Error('install-agent requires the TokenMonitor entry script path');
  const xml = buildTaskXml({ node, script, port });
  if (/Authorization|API[_-]?KEY|TOKEN=|secret/i.test(xml)) {
    throw new Error('refusing to write a task definition that looks like it contains secrets');
  }
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-task-'));
  const xmlPath = join(dir, 'TokenMonitor-Server.xml');
  try {
    const bom = Buffer.from([0xFF, 0xFE]);
    writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, 'utf16le')]));
    // /F：重复安装是覆盖更新。--force 同样走覆盖，语义是“允许替换已有同名任务”。
    const args = ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', xmlPath, '/F'];
    if (!force) {
      // 无 --force 时也必须幂等；/F 仍使用，避免“already exists”失败。
    }
    try {
      log(run('schtasks.exe', args) || `installed ${WINDOWS_TASK_NAME}`);
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
