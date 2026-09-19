import { useEffect, useState } from 'react';
import type { Dashboard } from '../lib/api';
import { quotaWindows } from '../lib/quota-observations';

const time = (value:number) => new Date(value).toLocaleString('zh-CN',{hour12:false});
export function QuotaPanel({data}:{data:Dashboard}) {
  const latest = data.quotas.find(row=>row.agent==='codex');
  const [now,setNow] = useState(Date.now());
  const [windowFilter,setWindowFilter] = useState('all');
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const windows = latest ? quotaWindows(latest) : [];
  const history = data.quotaHistory.items.flatMap(row=>quotaWindows(row).map(window=>({...window,ts:row.ts,session:row.session})))
    .filter(row=>windowFilter==='all'||row.key===windowFilter);
  return <section className="panel">
    <div className="panel-heading"><h2>Codex 额度 · 本地观测</h2><span>{latest?`日志记录于 ${time(latest.ts)}`:'尚无本地额度记录'}</span></div>
    <p className="table-note">卡片展示查询结束前最后一次日志观测，不是实时余额。账户额度无法按模型或项目拆分；Tokens 查询范围不等同于额度计费窗口。</p>
    <div className="quota-grid">{windows.map(window=><div key={window.key} className="quota-card">
      <h3>{window.label}</h3><strong>{window.remaining==null?'未知':`${window.remaining.toFixed(1)}%`}<span> 观测剩余</span></strong>
      <div className="bar-track"><i style={{width:`${window.remaining??0}%`}}/></div>
      <small>{window.reset?`${time(window.reset)} · ${window.reset<=now?'观测重置时间已过，等待新日志':`约 ${Math.ceil((window.reset-now)/60000)} 分钟后`}`:'未记录重置时间'}</small>
    </div>)}</div>
    {!windows.length&&<p className="table-note">日志未提供可解析的额度窗口。</p>}
    <details className="quota-history"><summary>查询范围内的额度观测历史 · {data.quotaHistory.total.toLocaleString('zh-CN')} 条日志观测</summary>
      <div className="panel-heading"><label>额度窗口 <select aria-label="额度历史窗口" value={windowFilter} onChange={e=>setWindowFilter(e.target.value)}><option value="all">全部</option><option value="primary">主窗口</option><option value="secondary">次窗口</option><option value="monthly">月窗口</option></select></label><span>显示最近 {data.quotaHistory.items.length} 条观测，每个窗口单独一行</span></div>
      <p className="table-note">严格使用当前起止时间（结束不含），重复归档观测已去重。仅展示日志记录；重置时间变化不作为人工重置或额度兑换的证据。</p>
      {history.length?<div className="table-wrap quota-history-table"><table><thead><tr><th>观测时间</th><th>窗口</th><th>已用</th><th>剩余</th><th>记录的重置时间</th><th>来源会话</th></tr></thead><tbody>{history.map((row,index)=><tr key={`${row.ts}:${row.session}:${row.key}:${index}`}><td>{time(row.ts)}</td><td>{row.label}</td><td>{row.used==null?'未知':`${row.used.toFixed(1)}%`}</td><td>{row.remaining==null?'未知':`${row.remaining.toFixed(1)}%`}</td><td>{row.reset?time(row.reset):'未记录'}</td><td className="long-cell">{row.session}</td></tr>)}</tbody></table></div>:<p className="table-note">当前范围和窗口下没有可解析的额度观测。</p>}
      {data.quotaHistory.total>data.quotaHistory.items.length&&<p className="table-note">为保持界面流畅，最多显示最近 500 条观测。缩小分钟查询范围可查看更早记录。</p>}
    </details>
  </section>;
}
