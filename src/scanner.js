import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { SOURCES } from './config.js';
import { createWatchManager } from './platform/watch.js';

/** 真目录包含判定（#43）：字符串 startsWith 会把 C:\data\codex-old 误判成 C:\data\codex 的子项 */
function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function* walkByExt(root, match) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* walkByExt(p, match);
    else if (e.isFile() && match(e.name)) yield p;
  }
}

/** 按源类型枚举待解析文件，返回 [path, sessionKey]；sqlite 直接判断文件存在 */
async function* enumerate(source) {
  if (source.kind === 'sqlite') {
    for (const root of source.roots) {
      const s = await stat(root).catch(() => null);
      if (s?.isFile()) yield [root, null];
    }
    return;
  }
  if (source.kind === 'zst') {
    for (const root of source.roots) {
      for await (const p of walkByExt(root, (n) => n.endsWith('.zst') || n.endsWith('.zstd'))) {
        yield [p, basename(dirname(p))]; // session.jsonl.zstd 全同名，以父目录为会话键
      }
    }
    return;
  }
  for (const root of source.roots) {
    for await (const p of walkByExt(root, (n) => n.endsWith('.jsonl'))) yield [p, null];
  }
}

/** 当前确实存在的 roots；root 整体不可用（外置盘未挂载/目录重命名）时不清理其游标 */
async function liveRootsOf(source) {
  const out = [];
  for (const root of source.roots) {
    if (await stat(root).then(() => true).catch(() => false)) out.push(root);
  }
  return out;
}

export class Scanner extends EventEmitter {
  constructor(store, { log = () => {}, sources = SOURCES, watchOptions = {} } = {}) {
    super();
    this.store = store;
    this.log = log;
    this.sources = sources;
    this.scanning = false;
    this.stats = {}; // tool -> { files, parse_errors, last_error, last_scan_ms }
    this._watchOptions = watchOptions;
    this._watchManager = null;
    this._scanPending = false;
  }

  get _watchers() {
    return this._watchManager ? this._watchManager.watchers : [];
  }

  get watchManager() {
    return this._watchManager;
  }

  _stat(tool) {
    if (!this.stats[tool]) this.stats[tool] = { files: 0, parse_errors: 0, last_error: null, last_scan_ms: 0 };
    return this.stats[tool];
  }

  /** 全量增量扫描：游标未变的文件直接跳过。 */
  async scanAll({ quiet = false } = {}) {
    if (this.scanning) {
      this._scanPending = true;
      return { skippedConcurrent: true };
    }
    this.scanning = true;
    this._scanPending = false;
    const t0 = Date.now();
    let files = 0, inserted = 0;

    try {
    for (const src of this.sources) {
      const st = this._stat(src.tool);
      // 每轮全部重置为"本轮"语义（#43）：修前 files 从不重置（实际是累计扫描次数）、
      // last_error 从不置回（解析恢复后前端 tooltip 仍挂着几天前的错误）
      st.files = 0;
      st.parse_errors = 0;
      st.last_error = null;
      st.last_scan_ms = Date.now();
      const liveRoots = await liveRootsOf(src);
      const seen = new Set();
      for await (const [path, sessionKey] of enumerate(src)) {
        // 枚举与 stat 之间文件可能已被删除（Claude 会话清理 / Codex 归档搬移是常态）：
        // stat 抛 ENOENT 会让整轮扫描 reject，在防抖定时器里就是未处理 rejection → 进程退出
        const s = await stat(path).catch(() => null);
        if (!s) continue;
        files++;
        st.files++;
        seen.add(path);
        const fileId = sessionKey || basename(path, '.jsonl');
        const row = this.store.getFile(path);
        // 脏 state_json 容错（#43）：旧版本数据/库损坏/手改都可能产生坏 JSON。
        // 修前裸 JSON.parse 让一行坏数据 reject 整轮扫描；现在记 warning、该文件按
        // state=undefined 全量重扫（needFull 因 !prev 自动成立），其余源/文件不受影响，
        // dedup_key 保证重扫幂等。
        let prev;
        try {
          prev = row?.state_json ? JSON.parse(row.state_json) : undefined;
        } catch (err) {
          prev = undefined;
          this.log(`corrupt state_json ${path}: ${err.message}`);
        }
        // 采集器版本落后 → 全量重扫补数据（dedup 幂等，仅一次性成本）
        const needFull = !prev || prev._v !== src.version;
        // mtime 跳过仅用于文件型源（sqlite 的 WAL 写入不改变主文件 mtime），且须版本一致
        const unchanged = row && row.size === s.size && row.mtime_ms === s.mtimeMs;
        if (src.kind !== 'sqlite' && unchanged && !needFull) continue;
        const state = needFull ? undefined : prev;
        const cursor = row?.offset ?? 0;
        const offset = src.kind === 'jsonl'
          ? (needFull || s.size < cursor ? 0 : cursor)
          : 0;

        this.store.db.exec('BEGIN');
        try {
          if (typeof src.collect !== 'function') {
            throw new Error(`source ${src.tool} has no collector`);
          }
          const r = await src.collect(this.store, {
            tool: src.tool, path, fileId, offset, state, version: src.version,
          });
          inserted += r.inserted;
          const nextState = { ...(r.state || {}), _v: src.version };
          this.store.saveFile({
            path, tool: src.tool, session_id: fileId, size: s.size,
            mtime_ms: s.mtimeMs,
            offset: src.kind === 'jsonl' ? r.newOffset : 0,
            state_json: JSON.stringify(nextState),
          });
          this.store.db.exec('COMMIT');
        } catch (err) {
          this.store.db.exec('ROLLBACK');
          st.parse_errors++;
          st.last_error = `${new Date().toISOString()} ${err.message}`;
          this.log(`parse error ${path}: ${err.message}`);
        }
      }
      this._pruneMissingFiles(src.tool, seen, liveRoots);
    }
    } finally {
      // 必须无条件复位：留在 true 会让之后每一轮扫描都被"并发中"挡掉，面板从此停更
      this.scanning = false;
      if (this._scanPending) {
        this._scanPending = false;
        queueMicrotask(() => this.scanAll({ quiet: true }).catch(() => {}));
      }
    }
    this._inheritCodexModels();
    if (!quiet) {
      this.log(`scan: ${files} files, +${inserted} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (inserted > 0) this.emit('update');
    return { files, inserted };
  }

  /**
   * 清理已消失文件的游标行（真实库两天就攒下 40 条，且会让健康自检的文件数长期虚高）。
   * 只清"所属 root 当前存在"的路径；只删 files 行，绝不动 events——历史用量必须保留。
   * 文件若日后回来，dedup 保证重新解析是幂等的。
   */
  _pruneMissingFiles(tool, seen, liveRoots) {
    if (!liveRoots.length) return 0;
    const db = this.store.db;
    const rows = db.prepare('SELECT path FROM files WHERE tool = ?').all(tool);
    const gone = rows.filter(r => !seen.has(r.path) && liveRoots.some(root => isInside(root, r.path)));
    if (!gone.length) return 0;
    const del = db.prepare('DELETE FROM files WHERE path = ?');
    db.exec('BEGIN');
    try {
      for (const g of gone) del.run(g.path);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      this.log(`prune ${tool}: ${err.message}`);
      return 0;
    }
    return gone.length;
  }

  /**
   * Codex 模型补全（两步）：
   * 1. resume 链继承：续写文件自身无模型记录，按 parent_thread_id 继承父的最终模型；
   * 2. 事件回填：dedup 只防重插不更新旧行——state.model 已知但事件为 null 的，UPDATE 补写。
   */
  _inheritCodexModels() {
    const db = this.store.db;
    const rows = db.prepare("SELECT * FROM files WHERE tool = 'codex'").all();
    // files.session_id 是完整 stem（rollout-时间-<uuid>），parent_thread_id 是裸 uuid → 按尾部 36 位匹配
    const uuidOf = (sid) => (sid || '').slice(-36);
    const byUuid = new Map(rows.map(r => [uuidOf(r.session_id), r]));
    const updState = db.prepare(
      "UPDATE events SET model = ? WHERE tool = 'codex' AND session_id = ? AND model IS NULL");
    const states = new Map();
    for (const r of rows) {
      try { states.set(r.session_id, r.state_json ? JSON.parse(r.state_json) : null); } catch { states.set(r.session_id, null); }
    }
    let changed = true, passes = 0;
    while (changed && passes++ < 6) {
      changed = false;
      for (const [sid, st] of states) {
        if (!st || st.model || !st.parent) continue;
        const pst = states.get(byUuid.get(st.parent)?.session_id ?? '') ?? null;
        if (!pst?.model) continue;
        st.model = pst.model;
        changed = true;
      }
    }
    // 统一回填事件 + 持久化 state
    for (const r of rows) {
      const st = states.get(r.session_id);
      if (!st) continue;
      if (st.model) updState.run(st.model, r.session_id);
      this.store.saveFile({ ...r, state_json: JSON.stringify(st) });
    }
  }

  /** Windows 兼容监听 + 优雅降级 + 防抖 + 周期兜底扫描 */
  startWatching(options = {}) {
    if (this._watchManager) return; // 幂等保护
    this._watchManager = createWatchManager({
      sources: this.sources,
      onChanged: () => this.scanAll({ quiet: true }).catch(err => this.log(`scan failed: ${err?.message ?? err}`)),
      log: this.log,
      ...this._watchOptions,
      ...options,
    });
    this._watchManager.start();
  }

  _scheduleScan() {
    if (this._watchManager) {
      this._watchManager._scheduleScan('manual');
    }
  }

  stop() {
    if (this._watchManager) {
      this._watchManager.stop();
      this._watchManager = null;
    }
  }
}
