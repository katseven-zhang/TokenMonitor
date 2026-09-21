import { watch as defaultWatch, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Windows 文件监听与生命周期管理器 (Win-Watch)：
 * - 针对 Windows 上 recursive: true 不可靠、报错或抛出的场景，自动降级为非递归/目录级监听 + 周期性兜底扫描。
 * - SQLite 来源监听主库所在父目录，感知 -wal / -shm 临时文件的变更。
 * - JSONL / 多层目录源：在降级模式下监听子目录并在新建子目录时动态挂载监听。
 * - 对文件重命名、删除、ENOENT、短暂锁和高频事件风暴进行防抖，确保只触发受控的有限次扫描。
 * - 监听器抛错（Windows 上递归监听的典型症状）后**必须重新挂上**：只关不重挂会让该目录
 *   从此只剩 60 秒兜底轮询，实时性静默退化成"看起来一切正常，只是不再跟随写入"（#96）。
 * - 保证 start() 与 stop() 幂等，stop() 彻底关闭所有 watcher、重挂定时器与 timer，
 *   不泄漏事件循环句柄。
 */
export class WatchManager {
  constructor({
    sources = [],
    onChanged = async () => {},
    debounceMs = 800,
    pollIntervalMs = 60_000,
    rearmMs = 5_000,
    rearmMaxMs = 300_000,
    watchImpl = defaultWatch,
    log = () => {},
  } = {}) {
    this.sources = sources;
    this.onChanged = onChanged;
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
    this.rearmMs = rearmMs;
    this.rearmMaxMs = rearmMaxMs;
    this.watchImpl = watchImpl;
    this.log = log;

    this._watchers = new Map(); // dirPath -> FSWatcher
    this._rearming = new Map(); // dirPath -> 等待重挂的定时器
    this._backoff = new Map();  // dirPath -> 下一次重挂的等待毫秒（指数退避）
    this._debounceTimer = null;
    this._intervalTimer = null;
    this._running = false;
    this._isFallback = false;
  }

  get watchers() {
    return [...this._watchers.values()];
  }

  /** 已挂上监听的目录数（键即路径），测试与排障都靠它确认"真的还跟着"。 */
  get watchedDirs() {
    return [...this._watchers.keys()];
  }

  /** 正在排队等待重挂的目录；stop() 之后必须为空，否则就是句柄泄漏。 */
  get rearmingDirs() {
    return [...this._rearming.keys()];
  }

  get isFallback() {
    return this._isFallback;
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;

    for (const src of this.sources) {
      for (const root of src.roots || []) {
        // SQLite 来源：WAL/SHM 写入不改变主文件 mtime，必须监听主库所在父目录
        const watchDir = src.kind === 'sqlite' ? dirname(root) : root;
        if (!existsSync(watchDir)) continue;
        this._watchDirectory(watchDir, src.kind);
      }
    }

    if (this.pollIntervalMs > 0) {
      this._intervalTimer = setInterval(() => {
        this._scheduleScan('poll');
      }, this.pollIntervalMs);
      if (this._intervalTimer.unref) {
        this._intervalTimer.unref();
      }
    }
  }

  _watchDirectory(dir, kind) {
    if (this._watchers.has(dir)) return;

    // 首先尝试递归监听
    try {
      const w = this.watchImpl(dir, { recursive: true }, (eventType, filename) => {
        this._onFsEvent(eventType, filename, dir, kind);
      });
      this._setupWatcher(dir, w, kind);
    } catch (err) {
      // 递归监听不支持或抛错（Windows 典型场景）：自动降级为非递归目录监听
      this._isFallback = true;
      this.log(`watch recursive failed for ${dir} (${err.message}), falling back to non-recursive`);
      try {
        const w = this.watchImpl(dir, { recursive: false }, (eventType, filename) => {
          this._onFsEvent(eventType, filename, dir, kind);
        });
        this._setupWatcher(dir, w, kind);
        // 对非 SQLite 源，遍历现有直接子目录并建立非递归监听
        if (kind !== 'sqlite') {
          this._attachSubdirectories(dir, kind);
        }
      } catch (fallbackErr) {
        this.log(`watch non-recursive failed for ${dir}: ${fallbackErr.message}`);
        // 重挂本身失败时必须继续排下一轮，否则"只关不重挂"的静默降级只是往后挪了一步：
        // 一次 error → 重挂 → 目录当时正被占用/正在改名 → 重挂抛错 → 从此再没人管这个目录。
        // _rearmWatcher 里同目录只排一个在途定时器、且退避已在 _backoff 上放大并封顶，
        // 所以这里递归排轮不会变成忙等。
        if (this._running && !this._watchers.has(dir)) this._rearmWatcher(dir, kind);
      }
    }
  }

  _setupWatcher(dir, w, kind) {
    if (!w) return;
    this._watchers.set(dir, w);
    // 挂上了就把退避档位归零：一次错误不应该让后续重挂永远停在 5 分钟
    this._backoff.delete(dir);
    if (typeof w.on === 'function') {
      w.on('error', (err) => {
        this.log(`watcher error on ${dir}: ${err?.message ?? err}`);
        this._closeWatcher(dir);
        // #96：修前到这里就结束了——这个目录的实时监听从此消失，只剩 60 秒兜底轮询，
        // 面板照常出数、看不出任何异常。异步错误（Windows 上递归监听中途抛 ENOSPC /
        // 目录被重命名）因此等于永久降级，必须重新挂上。
        this._rearmWatcher(dir, kind);
      });
    }
  }

  /**
   * 延迟重挂一个目录，失败按指数退避放大间隔（rearmMs → ×2 → … → rearmMaxMs 封顶）。
   * 退避是必需的：目录本身没了的话，同步重试会变成"抛错→重挂→抛错"的死循环。
   * 封顶的是**速率**而不是次数：目录可以几小时后才回来，放弃就等于永久降级，所以轮次不设
   * 上限，但最长每 rearmMaxMs 才试一次。挂上之后 _setupWatcher 把档位归零。
   * 同一目录只排一个在途重挂；stop() 之后不再重挂。
   */
  _rearmWatcher(dir, kind) {
    if (!this._running || this._rearming.has(dir)) return;
    const wait = this._backoff.get(dir) ?? this.rearmMs;
    this._backoff.set(dir, Math.min(wait * 2, this.rearmMaxMs));
    const timer = setTimeout(() => {
      this._rearming.delete(dir);
      if (!this._running) return;
      if (this._watchers.has(dir)) return; // 别的路径已经把它挂回来了
      this.log(`re-arming watcher for ${dir}`);
      this._watchDirectory(dir, kind);
    }, wait);
    if (timer.unref) timer.unref();
    this._rearming.set(dir, timer);
  }

  _closeWatcher(dir) {
    const w = this._watchers.get(dir);
    if (w) {
      try { w.close(); } catch { /* ignore */ }
      this._watchers.delete(dir);
    }
  }

  _attachSubdirectories(parentDir, kind) {
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const sub = join(parentDir, e.name);
          if (!this._watchers.has(sub) && existsSync(sub)) {
            try {
              const w = this.watchImpl(sub, { recursive: false }, (eventType, filename) => {
                this._onFsEvent(eventType, filename, sub, kind);
              });
              this._setupWatcher(sub, w, kind);
            } catch (err) {
              this.log(`watch subdir failed for ${sub}: ${err.message}`);
            }
          }
        }
      }
    } catch {
      // 忽略目录不可读或竞态消失
    }
  }

  _onFsEvent(eventType, filename, dir, kind) {
    if (!this._running) return;

    // 在非递归降级模式下，若收到新子目录创建事件，自动为新子目录挂载监听
    if (this._isFallback && filename) {
      try {
        const full = join(dir, filename);
        if (existsSync(full)) {
          const st = statSync(full, { throwIfNoEntry: false });
          if (st?.isDirectory()) {
            this._watchDirectory(full, kind);
          }
        }
      } catch {
        // filename 可能已删除或无权限
      }
    }

    this._scheduleScan('event');
  }

  _scheduleScan(trigger = 'event') {
    if (!this._running) return;

    // 防抖：已有在途定时器时直接复用，不重复创建，规避事件风暴
    if (this._debounceTimer) return;

    this._debounceTimer = setTimeout(async () => {
      this._debounceTimer = null;
      if (!this._running) return;
      try {
        await this.onChanged();
      } catch (err) {
        this.log(`scheduled scan (${trigger}) failed: ${err?.message ?? err}`);
      }
    }, this.debounceMs);

    if (this._debounceTimer?.unref) {
      this._debounceTimer.unref();
    }
  }

  stop() {
    this._running = false;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }

    for (const [dir, w] of this._watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this._watchers.clear();
    // 在途的重挂定时器一并取消：留着就是 stop() 之后进程还被它唤一次，
    // 事件循环句柄泄漏正体现在这里
    for (const timer of this._rearming.values()) clearTimeout(timer);
    this._rearming.clear();
    this._backoff.clear();
  }
}

export function createWatchManager(options) {
  return new WatchManager(options);
}
