/**
 * Win-Runtime：单实例锁、日志脱敏与轮转、端口冲突诊断与受控关闭。
 * 运行：TOKENMETER_OFFLINE=1 node test/windows/runtime.test.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  isProcessAlive,
  diagnosePortConflict,
  sanitizeLogMessage,
  RuntimeLogger,
  RuntimeManager,
  getLockFilePath,
  getDefaultDataDir,
} from '../../src/platform/runtime.js';
import { startServer } from '../../src/server.js';
import { Store } from '../../src/store.js';

process.env.TOKENMETER_OFFLINE = '1';

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const TEMP_BASE = mkdtempSync(join(tmpdir(), 'runtime-测试 空格-'));
console.log(`[test setup] temp directory: ${TEMP_BASE}`);

// ==========================================
// 1. 单实例锁：作用域、并发竞争与陈旧锁恢复
// ==========================================
console.log('\n[single-instance lock] 作用域、幂等检测与陈旧锁安全恢复');
{
  const testDataDir = join(TEMP_BASE, 'data-dir-中文');
  const portA = 9871;
  const portB = 9872;

  // 首次获取锁
  const lock1 = acquireSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });
  ok('首次获取锁成功', lock1.acquired === true && lock1.status === 'acquired');
  ok('锁文件存在于数据目录下', existsSync(lock1.lockPath));

  // 重复获取相同目录与端口的锁
  const lock2 = acquireSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: 99999 });
  ok('重复获取锁返回 already_running', lock2.acquired === false && lock2.status === 'already_running');
  ok('重复启动返回已运行 PID', lock2.existingPid === process.pid);
  ok('重复启动包含清晰诊断消息', typeof lock2.message === 'string' && lock2.message.includes(String(process.pid)));

  // 不同端口互不干扰（以 port 为作用域）
  const lockDiffPort = acquireSingleInstanceLock({ dataDir: testDataDir, port: portB, pid: process.pid });
  ok('不同端口可独立获取锁', lockDiffPort.acquired === true);
  releaseSingleInstanceLock({ dataDir: testDataDir, port: portB, pid: process.pid });

  // 释放主锁
  const released = releaseSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });
  ok('释放锁成功', released === true && !existsSync(lock1.lockPath));

  // 陈旧锁恢复测试（死进程 PID）
  const deadPid = 2147483640; // 极大 PID，不可能存活
  ok('死进程 PID 确认不存活', isProcessAlive(deadPid) === false);
  const staleLockPath = getLockFilePath(testDataDir, portA);
  writeFileSync(staleLockPath, JSON.stringify({ pid: deadPid, port: portA, dataDir: testDataDir }), 'utf8');
  ok('已写入陈旧锁文件', existsSync(staleLockPath));

  const recoverLock = acquireSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });
  ok('检测到死进程陈旧锁并成功恢复获取', recoverLock.acquired === true && recoverLock.recoveredFromStale === true);
  ok('恢复后锁文件记录新 PID', JSON.parse(readFileSync(staleLockPath, 'utf8')).pid === process.pid);
  releaseSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });

  // 损坏的锁文件自动恢复测试
  writeFileSync(staleLockPath, '{ bad json corrupted ...', 'utf8');
  const recoverCorrupt = acquireSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });
  ok('损坏锁文件安全恢复获取', recoverCorrupt.acquired === true);
  releaseSingleInstanceLock({ dataDir: testDataDir, port: portA, pid: process.pid });
}

// ==========================================
// 2. 并发启动测试：确保无锁竞争冲突、唯一性
// ==========================================
console.log('\n[concurrency] 并发竞争启动锁');
{
  const concurrentDir = join(TEMP_BASE, 'concurrent-测试');
  const port = 9873;
  const attempts = await Promise.all([
    new Promise((resolve) => setTimeout(() => resolve(acquireSingleInstanceLock({ dataDir: concurrentDir, port, pid: process.pid })), 5)),
    new Promise((resolve) => setTimeout(() => resolve(acquireSingleInstanceLock({ dataDir: concurrentDir, port, pid: process.pid })), 2)),
    new Promise((resolve) => setTimeout(() => resolve(acquireSingleInstanceLock({ dataDir: concurrentDir, port, pid: process.pid })), 8)),
  ]);

  const acquiredCount = attempts.filter((a) => a.acquired).length;
  const rejectedCount = attempts.filter((a) => !a.acquired && a.status === 'already_running').length;
  ok('并发启动下严格恰有 1 个实例获锁', acquiredCount === 1, `acquired=${acquiredCount}`);
  ok('其余并发尝试均识别为 already_running', rejectedCount === 2, `rejected=${rejectedCount}`);
  releaseSingleInstanceLock({ dataDir: concurrentDir, port, pid: process.pid });
}

// ==========================================
// 3. 端口占用诊断：报告地址、端口、PID 与降级
// ==========================================
console.log('\n[port diagnostics] 端口冲突诊断与降级');
{
  // 创建一个测试服务器占用端口
  const testServer = net.createServer();
  const port = await new Promise((resolve) => {
    testServer.listen(0, '127.0.0.1', () => resolve(testServer.address().port));
  });

  const diag = diagnosePortConflict(port, '127.0.0.1');
  ok('检测到端口冲突', diag.conflict === true);
  ok('返回正确的地址和端口', diag.address === '127.0.0.1' && diag.port === port);
  ok('诊断消息包含端口号', diag.diagnostics.includes(String(port)));
  if (process.platform === 'win32') {
    ok('Windows 上获得占用进程 PID', typeof diag.pid === 'number' && diag.pid > 0, `pid=${diag.pid}`);
  }

  // 模拟命令抛错或无权限情况下的降级行为
  const degradedDiag = diagnosePortConflict(port, '127.0.0.1', {
    exec: () => { throw new Error('EPERM: operation not permitted'); },
  });
  ok('无权限执行诊断命令时明确降级', degradedDiag.degraded === true);
  ok('降级后仍返回冲突标记与解释说明', degradedDiag.conflict === true && degradedDiag.diagnostics.includes('not permitted'));

  await new Promise((resolve) => testServer.close(resolve));
}

// ==========================================
// 4. startServer 端口占用集成与 /api/status 端点
// ==========================================
console.log('\n[server integration] EADDRINUSE 捕获与 /api/status 接口');
{
  const occupiedServer = net.createServer();
  const testPort = await new Promise((resolve) => {
    occupiedServer.listen(0, '127.0.0.1', () => resolve(occupiedServer.address().port));
  });

  const dummyStore = { db: { prepare: () => ({ all: () => [], get: () => ({}) }) } };
  const dummyScanner = { on: () => {}, stats: {} };

  let errorCaught = null;
  try {
    await startServer({
      store: dummyStore,
      scanner: dummyScanner,
      port: testPort,
      log: () => {},
    });
  } catch (err) {
    errorCaught = err;
  }

  ok('端口被占用时 startServer 抛出受控异常', errorCaught !== null && errorCaught.code === 'EADDRINUSE');
  ok('异常对象挂载冲突诊断信息', errorCaught?.conflict?.conflict === true && errorCaught.conflict.port === testPort);
  await new Promise((resolve) => occupiedServer.close(resolve));

  // 启动真实 server 校验 /api/status 端点与关闭机制
  const freePort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

  const liveServer = await startServer({
    store: dummyStore,
    scanner: dummyScanner,
    port: freePort,
    log: () => {},
  });

  // 测试 /api/status
  const statusRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${freePort}/api/status`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  ok('/api/status 返回 status=ok', statusRes.status === 'ok');
  ok('/api/status 返回 pid 与 port', statusRes.pid === process.pid && statusRes.port === freePort);
  ok('/api/status 返回 offline 模式标记', typeof statusRes.offline === 'boolean');

  await new Promise((resolve) => liveServer.close(resolve));
}

// ==========================================
// 5. 日志脱敏与上限轮转测试
// ==========================================
console.log('\n[logging] 自动脱敏与受控轮转');
{
  const logDir = join(TEMP_BASE, 'logs-中文 空格');
  const logger = new RuntimeLogger({
    logDir,
    filename: 'test.log',
    maxSizeBytes: 800, // 设小字节上限以便测试轮转
    maxBackups: 3,
    consoleOutput: false,
  });

  // 脱敏规则断言
  const sensitiveMsg = [
    'User header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.testTokenValue',
    'Room credential token acr.credential_efd620869f8c4615.CWHV4Sh1V8uehL7W7c5St3GYSevUPMNcy8jXttCtKK8',
    'OpenAI sk-proj-1234567890abcdef123456 and Anthropic sk-ant-api03-abcdef123456',
    'Custom key-9876543210fedcba and api_key="superSecretKey12345"',
    'Session payload: {"content": "This is private user chat prompt", "prompt": "Tell me a secret"}',
  ].join('\n');

  logger.info(sensitiveMsg);

  const logFile = join(logDir, 'test.log');
  ok('日志文件创建成功', existsSync(logFile));
  const written = readFileSync(logFile, 'utf8');

  ok('Bearer token 已脱敏', written.includes('Bearer [REDACTED]') && !written.includes('eyJhbGciOi'));
  ok('AgentChatRoom credential token 已脱敏', written.includes('acr.credential_[REDACTED]') && !written.includes('CWHV4Sh1'));
  ok('OpenAI sk- API Key 已脱敏', written.includes('sk-[REDACTED]') && !written.includes('sk-proj-123456'));
  ok('Anthropic sk-ant- API Key 已脱敏', written.includes('sk-ant-[REDACTED]') && !written.includes('sk-ant-api03-'));
  ok('key- API Key 已脱敏', written.includes('key-[REDACTED]') && !written.includes('key-9876543210'));
  ok('会话 content/prompt 正文已脱敏', /"content"\s*:\s*"\[REDACTED\]"/.test(written) && !written.includes('private user chat'));

  // 轮转测试：写入多条日志直至触发轮转
  for (let i = 0; i < 25; i++) {
    logger.info(`Log line ${i} padding message ${'x'.repeat(80)}`);
  }

  const files = readdirSync(logDir).filter((f) => f.startsWith('test.log'));
  ok('产生轮转备份文件', files.some((f) => f === 'test.log.1'));
  ok('轮转文件数量不超过 maxBackups + 1', files.length <= 4, `found=${files.join(', ')}`);
}

// ==========================================
// 6. RuntimeManager 受控关闭生命周期
// ==========================================
console.log('\n[runtime lifecycle] RuntimeManager 资源接管与受控停止');
{
  const dataDir = join(TEMP_BASE, 'runtime-lifecycle');
  const port = 9875;
  const manager = new RuntimeManager({ dataDir, port });

  const lockRes = manager.acquireLock();
  ok('RuntimeManager 获取锁成功', lockRes.acquired === true);

  let scannerStopped = false;
  let pollerStopped = false;
  let serverClosed = false;
  let storeClosed = false;

  const mockScanner = { stop: () => { scannerStopped = true; } };
  const mockPoller = { stop: () => { pollerStopped = true; } };
  const mockServer = {
    close: (cb) => { serverClosed = true; if (cb) cb(); },
    closeAllConnections: () => {},
  };
  const mockStore = { close: () => { storeClosed = true; } };

  manager.registerServices({
    store: mockStore,
    scanner: mockScanner,
    balancePoller: mockPoller,
    server: mockServer,
  });

  const stopRes = await manager.shutdown('SIGTERM');
  ok('受控关闭返回成功', stopRes.closed === true && stopRes.signal === 'SIGTERM');
  ok('受控关闭终止 scanner', scannerStopped === true);
  ok('受控关闭终止 balancePoller', pollerStopped === true);
  ok('受控关闭关闭 server', serverClosed === true);
  ok('受控关闭关闭 store', storeClosed === true);
  ok('受控关闭释放单实例锁文件', !existsSync(getLockFilePath(dataDir, port)));

  // 幂等重复停止
  const stopAgain = await manager.shutdown('controlled');
  ok('重复关闭幂等安全返回', stopAgain.closed === true && stopAgain.already === true);
}

// 清理临时目录
try {
  rmSync(TEMP_BASE, { recursive: true, force: true });
} catch {}

if (failed) {
  console.error(`\nruntime test FAILED: ${failed} assertions failed.`);
  process.exit(1);
}

console.log('\nruntime test OK: all assertions passed.');
process.exit(0);
