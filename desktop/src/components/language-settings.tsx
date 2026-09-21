import { useTranslation } from 'react-i18next';
import { asLanguage, LANGUAGES, switchLanguage } from '../lib/language';

// Task #72 criterion 7: the `settings.lang_*` keys existed in all three tables but no
// control could reach them, and nothing called `changeLanguage`. This is that control.
// Each language is shown by its own name in every locale — translating the endonym
// 「English」 into 「英語」 would make a Japanese user guess which option they are picking.
export function LanguageField() {
  const { t, i18n } = useTranslation();
  const current = asLanguage(i18n.resolvedLanguage ?? i18n.language) ?? asLanguage(i18n.language) ?? LANGUAGES[0];
  const label = t('settings.language_label');
  return <label>{label}<select
    aria-label={t('settings.language_aria')}
    value={current}
    onChange={event => {
      // An unrecognised option would leave the tables half switched, so it is ignored.
      const next = asLanguage(event.target.value);
      if (next) switchLanguage(next, i18n);
    }}
  >{LANGUAGES.map(code => <option key={code} value={code}>{t(`settings.lang_${code}`)}</option>)}</select></label>;
}
