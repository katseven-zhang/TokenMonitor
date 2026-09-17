import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultContext, dedupeRoots, validateManifest } from './sources/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCES_DIR = join(HERE, 'sources');
const DEFAULT_COLLECTORS_DIR = join(HERE, 'collectors');

function pickCollectorExport(mod, collectorId) {
  if (typeof mod.collect === 'function') return mod.collect;
  const named = Object.values(mod).filter((v) => typeof v === 'function' && /^collect/i.test(v.name || ''));
  if (named.length === 1) return named[0];
  if (typeof collectorId === 'string') {
    const guess = Object.values(mod).filter((v) => typeof v === 'function'
      && v.name.toLowerCase().includes(collectorId.replace(/[^a-z0-9]/gi, '').toLowerCase()));
    if (guess.length === 1) return guess[0];
  }
  return null;
}

async function resolveCollector(collector, collectorsDir) {
  if (typeof collector === 'function') return { fn: collector };
  const file = join(collectorsDir, `${collector}.js`);
  if (!existsSync(file)) return { error: `collector module missing: ${collector}` };
  try {
    const mod = await import(pathToFileURL(file).href);
    const fn = pickCollectorExport(mod, collector);
    if (!fn) return { error: `collector export missing: ${collector}` };
    return { fn };
  } catch (err) {
    return { error: `collector load failed: ${collector}: ${err.message}` };
  }
}

/**
 * 加载 src/sources/*.js（跳过 contract.js）。非法 manifest 记入 errors，不抛、不让进程崩溃。
 */
export async function loadSources({
  sourcesDir = DEFAULT_SOURCES_DIR,
  collectorsDir = DEFAULT_COLLECTORS_DIR,
  context,
} = {}) {
  const ctx = defaultContext(context || {});
  const errors = [];
  const sources = [];
  const seenTools = new Map();
  let files = [];
  try {
    files = readdirSync(sourcesDir).filter((n) => n.endsWith('.js') && n !== 'contract.js').sort();
  } catch (err) {
    return { sources, errors: [{ tool: null, error: `sources dir unreadable: ${err.message}` }] };
  }

  for (const name of files) {
    const file = join(sourcesDir, name);
    let raw;
    try {
      const mod = await import(pathToFileURL(file).href);
      raw = mod.default;
    } catch (err) {
      errors.push({ tool: null, file: name, error: `manifest threw: ${err.message}` });
      continue;
    }
    const v = validateManifest(raw, { file: name });
    if (!v.ok) {
      errors.push({ tool: raw?.tool ?? null, file: name, error: v.error });
      continue;
    }
    if (seenTools.has(raw.tool)) {
      errors.push({ tool: raw.tool, file: name, error: `duplicate tool '${raw.tool}' (already ${seenTools.get(raw.tool)})` });
      continue;
    }
    let rootList;
    try {
      rootList = dedupeRoots(raw.roots(ctx), { caseInsensitive: ctx.caseInsensitive });
    } catch (err) {
      errors.push({ tool: raw.tool, file: name, error: `roots() threw: ${err.message}` });
      continue;
    }
    const resolved = await resolveCollector(raw.collector, collectorsDir);
    if (resolved.error) {
      errors.push({ tool: raw.tool, file: name, error: resolved.error });
      continue;
    }
    seenTools.set(raw.tool, name);
    const collect = resolved.fn;
    sources.push({
      tool: raw.tool,
      label: raw.label,
      kind: raw.kind,
      version: raw.version,
      apiBilled: !!raw.apiBilled,
      collector: typeof raw.collector === 'string' ? raw.collector : (collect.name || 'fn'),
      roots: rootList,
      collect,
      order: Number.isFinite(raw.order) ? raw.order : 100,
      file: name,
    });
  }
  sources.sort((a, b) => (a.order - b.order) || a.tool.localeCompare(b.tool));
  return { sources, errors };
}

const loaded = await loadSources();
export const SOURCES = loaded.sources;
export const SOURCE_ERRORS = loaded.errors;
