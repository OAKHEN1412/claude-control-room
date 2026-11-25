import { setLanguage } from './i18n';
// Existing tests assert Thai text: pin the language to Thai in the node test env.
setLanguage('th', { persist: false });
