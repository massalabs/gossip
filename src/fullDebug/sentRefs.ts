/**
 * The reference of a send: `<install>/<upload>`, the path of the upload on
 * the backend (`debug-logs/<install>/<upload>/`), so that a tester can give
 * it and the developers can find the upload with it.
 */
const SENT_KEY = 'gossip-full-debug-sent';
const KEEP = 5;

export function uploadRef(install: string, upload: string): string {
  return `${install}/${upload}`;
}

export interface SentRef {
  ref: string;
  at: string;
}

export function recentSends(): SentRef[] {
  try {
    const list = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]');
    return Array.isArray(list)
      ? list.filter(
          (e): e is SentRef =>
            typeof e?.ref === 'string' && typeof e?.at === 'string'
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberSend(ref: string, at: Date = new Date()): void {
  try {
    const list = [{ ref, at: at.toISOString() }, ...recentSends()].slice(
      0,
      KEEP
    );
    localStorage.setItem(SENT_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}
