export interface InitError {
  title: string;
  detail: string;
  actionLabel: string;
  showClear: boolean;
}

export function parseInitError(error: unknown): InitError {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof DOMException ? error.name : '';

  if (
    msg.includes('createSyncAccessHandle') ||
    msg.includes('another open Access Handle')
  ) {
    return {
      title: 'App already open',
      detail:
        'Another tab may have this app open. Please close other tabs and refresh.',
      actionLabel: 'Reload Page',
      showClear: false,
    };
  }

  if (
    name === 'VersionError' ||
    msg.includes('less than the existing version')
  ) {
    return {
      title: 'Database version conflict',
      detail:
        'The local database is from a newer version and cannot be opened. Clear app data to start fresh.',
      actionLabel: 'Clear data & reload',
      showClear: true,
    };
  }

  return {
    title: 'Something went wrong',
    detail: 'An unexpected error occurred. Please restart the app.',
    actionLabel: 'Reload Page',
    showClear: false,
  };
}
