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
 *  7. #96 第 8 条：watcher 抛错后按指数退避重新挂上、重挂的那只真的在接活、
 *     重挂本身失败时继续排下一轮并按 rearmMaxMs 封顶；stop() 取消在途重挂
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

  /* ---------- 7. #96 第 8 条：watcher 抛错后要重新挂上，且重挂的那只真的在接活 ---------- */
  console.log('\n[7] #96 watcher 抛错后的退避重挂');
  {
    const dir = join(baseTmp, 'case7-rearm', '项目 B');
    mkdirSync(dir, { recursive: true });

    // 注入假 watcher：错误与文件事件都由测试触发，不赌真实 fs 事件时序。
    let made = 0;      // 成功构造出来的 watcher 只数
    let attempts = 0;  // watchImpl 被调用的次数（含失败）
    let failNext = false;
    class FakeWatcher {
      constructor(watchDir, opts, cb) {
        this.dir = watchDir; this.opts = opts; this.cb = cb;
        this.id = ++made; this.closed = false; this.onError = null;
      }
      on(ev, fn) { if (ev === 'error') this.onError = fn; }
      fire(evType, filename) { this.cb(evType, filename); }
      boom(err) { this.onError(err); }
      close() { this.closed = true; }
    }
    const watchImpl = (watchDir, opts, cb) => {
      attempts++;
      if (failNext) throw new Error('EBUSY: resource busy or locked, watch');
      return new FakeWatcher(watchDir, opts, cb);
    };

    let scans = 0;
    const wm = new WatchManager({
      sources: [{ tool: 'fake', kind: 'jsonl', roots: [dir] }],
      watchImpl,
      debounceMs: 20,
      pollIntervalMs: 0,   // 关掉兜底轮询：此时"有没有实时监听"就是全部差别
      rearmMs: 30,
      rearmMaxMs: 120,
      onChanged: async () => { scans++; },
      log: () => {},
    });

    wm.start();
    ok('start() 恰好挂上 1 个 watcher', wm.watchers.length === 1, String(wm.watchers.length));
    ok('watchedDirs 精确暴露被监听的目录', wm.watchedDirs.length === 1 && wm.watchedDirs[0] === dir,
      JSON.stringify(wm.watchedDirs));
    const first = wm.watchers[0];
    first.fire('change', 'a.jsonl');
    await delay(80);
    ok('重挂前：原 watcher 的事件正常触发扫描', scans === 1, `实际 ${scans} 次`);

    first.boom(new Error('ENOSPC: no space left on device, watch'));
    ok('抛错瞬间 watcher 计数归零（不留下半死的句柄）', wm.watchers.length === 0);
    ok('抛错的原 watcher 被 close', first.closed === true);
    ok('抛错后排上了重挂（修前到此为止，只剩静默降级）', wm.rearmingDirs.length === 1,
      JSON.stringify(wm.rearmingDirs));

    await delay(150);
    ok('到点后重新挂上同一个目录', wm.watchers.length === 1 && wm.watchedDirs[0] === dir,
      JSON.stringify(wm.watchedDirs));
    const second = wm.watchers[0];
    ok('重挂上是新 watcher 而不是那只已关闭的',
      !!second && second !== first && second.closed === false, JSON.stringify({ id: second?.id }));

    ok('重挂完成后待重挂队列清空', wm.rearmingDirs.length === 0);

    const beforeRearm = scans;
    second?.fire('change', 'b.jsonl');
    await delay(80);
    ok('重挂后的 watcher 真的在接活（不是只计数好看）', scans === beforeRearm + 1,
      `${beforeRearm} -> ${scans}`);

    // 退避封顶：重挂本身一直失败时，既不放弃也不忙等
    const attemptsBefore = attempts;
    failNext = true;
    second?.boom(new Error('EPERM: operation not permitted, watch'));
    await delay(400);
    ok('重挂失败后仍继续排下一轮（不能一次失败就永远降级）', attempts - attemptsBefore >= 4,
      `失败期间又试了 ${attempts - attemptsBefore} 次`);
    ok('退避按 rearmMaxMs 封顶，不是无限放大',
      (wm._backoff.get(dir) ?? 0) <= wm.rearmMaxMs && (wm._backoff.get(dir) ?? 0) > wm.rearmMs,
      `backoff=${wm._backoff.get(dir)} max=${wm.rearmMaxMs}`);
    ok('失败期间既不虚报在监听也不漏掉待重挂',
      wm.watchers.length === 0 && wm.rearmingDirs.length === 1,
      JSON.stringify([wm.watchers.length, wm.rearmingDirs]));

    // 成功挂上之后退避档位归零：一次故障不该让后续重挂永远停在封顶值
    failNext = false;
    await delay(200);
    ok('故障恢复后终于挂上', wm.watchers.length === 1);
    ok('挂上后退避档位归零', (wm._backoff.get(dir) ?? 0) === 0, String(wm._backoff.get(dir)));
    const third = wm.watchers[0];
    const beforeHeal = scans;
    third?.fire('change', 'c.jsonl');
    await delay(80);
    ok('恢复后的 watcher 同样在接活', scans === beforeHeal + 1, `${beforeHeal} -> ${scans}`);

    // stop() 必须连带取消在途重挂，否则就是事件循环句柄泄漏
    third?.boom(new Error('EBUSY again'));
    ok('再次抛错后又排上重挂', wm.rearmingDirs.length === 1);
    const attemptsAtStop = attempts;
    wm.stop();
    ok('stop() 清空 watcher 与在途重挂', wm.watchers.length === 0 && wm.rearmingDirs.length === 0);
    await delay(200);
    ok('stop() 之后不再有重挂动作（无句柄泄漏）', attempts === attemptsAtStop,
      `stop 时 ${attemptsAtStop} -> 现 ${attempts}`);
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
