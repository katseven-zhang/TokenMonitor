import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CurrencySettings } from './currency-settings';
import { FailureNotice } from './error-boundary';
import { LanguageField } from './language-settings';
import { PriceCatalog } from './price-catalog';
import { priceFailureAt, type PriceFailure, type PriceSurface } from '../lib/app-action';
import type { CurrencyDisplay } from '../lib/currency';
import type { Bootstrap, Settings } from '../lib/api';

type Action = (method: string, args?: unknown, onError?: (message: string) => void) => Promise<boolean>;

export type SettingsViewProps = {
  /** `null` while the bootstrap read is in flight or after it failed. */
  boot: Bootstrap | null;
  settings: Settings | null;
  currency: CurrencyDisplay;
  theme: string;
  priceText: string;
  busy: boolean;
  /** The read failure to explain, when there is one. */
  loadError: string;
  action: Action;
  onThemeChange: (theme: string) => void;
  onPriceTextChange: (text: string) => void;
  onSettingsChange: (settings: Settings) => void;
  onPricesSaved: (text: string) => void;
  onRuntimeSaved: () => void;
  onAutostartSaved: (enabled: boolean) => void;
  onRetry: () => void;
};

// Task #72 criterion 6: the whole page used to hang off `settings &&`, so a machine that
// could not bootstrap showed a blank settings page - including the language switcher, which
// is the one control that cannot be reached any other way. Only the panels that genuinely
// need the backend document are gated now; the appearance and price panels stand on their own.
export function SettingsView({
  boot, settings, currency, theme, priceText, busy, loadError, action,
  onThemeChange, onPriceTextChange, onSettingsChange, onPricesSaved, onRuntimeSaved, onAutostartSaved, onRetry,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const [priceFailure, setPriceFailure] = useState<PriceFailure>(null);
  const patch = (next: Partial<Settings>) => { if (settings) onSettingsChange({ ...settings, ...next }); };

  async function savePrices(surface: PriceSurface) {
    setPriceFailure(null);
    if (await action('save_prices', { text: priceText }, message => setPriceFailure({ surface, message }))) onPricesSaved(priceText);
  }

  async function saveRuntime() {
    if (!settings) return;
    const roots = Object.fromEntries(Object.entries(settings.roots).map(([id, paths]) => [id, paths.map(path => path.trim()).filter(Boolean)]));
    if (await action('save_settings', { ...settings, roots })) onRuntimeSaved();
  }

  return <>
    <section className="page-heading"><div><p className="eyebrow">{t('settings.eyebrow')}</p><h1>{t('nav.settings')}</h1><p>{t('settings.subtitle')}</p></div></section>
    {!settings&&<FailureNotice title={t('errors.read_failed')} message={loadError||t('loading.cache_title')} hint={t('errors.data_dir_hint')} onRetry={onRetry}/>}
    <section className="panel settings-panel">
      <h2>{t('settings.appearance')}</h2>
      <div className="settings-grid">
        <label>{t('settings.theme')}<select value={theme} onChange={e => onThemeChange(e.target.value)}><option value="light">{t('settings.theme_light')}</option><option value="dark">{t('settings.theme_dark')}</option><option value="system">{t('settings.theme_system')}</option></select></label>
        <LanguageField/>
        {settings&&<>
          <label>{t('settings.port')}<input type="number" min="1" max="65535" value={settings.port} onChange={e => patch({ port: Number(e.target.value) })}/></label>
          <label>{t('settings.scan_interval')}<input type="number" min="10" max="86400" value={settings.refreshSeconds} onChange={e => patch({ refreshSeconds: Number(e.target.value) })}/></label>
          <label className="checkbox"><input type="checkbox" checked={boot?.autostart||false} onChange={async e => { const enabled = e.target.checked; if (await action('autostart', { enabled })) onAutostartSaved(enabled); }}/>{t('settings.autostart')}</label>
        </>}
      </div>
      {boot&&<p className="muted">{t('settings.data_dir', { path: boot.dataDir })}</p>}
    </section>
    <section className="panel settings-panel">
      <h2>{t('settings.currency_title')}</h2>
      <CurrencySettings text={priceText} onChange={onPriceTextChange}/>
      <button className="primary" disabled={busy} onClick={() => void savePrices('currency')}>{t('settings.save_currency')}</button>
      {currency.rateMissing&&<p className="table-note">{t('common.rate_missing', { code: currency.code })}</p>}
      {priceFailureAt(priceFailure, 'currency')&&<p role="alert" className="error-text">{priceFailureAt(priceFailure, 'currency')}</p>}
    </section>
    {settings&&boot&&<>
      <section className="panel settings-panel">
        <h2>{t('settings.roots_title')}</h2>
        <p>{t('settings.roots_note')}</p>
        {boot.agents.map(([id, name]) => <div className="source-setting" key={id}>
          <label className="checkbox"><input type="checkbox" checked={!settings.disabledAgents.includes(id)} onChange={e => patch({ disabledAgents: e.target.checked ? settings.disabledAgents.filter(agent => agent !== id) : [...settings.disabledAgents, id] })}/>{name}</label>
          <textarea aria-label={t('settings.roots_aria', { name })} rows={id === 'antigravity' ? 3 : 2} value={(settings.roots[id] || []).join('\n')} onChange={e => patch({ roots: { ...settings.roots, [id]: e.target.value.split('\n') } })}/>
        </div>)}
        <button className="primary" disabled={busy} onClick={() => void saveRuntime()}>{t('settings.save_runtime')}</button>
      </section>
      <PriceCatalog text={boot.prices}/>
    </>}
    <section className="panel settings-panel">
      <h2>{t('settings.prices_title')}</h2>
      <p>{t('settings.prices_note')}</p>
      <details><summary>{t('settings.example_summary')}</summary><pre>{JSON.stringify({ version: 1, currency: 'USD', displayCurrency: 'CNY', usdCny: 7, aliases: { 'model-name-in-logs': 'my-model' }, models: { 'my-model': [{ currency: 'CNY', input: 1, cached: 0.1, cacheWrite: 1.25, output: 4 }, { currency: 'CNY', effectiveFrom: '2026-09-20T00:00:00+08:00', input: 2, cached: 0.2, cacheWrite: 2.5, output: 8 }] } }, null, 2)}</pre><small>{t('settings.example_note')}</small></details>
      <textarea className="price-editor" aria-label={t('settings.prices_title')} spellCheck={false} value={priceText} onChange={e => onPriceTextChange(e.target.value)}/>
      <button className="primary" disabled={busy} onClick={() => void savePrices('prices')}>{t('settings.save_prices')}</button>
      {priceFailureAt(priceFailure, 'prices')&&<p role="alert" className="error-text" style={{ marginTop: 12 }}>{priceFailureAt(priceFailure, 'prices')}</p>}
    </section>
  </>;
}
