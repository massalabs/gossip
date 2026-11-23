/**
 * The error pop-up and the send dialog of the full debug build, in their own
 * React root on top of the app: they work before login, after a failed start
 * and when the app's own tree has crashed. A failure inside them is recorded
 * as a warning (never as an error, so it cannot open the pop-up again) and
 * hides them.
 */
import {
  Component,
  StrictMode,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import {
  fullDebug,
  getOverlay,
  openSendDialog,
  recordUiFailure,
  setOverlay,
  subscribeOverlay,
} from '../state';
import { FULL_DEBUG_NS } from '../texts';
import SendDialog from './SendDialog';

class Guard extends Component<
  { children: ReactNode; where: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    recordUiFailure(this.props.where, error);
    try {
      fullDebug.gate.close(false);
      setOverlay({ prompt: false, dialog: false });
    } catch {
      // ignore
    }
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ErrorPrompt({ reason }: { reason: string }) {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const close = (never: boolean) => {
    fullDebug.gate.close(never);
    setOverlay({ prompt: false });
  };
  return (
    <div className="fixed inset-x-0 bottom-0 z-[10000] p-4 pointer-events-none">
      <div
        role="alertdialog"
        className="pointer-events-auto mx-auto max-w-md rounded-xl border border-destructive bg-card p-4 shadow-lg text-foreground"
      >
        <p className="font-semibold">{t('prompt_title')}</p>
        <p className="text-sm text-muted-foreground mt-1">{t('prompt_body')}</p>
        {reason && (
          <p className="text-xs text-muted-foreground mt-1 break-words line-clamp-3">
            {reason}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={() => {
              fullDebug.gate.close(false);
              openSendDialog();
            }}
          >
            {t('prompt_send')}
          </button>
          <button
            type="button"
            className="rounded-full border border-border px-4 py-2 text-sm"
            onClick={() => close(false)}
          >
            {t('prompt_later')}
          </button>
          <button
            type="button"
            className="rounded-full px-3 py-2 text-xs text-muted-foreground underline"
            onClick={() => close(true)}
          >
            {t('prompt_never')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Overlay() {
  const [state, setState] = useState(getOverlay());
  useEffect(() => subscribeOverlay(setState), []);
  return (
    <>
      {state.prompt && !state.dialog && (
        <Guard where="prompt">
          <ErrorPrompt reason={state.reason} />
        </Guard>
      )}
      {state.dialog && (
        <Guard where="dialog">
          <SendDialog onClose={() => setOverlay({ dialog: false })} />
        </Guard>
      )}
    </>
  );
}

let mounted = false;

export function mountFullDebugOverlay(): void {
  if (mounted) return;
  mounted = true;
  const host = document.createElement('div');
  host.id = 'full-debug-overlay';
  document.body.appendChild(host);
  createRoot(host).render(
    <StrictMode>
      <Guard where="overlay">
        <Overlay />
      </Guard>
    </StrictMode>
  );
}
