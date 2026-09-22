import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { applyDocumentLanguage } from "./lib/document-language";
import { readStoredLanguage, resolveLanguage } from "./lib/language";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";

// The saved choice is written by the language picker in settings (`lib/language.ts` owns the
// key and the fallback chain), so boot and switching can never disagree.
const initialLanguage = resolveLanguage(readStoredLanguage(globalThis.localStorage), navigator.language);

i18n.on("languageChanged", applyDocumentLanguage);

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja },
    },
    lng: initialLanguage,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // React already protects against XSS
    },
    // A missing key has to stay visible as its key: silently storing a translation back into
    // the table is how an untranslated string becomes indistinguishable from a translated one.
    saveMissing: false,
    returnNull: false,
  })
  .then(() => {
    applyDocumentLanguage(i18n.language);
  });

export default i18n;

