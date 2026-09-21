import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request, type ActivityPage, type Query } from '../lib/api';
import { latestLoader } from '../lib/latest-loader';
import { sameQuery } from '../lib/query-identity';
import { canStepTo, isCurrentRequest, lastPageOffset, pageNumberOf, pageCountOf, requestFor, type PagedRequest } from '../lib/page-request';
import { MISSING_VALUE, formatCount, formatTimestamp } from '../lib/localized-format';

const size = 100;
type Loaded = PagedRequest<Query> & { page:ActivityPage };

export function ActivityTable({query,onReveal}:{query:Query;onReveal:(path:string)=>void}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value:number) => formatCount(value, language);
  // The loader is created once, so the query travels inside the request key instead of
  // a closure over the first render's props. A new filter restarts paging at the first
  // page here rather than by remounting the table, which used to discard this state.
  const [stored,setStored]=useState<PagedRequest<Query>>({key:query,offset:0});
  const paging=requestFor(query,stored,sameQuery);
  if(paging!==stored) setStored(paging);
  const [response,setResponse]=useState<Loaded|null>(null);
  const [error,setError]=useState('');
  const [loader]=useState(()=>latestLoader<PagedRequest<Query>,Loaded>(
    (a,b)=>a.offset===b.offset&&sameQuery(a.key,b.key),
    async ({key,offset})=>({key,offset,page:await request<ActivityPage>('activities',{query:key,offset,limit:size})}),
    result=>{setResponse(result);setError('');},
    error=>setError(String(error)),
  ));
  useEffect(()=>{
    void loader.run(paging);
    const timer=setInterval(()=>void loader.run(paging),5000);
    return()=>clearInterval(timer);
  },[loader,paging]);
  const offset=paging.offset;
  const page=isCurrentRequest(response,paging,sameQuery)?response.page:null;
  const total=page?.total??null;
  const lastOffset=lastPageOffset(total,size);
  const goTo=(next:number)=>setStored({key:paging.key,offset:next});
  return <>
    {error&&<p role="alert" className="error-text">{error}</p>}
    <p className="table-note">{page&&<span>{t('activity.record_count',{total:number(total??0)})}</span>}{t('activity.note_order')}</p>
    <div className="pagination" aria-label={t('activity.pager_aria')}>
      <button disabled={!page||offset===0} onClick={()=>goTo(0)}>{t('pager.first')}</button>
      <button disabled={!page||!canStepTo(offset,size,total,'back')} onClick={()=>goTo(Math.max(0,offset-size))}>{t('pager.previous')}</button>
      <span>{page?t('pager.page_of',{current:pageNumberOf(offset,size),total:pageCountOf(total,size)}):MISSING_VALUE} · {t('pager.per_page',{count:size})}</span>
      <button disabled={!page||!canStepTo(offset,size,total,'forward')} onClick={()=>goTo(offset+size)}>{t('pager.next')}</button>
      <button disabled={!page||lastOffset===null||offset>=lastOffset} onClick={()=>goTo(lastOffset??0)}>{t('pager.last')}</button>
    </div>
    <div style={{height:'60vh',overflow:'auto'}} aria-busy={!page}>
    {!page?<p role="status" className="table-note">{t('activity.loading')}</p>:<>
      {page.items.length?<div className="table-wrap"><table><thead><tr><th>{t('activity.col_time')}</th><th>{t('activity.col_agent')}</th><th>{t('activity.col_tool')}</th><th>{t('activity.col_session')}</th><th>{t('activity.col_source')}</th></tr></thead><tbody>{page.items.map(a=><tr key={`${a.agent}:${a.id}`}>
        <td>{formatTimestamp(a.ts, language)}</td><td>{a.agent}</td><td>{a.name}</td><td className="long-cell">{a.session}</td><td><button title={a.path} onClick={()=>onReveal(a.path)}>{t('activity.reveal')}</button></td>
      </tr>)}</tbody></table></div>:<p className="table-note">{t('activity.empty_page')}</p>}
    </>}
    </div>
  </>;
}
