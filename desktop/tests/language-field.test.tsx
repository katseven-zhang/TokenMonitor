import { describe, expect, it, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { LanguageField } from '../src/components/language-settings';
import { LANGUAGES } from '../src/lib/language';

// The switcher is built from `t(`settings.lang_${code}`)`, so nothing here can reach the
// wrong table by accident: the option list is exactly `LANGUAGES`.
beforeAll(async () => {
  await i18n.changeLanguage('zh');
});

describe('language picker', () => {
  it('offers every language the tables carry', () => {
    const html = renderToStaticMarkup(<LanguageField />);
    for (const code of LANGUAGES) expect(html).toContain(`value="${code}"`);
    expect(html.match(/<option/g)?.length).toBe(LANGUAGES.length);
  });

  it('names each language the way its own speakers write it, in every locale', async () => {
    for (const locale of ['zh', 'en', 'ja'] as const) {
      await i18n.changeLanguage(locale);
      const html = renderToStaticMarkup(<LanguageField />);
      expect(html).toContain('English');
      expect(html).toContain('简体中文');
      expect(html).toContain('日本語');
      // A translated endonym would make a Japanese user guess which option they are picking.
      expect(html).not.toContain('英語');
    }
    await i18n.changeLanguage('zh');
  });

  it('marks the active language as the selected option', async () => {
    await i18n.changeLanguage('ja');
    try {
      expect(renderToStaticMarkup(<LanguageField />)).toContain('value="ja" selected=""');
    } finally {
      await i18n.changeLanguage('zh');
    }
  });
});
