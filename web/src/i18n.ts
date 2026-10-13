import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import enTranslations from './locales/en.json';
import loTranslations from './locales/lo.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: enTranslations },
      lo: { translation: loTranslations },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'lo'],
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'loanms.language',
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language.startsWith('lo') ? 'lo' : 'en';
});

export default i18n;
