import { useCurrency } from '../lib/currency';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, X } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Dashboard, Summary } from '../lib/api';
import { formatCompact, formatCount, formatTickTimestamp, formatTimestamp } from '../lib/localized-format';

/** Series order and colours: the legend, the stacked bars and the tooltip all read this. */
function useSeries() {
  const { t } = useTranslation();
  return [
    ['input', t('common.new_input'), '#6b8def'],
    ['cached', t('common.cached_read'), '#39bb9a'],
    ['cacheWrite', t('common.cache_write'), '#f4b454'],
    ['output', t('common.output'), '#ab80db'],
    ['costUsd', t('common.estimated_cost'), '#ef8797'],
  ] as const;
}

function TrendTooltip({active,payload}:{active?:boolean;payload?:readonly {payload?:Summary}[]}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const {money}=useCurrency();
  const series=useSeries();
  const number = (n:number) => formatCount(n, language);
  const row=payload?.find(item=>item.payload)?.payload;
  if(!active || !row) return null;
  return <div className="trend-tooltip"><strong>{formatTimestamp(Number(row.label),language)}</strong>
    <p>{t('common.total_tokens')} <b>{number(row.totalTokens)}</b></p>
    {series.filter(([key])=>key!=='costUsd').map(([key,label,color])=><p key={key}><span style={{color}}>{label}</span><b>{number(row.tokens[key as keyof typeof row.tokens])}</b></p>)}
    <p>{t('trend.reasoning')}<b>{number(row.tokens.reasoning)}</b></p>
    <p>{t('common.usage_records')} <b>{number(row.events)}</b></p>
    <p>{t('common.estimated_cost')} <b>{money(row.costUsd)}</b></p>
    {row.unpricedEvents>0&&<small>{t('trend.unpriced_note',{records:number(row.unpricedEvents),cost:money(row.knownCostUsd)})}</small>}
  </div>;
}

export function UsageTrend({data}:{data:Pick<Dashboard,'series'|'bucketMs'>}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const {money}=useCurrency();
  const series=useSeries();
  const [hidden,setHidden]=useState<Set<string>>(()=>new Set());
  const dialog=useRef<HTMLDialogElement>(null);
  const compact=(n:number)=>formatCompact(n,language);
  const points=useMemo(()=>data.series.map(row=>({...row,ts:Number(row.label),...row.tokens})),[data.series]);
  const bucket=data.bucketMs===60000?t('trend.bucket_minutes'):data.bucketMs===3600000?t('trend.bucket_hour'):data.bucketMs===86400000?t('trend.bucket_day'):t('trend.bucket_days',{days:data.bucketMs/86400000});
  const chart=(height:number|string)=><>
    <div className="chart" style={{height}}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={points}>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)"/>
      <XAxis dataKey="ts" minTickGap={40} tickFormatter={ts=>formatTickTimestamp(ts,language,data.bucketMs<86400000,data.bucketMs===60000)} tick={{fontSize:11}}/>
      <YAxis yAxisId="tokens" tickFormatter={n=>compact(n)} width={55} tick={{fontSize:11}}/>
      <YAxis yAxisId="cost" orientation="right" hide={hidden.has('costUsd')} tickFormatter={n=>money(n)} width={58} tick={{fontSize:10}}/>
      <Tooltip content={<TrendTooltip/>}/>
      {series.filter(([key])=>key!=='costUsd').map(([key,label,color])=><Bar key={key} yAxisId="tokens" dataKey={key} name={label} stackId="tokens" fill={color} hide={hidden.has(key)} isAnimationActive={false}/>)}
      <Line yAxisId="cost" dataKey="costUsd" name={t('common.estimated_cost')} stroke="#ef8797" strokeWidth={2} dot={false} connectNulls={false} hide={hidden.has('costUsd')} isAnimationActive={false}/>
    </ComposedChart></ResponsiveContainer></div>
    <div className="chart-legend trend-legend">{series.map(([key,label,color])=><button key={key} aria-pressed={!hidden.has(key)} onClick={()=>setHidden(old=>{const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;})}><i style={{background:color}}/>{label}</button>)}</div>
    <p className="trend-note">{t('trend.legend_note')}</p>
  </>;
  return <div className="hero-chart"><div className="chart-label"><h3>{t('trend.title')}</h3><span>{t('trend.aggregation',{bucket})}</span><button className="icon-button" aria-label={t('trend.expand_aria')} onClick={()=>dialog.current?.showModal()}><Maximize2 size={15}/></button></div>{chart(250)}
    <dialog ref={dialog} className="trend-dialog" aria-labelledby="trend-dialog-title"><div className="chart-label"><h2 id="trend-dialog-title">{t('trend.dialog_title',{bucket})}</h2><button className="icon-button" aria-label={t('trend.close_aria')} onClick={()=>dialog.current?.close()}><X size={20}/></button></div>{chart('calc(85vh - 150px)')}</dialog>
  </div>;
}
