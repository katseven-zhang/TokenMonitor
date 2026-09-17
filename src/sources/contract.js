import { homedir as osHomedir } from 'node:os';

export const SOURCE_KINDS = new Set(['jsonl', 'sqlite', 'zst']);

/**
 * roots(context) 的标准上下文。禁止在 manifest 里写死盘符或用户名。
 */
export function defaultContext(overrides = {}) {
  const env = overrides.env || process.env;
  const homedir = overrides.homedir || osHomedir();
  return {
    homedir,
    env,
    localAppData: env.LOCALAPPDATA,
    appData: env.APPDATA,
    xdgDataHome: env.XDG_DATA_HOME,
    caseInsensitive: overrides.caseInsensitive ?? (process.platform === 'win32'),
  };
}

/** Windows 上按大小写不敏感去重；保留第一次出现的原始大小写。 */
export function dedupeRoots(paths, { caseInsensitive = process.platform === 'win32' } = {}) {
  const seen = new Set();
  const out = [];
  for (const p of paths || []) {
    if (p == null || p === '') continue;
    const s = String(p);
    const key = caseInsensitive ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function validateManifest(raw, { file = '' } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `invalid manifest (not an object)${file ? `: ${file}` : ''}` };
  }
  if (typeof raw.tool !== 'string' || !raw.tool.trim()) {
    return { ok: false, error: `missing tool${file ? ` in ${file}` : ''}` };
  }
  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    return { ok: false, error: `missing label for ${raw.tool}` };
  }
  if (!SOURCE_KINDS.has(raw.kind)) {
    return { ok: false, error: `illegal kind '${raw.kind}' for ${raw.tool}` };
  }
  if (!Number.isFinite(raw.version)) {
    return { ok: false, error: `missing version for ${raw.tool}` };
  }
  if (typeof raw.roots !== 'function') {
    return { ok: false, error: `roots(context) missing for ${raw.tool}` };
  }
  if (typeof raw.collector !== 'string' && typeof raw.collector !== 'function') {
    return { ok: false, error: `missing collector for ${raw.tool}` };
  }
  if (typeof raw.collector === 'string' && !raw.collector.trim()) {
    return { ok: false, error: `missing collector for ${raw.tool}` };
  }
  return { ok: true };
}
