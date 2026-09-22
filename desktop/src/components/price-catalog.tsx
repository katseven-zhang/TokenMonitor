import { useMemo,useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localInput } from '../lib/range';
import { formatCount, formatList, formatTimestamp } from '../lib/localized-format';

type Rate={currency?:string;effectiveFrom?:string|null;input:number;cached:number;cacheWrite:number;output:number};
type Catalog={currency?:string;description?:string;models:Record<string,Rate[]>;aliases?:Record<string,string>};
// #76: 这里刻意不做"别名键与某个模型同名"的前端校验，不要当成漏检来"补上"。
// 这类冲突的判词在 Rust 侧唯一权威实现 `Prices::parse`（pricing.rs）里：别名键
// 顶掉真实模型时，事件计费会路由到别名目标、价目表展示的却是该模型自身的单价，
// 两处数字必然背离。保存路径 save_prices→Prices::parse 会先把它拒掉，一份带着
// 冲突别名的目录根本到不了本组件（手改 prices.json 也一样：查询与汇总都会立刻
// 报错，不会静默按背离的数字出数）。在前端再写一遍只会和后端漂移出两套规则。
export function PriceCatalog({text}:{text:string}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [search,setSearch]=useState(''),[at,setAt]=useState(()=>localInput(Date.now())),[requestedPage,setPage]=useState(0);
  const catalog=useMemo(()=>{try{return JSON.parse(text) as Catalog;}catch{return null;}},[text]);
  const timestamp=new Date(at).getTime();
  // An unpriced rate is a gap in the table, so it reads as the same translated notice the
  // cost cells use instead of a bare word baked into this file.
  const price=(value:number|undefined,currency:string)=>value===undefined?t('common.unpriced'):`${currency} ${value.toLocaleString('en',{maximumFractionDigits:8})}`;
  const rows=useMemo(()=>Object.entries(catalog?.models??{}).map(([model,rates])=>({model,rates:[...rates].sort((a,b)=>(a.effectiveFrom?Date.parse(a.effectiveFrom):0)-(b.effectiveFrom?Date.parse(b.effectiveFrom):0)),aliases:Object.entries(catalog?.aliases??{}).filter(([,target])=>target===model).map(([alias])=>alias)})).filter(row=>[row.model,...row.aliases].some(value=>value.toLowerCase().includes(search.toLowerCase()))).sort((a,b)=>a.model.localeCompare(b.model)),[catalog,search]);
  const pages=Math.max(1,Math.ceil(rows.length/25)),page=Math.min(requestedPage,pages-1);
  return <section className="panel settings-panel"><h2>{t('catalog.title')}</h2><p>{t('catalog.note')}</p>
    {catalog?.description&&<p>{catalog.description}</p>}
    <div className="catalog-filters"><label>{t('catalog.search_label')}<input aria-label={t('catalog.search_aria')} value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder={t('catalog.search_placeholder')}/></label><label>{t('catalog.at_label')}<input aria-label={t('catalog.at_aria')} type="datetime-local" step="60" value={at} onChange={e=>setAt(e.target.value)}/></label></div>
    {!Number.isFinite(timestamp)&&<p role="alert">{t('catalog.invalid_time')}</p>}
    <div className="table-wrap"><table><thead><tr><th>{t('catalog.col_model')}</th><th>{t('common.new_input')}</th><th>{t('common.cached_read')}</th><th>{t('common.cache_write')}</th><th>{t('common.output')}</th><th>{t('catalog.col_effective')}</th></tr></thead><tbody>{rows.slice(page*25,(page+1)*25).map(row=>{const active=[...row.rates].reverse().find(rate=>(rate.effectiveFrom?Date.parse(rate.effectiveFrom):0)<=timestamp);const base=active?.currency||catalog?.currency||'USD';return <tr key={row.model}><td className="long-cell"><b>{row.model}</b>{row.aliases.length>0&&<small className="cell-sub">{t('catalog.aliases',{value:formatList(row.aliases,language)})}</small>}</td>{(['input','cached','cacheWrite','output'] as const).map(key=><td key={key} className="number">{price(active?.[key],base)}</td>)}<td className="long-cell"><span>{active?active.effectiveFrom?formatTimestamp(Date.parse(active.effectiveFrom),language):t('catalog.base_price'):t('catalog.no_effective')}</span><details><summary>{t('catalog.rate_records',{records:formatCount(row.rates.length,language)})}</summary>{row.rates.map((rate,index)=><div className="catalog-rate" key={index}><b>{rate.effectiveFrom||t('catalog.base_price_unspecified')}</b><span>{t('catalog.rate_line',{input:price(rate.input,rate.currency||base),cached:price(rate.cached,rate.currency||base),cacheWrite:price(rate.cacheWrite,rate.currency||base),output:price(rate.output,rate.currency||base)})}</span></div>)}</details></td></tr>;})}</tbody></table></div>
    {!rows.length&&<p className="table-note">{t('catalog.empty')}</p>}
    <div className="summary-pagination"><span>{t('catalog.matching',{total:formatCount(rows.length,language),page:page+1,pages})}</span><div><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>{t('pager.previous')}</button><button className="secondary" disabled={page===pages-1} onClick={()=>setPage(page+1)}>{t('pager.next')}</button></div></div>
  </section>;
}
