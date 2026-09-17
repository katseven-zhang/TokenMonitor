/**
 * Win-Watch 专项测试：
 * 验证 Windows 文件监听降级机制、生命周期管理与异常防御。
 *
 * 验收点：
 *  1. recursive fs.watch 不支持或抛错时自动使用非递归/目录级监听加周期扫描，服务不退出
 *  2. SQLite 来源监听父目录并响应 -wal/-shm 变化，JSONL 来源支持新建子目录后的发现
 *  3. 重命名、删除、ENOENT、短时锁定和事件风暴经防抖后只触发有限扫描
 *  4. stop() 关闭全部 watcher/timer，不留下句柄；重复 start/stop 幂等
 *  5. Windows 路径空格与中文测试通过，测试不依赖真实用户目录
 *  6. 提交聚焦 commit、git diff --check 与 fake watcher/真实临时目录证据
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watch as realWatch } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WatchManager, createWatchManager } = await import(pathToFileURL(join(ROOT, 'src/platform/watch.js')).href);
const { Scanner } = await import(pathToFileURL(join(ROOT, 'src/scanner.js')).href);
const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseTmp = mkdtempSync(join(tmpdir(), 'watch-测试 空格-'));

try {
  /* ---------- 1. 递归失败优雅降级到非递归与周期扫描 ---------- */
  console.log('\n[1] 递归监听失败优雅降级');
  {
    const workDir = join(baseTmp, 'case1-fallback');
    const subDir = join(workDir, 'existing-sub');
    mkdirSync(subDir, { recursive: true });

    let scans = 0;
    let fallbackLogged = false;

    // 注入模拟 Windows recursive 失败的 watchImpl
    const fakeWatch = (dir, opts, cb) => {
      if (opts?.recursive) {
        const err = new Error('recursive not supported on this platform');
        err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
        throw err;
      }
      return realWatch(dir, opts, cb);
    };

    const wm = new WatchManager({
      sources: [
        { tool: 'test-jsonl', kind: 'jsonl', roots: [workDir] },
      ],
      watchImpl: fakeWatch,
      debounceMs: 50,
      pollIntervalMs: 200,
      onChanged: async () => { scans++; },
      log: (msg) => {
        if (msg.includes('falling back to non-recursive')) fallbackLogged = true;
      },
    });

    wm.start();
    ok('检测到 recursive 失败并标明降级模式', wm.isFallback);
    ok('记录了降级日志', fallbackLogged);
    ok('子目录亦挂载了非递归监听', wm.watchers.length >= 2);

    // 在现有子目录创建文件
    writeFileSync(join(subDir, 'test.jsonl'), '{"hello":1}\n');
    await delay(120);
    ok('降级模式下修改现有子目录触发扫描', scans >= 1, `实际扫描 ${scans} 次`);

    // 周期扫描触发兜底
    const prevScans = scans;
    await delay(250);
    ok('周期兜底定时器定时触发扫描', scans > prevScans, `前后扫描对比: ${prevScans} -> ${scans}`);

    wm.stop();
    ok('stop() 成功关闭全部 watcher', wm.watchers.length === 0);
  }

  /* ---------- 2. SQLite 来源监听父目录并感知 -wal/-shm 变更 ---------- */
  console.log('\n[2] SQLite 来源监听父目录及 -wal/-shm');
  {
    const sqliteDir = join(baseTmp, 'case2-sqlite', '数据 目录');
    mkdirSync(sqliteDir, { recursive: true });
    const dbPath = join(sqliteDir, 'test.db');
    writeFileSync(dbPath, 'dummy sqlite content');

    let scans = 0;
    const wm = createWatchManager({
      sources: [
        { tool: 'test-sqlite', kind: 'sqlite', roots: [dbPath] },
      ],
      debounceMs: 50,
      pollIntervalMs: 0,
      onChanged: async () => { scans++; },
    });

    wm.start();
    // 应当监听 dirname(dbPath)，即 sqliteDir
    const watchedPaths = [...wm._watchers.keys()];
    ok('SQLite 监听的是父目录而非单个 db 文件',
      watchedPaths.some((p) => p.toLowerCase() === sqliteDir.toLowerCase()),
      JSON.stringify(watchedPaths));

    // 修改 -wal 文件
    writeFileSync(join(sqliteDir, 'test.db-wal'), 'wal updates');
    await delay(120);
    ok('修改 -wal 触发了扫描', scans >= 1, `实际扫描 ${scans} 次`);

    // 修改 -shm 文件
    const prevScans = scans;
    writeFileSync(join(sqliteDir, 'test.db-shm'), 'shm updates');
    await delay(120);
    ok('修改 -shm 触发了扫描', scans > prevScans, `实际扫描 ${scans} 次`);

    wm.stop();
  }

  /* ---------- 3. JSONL 来源新建子目录动态发现 ---------- */
  console.log('\n[3] 降级模式下新建子目录动态发现');
  {
    const rootDir = join(baseTmp, 'case3-new-sub');
    mkdirSync(rootDir, { recursive: true });

    let scans = 0;
    const fakeWatch = (dir, opts, cb) => {
      if (opts?.recursive) throw new Error('recursive unavailable');
      return realWatch(dir, opts, cb);
    };

    const wm = new WatchManager({
      sources: [
        { tool: 'test-jsonl', kind: 'jsonl', roots: [rootDir] },
      ],
      watchImpl: fakeWatch,
      debounceMs: 50,
      pollIntervalMs: 0,
      onChanged: async () => { scans++; },
    });

    wm.start();
    const initialWatchers = wm.watchers.length;

    // 动态创建新子目录并在其中写入文件
    const newSub = join(rootDir, 'dynamic-sub');
    mkdirSync(newSub);
    await delay(120);

    ok('新建子目录后挂载了新的 watcher', wm.watchers.length > initialWatchers,
      `初始 ${initialWatchers} -> 现 ${wm.watchers.length}`);

    // 在新子目录中写入文件
    const prevScans = scans;
    writeFileSync(join(newSub, 'session.jsonl'), '{"type":"message"}\n');
    await delay(120);
    ok('新子目录内文件写入触发了扫描', scans > prevScans, `扫描对比: ${prevScans} -> ${scans}`);

    wm.stop();
  }

  /* ---------- 4. 事件风暴、重命名、删除与防抖 ---------- */
  console.log('\n[4] 事件风暴、重命名、删除与防抖');
  {
    const stormDir = join(baseTmp, 'case4-storm');
    mkdirSync(stormDir, { recursive: true });

    let scans = 0;
    const wm = new WatchManager({
      sources: [{ tool: 'storm', kind: 'jsonl', roots: [stormDir] }],
      debounceMs: 100,
      pollIntervalMs: 0,
      onChanged: async () => { scans++; },
    });

    wm.start();

    // 触发事件风暴：连续快速执行 30 次文件写操作
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(stormDir, `file_${i}.jsonl`), `data ${i}\n`);
    }

    await delay(250);
    ok('30 次突发事件经防抖后仅触发有限次扫描（1~2 次）', scans >= 1 && scans <= 2,
      `实际扫描次数: ${scans}`);

    // 重命名与删除文件操作
    const beforeOps = scans;
    renameSync(join(stormDir, 'file_0.jsonl'), join(stormDir, 'file_renamed.jsonl'));
    rmSync(join(stormDir, 'file_1.jsonl'));
    await delay(200);
    ok('重命名与删除触发受控防抖扫描', scans > beforeOps && scans <= beforeOps + 2,
      `操作前后扫描: ${beforeOps} -> ${scans}`);

    // 模拟 watcher 接收 error 事件（如 Windows 目录句柄被异常重置）
    let errorHandled = false;
    const watcher = wm._watchers.values().next().value;
    if (watcher) {
      wm.log = (msg) => { if (msg.includes('watcher error')) errorHandled = true; };
      watcher.emit('error', new Error('EPERM: operation not permitted'));
      ok('watcher 抛出 error 被安全捕获未导致未捕获异常退出', errorHandled);
    }

    wm.stop();
  }

  /* ---------- 5. 生命周期与幂等性验证 ---------- */
  console.log('\n[5] 生命周期与幂等性');
  {
    const lifeDir = join(baseTmp, 'case5-lifecycle');
    mkdirSync(lifeDir, { recursive: true });

    const wm = new WatchManager({
      sources: [{ tool: 'life', kind: 'jsonl', roots: [lifeDir] }],
      pollIntervalMs: 500,
      debounceMs: 50,
      onChanged: async () => {},
    });

    // 多次 start 幂等
    wm.start();
    const count1 = wm.watchers.length;
    wm.start();
    const count2 = wm.watchers.length;
    ok('重复调用 start() 幂等', count1 === count2 && count1 > 0, `${count1} vs ${count2}`);

    // 多次 stop 幂等且清理句柄
    wm.stop();
    ok('stop() 后 watcher 被全部清空', wm.watchers.length === 0);
    ok('stop() 后 timers 被重置', wm._debounceTimer === null && wm._intervalTimer === null);

    wm.stop();
    ok('重复调用 stop() 不报错且状态保持已停止', wm.watchers.length === 0 && !wm.running);
  }

  /* ---------- 6. Scanner 与 WatchManager 真实数据扫描协同 ---------- */
  console.log('\n[6] Scanner 与 WatchManager 真实扫描协同');
  {
    const scanDir = join(baseTmp, 'case6-scanner', '项目 A');
    mkdirSync(scanDir, { recursive: true });
    const dbPath = join(baseTmp, 'case6-scanner', 'scanner.db');
    const store = new Store(dbPath);

    // 自定义测试源配置
    const customSources = [
      {
        tool: 'claude-code',
        kind: 'jsonl',
        roots: [scanDir],
        version: 1,
        collect: async (st, { path }) => {
          st.insertEvent({
            ts: Date.now(),
            tool: 'claude-code',
            model: 'opus',
            session_id: 'sess1',
            project: 'projA',
            input_tokens: 10,
            cached_input: 0,
            cache_write: 0,
            output_tokens: 5,
            reasoning_tokens: 0,
            total_tokens: 15,
            dedup_key: `test:${path}`,
          });
          return { inserted: 1, newOffset: 100, state: {} };
        },
      },
    ];

    const scanner = new Scanner(store, {
      sources: customSources,
      watchOptions: {
        debounceMs: 50,
        pollIntervalMs: 0,
      },
    });

    scanner.startWatching();
    ok('Scanner 成功创建并启动 watchManager', !!scanner.watchManager && scanner.watchManager.running);

    let updated = false;
    scanner.once('update', () => { updated = true; });

    // 写入文件
    writeFileSync(join(scanDir, 's1.jsonl'), 'dummy content\n');
    await delay(200);

    ok('文件写入触发 Scanner scanAll 并发射 update 事件', updated);
    const evCount = store.countEvents();
    ok('事件正确入库', evCount.n === 1 && evCount.total === 15, JSON.stringify(evCount));

    scanner.stop();
    ok('scanner.stop() 关闭了底层的 watchManager', scanner.watchManager === null);
    store.close();
  }
} finally {
  try {
    rmSync(baseTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 忽略清理临时目录时的短暂锁
  }
}

if (failed) {
  console.error(`\nwatch.test FAILED ${failed}`);
  process.exit(1);
}
console.log('\nwatch.test OK  node', process.version);
