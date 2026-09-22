import { CurrencyContext,currencyFromJson } from './lib/currency';
import { SettingsView } from './components/settings-view';
import { useCallback,useEffect,useLayoutEffect,useMemo,useState } from 'react';
import { useTranslation } from 'react-i18next';
import { debounce,SEARCH_DEBOUNCE_MS } from './lib/debounce';
import { NOTICE_TTL_MS,dismissError,emptyErrorSlots,serverErrorSlot,visibleError,type ErrorSlot,type ErrorSlots } from './lib/banner';
import { ErrorBoundary,FailureNotice } from './components/error-boundary';
import { Activity,ArrowDownToLine,BarChart3,ChevronRight,Clock3,Coins,Cpu,Database,Folder,HardDrive,Layers,Loader2,Moon,Play,RefreshCw,Search,Settings2,ShieldCheck,Square,Sun,Terminal,X } from 'lucide-react';
import { UsageTrend } from './components/usage-trend';
import { save } from '@tauri-apps/plugin-dialog';
import { request,type Bootstrap,type Dashboard,type Query,type Settings,type Status,type Summary,type SessionDetailRow } from './lib/api';
import { loadLogs,runAction } from './lib/app-action';
import { localInput,preset,initialQuery,dateRange,windowOf } from './lib/range';
import { latestLoader } from './lib/latest-loader';
import { readScanStatusRows } from './lib/scan-status';
import { sameQuery } from './lib/query-identity';
import { formatCount,formatOrNull,formatTimeOrNull,formatTimestamp,formatCompact } from './lib/localized-format';
import { SummaryTable,type SummaryKind } from './components/summary-table';
import { ActivityTable } from './components/activity-table';
import { Empty } from './components/empty-state';
import { EventDetailTable } from './components/event-detail-table';
import { QuotaPanel } from './components/quota-panel';
import { SessionDetailModal } from './components/session-detail-modal';

type Tab='overview'|'sessions'|'models'|'projects'|'days'|'months'|'requests'|'tools'|'service'|'settings';
function Metric({label,value,hint,icon}:{label:string;value:string;hint:string;icon:React.ReactNode}){return <div className="metric"><span>{icon}{label}</span><strong>{value}</strong><small>{hint}</small></div>}

export default function App(){
 const {t,i18n}=useTranslation();
 const language=i18n.resolvedLanguage??i18n.language;
 const n=(x:number)=>formatCount(x,language);
 const compact=(x:number)=>formatCompact(x,language);
 const time=(x:number)=>formatTimestamp(x,language);
 // A degraded status row must show a gap, never a confident zero: an absent count and a
 // measured zero answer different questions.
 const countOrNull=(x:number|null)=>formatOrNull(x,language);
 const timeOrNull=(x:number|null)=>formatTimeOrNull(x,language);
 const tabs:[Tab,string][]=[['overview',t('tabs.overview')],['sessions',t('tabs.sessions')],['models',t('tabs.models')],['projects',t('tabs.projects')],['days',t('tabs.days')],['months',t('tabs.months')],['requests',t('tabs.requests')],['tools',t('tabs.tools')]];
 const [boot,setBoot]=useState<Bootstrap|null>(null),[q,setQ]=useState<Query>(initialQuery),[response,setData]=useState<Dashboard|null>(null),[tab,setTab]=useState<Tab>('overview');
 // `money()` carries the unpriced label in its closure, so it is rebuilt when the price
 // document or the interface language changes. `t` is stable within a language.
 const currency=useMemo(()=>currencyFromJson(boot?.prices,t),[boot?.prices,t,i18n.language]);
 const money=currency.money;
 const data=response&&sameQuery(response.query,q)?response:null;
 // Status rows are raw table content, so they are read once here and every reader below
 // uses the degraded shape instead of indexing fields that may not exist.
 const sourceRows=readScanStatusRows(data?.status);
 const [status,setStatus]=useState<Status>({running:false,scanning:false}),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 // Every failure keeps its own slot, so one banner shows at a time and closing it
 // removes the message that was shown instead of an unrelated source that cannot be
 // dismissed (the old banner cleared two of its three sources).
 const [errors,setErrors]=useState<ErrorSlots>(emptyErrorSlots),[dismissedServer,setDismissedServer]=useState('');
 const visible=visibleError({...errors,server:serverErrorSlot(status.error,dismissedServer)});
 const fail=(slot:ErrorSlot,message:string)=>setErrors(current=>({...current,[slot]:message}));
 const clearError=(slot:ErrorSlot)=>setErrors(current=>current[slot]?{...current,[slot]:''}:current);
 const dismissBanner=()=>{if(!visible)return;if(visible.slot==='server')setDismissedServer(visible.message);setErrors(current=>dismissError(current,visible.slot));};
 const [theme,setTheme]=useState(()=>localStorage.getItem('tm-theme')||'light'),[selected,setSelected]=useState<SessionDetailRow|null>(null);
 const [priceText,setPriceText]=useState(''),[settings,setSettings]=useState<Settings|null>(null),[logs,setLogs]=useState('');
 // Bumped when prices are saved so the detail page re-reads its costs without losing its place.
 const [pricingRevision,setPricingRevision]=useState(0);
 // A price save is reported by the panel that asked for it (`SettingsView` owns that message),
 // so there is no second copy of it to keep here.
 // Range validation belongs next to the fields it describes, not in the shared banner
 // where the next background poll would overwrite it.
 const [rangeError,setRangeError]=useState('');
 const [startText,setStartText]=useState(localInput(q.start)),[endText,setEndText]=useState(localInput(q.end));
 // Search is typed into a draft and reaches the query only after a pause, so a filter
 // change costs one query instead of one per keystroke.
 const [searchDraft,setSearchDraft]=useState(q.search),[searchApplied,setSearchApplied]=useState(q.search);
 if(searchApplied!==q.search){setSearchApplied(q.search);setSearchDraft(q.search);}
 const [commitSearch]=useState(()=>debounce((text:string)=>{setSearchApplied(text);setQ(current=>current.search===text?current:{...current,search:text});},SEARCH_DEBOUNCE_MS));
 useEffect(()=>()=>commitSearch.cancel(),[commitSearch]);
 useLayoutEffect(()=>{window.scrollTo({top:0,left:0,behavior:'instant'});},[tab,q.agent]);
 useEffect(()=>{const m=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.classList.toggle('dark',theme==='dark'||(theme==='system'&&m.matches));document.documentElement.style.colorScheme=theme==='system'?(m.matches?'dark':'light'):theme;};apply();m.addEventListener('change',apply);localStorage.setItem('tm-theme',theme);return()=>m.removeEventListener('change',apply);},[theme]);
 const [loader]=useState(()=>latestLoader<Query,Dashboard>(sameQuery,query=>request<Dashboard>('dashboard',{query}),result=>{setData(result);clearError('query');},e=>fail('query',String(e))));
 const refresh=useCallback((force=false)=>loader.run(q,force),[q,loader]);
 // A failed bootstrap is the one failure the user can act on without the backend: the language
 // and theme still work, and the settings page says what to check. It is also retryable, so the
 // read lives in a callback the settings page can call again instead of a one-shot effect.
 const loadBootstrap=useCallback(()=>{request<Bootstrap>('bootstrap').then(b=>{setBoot(b);setPriceText(b.prices);setSettings(b.settings);clearError('query');}).catch(e=>fail('query',String(e)));},[]);
 useEffect(()=>{void loadBootstrap();},[loadBootstrap]);
 useEffect(()=>{setStartText(localInput(q.start));setEndText(localInput(q.end));void refresh();},[q,refresh]);
 useEffect(()=>{const poll=()=>{void request<Status>('status').then(s=>{setStatus(s);clearError('status');}).catch(e=>fail('status',t('top.status_read_failed',{message:String(e)})));};poll();const timer=setInterval(poll,2000);return()=>clearInterval(timer);},[t]);
 useEffect(()=>{const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
 useEffect(()=>{let cancelled=false;if(tab==='service')void loadLogs(request,text=>{if(!cancelled)setLogs(text);},m=>{if(!cancelled)fail('query',m);});return()=>{cancelled=true;};},[tab,data]);
 // The refresh button used to hand the same promise to nothing but a `then`, so a rejected
 // `invoke` was an unhandled rejection and the page kept yesterday's log in silence.
 const readLogs=()=>void loadLogs(request,text=>setLogs(text),m=>fail('query',m));
 // A confirmation is not state: it leaves on its own so it cannot hide a later failure.
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),NOTICE_TTL_MS);return()=>clearTimeout(timer);},[notice]);
 // `lib/app-action.ts` decides who reports a failure: a caller that can show it inline owns it,
 // and the shared banner speaks only for the failures nobody else can place.
 const action=(method:string,args:unknown={},onError?:(message:string)=>void)=>runAction({invoke:request,report:fail,clearActionError:()=>clearError('action'),setBusy,refresh:()=>refresh(true),setStatus},method,args,onError);
 function chooseAgent(agent:string|null){setQ({...q,agent,model:null,project:null,session:null,search:''});setTab('overview');}
 function quick(minutes:number){setQ({...q,...preset(minutes)});}
 function applyRange(){const start=new Date(startText).getTime(),end=new Date(endText).getTime();if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){setRangeError(t('filters.invalid_range'));return;}setRangeError('');setQ({...q,...windowOf(start,end)});}
 function drill(row:Summary,kind:Tab){
   if(kind==='models'){setQ({...q,model:row.key,session:null});setTab('sessions');}
   else if(kind==='projects'){setQ({...q,project:row.key,session:null});setTab('sessions');}
   else if(kind==='days'||kind==='months'){const range=row.rangeStart!=null&&row.rangeEnd!=null?{start:row.rangeStart,end:row.rangeEnd}:dateRange(row.key,kind==='months');setQ({...q,...windowOf(Math.max(range.start,q.start),Math.min(range.end,q.end)),session:null});setTab('sessions');}
   else if(kind==='sessions'){
    if(row.agent==='codex'){setSelected({path:row.path,sessionId:row.session,threadName:row.label,modifiedAtMs:row.lastTs,sizeBytes:0,inputTokens:row.tokens.input+row.tokens.cached+row.tokens.cacheWrite,cachedInputTokens:row.tokens.cached,outputTokens:row.tokens.output,reasoningOutputTokens:row.tokens.reasoning,totalTokens:row.totalTokens,costUSD:row.knownCostUsd,models:[],projects:[],dailyUsage:[]});}
    else{setQ({...q,agent:row.agent,session:row.session});setTab('requests');}
   }
 }
 // The price document is saved by the settings page, which also owns the failure message; this
 // is only the bookkeeping a successful save needs from the shell.
 function pricesSaved(text:string){setBoot(b=>b?{...b,prices:text}:b);setNotice(t('settings.prices_saved'));setPricingRevision(r=>r+1);}
 async function exportData(format:'csv'|'xlsx'|'markdown'){
  try{const extension=format==='markdown'?'md':format;const path=await save({defaultPath:`TokenMonitor-${q.agent||'all'}.${extension}`,filters:[{name:extension.toUpperCase(),extensions:[extension]}]});if(path&&await action('export',{query:q,format,path}))setNotice(t('notice.exported',{path}));}catch(e){fail('action',t('notice.export_failed',{message:String(e)}));}
 }
 const label=q.agent?(boot?.agents.find(([id])=>id===q.agent)?.[1]||q.agent):t('nav.all_agents');const totals=data?.totals;
 const filters=Boolean(q.model||q.project!==null||q.session||q.search);
 function table(rows:Summary[],kind:Tab){return <SummaryTable key={kind} rows={rows} kind={kind as SummaryKind} onDrill={drill}/>; }
 return <CurrencyContext.Provider value={currency}><div className="app-shell">
  <aside className="sidebar"><div className="brand"><div className="brand-icon"><BarChart3 size={22}/></div><div><b>TokenMonitor</b><small>{t('nav.tagline')}</small></div></div><nav className="sidebar-nav" aria-label={t('nav.aria_label')}><div className="sidebar-label">{t('nav.workspace')}</div><button className={`side-item ${q.agent===null&&tab!=='service'&&tab!=='settings'?'active':''}`} onClick={()=>chooseAgent(null)}><Layers size={18}/>{t('nav.overview')}</button><div className="sidebar-label">{t('nav.agent_tools')}</div>{(boot?.agents||[['codex','Codex']]).map(([id,name])=><button key={id} className={`side-item ${q.agent===id&&tab!=='service'&&tab!=='settings'?'active':''}`} onClick={()=>chooseAgent(id)}><Cpu size={16}/>{name}<span className={`source-dot ${sourceRows.find(s=>s.agent===id)?.state==='ready'?'ready':''}`}/></button>)}</nav><div className="sidebar-bottom"><button className={`side-item ${tab==='service'?'active':''}`} onClick={()=>setTab('service')}><Terminal size={17}/>{t('nav.logs')}</button><button className={`side-item ${tab==='settings'?'active':''}`} onClick={()=>setTab('settings')}><Settings2 size={17}/>{t('nav.settings')}</button><div className="offline"><ShieldCheck size={15}/>{t('nav.local_only')}</div></div></aside>
  <main className="workspace"><ErrorBoundary key={tab} label={t('boundary.workspace')}><header className="topbar"><div className="breadcrumb">{t('top.breadcrumb')} <ChevronRight size={14}/><strong>{tab==='settings'?t('top.settings'):tab==='service'?t('top.logs'):label}</strong></div><div className="header-actions"><div className="service-controls" aria-label={t('top.controls_aria')}><button className="primary" disabled={busy||status.running} onClick={()=>void action('start')}><Play size={15}/>{t('top.start')}</button><button className="secondary" disabled={busy||!status.running} onClick={()=>void action('stop')}><Square size={15}/>{t('top.stop')}</button><button className="secondary" disabled={busy||status.stopping} onClick={()=>void action('restart')}><RefreshCw size={15}/>{t('top.restart')}</button></div><span className={`status ${status.running?'online':''}`}><i/>{status.stopping?t('top.status_stopping'):status.scanning?t('top.status_scanning'):status.running?t('top.status_running'):t('top.status_stopped')}</span><button className="icon-button" title={t('top.theme_title')} aria-label={t('top.theme_aria')} onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?<Moon size={17}/>:<Sun size={17}/>}</button><button className="primary" disabled={busy||status.scanning} onClick={()=>void action('scan')}><RefreshCw size={15} className={status.scanning?'spin':''}/>{status.scanning?t('top.scan_running'):t('top.scan_action')}</button></div></header>
   {visible&&<div role="alert" className="banner error">{visible.message}<button className="icon-button" aria-label={t('common.close_error')} onClick={dismissBanner}><X size={15}/></button></div>}{notice&&<div role="status" className="banner">{notice}<button className="icon-button" aria-label={t('common.close_notice')} onClick={()=>setNotice('')}><X size={15}/></button></div>}
   {tab!=='settings'&&tab!=='service'&&<><section className="page-heading"><div><p className="eyebrow">{q.agent==='codex'?t('hero.codex_eyebrow'):t('hero.usage_eyebrow')}</p><h1>{t('hero.title',{agent:label})}</h1><p>{t('hero.subtitle')}</p></div><div className="exports"><ArrowDownToLine size={15}/><button onClick={()=>void exportData('xlsx')}>Excel</button><button onClick={()=>void exportData('csv')}>CSV</button><button onClick={()=>void exportData('markdown')}>Markdown</button></div></section>
    <section className="filters"><div className="presets">{[[300,t('filters.preset_5h')],[1440,t('filters.preset_24h')],[10080,t('filters.preset_7d')],[43200,t('filters.preset_30d')]].map(([m,l])=><button key={m} className={q.end-q.start===Number(m)*60000?'selected':''} onClick={()=>quick(Number(m))}>{l}</button>)}</div><div className="date-fields"><label>{t('filters.start')}<input aria-label={t('filters.start_aria')} type="datetime-local" step="60" value={startText} onChange={e=>setStartText(e.target.value)}/></label><span>→</span><label>{t('filters.end')}<input aria-label={t('filters.end_aria')} type="datetime-local" step="60" value={endText} onChange={e=>setEndText(e.target.value)}/></label><button className="secondary" onClick={applyRange}>{t('filters.apply')}</button></div><small>{t('filters.note')}</small>{rangeError&&<p role="alert" className="error-text">{rangeError}</p>}</section>
    <div className="subnav">{tabs.map(([id,name])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{name}</button>)}</div>
    {filters&&<div className="filter-chips"><span>{t('filters.active',{value:[q.model,q.project,q.session,q.search].filter(x=>x!==null&&x!=='').join(' / ')})}</span><button onClick={()=>setQ({...q,model:null,project:null,session:null,search:''})}><X size={13}/>{t('filters.clear')}</button></div>}
    {!data?(errors.query?<FailureNotice title={t('errors.read_failed')} message={errors.query} hint={t('errors.data_dir_hint')} onRetry={()=>{void loadBootstrap();void refresh(true);}}/>:<Empty text={t('loading.cache_title')} hint={t('loading.cache_hint')}/>):<>
     {tab==='overview'&&<><section className="hero panel"><div className="hero-summary"><p className="eyebrow">{t('hero.summary_eyebrow',{agent:label})}</p><div className="hero-value">{compact(totals!.totalTokens)}<span>tokens</span></div><p className="hero-cost">{money(totals!.knownCostUsd)} <span>{t('hero.estimate_note',{code:currency.code})}</span></p>{currency.rateMissing&&<p className="pricing-note">{t('common.rate_missing',{code:currency.code})}</p>}{totals!.unpricedEvents>0&&<p className="pricing-note">{t('hero.unpriced_note',{records:n(totals!.unpricedEvents),tokens:n(totals!.unpricedTokens)})}<button onClick={()=>setTab('settings')}>{t('hero.configure_prices')}</button></p>}<div className="distribution"><h3>{t('hero.top_consumers')}</h3>{[...data.projects].sort((a,b)=>b.totalTokens-a.totalTokens).slice(0,3).map((p,i)=><button key={p.key} onClick={()=>drill(p,'projects')}><div><span>{i+1}. {p.label.split(/[\\/]/).filter(Boolean).at(-1)||t('common.unrecorded_project')}</span><b>{compact(p.totalTokens)}</b></div><div className="bar-track"><i style={{width:`${totals!.totalTokens?p.totalTokens/totals!.totalTokens*100:0}%`}}/></div></button>)}</div></div><UsageTrend data={data}/></section>
      <section className="metrics"><Metric icon={<Layers size={16}/>} label={t('common.usage_records')} value={n(totals!.events)} hint={t('metrics.sessions_models',{sessions:data.sessions.length,models:data.models.length})}/><Metric icon={<Database size={16}/>} label={t('metrics.cache_hit')} value={`${(totals!.tokens.cached/Math.max(1,totals!.tokens.input+totals!.tokens.cached+totals!.tokens.cacheWrite)*100).toFixed(1)}%`} hint={t('metrics.cached_tokens',{tokens:n(totals!.tokens.cached)})}/><Metric icon={<Clock3 size={16}/>} label={t('metrics.per_minute')} value={compact(totals!.totalTokens/Math.max(1,(q.end-q.start)/60000))} hint={t('metrics.selected_minutes',{minutes:(q.end-q.start)/60000})}/><Metric icon={<Coins size={16}/>} label={t('metrics.million_cost')} value={totals!.costUsd==null?t('metrics.not_fully_priced'):money(totals!.knownCostUsd/Math.max(1,totals!.totalTokens)*1e6)} hint={t('metrics.estimate_hint')}/></section>
      {data.quotas.length>0&&<QuotaPanel data={data}/>}
      {!q.agent&&<section className="panel"><div className="panel-heading"><h2>{t('panels.agent_distribution')}</h2><span>{t('panels.agent_distribution_hint')}</span></div><div className="agent-grid">{(boot?.agents||[]).map(([id,name])=>{const a=data.agents.find(a=>a.key===id);return <button key={id} className="agent-card" onClick={()=>chooseAgent(id)}><Cpu size={18}/><b>{name}</b><strong>{compact(a?.totalTokens||0)}</strong><span>{a?t('panels.agent_records',{records:n(a.events)}):t('panels.agent_no_records')}</span></button>})}</div></section>}
      <section className="panel"><div className="panel-heading"><h2>{t('panels.model_consumption')}</h2><button onClick={()=>setTab('models')}>{t('panels.view_all')}</button></div>{table(data.models,'models')}</section>
     </>}
     {(['models','projects','days','months','sessions'] as Tab[]).includes(tab)&&<section className="panel"><div className="panel-heading"><h2>{t('panels.detail_title',{kind:tabs.find(([id])=>id===tab)?.[1]})}</h2><label className="search"><Search size={15}/><input aria-label={t('panels.search_aria')} placeholder={t('panels.search_placeholder')} value={searchDraft} onChange={e=>{setSearchDraft(e.target.value);commitSearch(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter')commitSearch.flush();}}/></label></div>{table(data[tab as 'models'|'projects'|'days'|'months'|'sessions'],tab)}</section>}
     {tab==='requests'&&<EventDetailTable query={q} revision={pricingRevision} onFilterSession={(agent,session)=>setQ({...q,agent,session})} onReveal={path=>void action('reveal',{path})}/>}
     {tab==='tools'&&<section className="panel"><div className="panel-heading"><h2>{t('panels.tool_activity')}</h2><span>{t('panels.tool_activity_note')}</span></div>{q.agent==='antigravity'?<Empty text={t('panels.antigravity_note')}/>:<><details><summary>{t('panels.tool_call_total',{records:n(data.activityCount)})}</summary><div className="tool-counts">{Object.entries(data.tools).sort((a,b)=>b[1]-a[1]).map(([name,count])=><span key={name}><Terminal size={14}/>{name}<b>{n(count)}</b></span>)}</div></details><ActivityTable query={q} onReveal={path=>void action('reveal',{path})}/></>}</section>}
    </>}
   </>}
   {tab==='service'&&<><section className="page-heading"><div><p className="eyebrow">{t('service.eyebrow')}</p><h1>{t('nav.logs')}</h1><p>{t('service.subtitle')}</p></div></section><section className="panel service-panel"><div><h2>{status.stopping?t('service.stopping'):status.running?t('service.running'):t('top.status_stopped')}</h2><p>127.0.0.1:{settings?.port} · {status.pid?`PID ${status.pid}`:t('service.not_connected')} · {status.scanning?t('top.scan_running'):t('service.idle')}</p></div></section><section className="panel"><div className="panel-heading"><h2>{t('service.source_status')}</h2><span>{t('service.source_status_note')}</span></div><div className="source-list">{sourceRows.map((s,index)=><div key={`${s.agent}:${index}`}><b>{s.agent}</b><span>{({ready:t('service.state_ready'),warning:t('service.state_warning'),scanning:t('service.state_scanning'),missing:t('service.state_missing'),error:t('service.state_error'),degraded:t('service.state_degraded'),disabled:t('service.state_disabled'),stopped:t('service.state_stopped')} as Record<string,string>)[s.state]||s.state}</span><small>{t('service.source_counts',{files:countOrNull(s.files),reused:countOrNull(s.reused),malformed:countOrNull(s.malformedLines),updated:timeOrNull(s.updatedAt)})}</small>{s.failedFiles!=null&&s.failedFiles>0&&<small>{t('service.retry_pending',{files:s.failedFiles,time:timeOrNull(s.nextRetryAt??null)})}</small>}{s.partial&&<p className="error-text">{t('service.source_partial')}</p>}{s.errors.map((e,i)=><p key={i} className="error-text">{e}</p>)}{s.unreadableErrors>0&&<p className="error-text">{t('service.unreadable_errors',{records:s.unreadableErrors})}</p>}</div>)}</div></section><section className="panel"><div className="panel-heading"><h2>{t('service.logs_title')}</h2><button onClick={readLogs}>{t('service.refresh')}</button></div><pre className="logs">{logs||t('service.no_logs')}</pre></section></>}
   {tab==='settings'&&<SettingsView boot={boot} settings={settings} currency={currency} theme={theme} priceText={priceText} busy={busy} loadError={errors.query} action={action} onThemeChange={setTheme} onPriceTextChange={setPriceText} onSettingsChange={setSettings} onPricesSaved={pricesSaved} onRuntimeSaved={()=>setNotice(t('settings.saved'))} onAutostartSaved={enabled=>setBoot(b=>b?{...b,autostart:enabled}:b)} onRetry={()=>{void loadBootstrap();void refresh(true);}}/>}
   <footer><span><HardDrive size={13}/>{t('footer.local')}</span><span>{t('footer.version')}</span></footer>
  </ErrorBoundary></main>{selected&&<ErrorBoundary label={t('boundary.replay')} onClose={()=>setSelected(null)}><SessionDetailModal query={q} session={selected} onClose={()=>setSelected(null)}/></ErrorBoundary>} {busy&&<div className="busy-toast" role="status" aria-live="polite"><Loader2 className="spin" size={16}/>{t('common.processing')}</div>}
 </div></CurrencyContext.Provider>
}
