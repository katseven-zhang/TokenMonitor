import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '../lib/currency';
import { request, type EventPage, type Query } from '../lib/api';
import { latestLoader } from '../lib/latest-loader';
import { sameQuery } from '../lib/query-identity';
import { canStepTo, isCurrentRequest, pageNumberOf, pageCountOf, requestFor, type PagedRequest } from '../lib/page-request';
import { MISSING_VALUE, formatCount, formatTimestamp } from '../lib/localized-format';
import { Empty } from './empty-state';

const limit = 100;
// Shown where a total belongs but the page has not arrived yet; it is punctuation, not copy.
const pending = '…';
type DetailRequest = PagedRequest<Query> & { revision:number };
type Loaded = DetailRequest & { result:EventPage };

// The page and its filter live in one state object, so a changed filter can never be
// sent out with the previous page's offset. `revision` lets a pricing change re-read
// the same page without the list restarting, and an unmatched result is treated as
// "still loading" instead of "no records".
export function EventDetailTable({query,revision,onFilterSession,onReveal}:{query:Query;revision:number;onFilterSession:(agent:string,session:string)=>void;onReveal:(path:string)=>void}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const n = (value:number) => formatCount(value, language);
  const time = (value:number) => formatTimestamp(value, language);
  const { money } = useCurrency();
  const [stored,setStored]=useState<PagedRequest<Query>>({key:query,offset:0});
  const paging=requestFor(query,stored,sameQuery);
  if(paging!==stored) setStored(paging);
  const [loaded,setLoaded]=useState<Loaded|null>(null);
  const [error,setError]=useState('');
  const [loader]=useState(()=>latestLoader<DetailRequest,Loaded>(
    (a,b)=>a.revision===b.revision&&a.offset===b.offset&&sameQuery(a.key,b.key),
    async ({key,offset,revision})=>({key,offset,revision,result:await request<EventPage>('events',{query:key,offset,limit})}),
    result=>{setLoaded(result);setError('');},
    error=>setError(String(error)),
  ));
  useEffect(()=>{
    const key:DetailRequest={...paging,revision};
    void loader.run(key);
    const timer=setInterval(()=>void loader.run(key),5000);
    return()=>clearInterval(timer);
  },[loader,paging,revision]);
  const page=loaded&&loaded.revision===revision&&isCurrentRequest(loaded,paging,sameQuery)?loaded.result:null;
  const offset=paging.offset;
  const total=page?.total??null;
  return <section className="panel"><div className="panel-heading"><h2>{t('events.title')}</h2><span>{t('events.total_in_range',{total:page?n(total??0):pending})}</span></div>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {!page?<p role="status" className="table-note">{t('events.loading')}</p>:page.items.length?<div className="table-wrap"><table><thead><tr>{[t('common.time'),t('events.col_agent_model'),t('events.col_project_session'),t('common.input'),t('events.col_cache_read'),t('events.col_output_reasoning'),t('common.estimated_cost'),t('events.col_source')].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{page.items.map(({event:e,costUSD})=><tr key={`${e.agent}:${e.id}`}><td>{time(e.ts)}</td><td>{e.agent}<small className="cell-sub">{e.model}</small></td><td className="long-cell">{e.project||t('common.unrecorded_project')}<button className="cell-sub row-link" onClick={()=>onFilterSession(e.agent,e.session)}>{e.session}</button></td><td className="number">{n(e.tokens.input)}</td><td className="number">{n(e.tokens.cached)} / {n(e.tokens.cacheWrite)}</td><td className="number">{n(e.tokens.output)} / {n(e.tokens.reasoning)}</td><td>{money(costUSD)}</td><td><button title={e.path} onClick={()=>onReveal(e.path)}>{e.line?t('events.file_line',{line:e.line}):t('events.file')}</button></td></tr>)}</tbody></table></div>:<Empty/>}
    <div className="pagination" aria-label={t('events.pager_aria')}>
      <button disabled={!page||!canStepTo(offset,limit,total,'back')} onClick={()=>setStored({key:paging.key,offset:Math.max(0,offset-limit)})}>{t('pager.previous')}</button>
      <span>{page?t('pager.page_of',{current:pageNumberOf(offset,limit),total:pageCountOf(total,limit)}):MISSING_VALUE}</span>
      <button disabled={!page||!canStepTo(offset,limit,total,'forward')} onClick={()=>setStored({key:paging.key,offset:offset+limit})}>{t('pager.next')}</button>
    </div>
  </section>;
}
