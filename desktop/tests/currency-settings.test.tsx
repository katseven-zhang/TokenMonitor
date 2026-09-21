import { describe,expect,it,beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { CurrencySettings } from '../src/components/currency-settings';

beforeAll(async()=>{
  // `src/i18n.ts` initializes i18next as a side effect; the rate field reads its
  // copy from the tables now, so the instance has to be ready before a render.
  await i18n.changeLanguage('zh');
});

describe('exchange rate field',()=>{
  it('shows the stored rate verbatim in a field that owns its text',()=>{
    const html=renderToStaticMarkup(
      <CurrencySettings text={JSON.stringify({ version:1,currency:'USD',displayCurrency:'CNY',usdCny:7.2 })} onChange={()=>{}}/>,
    );
    expect(html).toContain('type="text"');
    expect(html).toContain('7.2');
    expect(html).not.toContain('type="number"');
  });

  it('offers no rate instead of a zeroed one when the field is empty',()=>{
    const html=renderToStaticMarkup(
      <CurrencySettings text={JSON.stringify({ displayCurrency:'CNY' })} onChange={()=>{}}/>,
    );
    expect(html).toContain('请输入采用的汇率');
    expect(html).not.toContain('value="0"');
  });

  it('points at the JSON editor when the price document cannot be read',()=>{
    const html=renderToStaticMarkup(<CurrencySettings text="{unclosed" onChange={()=>{}}/>);
    expect(html).toContain('请先修正下方 JSON');
    expect(html).not.toContain('<input');
  });

  // Task #84: the copy used to be Chinese string literals baked into the
  // component, so every locale except zh showed Chinese labels and the invalid
  // rate hint stayed Chinese even in an English interface.
  it('renders the same field in the active language instead of one baked-in language',async()=>{
    await i18n.changeLanguage('en');
    try {
      const html=renderToStaticMarkup(
        <CurrencySettings text={JSON.stringify({ displayCurrency:'USD',usdCny:7.2 })} onChange={()=>{}}/>,
      );
      expect(html).toContain('Enter the rate to use');
      expect(html).toContain('aria-label="Local USD to CNY exchange rate"');
      expect(html).not.toContain('汇率');
    } finally {
      await i18n.changeLanguage('zh');
    }
  });
});
