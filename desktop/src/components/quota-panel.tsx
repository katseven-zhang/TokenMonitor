import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dashboard } from '../lib/api';
import { creditWindows, quotaHistoryRows, quotaWindowName, quotaWindows } from '../lib/quota-observations';
import { sharedQuotaClock, type QuotaClock } from '../lib/quota-clock';
import { formatCount, formatTimestamp } from '../lib/localized-format';
import { QuotaWindowCountdown } from './quota-countdown';
import { QuotaHistoryTable } from './quota-history';

export type QuotaPanelData=Pick<Dashboard,'quotas'|'quotaHistory'>;

/**
 * Local quota observations. Nothing here knows what time it is: the one-second countdown is
 * a leaf (`QuotaWindowCountdown`) subscribed to a shared clock, so the history table below it
 * renders once per data or filter change instead of once per second (task #72 criterion 8).
 */
export function QuotaPanel({data, clock = sharedQuotaClock()}:{data:QuotaPanelData;clock?:QuotaClock}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const latestByAgent = [...new Map([...data.quotas].sort((a,b)=>a.ts-b.ts).filter(row=>quotaWindows(row).length>0).map(row=>[row.agent,row])).values()];
  const latest = [...latestByAgent].sort((a,b)=>b.ts-a.ts)[0];
  const credits = creditWindows(data.quotas);
  const time=(value:number)=>formatTimestamp(value,language);
  const num=(value:number|null,digits=4)=>value==null?'—':value.toLocaleString(language,{maximumFractionDigits:digits});
  const pct=(value:number|null)=>value==null?'—':`${(value*100).toFixed(1)}%`;
  const [windowFilter,setWindowFilter] = useState('all');
  const windows = latestByAgent.flatMap(row=>quotaWindows(row).map(window=>({...window,agent:row.agent})));
  const history = quotaHistoryRows(data.quotaHistory.items, windowFilter);
  const percent = (value:number|null) => value===null ? t('quota.unknown') : `${value.toFixed(1)}%`;
  const windowOptions:[string,string][] = [['primary',t('quota.window_primary')],['secondary',t('quota.window_secondary')],['monthly',t('quota.window_monthly')]];
  return <section className="panel">
    <div className="panel-heading"><h2>{t('quota.title')}</h2><span>{latest?t('quota.observed_at',{value:formatTimestamp(latest.ts,language)}):credits.length?t('credits.sessions',{count:credits.length}):t('credits.none_yet')}</span></div>
    <p className="table-note">{t('quota.disclaimer')}</p>
    <div className="quota-grid">{windows.map(window=><div key={`${window.agent}:${window.key}`} className="quota-card">
      <h3>{window.agent} · {quotaWindowName(window,t)}</h3><strong>{percent(window.remaining)}<span> {t('quota.remaining_label')}</span></strong>
      <div className="bar-track"><i style={{width:`${window.remaining??0}%`}}/></div>
      <small><QuotaWindowCountdown reset={window.reset} language={language} clock={clock}/></small>
    </div>)}</div>
    {!windows.length&&<p className="table-note">{t('quota.no_windows')}</p>}
    {!!credits.length&&<div className="credit-block">
      <div className="panel-heading"><h2>{t('credits.title')}</h2><span>{t('credits.sessions',{count:credits.length})}</span></div>
      <p className="table-note">{t('credits.disclaimer')}</p>
      <div className="table-wrap"><table><thead><tr><th>{t('credits.source')}</th><th>{t('credits.recent')}</th><th>{t('credits.session')}</th><th>{t('credits.project')}</th><th>{t('credits.requests')}</th><th>{t('credits.credits')}</th><th>{t('credits.original')}</th><th>{t('credits.billable')}</th><th>{t('credits.context')}</th><th>{t('credits.models')}</th></tr></thead><tbody>
        {credits.map(row=><tr key={`${row.agent}:${row.session}`}>
          <td>{row.agent}</td>
          <td>{row.ts?time(row.ts):'—'}</td>
          <td className="long-cell">{row.session}</td>
          <td className="long-cell">{row.project?row.project.split(/[\\/]/).filter(Boolean).slice(-1)[0]:t('credits.no_project')}</td>
          <td className="number">{num(row.requests,0)}</td>
          <td className="number">{num(row.credits)}</td>
          <td className="number">{num(row.originalCredits)}</td>
          <td className="number">{num(row.billableRequests,0)}</td>
          <td className="number">{pct(row.contextUsageRatio)}</td>
          <td className="long-cell">{[...row.models.map(m=>`${m.key} × ${m.requests}`),...row.degraded.map(d=>`${d.key} ${d.count}`)].slice(0,6).join(' · ')||'—'}</td>
        </tr>)}</tbody></table></div>
    </div>}
    <details className="quota-history"><summary>{t('quota.history_summary',{total:formatCount(data.quotaHistory.total,language)})}</summary>
      <div className="panel-heading"><label>{t('quota.window_filter_label')} <select aria-label={t('quota.window_filter_aria')} value={windowFilter} onChange={e=>setWindowFilter(e.target.value)}><option value="all">{t('quota.filter_all')}</option>{windowOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><span>{t('quota.history_showing',{shown:formatCount(data.quotaHistory.items.length,language)})}</span></div>
      <p className="table-note">{t('quota.history_note')}</p>
      <QuotaHistoryTable rows={history} language={language}/>
      {data.quotaHistory.total>data.quotaHistory.items.length&&<p className="table-note">{t('quota.history_capped',{max:formatCount(data.quotaHistory.items.length,language)})}</p>}
    </details>
  </section>;
}
