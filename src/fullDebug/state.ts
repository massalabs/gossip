/**
 * Shared state of the full debug build: the record, its backend, the pop-up
 * gate and what the overlay shows. Set up by boot.ts.
 */
import type { Recorder } from './recorder';
import type { RecordBackend } from './writers';
import { PromptGate } from './promptGate';

export interface OverlayState {
  prompt: boolean;
  dialog: boolean;
  /** Short text of the error that opened the pop-up. */
  reason: string;
}

type Listener = (s: OverlayState) => void;

let overlay: OverlayState = { prompt: false, dialog: false, reason: '' };
const listeners = new Set<Listener>();

export const fullDebug: {
  recorder: Recorder | null;
  backend: RecordBackend | null;
  gate: PromptGate;
} = { recorder: null, backend: null, gate: new PromptGate() };

export function getOverlay(): OverlayState {
  return overlay;
}

export function setOverlay(next: Partial<OverlayState>): void {
  overlay = { ...overlay, ...next };
  for (const l of listeners) {
    try {
      l(overlay);
    } catch {
      // ignore
    }
  }
}

export function subscribeOverlay(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Opens the send dialog (debug settings, login screens, the pop-up). */
export function openSendDialog(): void {
  setOverlay({ dialog: true, prompt: false });
}

/** Asks the tester to send, if the gate allows it now. */
export function requestErrorPrompt(reason: string): void {
  if (overlay.dialog) return;
  if (!fullDebug.gate.request()) return;
  setOverlay({ prompt: true, reason: reason.slice(0, 300) });
}

/** A UI failure of the full debug overlay: recorded as `warn`, so it never opens the pop-up. */
export function recordUiFailure(where: string, error: unknown): void {
  try {
    fullDebug.recorder?.record({
      src: 'ui',
      ev: 'fulldebug.ui_failure',
      lvl: 'warn',
      f: { where, error },
    });
  } catch {
    // ignore
  }
}
