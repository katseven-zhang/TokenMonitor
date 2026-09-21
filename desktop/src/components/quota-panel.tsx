import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dashboard } from '../lib/api';
import { quotaHistoryRows, quotaWindows } from '../lib/quota-observations';
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
  const latest = data.quotas.find(row=>row.agent==='codex');
  const [windowFilter,setWindowFilter] = useState('all');
  const windows = latest ? quotaWindows(latest) : [];
  const history = quotaHistoryRows(data.quotaHistory.items, windowFilter);
  const percent = (value:number|null) => value===null ? t('quota.unknown') : `${value.toFixed(1)}%`;
  const windowOptions:[string,string][] = [['primary',t('quota.window_primary')],['secondary',t('quota.window_secondary')],['monthly',t('quota.window_monthly')]];
  return <section className="panel">
    <div className="panel-heading"><h2>{t('quota.title')}</h2><span>{latest?t('quota.observed_at',{value:formatTimestamp(latest.ts,language)}):t('quota.none_yet')}</span></div>
    <p className="table-note">{t('quota.disclaimer')}</p>
    <div className="quota-grid">{windows.map(window=><div key={window.key} className="quota-card">
      <h3>{window.label}</h3><strong>{percent(window.remaining)}<span> {t('quota.remaining_label')}</span></strong>
      <div className="bar-track"><i style={{width:`${window.remaining??0}%`}}/></div>
      <small><QuotaWindowCountdown reset={window.reset} language={language} clock={clock}/></small>
    </div>)}</div>
    {!windows.length&&<p className="table-note">{t('quota.no_windows')}</p>}
    <details className="quota-history"><summary>{t('quota.history_summary',{total:formatCount(data.quotaHistory.total,language)})}</summary>
      <div className="panel-heading"><label>{t('quota.window_filter_label')} <select aria-label={t('quota.window_filter_aria')} value={windowFilter} onChange={e=>setWindowFilter(e.target.value)}><option value="all">{t('quota.filter_all')}</option>{windowOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><span>{t('quota.history_showing',{shown:formatCount(data.quotaHistory.items.length,language)})}</span></div>
      <p className="table-note">{t('quota.history_note')}</p>
      <QuotaHistoryTable rows={history} language={language}/>
      {data.quotaHistory.total>data.quotaHistory.items.length&&<p className="table-note">{t('quota.history_capped',{max:formatCount(data.quotaHistory.items.length,language)})}</p>}
    </details>
  </section>;
}
