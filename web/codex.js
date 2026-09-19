/* Codex 独立统计页逻辑（#48）。
 * 契约边界：窗口/pace/cost 数据只消费 #46 的 /api/codex/*；
 * burn/risk/ETA 只展示 #47（经 #46 序列化）的结果，前端零算法；
 * 金额只经 #38 的共享 money.js 换算（USD 按同一次接口汇率折算）。
 * unknown/0/缺失语义：后端给 null 一律显示 — 与 unknown_reason，绝不伪装成 0。 */
import { esc, fmt, fmtShort } from './lib/format.js';
import { initMoney, formatMoney, getFx } from './lib/money.js';

const charts = {};
for (const [k, id] of [['day', 'codex-day'], ['hour', 'codex-hour']]) {
  const el = document.getElementById(id);
  if (el && window.echarts) charts[k] = window.echarts.init(el, null, { renderer: 'canvas' });
}

function showError(msg) {
  const banner = document.getElementById('codex-error');
  if (!banner) return;
  banner.textContent = msg;
  banner.hidden = false;
}

const card = (v, l) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`;

/** 倒计时：resets_at_ms 距 now 的时:分；过期/未知显示占位，不误报已耗尽 */
function countdown(resetsAtMs, now) {
  if (typeof resetsAtMs !== 'number' || !Number.isFinite(resetsAtMs)) return '—';
  const d = resetsAtMs - now;
  if (d <= 0) return '已重置';
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  return h > 0 ? `${h}时${m}分` : `${m}分`;
}

const WINDOW_LABEL = { primary: '5h 窗口（primary）', secondary: 'Weekly（secondary）', monthly: 'Monthly' };

/** 窗口卡：used/remaining/credits/reset/plan；monthly 缺失按"未提供"展示（AC 健壮性） */
function renderQuota(summary) {
  const host = document.getElementById('codex-quota');
  if (!host) return;
  if (summary.state === 'unknown') {
    host.innerHTML = `<div class="quota-card"><div class="quota-head"><span class="q-title">配额窗口</span></div>
      <div class="recon dim">暂无配额快照：${esc(summary.unknown_reason || 'unknown')}。启动 Codex 并产生用量后这里会出现 5h / Weekly / Monthly 窗口。</div></div>`;
    return;
  }
  const now = Date.now();
  const rows = (summary.windows || []).map((w) => {
    const pct = typeof w.used_percent === 'number' ? `${w.used_percent.toFixed(1)}%` : '—';
    const remaining = w.remaining ?? (typeof w.used_percent === 'number' ? `已用 ${pct}` : null);
    return `<div class="quota-card">
      <div class="quota-head"><span class="q-title">${esc(WINDOW_LABEL[w.kind] || w.kind || '窗口')}</span>
        <span class="q-reset">${esc(summary.plan_type || '')}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span style="font-size:20px;font-weight:650">${pct}</span>
        <span class="dim">剩余 ${remaining != null ? esc(String(remaining)) : '—'} · 重置 ${countdown(w.resets_at_ms, now)}</span>
      </div>
      ${w.credits != null ? `<div class="recon dim">credits ${esc(String(w.credits))}</div>` : ''}
      ${w.capacity != null ? `<div class="recon dim">容量 ${fmt(w.capacity)}</div>` : ''}
    </div>`;
  }).join('');
  // monthly 未提供的显式提示（AC：monthly 缺失正确处理、布局不跳动）
  const kinds = new Set((summary.windows || []).map((w) => w.kind));
  const monthlyNote = kinds.has('monthly') ? '' : `<div class="quota-card"><div class="quota-head"><span class="q-title">Monthly</span></div>
    <div class="recon dim">该来源暂未提供 monthly 窗口数据（null，不是 0）。</div></div>`;
  host.innerHTML = rows + monthlyNote;
}

/** pace 卡：只展示 #47 结果（unknown 显原因）；绝不前端重算 */
function renderPace(pace) {
  const host = document.getElementById('codex-pace');
  if (!host) return;
  if (pace.state === 'unknown') {
    const facts = [
      `已用 ${pace.used ?? '—'} / 容量 ${pace.capacity ?? '—'}`,
      pace.burn_rate_per_hour != null ? `burn ${fmtShort(pace.burn_rate_per_hour)} tok/h` : null,
      pace.reset_relief === true ? '即将重置，风险缓解' : null,
    ].filter(Boolean).join(' · ');
    host.innerHTML = `<div class="recon dim">暂无法推断节奏（${esc(pace.unknown_reason || 'unknown')}）。${esc(facts)}</div>`;
    return;
  }
  const eta = pace.eta_to_exhaust_ms != null ? `${(pace.eta_to_exhaust_ms / 3_600_000).toFixed(1)} 小时` : '—';
  const safe = pace.safe_usage_line != null ? fmt(pace.safe_usage_line) : '—';
  host.innerHTML = `
    <div class="quota-card"><div class="quota-head"><span class="q-title">burn / risk / ETA</span>
      <span class="q-reset">samples ${pace.samples_used ?? '—'}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span style="font-size:18px;font-weight:650">${fmtShort(pace.burn_rate_per_hour ?? 0)} tok/h</span>
        <span class="dim">风险 <b>${esc(pace.risk || '—')}</b>${pace.reset_relief === true ? ' · 即将重置缓解' : ''}</span>
      </div>
      <div class="recon dim">外推耗尽 ETA：${eta} · 安全线（窗口内 80% 预算）：${safe}</div>
      <div class="recon dim">已用 ${pace.used_percent != null ? pace.used_percent.toFixed(1) + '%' : '—'} · 剩余 ${pace.remaining ?? '—'}</div>
    </div>`;
}

/** weekly API 等值金额卡：金额只经 #38 money.js；免责声明显著（AC5） */
function renderCost(cost) {
  const host = document.getElementById('codex-cost');
  if (!host) return;
  const fx = getFx();
  const rows = (cost.models || []).slice(0, 8).map((m) => `<tr>
    <td>${esc(m.model)}</td><td>${fmt(m.total)}</td>
    <td>${m.priced ? formatMoney(m.cost_cny) : '<span class="dim">未配价</span>'}</td></tr>`).join('');
  host.innerHTML = `
    <div class="quota-card"><div class="quota-head"><span class="q-title">Weekly API-equivalent cost</span>
      <span class="q-reset" title="${fx.fx_ts ? '汇率时间 ' + esc(new Date(fx.fx_ts).toLocaleString('zh-CN')) : ''}">USD×${esc(fx.usd_to_cny ?? '—')}${fx.fx_source === 'manual' ? '' : ' · 同接口汇率'}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span style="font-size:20px;font-weight:650">${formatMoney(cost.total_cny ?? null)}</span>
        <span class="dim">7 天窗口</span>
      </div>
      ${rows ? `<table class="rates-table"><thead><tr><th>模型</th><th>Tokens</th><th>金额</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      ${(cost.unpriced_models || []).length ? `<div class="recon dim">⚠ ${cost.unpriced_models.length} 个未配价模型未计入金额</div>` : ''}
      ${cost.extrapolation?.state === 'ok'
        ? `<div class="recon dim">完整周额度外推估算：${formatMoney(cost.extrapolation.full_window_cny)}（按已用比例线性放大）</div>`
        : `<div class="recon dim">完整周额度外推不可用（${esc(cost.extrapolation?.unknown_reason || 'unknown')}）</div>`}
      <div class="recon dim" style="margin-top:4px">⚠ API 等值估算，不是订阅真实账单。</div>
    </div>`;
}

/** 吞吐 breakdown 卡（AC3：input/cached/cache-write/output/reasoning/total/requests/sessions/平均/峰值） */
function renderBreakdown(throughput) {
  const host = document.getElementById('codex-breakdown');
  if (!host) return;
  const t = throughput.totals || {};
  const avg = t.requests > 0 ? Math.round((t.total ?? 0) / t.requests) : null;
  host.innerHTML = `<table class="rates-table"><tbody>
    <tr><td>Requests</td><td>${t.requests ?? '—'}</td><td>Sessions</td><td>${t.sessions ?? '—'}</td></tr>
    <tr><td>Input</td><td>${fmt(t.input)}</td><td>Cached input</td><td>${fmt(t.cached_input)}</td></tr>
    <tr><td>Cache write</td><td>${fmt(t.cache_write)}</td><td>Output</td><td>${fmt(t.output)}</td></tr>
    <tr><td>Reasoning</td><td>${fmt(t.reasoning)}</td><td>Total</td><td>${fmt(t.total)}</td></tr>
    <tr><td>平均/请求</td><td>${avg != null ? fmt(avg) : '—'}</td><td>单请求峰值</td><td>${typeof t.peak === 'number' ? fmt(t.peak) : '—'}</td></tr>
    <tr><td colspan="4" class="dim">口径：total = input + output（cached/reasoning 不重复计入 total）</td></tr>
  </tbody></table>`;
}

function renderDayChart(byDay) {
  if (!charts.day || !byDay?.length) return;
  const axis = byDay.map((d) => d.day.slice(5));
  const mk = (key, name, color) => ({
    name, type: 'line', smooth: true, showSymbol: false, data: byDay.map((d) => d[key] ?? 0),
    lineStyle: { color, width: 2 }, itemStyle: { color },
  });
  charts.day.setOption({
    animationDuration: 300,
    grid: { left: 70, right: 16, top: 30, bottom: 30 },
    legend: { textStyle: { color: '#8a8aa0', fontSize: 11 }, top: 0 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: axis, axisLabel: { color: '#8a8aa0', fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: '#8a8aa0', formatter: fmtShort }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
    series: [mk('input', 'input', '#5aa9e6'), mk('cached_input', 'cached', '#39d353'),
      mk('output', 'output', '#e0b34c'), mk('reasoning', 'reasoning', '#c678dd')],
  }, true);
}

function renderHourChart(byHour) {
  if (!charts.hour || !byHour?.length) return;
  charts.hour.setOption({
    animationDuration: 300,
    grid: { left: 70, right: 16, top: 14, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: byHour.map((d) => (d.hour || '').slice(11, 16)), axisLabel: { color: '#8a8aa0', fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: '#8a8aa0', formatter: fmtShort }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
    series: [{ name: 'tokens', type: 'bar', data: byHour.map((d) => d.total ?? 0), barMaxWidth: 16, itemStyle: { color: '#e0813f', borderRadius: [3, 3, 0, 0] } }],
  }, true);
}

/** 总卡行：totals + freshness（陈旧显示 unknown 原因，不静默） */
function renderCards(summary, throughput) {
  const host = document.getElementById('codex-cards');
  if (!host) return;
  const t = throughput.totals || {};
  const stale = summary.freshness?.stale === true;
  const live = document.getElementById('codex-live');
  if (live) {
    live.classList.toggle('off', !!stale);
    live.title = stale ? `快照已陈旧（${Math.round((summary.freshness?.age_ms ?? 0) / 60_000)} 分钟前）` : '数据新鲜';
  }
  host.innerHTML = [
    card(fmt(t.total), 'Tokens（7 天）'),
    card(fmt(t.requests ?? 0), '请求数'),
    card(fmt(t.cached_input), 'Cached Input'),
    card(fmt(t.reasoning), 'Reasoning'),
    card(t.sessions ?? '—', 'Sessions'),
    card(summary.state === 'ok' ? '新鲜' : '陈旧/未知', '数据状态'),
  ].join('');
}

async function load() {
  try {
    const [summary, throughput, pace, cost] = await Promise.all([
      fetch('/api/codex/summary').then((r) => r.json()),
      fetch('/api/codex/throughput?days=7').then((r) => r.json()),
      fetch('/api/codex/pace').then((r) => r.json()),
      fetch('/api/codex/cost?window=weekly').then((r) => r.json()),
    ]);
    initMoney({ usd_to_cny: cost.fx?.usd_to_cny ?? null, fx_source: cost.fx?.source, fx_ts: cost.fx?.ts });
    renderCards(summary, throughput);
    renderQuota(summary);
    renderPace(pace.pace || pace);
    renderCost(cost);
    renderBreakdown(throughput);
    renderDayChart(throughput.by_day || []);
    renderHourChart(throughput.by_hour || []);
    const gen = document.getElementById('codex-gen');
    if (gen) gen.textContent = `更新于 ${new Date().toLocaleString('zh-CN')}`;
    const banner = document.getElementById('codex-error');
    if (banner) banner.hidden = true;
  } catch (err) {
    showError(`Codex 统计加载失败：${err.message}`);
  }
}

// 返回：优先浏览器历史（Back/Forward 原生）；直接书签进入时兜底回首页
document.getElementById('back-home')?.addEventListener('click', (e) => {
  if (history.length > 1) { e.preventDefault(); history.back(); }
});
document.getElementById('codex-refresh')?.addEventListener('click', () => load());
window.addEventListener('resize', () => { for (const c of Object.values(charts)) c.resize(); });

/* ==== 报告子视图（#49）：挂载在 #48 提供的 #codex-report-slot 内部，
 * 不注册新的顶层路由/入口/返回导航；数据只消费 /api/codex/events、
 * /api/codex/report、/api/codex/export.csv（#46 契约）。
 * 口径：total = input + output（cached/reasoning 不重复计入 total），
 * 缺失值显示 — 绝不伪装成 0。 ==== */
const reportState = { day: '', model: '', session: '' };

function reportQuery() {
  const p = new URLSearchParams();
  if (reportState.day) p.set('day', reportState.day);
  if (reportState.model) p.set('model', reportState.model);
  if (reportState.session) p.set('session', reportState.session);
  return p.toString();
}

async function loadReport() {
  const tbody = document.getElementById('rep-tbody');
  const summaryEl = document.getElementById('rep-summary');
  if (!tbody) return;
  try {
    const qs = reportQuery();
    const [ev, rep] = await Promise.all([
      fetch(`/api/codex/events?${qs}&limit=200`).then((r) => r.json()),
      fetch(`/api/codex/report${reportState.day ? `?day=${reportState.day}` : ''}`).then((r) => r.json()),
    ]);
    // 日报摘要（known/unknown coverage；total 口径注明）
    const cov = rep.reasoning_coverage || {};
    if (summaryEl) {
      summaryEl.textContent = `日报 ${rep.day}：${rep.by_model?.length ?? 0} 个模型 · requests ${cov.known + cov.unknown} · reasoning coverage known ${cov.known} / unknown ${cov.unknown} · total = input + output（cached/reasoning 不重复计入）`;
    }
    const rows = (ev.events || []).map((e) => {
      const d = (v) => (typeof v === 'number' && Number.isFinite(v) ? fmt(v) : '—');
      return `<tr>
        <td>${esc(new Date(e.ts).toLocaleString('zh-CN'))}</td>
        <td>${esc(e.model ?? '—')}</td>
        <td>${esc(e.session_id ?? '—')}</td>
        <td>${esc(e.project ?? '—')}</td>
        <td>${d(e.input)}</td><td>${d(e.cached_input)}</td><td>${d(e.cache_write)}</td>
        <td>${d(e.output)}</td><td>${d(e.reasoning)}</td><td>${d(e.total)}</td>
      </tr>`;
    }).join('');
    tbody.innerHTML = rows || '<tr><td colspan="10" class="dim">无匹配记录（筛选过宽或当日无用量）</td></tr>';
    // CSV 导出跟随当前筛选
    const csv = document.getElementById('rep-csv');
    if (csv) csv.href = `/api/codex/export.csv?${qs}`;
  } catch {
    if (summaryEl) summaryEl.textContent = '报告加载失败，可点「刷新」重试。';
  }
}

function initReport() {
  const slot = document.getElementById('codex-report-slot');
  if (!slot) return;
  slot.innerHTML = `
    <h3 style="margin-top:10px">请求明细与日报</h3>
    <div class="recon">
      <input id="rep-day" type="date" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:2px 6px">
      <input id="rep-model" placeholder="模型（可选）" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:2px 6px">
      <input id="rep-session" placeholder="会话（可选）" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:2px 6px">
      <button id="rep-load" class="on">查询</button>
      <a id="rep-csv" href="/api/codex/export.csv" download="codex.csv" style="color:#8a8aa0">导出 CSV</a>
    </div>
    <div id="rep-summary" class="recon dim" style="margin-top:4px"></div>
    <div style="overflow-x:auto">
      <table class="rates-table"><thead><tr>
        <th>时间</th><th>模型</th><th>会话</th><th>项目</th>
        <th>input</th><th>cached</th><th>cache write</th><th>output</th><th>reasoning</th><th>total</th>
      </tr></thead>
      <tbody id="rep-tbody"><tr><td colspan="10" class="dim">加载中…</td></tr></tbody></table>
    </div>
    <div class="recon dim" style="margin-top:2px">total = input + output；cached / reasoning 为并列口径，不重复计入 total；缺失值显示 —（不是 0）。</div>`;
  document.getElementById('rep-load')?.addEventListener('click', () => {
    reportState.day = document.getElementById('rep-day')?.value || '';
    reportState.model = document.getElementById('rep-model')?.value.trim() || '';
    reportState.session = document.getElementById('rep-session')?.value.trim() || '';
    loadReport();
  });
  loadReport();
}
initReport();

load();
setInterval(load, 60_000);
