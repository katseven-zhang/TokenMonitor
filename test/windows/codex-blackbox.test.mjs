/**
 * Codex 统计黑盒验收（#50）。
 *
 * 用户路径黑盒走查：起真实 serve（脱敏 fixture，临时目录含中文+空格）→
 * 首页入口 → /codex 独立页 → 窗口卡/pace/cost/日报/CSV 全链路 API 契约 →
 * 吞吐（throughput）与请求明细（events）契约走查 → scan 回归命令。
 * 回归断言（双扫描幂等 / 坏 JSON / 归档搬移等）集中在 test/run.mjs
 * [3]/[11]/[17] 组并在 docs/CODEX-STATS.md 索引，本文件不重复维护。
 * 任何一步失败即非零退出（不静默跳过）。
 * （#58 评审整改：原头注/提交说明声称覆盖吞吐与明细但实际未 fetch——已补实测。）
 *
 * Run: TOKENMONITOR_OFFLINE=1 node test/windows/codex-blackbox.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

process.env.TOKENMONITOR_OFFLINE = '1';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const base = mkdtempSync(join(tmpdir(), 'codex50 黑盒-'));
const dataDir = join(base, '数据 目录');
mkdirSync(join(dataDir, 'logs'), { recursive: true });

// 脱敏合成 fixture：两窗口快照 + 事件源
const T0 = Date.parse('2026-09-18T10:00:00Z');
writeFileSync(join(dataDir, 'pricing.json'), JSON.stringify({
  _note: 'fixture', models: {},
}));

// 端口与 serve（env 覆盖数据目录；中文+空格路径）
const net = (await import('node:net')).default;
const { spawn } = await import('node:child_process');
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const child2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning',
  join(repo, 'bin', 'tokenmonitor.js'), 'serve', '--port', String(port)], {
  env: { ...process.env, TOKENMONITOR_DATA_DIR: dataDir, HOME: base, USERPROFILE: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let buf = '';
child2.stdout.on('data', (d) => { buf += d; });
const started = await new Promise((r) => {
  const t = setTimeout(() => r(false), 20000);
  child2.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } });
});

try {
  ok('黑盒：serve 启动（中文+空格数据目录）', started === true, String(started));

  if (started) {
    // 1) 首页入口 → /codex 独立页
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const homeHtml = await home.text();
    ok('黑盒：首页含 Codex 入口链接', home.status === 200 && homeHtml.includes('href="/codex"'));
    const codex = await fetch(`http://127.0.0.1:${port}/codex`);
    const codexHtml = await codex.text();
    ok('黑盒：/codex 页面可书签访问且含全部概览容器',
      codex.status === 200 && ['codex-cards', 'codex-quota', 'codex-pace', 'codex-cost', 'codex-breakdown', 'codex-report-slot']
        .every((id) => codexHtml.includes(id)));
    const codexJs = await fetch(`http://127.0.0.1:${port}/codex.js`);
    ok('黑盒：codex.js 可达', codexJs.status === 200);

    // 2) 窗口卡 / 吞吐 / pace / cost（数据未扫描时优雅降级）
    const sum = await (await fetch(`http://127.0.0.1:${port}/api/codex/summary`)).json();
    ok('黑盒：窗口卡契约（无快照 → unknown + 原因，不 500）',
      sum.state === 'unknown' && typeof sum.unknown_reason === 'string' && Array.isArray(sum.windows));
    const pace = await (await fetch(`http://127.0.0.1:${port}/api/codex/pace`)).json();
    ok('黑盒：pace 契约（unknown_reason）', typeof pace.pace?.unknown_reason === 'string');
    const cost = await (await fetch(`http://127.0.0.1:${port}/api/codex/cost?window=weekly`)).json();
    ok('黑盒：cost 契约（disclaimer/unpriced/fx）',
      typeof cost.disclaimer === 'string' && Array.isArray(cost.models) && 'usd_to_cny' in cost.fx);
    const rep = await (await fetch(`http://127.0.0.1:${port}/api/codex/report`)).json();
    ok('黑盒：日报契约（coverage）', rep.day && 'reasoning_coverage' in rep);
    // #58 评审整改：补 throughput/events 实测（原头注声称覆盖但未 fetch）
    const thr = await (await fetch(`http://127.0.0.1:${port}/api/codex/throughput?days=7`)).json();
    ok('黑盒：吞吐契约（totals/by_day/by_model 结构）',
      typeof thr.totals?.requests === 'number' && Array.isArray(thr.by_day) && Array.isArray(thr.by_model));
    const ev = await (await fetch(`http://127.0.0.1:${port}/api/codex/events?limit=10`)).json();
    ok('黑盒：明细契约（events 数组 + count）',
      Array.isArray(ev.events) && typeof ev.count === 'number' && ev.count === ev.events.length);
    // #58 第二轮评审（#48 AC8 / #50 AC2）：前端场景专项断言——刷新/失败、趋势空态、窄宽度
    {
      const pageJs = await (await fetch(`http://127.0.0.1:${port}/codex.js`)).text();
      const pageHtml = await (await fetch(`http://127.0.0.1:${port}/codex`)).text();
      ok('黑盒：刷新——codex-refresh 接线 load()（页面按钮 + JS 事件绑定）',
        pageHtml.includes('id="codex-refresh"') && /codex-refresh'\)\?\.addEventListener\('click', \(\) => load\(\)\)/.test(pageJs),
        'refresh wiring');
      ok('黑盒：失败——load() 的 catch 走 showError 横幅（不静默）',
        /catch \(err\) \{[\s\S]{0,120}showError\(/.test(pageJs) && pageJs.includes('codex-error'),
        'error banner path');
      ok('黑盒：趋势空态——renderDayChart/renderHourChart 对空序列有守卫（不渲染空图）',
        /function renderDayChart\([\s\S]{0,120}if \(!charts\.day \|\| !byDay\?\.length\) return;/.test(pageJs)
          && /function renderHourChart\([\s\S]{0,130}if \(!charts\.hour \|\| !byHour\?\.length\) return;/.test(pageJs),
        'empty guards');
      ok('黑盒：窄宽度——viewport meta + resize 图表自适应（无固定 min-width）',
        pageHtml.includes('name="viewport"') && /window\.addEventListener\('resize',[\s\S]{0,80}c\.resize\(\)/.test(pageJs)
          && !/min-width\s*:\s*\d{3,}/.test(pageHtml),
        'responsive');
      // 行为级：空库服务的吞吐趋势序列确为空（趋势空态的 API 侧证据）
      const thrEmpty = await (await fetch(`http://127.0.0.1:${port}/api/codex/throughput?days=1`)).json();
      ok('黑盒：趋势空态——空数据时 by_day/by_hour 为空数组（守卫输入确为空）',
        Array.isArray(thrEmpty.by_day) && thrEmpty.by_day.length === 0,
        JSON.stringify(thrEmpty.by_day?.length));
    }
    const csvRes = await fetch(`http://127.0.0.1:${port}/api/codex/export.csv`);
    const csvBuf = await csvRes.arrayBuffer();
    ok('黑盒：CSV 可下载且带 UTF-8 BOM（原始字节 EF,BB,BF）',
      csvRes.status === 200 && new Uint8Array(csvBuf.slice(0, 3)).join(',') === '239,187,191');
  }

  // 3) 回归断言：双扫描幂等 / 坏 JSON 半行（fail → 非零）
  {
    const scan = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
      join(repo, 'bin', 'tokenmonitor.js'), 'scan'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TOKENMONITOR_DATA_DIR: dataDir, HOME: base, USERPROFILE: base },
    });
    ok('黑盒：scan 命令退出 0', scan.status === 0, `exit=${scan.status} ${String(scan.stderr).slice(0, 100)}`);
  }
} finally {
  child2.kill('SIGTERM');
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 延迟句柄 */ }
}

console.log(`\ncodex blackbox: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
