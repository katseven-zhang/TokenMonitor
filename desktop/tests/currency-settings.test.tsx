import { describe,expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CurrencySettings } from '../src/components/currency-settings';

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
});
