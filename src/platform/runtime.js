import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RUNTIME_DATA_DIR, DEFAULT_PORT } from '../config.js';

/**
 * Windows 平台默认数据目录与日志目录
 *
 * 数据位置由 src/config.js 的 resolveDataLocations 统一解析（#23）：
 * TOKENMONITOR_DATA_DIR > 打包形态 <应用根>\data > 源码默认 %LOCALAPPDATA%\TokenMonitor。
 */
export function getDefaultDataDir() {
  return RUNTIME_DATA_DIR;
}

export function getDefaultLogDir(dataDir = getDefaultDataDir()) {
  return join(dataDir, 'logs');
}

export function getLockFilePath(dataDir, port = DEFAULT_PORT) {
  return join(dataDir, `tokenmonitor-${port}.lock`);
}

/**
 * 检查 PID 是否仍存活
 * process.kill(pid, 0) 不会发送实际终止信号，仅探测进程是否存在
 */
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但当前用户权限不足以发信号，说明该进程仍在运行
    // ESRCH 表示该 PID 进程不存在
    return err.code === 'EPERM';
  }
}

/**
 * 单实例锁：以 (dataDir, port) 为作用域
 * 重复启动返回已运行状态，不终止任意 node.exe；陈旧锁自动清理并恢复。
 */
export function acquireSingleInstanceLock({
  dataDir = getDefaultDataDir(),
  port = DEFAULT_PORT,
  pid = process.pid,
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = getLockFilePath(dataDir, port);
  const payload = JSON.stringify({
    pid,
    port,
    dataDir,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
  }, null, 2);

  // 原子化创建锁文件（'wx' 标志若文件已存在则抛出 EEXIST）
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, payload, 'utf8');
    closeSync(fd);
    return {
      acquired: true,
      status: 'acquired',
      lockPath,
      pid,
      port,
      dataDir,
    };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    // 锁文件已存在，读取其中记录的 PID 检查存活状态
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      // 损坏的锁文件视为陈旧锁
      existing = null;
    }

    if (existing && isProcessAlive(existing.pid)) {
      // 目标实例仍在正常运行：绝不强杀进程，返回已运行状态
      return {
        acquired: false,
        status: 'already_running',
        running: true,
        existingPid: existing.pid,
        lockPath,
        port,
        dataDir,
        message: `TokenMonitor is already running on port ${port} (PID: ${existing.pid})`,
      };
    }

    // 进程已退出或锁文件损坏：陈旧锁，安全清理后重试
    try {
      unlinkSync(lockPath);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
    }

    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, payload, 'utf8');
      closeSync(fd);
      return {
        acquired: true,
        status: 'acquired',
        recoveredFromStale: true,
        lockPath,
        pid,
        port,
        dataDir,
      };
    } catch (retryErr) {
      if (retryErr.code === 'EEXIST') {
        try {
          const fresh = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (fresh && isProcessAlive(fresh.pid)) {
            return {
              acquired: false,
              status: 'already_running',
              running: true,
              existingPid: fresh.pid,
              lockPath,
              port,
              dataDir,
              message: `TokenMonitor is already running on port ${port} (PID: ${fresh.pid})`,
            };
          }
        } catch {}
      }
      throw retryErr;
    }
  }
}

/**
 * 释放单实例锁
 */
export function releaseSingleInstanceLock({
  dataDir,
  port = DEFAULT_PORT,
  lockPath = null,
  pid = process.pid,
} = {}) {
  const target = lockPath || (dataDir ? getLockFilePath(dataDir, port) : null);
  if (!target || !existsSync(target)) return false;
  try {
    const content = readFileSync(target, 'utf8');
    const existing = JSON.parse(content);
    if (existing.pid === pid) {
      unlinkSync(target);
      return true;
    }
  } catch {}
  return false;
}

/**
 * 端口占用诊断
 * 报告地址、端口及可获得的进程信息；无权限或无法解析时明确降级，不自动抢占端口。
 */
export function diagnosePortConflict(port, address = '127.0.0.1', { exec = spawnSync } = {}) {
  const isWin = process.platform === 'win32';

  if (isWin) {
    try {
      const res = exec('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });

      if (res.error) throw res.error;
      const lines = (res.stdout || '').split(/\r?\n/);
      const portRegex = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\*):${port}\\s+.*(?:LISTENING|LISTEN)\\s+(\\d+)`, 'i');
      let matchedPid = null;
      for (const line of lines) {
        const m = line.match(portRegex);
        if (m) {
          matchedPid = parseInt(m[1], 10);
          break;
        }
      }

      if (matchedPid) {
        let processName = null;
        try {
          const tRes = exec('tasklist', ['/FI', `PID eq ${matchedPid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true,
          });
          const mName = (tRes.stdout || '').match(/^"([^"]+)"/);
          if (mName) processName = mName[1];
        } catch {}

        return {
          conflict: true,
          address,
          port,
          pid: matchedPid,
          processName: processName || null,
          diagnostics: `Port ${port} on ${address} is already in use by process ${processName ? `"${processName}" ` : ''}(PID: ${matchedPid})`,
          degraded: false,
        };
      }
    } catch (err) {
      return {
        conflict: true,
        address,
        port,
        pid: null,
        processName: null,
        diagnostics: `Port ${port} on ${address} is in use, but process information could not be retrieved (${err?.message || err})`,
        degraded: true,
      };
    }
  } else {
    // macOS / Linux 兜底诊断
    try {
      const res = exec('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-n', '-P'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (res.error) throw res.error;
      const lines = (res.stdout || '').trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        const processName = parts[0] || null;
        const pid = parseInt(parts[1], 10) || null;
        return {
          conflict: true,
          address,
          port,
          pid,
          processName,
          diagnostics: `Port ${port} on ${address} is already in use by process ${processName ? `"${processName}" ` : ''}(PID: ${pid})`,
          degraded: false,
        };
      }
    } catch (err) {
      return {
        conflict: true,
        address,
        port,
        pid: null,
        processName: null,
        diagnostics: `Port ${port} on ${address} is in use, but process information could not be retrieved (${err?.message || err})`,
        degraded: true,
      };
    }
  }

  return {
    conflict: true,
    address,
    port,
    pid: null,
    processName: null,
    diagnostics: `Port ${port} on ${address} is in use by an existing process`,
    degraded: true,
  };
}

/**
 * 敏感信息脱敏：
 * 自动脱敏 Authorization、Bearer、API Key、Room/Credential Token 以及会话/消息正文
 */
export function sanitizeLogMessage(input) {
  let str = '';
  if (typeof input === 'string') {
    str = input;
  } else if (input instanceof Error) {
    str = input.stack || input.message || String(input);
  } else {
    try {
      str = JSON.stringify(input);
    } catch {
      str = String(input);
    }
  }

  return str
    // AgentChatRoom credential token
    .replace(/acr\.credential_[a-f0-9]+\.[A-Za-z0-9_-]+/g, 'acr.credential_[REDACTED]')
    // Authorization: Bearer <token>
    .replace(/(\bAuthorization\s*[:=]\s*Bearer\s+)[^\r\n,\s]+/gi, '$1[REDACTED]')
    // Bearer <token>
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    // Authorization: <token> (non-bearer header)
    .replace(/(\bAuthorization\s*[:=]\s*["']?)(?!Bearer\b)[^"'\r\n,\s}]+/gi, '$1[REDACTED]')
    // Specific token fields
    .replace(/(["']?(?:token|auth_token|access_token)["']?\s*[:=]\s*["']?)[^"'\r\n,\s}]+/gi, '$1[REDACTED]')
    // Anthropic API keys sk-ant- (must be before sk-)
    .replace(/\b(sk-ant-[a-zA-Z0-9_-]{8,})\b/gi, 'sk-ant-[REDACTED]')
    // OpenAI / general sk- keys
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,})\b/gi, 'sk-[REDACTED]')
    // key- prefix API keys
    .replace(/\b(key-[a-zA-Z0-9_-]{8,})\b/gi, 'key-[REDACTED]')
    // api_key="..." or apiKey: "..."
    .replace(/((?:api[_-]?key|secret[_-]?key|app[_-]?secret)\s*[:=]\s*["']?)([^"'\r\n,\s}]+)/gi, '$1[REDACTED]')
    // 会话正文 / 提示词 / 消息内容脱敏
    .replace(/(["']?(?:session_body|conversation_text|message_content|user_message|assistant_response|prompt|body|content)["']?\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"');
}

/**
 * 日志记录器：固定于 logs/，自动脱敏，带上限轮转
 */
export class RuntimeLogger {
  constructor({
    logDir = getDefaultLogDir(),
    filename = 'tokenmonitor.log',
    maxSizeBytes = 5 * 1024 * 1024,
    maxBackups = 5,
    consoleOutput = true,
  } = {}) {
    this.logDir = logDir;
    this.filename = filename;
    this.logPath = join(logDir, filename);
    this.maxSizeBytes = maxSizeBytes;
    this.maxBackups = maxBackups;
    this.consoleOutput = consoleOutput;
    mkdirSync(this.logDir, { recursive: true });
  }

  write(level, ...args) {
    const raw = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const sanitized = sanitizeLogMessage(raw);
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${level.toUpperCase()}] ${sanitized}\n`;

    // 轮转检查
    this._rotateIfNeeded(Buffer.byteLength(entry, 'utf8'));

    // 写入文件
    try {
      const fd = openSync(this.logPath, 'a');
      writeFileSync(fd, entry, 'utf8');
      closeSync(fd);
    } catch {}

    if (this.consoleOutput) {
      if (level === 'error') console.error(`[tokenmonitor] ${sanitized}`);
      else console.log(`[tokenmonitor] ${sanitized}`);
    }
  }

  _rotateIfNeeded(incomingBytes = 0) {
    try {
      if (!existsSync(this.logPath)) return;
      const st = statSync(this.logPath);
      if (st.size + incomingBytes < this.maxSizeBytes) return;

      // 超过上限，执行轮转
      const oldest = join(this.logDir, `${this.filename}.${this.maxBackups}`);
      if (existsSync(oldest)) rmSync(oldest, { force: true });

      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const src = join(this.logDir, `${this.filename}.${i}`);
        const dest = join(this.logDir, `${this.filename}.${i + 1}`);
        if (existsSync(src)) renameSync(src, dest);
      }

      const firstBackup = join(this.logDir, `${this.filename}.1`);
      renameSync(this.logPath, firstBackup);
    } catch {}
  }

  info(...args) { this.write('info', ...args); }
  warn(...args) { this.write('warn', ...args); }
  error(...args) { this.write('error', ...args); }
  close() {}
}

/**
 * Windows 后台运行时管理器
 * 统一管理单实例锁、受控停止、服务关闭与信号处理
 */
export class RuntimeManager {
  constructor({
    dataDir = getDefaultDataDir(),
    port = DEFAULT_PORT,
    logger = null,
  } = {}) {
    this.dataDir = dataDir;
    this.port = port;
    this.logger = logger || new RuntimeLogger({ logDir: getDefaultLogDir(dataDir), consoleOutput: false });
    this.store = null;
    this.scanner = null;
    this.balancePoller = null;
    this.server = null;
    this.lockInfo = null;
    this.shuttingDown = false;
    this.signalListeners = [];
  }

  acquireLock() {
    const res = acquireSingleInstanceLock({
      dataDir: this.dataDir,
      port: this.port,
    });
    if (res.acquired) {
      this.lockInfo = res;
      this.logger.info(`Single instance lock acquired: ${res.lockPath}`);
    } else {
      this.logger.warn(`Single instance lock conflict: ${res.message}`);
    }
    return res;
  }

  registerServices({ store, scanner, balancePoller, server } = {}) {
    if (store) this.store = store;
    if (scanner) this.scanner = scanner;
    if (balancePoller) this.balancePoller = balancePoller;
    if (server) this.server = server;
  }

  registerSignalHandlers({ onExit = true } = {}) {
    const handleSignal = (sig) => {
      this.shutdown(sig).then(() => {
        if (onExit) process.exit(0);
      });
    };

    const sigint = () => handleSignal('SIGINT');
    const sigterm = () => handleSignal('SIGTERM');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    this.signalListeners.push(['SIGINT', sigint], ['SIGTERM', sigterm]);

    if (process.platform === 'win32') {
      const sigbreak = () => handleSignal('SIGBREAK');
      process.on('SIGBREAK', sigbreak);
      this.signalListeners.push(['SIGBREAK', sigbreak]);
    }
  }

  unregisterSignalHandlers() {
    for (const [sig, fn] of this.signalListeners) {
      process.removeListener(sig, fn);
    }
    this.signalListeners = [];
  }

  async shutdown(signal = 'controlled') {
    if (this.shuttingDown) return { closed: true, already: true };
    this.shuttingDown = true;
    this.logger.info(`Graceful shutdown initiated (${signal})`);

    // 1. 停止 scanner
    if (this.scanner) {
      try { this.scanner.stop(); } catch {}
    }

    // 2. 停止 balancePoller
    if (this.balancePoller) {
      try { this.balancePoller.stop?.(); } catch {}
    }

    // 3. 关闭 HTTP 服务
    if (this.server) {
      try {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
        await new Promise((resolve) => {
          this.server.close(() => resolve());
          // 兜底超时防止永久挂起
          setTimeout(resolve, 2000).unref?.();
        });
      } catch {}
    }

    // 4. 关闭 Store
    if (this.store) {
      try { this.store.close(); } catch {}
    }

    // 5. 释放锁文件
    if (this.lockInfo) {
      releaseSingleInstanceLock({
        dataDir: this.dataDir,
        port: this.port,
        lockPath: this.lockInfo.lockPath,
      });
      this.lockInfo = null;
    }

    // 6. 清理信号监听
    this.unregisterSignalHandlers();
    this.logger.info(`Shutdown complete (${signal})`);
    this.logger.close();

    return { closed: true, signal };
  }
}
