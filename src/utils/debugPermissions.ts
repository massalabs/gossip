/**
 * Permission events for the debug log of the full debug build: each check,
 * request and its result, as the JS side sees it. Observes only; it never
 * asks for anything itself.
 */
import { Capacitor } from '@capacitor/core';
import { dlog } from '@massalabs/gossip-sdk/utils/debugLog.js';

export type PermissionEvent =
  | 'permission.check'
  | 'permission.request'
  | 'permission.result';

export function logPermission(
  ev: PermissionEvent,
  name: string,
  state?: unknown,
  fields?: Record<string, unknown>
): void {
  let platform = 'web';
  try {
    platform = Capacitor.getPlatform();
  } catch {
    // Only a log.
  }
  dlog(
    'app',
    ev,
    { name, state: state === undefined ? null : state, platform, ...fields },
    { lvl: 'info' }
  );
}
