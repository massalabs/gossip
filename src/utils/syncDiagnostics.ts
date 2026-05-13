import { logger } from './logger.ts';
/**
 * Opt-in console diagnostics for background sync (web + native init path).
 * Enable: `localStorage.setItem('gossip-sync-diagnostics', '1')` then reload.
 */

const DIAG_KEY = 'gossip-sync-diagnostics';

export function isSyncDiagnosticsEnabled(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(DIAG_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function logSyncDiagnostics(
  message: string,
  data?: Record<string, unknown>
): void {
  if (!isSyncDiagnosticsEnabled()) {
    return;
  }
  if (data !== undefined) {
    logger.info(`[GossipSync] ${message}`, data);
  } else {
    logger.info(`[GossipSync] ${message}`);
  }
}
