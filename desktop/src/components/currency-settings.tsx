import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseExchangeRateDraft } from '../lib/rate-draft';

function readConfig(text:string):Record<string,unknown>|null {
  try {
    const config:unknown=JSON.parse(text);
    return config&&typeof config==='object'&&!Array.isArray(config)?config as Record<string,unknown>:null;
  } catch { return null; }
}

// The rate field keeps its own text so an in-progress decimal such as "7." survives
// the round trip through the parsed price JSON. A `type="number"` input bound to the
// parsed value drops the decimal separator, which turned "7.2" into "72" and inflated
// every CNY cost by a factor of ten.
function ExchangeRateField({value,onCommit}:{value:number|null;onCommit:(value:number|null)=>void}) {
  const {t}=useTranslation();
  const [draft,setDraft]=useState(value===null?'':String(value));
  const [committed,setCommitted]=useState<number|null>(value);
  // An edit made elsewhere (the JSON editor, a saved bootstrap) wins over this draft.
  if(committed!==value) { setCommitted(value); setDraft(value===null?'':String(value)); }
  const parsed=parseExchangeRateDraft(draft);
  return <label>{t('settings.currency.rate_label')}
    <input
      aria-label={t('settings.currency.rate_aria')}
      aria-invalid={!parsed.ok}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder={t('settings.currency.rate_placeholder')}
      value={draft}
      onChange={event=>{
        const text=event.target.value;
        setDraft(text);
        const next=parseExchangeRateDraft(text);
        // Unparseable or half-typed text leaves the stored rate untouched; only an
        // emptied field clears it.
        if(!next.ok||(next.value===null&&text.trim()!=='')) return;
        onCommit(next.value);
      }}
      onBlur={event=>setDraft(parseExchangeRateDraft(event.target.value).display)}
    />
    {!parsed.ok&&<span className="table-note">{t('settings.currency.rate_invalid')}</span>}
  </label>;
}

export function CurrencySettings({text,onChange}:{text:string;onChange:(text:string)=>void}) {
  const {t}=useTranslation();
  const config=readConfig(text);
  if(!config) return <p className="table-note">{t('settings.currency.fix_json_first')}</p>;
  const update=(key:string,value:unknown)=>onChange(JSON.stringify({...config,[key]:value},null,2));
  const rate=typeof config.usdCny==='number'&&Number.isFinite(config.usdCny)?config.usdCny:null;
  const currencyLabel=t('settings.currency.display_currency_label');
  return <div className="settings-grid">
    <label>{currencyLabel}<select aria-label={currencyLabel} value={String(config.displayCurrency||'USD').toUpperCase()} onChange={e=>update('displayCurrency',e.target.value)}><option value="USD">{t('settings.currency.currency_usd')}</option><option value="CNY">{t('settings.currency.currency_cny')}</option></select></label>
    <ExchangeRateField value={rate} onCommit={value=>update('usdCny',value)}/>
    <p className="table-note">{t('settings.currency.manual_rate_note')}</p>
  </div>;
}
