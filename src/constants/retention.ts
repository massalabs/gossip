/**
 * Auto-delete (message retention) options shared by discussion settings,
 * the self-discussion and the default-retention privacy setting.
 * Label keys are fully qualified so they resolve from any namespace.
 */
export const RETENTION_OPTIONS: { labelKey: string; value: number | null }[] =
  [
    { labelKey: 'discussions:settings.auto_delete_off', value: null },
    { labelKey: 'discussions:settings.auto_delete_5m', value: 300 },
    { labelKey: 'discussions:settings.auto_delete_1h', value: 3600 },
    { labelKey: 'discussions:settings.auto_delete_8h', value: 28800 },
    { labelKey: 'discussions:settings.auto_delete_1d', value: 86400 },
    { labelKey: 'discussions:settings.auto_delete_1w', value: 604800 },
    { labelKey: 'discussions:settings.auto_delete_1mo', value: 2592000 },
  ];
