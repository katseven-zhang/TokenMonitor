import { watch as defaultWatch, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Windows 文件监听与生命周期管理器 (Win-Watch)：
 * - 针对 Windows 上 recursive: true 不可靠、报错或抛出的场景，自动降级为非递归/目录级监听 + 周期性兜底扫描。
 * - SQLite 来源监听主库所在父目录，感知 -wal / -shm 临时文件的变更。
 * - JSONL / 多层目录源：在降级模式下监听子目录并在新建子目录时动态挂载监听。
 * - 对文件重命名、删除、ENOENT、短暂锁和高频事件风暴进行防抖，确保只触发受控的有限次扫描。
 * - 保证 start() 与 stop() 幂等，stop() 彻底关闭所有 watcher 与 timer，不泄漏事件循环句柄。
 */
export class WatchManager {
  constructor({
    sources = [],
    onChanged = async () => {},
    debounceMs = 800,
    pollIntervalMs = 60_000,
    watchImpl = defaultWatch,
    log = () => {},
  } = {}) {
    this.sources = sources;
    this.onChanged = onChanged;
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
    this.watchImpl = watchImpl;
    this.log = log;

    this._watchers = new Map(); // dirPath -> FSWatcher
    this._debounceTimer = null;
    this._intervalTimer = null;
    this._running = false;
    this._isFallback = false;
  }

  get watchers() {
    return [...this._watchers.values()];
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
      this._setupWatcher(dir, w);
    } catch (err) {
      // 递归监听不支持或抛错（Windows 典型场景）：自动降级为非递归目录监听
      this._isFallback = true;
      this.log(`watch recursive failed for ${dir} (${err.message}), falling back to non-recursive`);
      try {
        const w = this.watchImpl(dir, { recursive: false }, (eventType, filename) => {
          this._onFsEvent(eventType, filename, dir, kind);
        });
        this._setupWatcher(dir, w);
        // 对非 SQLite 源，遍历现有直接子目录并建立非递归监听
        if (kind !== 'sqlite') {
          this._attachSubdirectories(dir);
        }
      } catch (fallbackErr) {
        this.log(`watch non-recursive failed for ${dir}: ${fallbackErr.message}`);
      }
    }
  }

  _setupWatcher(dir, w) {
    if (!w) return;
    this._watchers.set(dir, w);
    if (typeof w.on === 'function') {
      w.on('error', (err) => {
        this.log(`watcher error on ${dir}: ${err?.message ?? err}`);
        this._closeWatcher(dir);
      });
    }
  }

  _closeWatcher(dir) {
    const w = this._watchers.get(dir);
    if (w) {
      try { w.close(); } catch { /* ignore */ }
      this._watchers.delete(dir);
    }
  }

  _attachSubdirectories(parentDir) {
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const sub = join(parentDir, e.name);
          if (!this._watchers.has(sub) && existsSync(sub)) {
            try {
              const w = this.watchImpl(sub, { recursive: false }, (eventType, filename) => {
                this._onFsEvent(eventType, filename, sub);
              });
              this._setupWatcher(sub, w);
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
  }
}

export function createWatchManager(options) {
  return new WatchManager(options);
}
