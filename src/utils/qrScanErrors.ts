/**
 * Helpers for @capacitor/barcode-scanner errors (OutSystems / Ionic ionbarcode).
 * See OSBarcodeError in node_modules/@capacitor/barcode-scanner — code 6 = cancelled.
 */

const CANCEL_CODE = 'OS-PLUG-BARC-0006';

export interface NormalizedQrScanError {
  message: string;
  code?: string;
  isCancelled: boolean;
}

function pickCode(obj: Record<string, unknown>): string | undefined {
  const c = obj.code;
  if (typeof c === 'string' && c.startsWith('OS-PLUG-BARC-')) return c;
  const args = obj.args;
  if (Array.isArray(args)) {
    for (const a of args) {
      if (a && typeof a === 'object' && 'code' in a) {
        const inner = (a as { code?: unknown }).code;
        if (typeof inner === 'string' && inner.startsWith('OS-PLUG-BARC-'))
          return inner;
      }
    }
  }
  return undefined;
}

/**
 * Turns plugin rejections (Error, plain object, nested Capacitor payload) into a stable shape.
 */
export function normalizeNativeQrError(err: unknown): NormalizedQrScanError {
  let message = '';
  let code: string | undefined;

  if (err instanceof Error) {
    message = err.message;
    const anyErr = err as Error & { code?: string };
    if (typeof anyErr.code === 'string') code = anyErr.code;
  } else if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') message = o.message;
    code = pickCode(o);
    if (!message) {
      try {
        message = JSON.stringify(err);
      } catch {
        message = String(err);
      }
    }
  } else {
    message = String(err);
  }

  const lower = message.toLowerCase();
  const isCancelled =
    code === CANCEL_CODE ||
    lower.includes('process was cancelled') ||
    lower.includes('the process was cancelled');

  return { message, code, isCancelled };
}

/**
 * One-line detail for debug overlay / logcat (never shown to the user as a toast).
 */
export function formatQrScanErrorForLog(
  normalized: NormalizedQrScanError
): string {
  const parts = [`[QRScan]`, normalized.isCancelled ? 'cancelled' : 'error'];
  if (normalized.code) parts.push(normalized.code);
  parts.push(normalized.message);
  return parts.join(' ');
}

/** For WebQRScanner or parent handlers; same semantics as normalizeNativeQrError().isCancelled */
export function isQrScanCancelledMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('process was cancelled') ||
    lower.includes('the process was cancelled')
  );
}
