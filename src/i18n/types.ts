declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    // Strict resource typing disabled — the codebase uses cross-namespace
    // access everywhere (e.g. t('common:save') from a discussions-scoped t),
    // which is incompatible with per-namespace key validation.
  }
}
