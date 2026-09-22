import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { SettingsView, type SettingsViewProps } from '../src/components/settings-view';
import { currencyFromJson } from '../src/lib/currency';
import type { Bootstrap, Settings } from '../src/lib/api';

beforeAll(async () => {
  // The page reads all of its copy from the locale tables, so the assertions below are
  // written against the Chinese bundle the same way `currency-settings.test.tsx` is.
  await i18n.changeLanguage('zh');
});

const settings: Settings = { port: 18787, refreshSeconds: 60, roots: { codex: ['D:/logs'] }, disabledAgents: [] };
const boot: Bootstrap = { settings, prices: '{"version":1,"currency":"USD"}', dataDir: 'D:/TokenMonitor', agents: [['codex', 'Codex']], autostart: false };

function view(overrides: Partial<SettingsViewProps> = {}) {
  const props: SettingsViewProps = {
    boot, settings, currency: currencyFromJson(boot.prices), theme: 'light',
    priceText: boot.prices, busy: false, loadError: '', action: async () => true,
    onThemeChange: () => {}, onPriceTextChange: () => {}, onSettingsChange: () => {},
    onPricesSaved: () => {}, onRuntimeSaved: () => {}, onAutostartSaved: () => {}, onRetry: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<SettingsView {...props}/>);
}

describe('settings page without a bootstrap', () => {
  // Task #72 criterion 6: the page used to hang off `settings &&`, so a machine that could not
  // read its own configuration rendered nothing at all - and the language switcher, the only
  // way to change the interface language, went with it.
  it('still offers the language switcher when the bootstrap read failed', () => {
    const html = view({ boot: null, settings: null, loadError: 'Error: 数据目录无法打开' });
    expect(html).toContain('aria-label="选择界面语言"');
    expect(html).toContain('English');
    expect(html).toContain('简体中文');
    expect(html).toContain('日本語');
    expect(html).toContain('value="zh"');
  });

  it('explains the failure and points at the data directory instead of a blank panel', () => {
    const html = view({ boot: null, settings: null, loadError: 'Error: 数据目录无法打开' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Error: 数据目录无法打开');
    expect(html).toContain('重试');
    expect(html).toContain('用量数据保存在本机的一个文件夹里');
    expect(html).toContain('外观与运行');
    expect(html).toContain('class="price-editor"');
  });

  it('gates only the fields the missing document actually owns', () => {
    const html = view({ boot: null, settings: null });
    // Port and scan interval are the page's only number inputs and both come from `settings`.
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('D:/TokenMonitor');
    expect(view({ boot, settings })).toContain('type="number"');
  });

  it('shows the runtime fields and the data directory once the document arrives', () => {
    const html = view({ boot, settings });
    expect(html).toContain('value="18787"');
    expect(html).toContain('D:/TokenMonitor');
    expect(html).toContain('保存运行与数据源设置');
    expect(html).not.toContain('role="alert"');
  });
});

describe('unconverted display currency', () => {
  // Task #72 criterion 4: a CNY display with no rate no longer prints yuan digits, so the
  // page has to say what it did instead.
  it('states that amounts are shown without conversion when the rate is missing', () => {
    const html = view({ currency: currencyFromJson('{"displayCurrency":"CNY"}') });
    expect(html).toContain('未设置美元汇率');
    expect(html).toContain('USD');
  });

  it('claims nothing when the configured rate is usable', () => {
    expect(view({ currency: currencyFromJson('{"displayCurrency":"CNY","usdCny":7.2}') })).not.toContain('未设置美元汇率');
    expect(view({ currency: currencyFromJson('{"displayCurrency":"USD"}') })).not.toContain('未设置美元汇率');
  });
});
