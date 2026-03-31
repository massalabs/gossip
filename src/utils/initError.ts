/**
 * Classify an SDK initialization error and return a user-facing message.
 *
 * When wa-sqlite (OPFS) fails because another tab already holds the
 * SyncAccessHandle, the browser throws with a message containing
 * "createSyncAccessHandle" or "another open Access Handle".
 * We surface a friendlier multi-tab hint in that case.
 */
export function getInitErrorMessage(error: unknown): string {
  if (
    typeof (error as { message?: unknown })?.message === 'string' &&
    ((error as Error).message.includes('createSyncAccessHandle') ||
      (error as Error).message.includes('another open Access Handle'))
  ) {
    return 'Another tab may have this app open. Please close other tabs and refresh.';
  }
  return 'Failed to start. Please restart the app.';
}

/**
 * Render an init error message into the root element.
 * Called from main.tsx when the SDK fails to start.
 */
export function showInitError(error: unknown): void {
  const root = document.getElementById('root');
  if (root) {
    root.textContent = getInitErrorMessage(error);
  }
}
