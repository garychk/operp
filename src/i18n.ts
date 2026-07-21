import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US';
import zhCN from './locales/zh-CN';

export const LANGUAGE_STORAGE_KEY = 'erp-language';
export type SupportedLanguage = 'zh-CN' | 'en-US';
const savedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
const initialLanguage: SupportedLanguage = savedLanguage === 'en-US' ? 'en-US' : 'zh-CN';

void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': zhCN, 'en-US': enUS },
  lng: initialLanguage,
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN', 'en-US'],
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (language) => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  document.documentElement.lang = language;
});

document.documentElement.lang = initialLanguage;
export default i18n;
