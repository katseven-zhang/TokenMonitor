import { useEffect, useState } from 'react';
import type { Dashboard } from '../lib/api';
import { creditWindows, quotaWindows, type QuotaObservation } from '../lib/quota-observations';

const time = (value:number) => new Date(value).toLocaleString('zh-CN',{hour12:false});
const num = (value:number|null, digits=4) => value==null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:digits});
const pct = (value:number|null) => value==null?'—':`${(value*100).toFixed(1)}%`;

/**
 * 额度与计费面板（#105 起不再只服务 Codex）。
 *
 * 两类观测各自成表，因为它们的口径完全不同：
 *  - 窗口型额度（Codex `rate_limits`）：账号级 used_percent + 重置时间；
 *  - 会话级计费（Qoder credits 面）：逐请求累加的 requests / credits /
 *    billable / 上下文峰值，按会话归并（一个会话有多份转录）。
 * credits 是产品自己的订阅计费刻度，**不参与 ¥/$ 折算**，也不进模型成本；
 * 这里原样展示数值，不套 money()、不产生未定价告警。
 * 观测一律来自本地日志，不是实时余额——缺数据一律显示 —，不写成零。
 */
export function QuotaPanel({data}:{data:Dashboard}) {
  const [now,setNow] = useState(Date.now());
  const [windowFilter,setWindowFilter] = useState('all');
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  // 每个 Agent 取查询结束前最后一条观测（后端按 ts DESC 返回）
  const latestByAgent:QuotaObservation[] = [];
  const seen = new Set<string>();
  for (const row of data.quotas) {
    const windows = quotaWindows(row);
    if (!windows.length || seen.has(row.agent)) continue;
    seen.add(row.agent);
    latestByAgent.push(row);
  }
  const cards = latestByAgent.flatMap(row=>quotaWindows(row).map(window=>({...window, agent:row.agent})));
  const credits = creditWindows(data.quotas);
  // 面板同时容纳多个来源时（综合总览下就是如此），卡片必须标出观测来自谁
  const agents = new Set([...latestByAgent.map(row=>row.agent),...credits.map(row=>row.agent)]);
  const history = data.quotaHistory.items.flatMap(row=>quotaWindows(row).map(window=>({...window,agent:row.agent,ts:row.ts,session:row.session})))
    .filter(row=>windowFilter==='all'||row.key===windowFilter);
  const observedAt = [...latestByAgent,...credits.map(row=>({ts:row.ts}))].reduce((max,row)=>Math.max(max,row.ts),0);
  return <section className="panel">
    <div className="panel-heading"><h2>额度与计费 · 本地观测</h2><span>{observedAt?`日志记录于 ${time(observedAt)}`:'尚无本地额度或计费记录'}</span></div>
    <p className="table-note">卡片展示查询结束前最后一次日志观测，不是实时余额。账户额度无法按模型或项目拆分；Tokens 查询范围不等同于额度计费窗口。</p>
    <div className="quota-grid">{cards.map(card=><div key={`${card.agent}:${card.key}`} className="quota-card">
      <h3>{agents.size>1?`${card.agent} · ${card.label}`:card.label}</h3>
      <strong>{card.remaining==null?'未知':`${card.remaining.toFixed(1)}%`}<span> 观测剩余</span></strong>
      <div className="bar-track"><i style={{width:`${card.remaining??0}%`}}/></div>
      <small>{card.reset?`${time(card.reset)} · ${card.reset<=now?'观测重置时间已过，等待新日志':`约 ${Math.ceil((card.reset-now)/60000)} 分钟后`}`:'未记录重置时间'}</small>
    </div>)}</div>
    {!cards.length&&<p className="table-note">日志未提供可解析的额度窗口。</p>}
    {!!credits.length&&<div className="credit-block">
      <div className="panel-heading"><h2>会话计费观测</h2><span>{credits.length} 个会话 · 查询范围内逐请求累加</span></div>
      <p className="table-note">credits 是该产品的订阅计费刻度，不参与 ¥/$ 折算、不计入模型成本，也不会因未配价而告警；上下文比例按厂商给定的窗口分母取会话峰值。缺数据以 — 表示，不等同零。</p>
      <div className="table-wrap"><table><thead><tr><th>来源</th><th>最近请求</th><th>会话</th><th>项目</th><th>请求数</th><th>credits</th><th>原始 credits</th><th>计费请求</th><th>上下文峰值</th><th>模型 / 降级</th></tr></thead><tbody>
        {credits.map(row=><tr key={`${row.agent}:${row.session}`}>
          <td>{row.agent}</td>
          <td>{row.ts?time(row.ts):'—'}</td>
          <td className="long-cell">{row.session}</td>
          <td className="long-cell">{row.project?row.project.split(/[\\/]/).filter(Boolean).at(-1):'未记录项目'}</td>
          <td className="number">{num(row.requests,0)}</td>
          <td className="number">{num(row.credits)}</td>
          <td className="number">{num(row.originalCredits)}</td>
          <td className="number">{num(row.billableRequests,0)}</td>
          <td className="number">{pct(row.contextUsageRatio)}</td>
          <td className="long-cell">{[...row.models.map(m=>`${m.key} × ${m.requests}`),...row.degraded.map(d=>`${d.key} ${d.count}`)].slice(0,6).join(' · ')||'—'}</td>
        </tr>)}</tbody></table></div>
    </div>}
    <details className="quota-history"><summary>查询范围内的额度观测历史 · {data.quotaHistory.total.toLocaleString('zh-CN')} 条日志观测</summary>
      <div className="panel-heading"><label>额度窗口 <select aria-label="额度历史窗口" value={windowFilter} onChange={e=>setWindowFilter(e.target.value)}><option value="all">全部</option><option value="primary">主窗口</option><option value="secondary">次窗口</option><option value="monthly">月窗口</option></select></label><span>显示最近 {data.quotaHistory.items.length} 条观测，每个窗口单独一行</span></div>
      <p className="table-note">严格使用当前起止时间（结束不含），重复归档观测已去重。仅展示日志记录；重置时间变化不作为人工重置或额度兑换的证据。</p>
      {history.length?<div className="table-wrap quota-history-table"><table><thead><tr><th>观测时间</th><th>Agent</th><th>窗口</th><th>已用</th><th>剩余</th><th>记录的重置时间</th><th>来源会话</th></tr></thead><tbody>{history.map((row,index)=><tr key={`${row.ts}:${row.agent}:${row.session}:${row.key}:${index}`}><td>{time(row.ts)}</td><td>{row.agent}</td><td>{row.label}</td><td>{row.used==null?'未知':`${row.used.toFixed(1)}%`}</td><td>{row.remaining==null?'未知':`${row.remaining.toFixed(1)}%`}</td><td>{row.reset?time(row.reset):'未记录'}</td><td className="long-cell">{row.session}</td></tr>)}</tbody></table></div>:<p className="table-note">当前范围和窗口下没有可解析的额度观测。</p>}
      {data.quotaHistory.total>data.quotaHistory.items.length&&<p className="table-note">为保持界面流畅，最多显示最近 500 条观测。缩小分钟查询范围可查看更早记录。</p>}
    </details>
  </section>;
}
