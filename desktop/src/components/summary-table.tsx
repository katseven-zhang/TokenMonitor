import { useCurrency } from '../lib/currency';
import { useMemo,useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { Summary } from '../lib/api';
import { sortSummaries,type SummarySort } from '../lib/summary-sort';
import { cacheHitRate,componentPrices,comparisonShares,comparisonTotals,effectivePrice } from '../lib/summary-analytics';
import { MISSING_VALUE, formatCount, formatTimestamp } from '../lib/localized-format';

export type SummaryKind='models'|'projects'|'sessions'|'days'|'months';
const n=(value:number,language:string)=>formatCount(value,language);
const percent=(value:number|null)=>value===null?MISSING_VALUE:`${(value*100).toFixed(1)}%`;
export function SummaryTable({rows,kind,onDrill}:{rows:Summary[];kind:SummaryKind;onDrill:(row:Summary,kind:SummaryKind)=>void}) {
  const {t,i18n}=useTranslation();
  const language=i18n.resolvedLanguage??i18n.language;
  const {money,code}=useCurrency();
  const titles:Record<SummaryKind,string>={models:t('summary.kind_models'),projects:t('summary.kind_projects'),sessions:t('summary.kind_sessions'),days:t('summary.kind_days'),months:t('summary.kind_months')};
  const time=(value:number)=>formatTimestamp(value,language);
  const [column,setColumn]=useState<SummarySort>(kind==='days'||kind==='months'?'label':'totalTokens');
  const [descending,setDescending]=useState(true);
  const [requestedPage,setPage]=useState(0),[pageSize,setPageSize]=useState(50);
  const sorted=useMemo(()=>sortSummaries(rows,column,descending),[rows,column,descending]);
  const pageCount=Math.max(1,Math.ceil(sorted.length/pageSize));
  const page=Math.min(requestedPage,pageCount-1);
  const visible=sorted.slice(page*pageSize,(page+1)*pageSize);
  const comparing=kind==='models'||kind==='projects';
  const totals=useMemo(()=>comparisonTotals(rows),[rows]);
  const components=[t('common.new_input'),t('common.cached_read'),t('common.cache_write'),t('common.output')];
  const columns:[SummarySort,string][]=[['label',titles[kind]],['totalTokens',t('summary.col_total_tokens')],['input',t('common.input')],['cached',t('common.cached_read')],['cacheWrite',t('common.cache_write')],['output',t('common.output')],['reasoning',t('summary.col_reasoning')],['events',t('summary.col_events')],['costUsd',t('common.estimated_cost')]];
  if(comparing) columns.push(['cacheHitRate',t('summary.col_cache_hit')],['effectivePrice',t('summary.col_effective_price',{code})]);
  if(kind==='sessions'||comparing) columns.push(['lastTs',t('summary.col_last_activity')]);
  function sort(next:SummarySort){setDescending(next===column?!descending:next!=='label');setColumn(next);setPage(0);}
  return <>
    {comparing&&<p className="comparison-note"><span>{t('summary.composition_label')}</span>：<span style={{color:'#6b8def'}}>{components[0]}</span> / <span style={{color:'#39bb9a'}}>{components[1]}</span> / <span style={{color:'#f4b454'}}>{components[2]}</span> / <span style={{color:'#ab80db'}}>{components[3]}</span><span>{t('summary.composition_note')}</span></p>}
    <div className="table-wrap"><table><thead><tr>{columns.map(([key,title])=><th key={key} aria-sort={column===key?(descending?'descending':'ascending'):'none'}><button className="table-sort" onClick={()=>sort(key)}>{title}<span aria-hidden="true">{column===key?(descending?' ↓':' ↑'):' ↕'}</span></button></th>)}<th/></tr></thead>
      <tbody>{visible.map(row=><tr key={row.key}><td><button className="row-link" onClick={()=>onDrill(row,kind)}>{row.label||t('common.unrecorded_project')}</button>{comparing&&<small className="cell-sub">{t('summary.usage_share',{value:percent(comparisonShares(row,totals).usage)})}</small>}{kind==='models'&&<details className="component-prices"><summary>{t('summary.component_prices_title')}</summary><small>{t('summary.component_prices_unit',{code})}</small>{componentPrices(row).map((price,index)=><p key={index}><span>{components[index]}</span><b>{price===null?MISSING_VALUE:money(price)}</b></p>)}<small>{t('summary.component_prices_note')}</small></details>}{kind==='sessions'&&<small className="cell-sub">{row.agent} · {row.session}</small>}</td><td className="number strong">{n(row.totalTokens,language)}{comparing&&<div className="composition-bar" role="img" aria-label={t('summary.composition_aria',{input:n(row.tokens.input,language),cached:n(row.tokens.cached,language),cacheWrite:n(row.tokens.cacheWrite,language),output:n(row.tokens.output,language)})}>{(['input','cached','cacheWrite','output'] as const).map((key,index)=><i key={key} style={{width:`${row.totalTokens?row.tokens[key]/row.totalTokens*100:0}%`,background:['#6b8def','#39bb9a','#f4b454','#ab80db'][index]}}/>)}</div>}</td>{(['input','cached','cacheWrite','output','reasoning'] as const).map(key=><td key={key} className="number">{n(row.tokens[key],language)}</td>)}<td className="number">{n(row.events,language)}</td><td className="number cost" title={row.unpricedEvents?t('summary.unpriced_tooltip',{records:n(row.unpricedEvents,language),cost:money(row.knownCostUsd)}):''}>{money(row.costUsd)}{comparing&&<small className="cell-sub">{t('summary.cost_share',{value:percent(comparisonShares(row,totals).cost)})}</small>}</td>{comparing&&<><td className="number">{percent(cacheHitRate(row))}</td><td className="number">{effectivePrice(row)===null?MISSING_VALUE:money(effectivePrice(row))}</td></>}{(kind==='sessions'||comparing)&&<td className="number">{time(row.lastTs)}</td>}<td><button className="icon-button" aria-label={t('summary.view_row',{label:row.label})} onClick={()=>onDrill(row,kind)}><ChevronRight size={16}/></button></td></tr>)}</tbody>
    </table></div>
    {!rows.length&&<div className="empty"><h3>{t('empty.usage_title')}</h3><p>{t('empty.usage_hint')}</p></div>}
    <div className="summary-pagination"><span>{rows.length?t('summary.page_range',{from:n(page*pageSize+1,language),to:n(Math.min((page+1)*pageSize,rows.length),language)}):MISSING_VALUE} / {n(rows.length,language)} {t('summary.items')}</span><label>{t('pager.per_page_label')} <select aria-label={t('summary.per_page_aria',{kind:titles[kind]})} value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(0);}}>{[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={page===0} onClick={()=>setPage(0)}>{t('pager.first')}</button><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>{t('pager.previous')}</button><span>{t('pager.page_of',{current:page+1,total:pageCount})}</span><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(page+1)}>{t('pager.next')}</button><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(pageCount-1)}>{t('pager.last')}</button></div></div>
    <div className="table-note">{t('summary.footnote')}</div>
  </>;
}
