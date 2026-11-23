/** The send dialog of the full debug build (see send.ts). */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fullDebug, recordUiFailure } from '../state';
import { FULL_DEBUG_NS } from '../texts';
import {
  lastSentLine,
  sendRecord,
  shareRecord,
  uploadConfig,
  type SendPhase,
} from '../send';
import { MAX_ATTACHMENTS } from '../upload';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; phase: SendPhase }
  | { kind: 'done'; ref: string }
  | { kind: 'failed'; error: string };

export default function SendDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(FULL_DEBUG_NS);
  const [note, setNote] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const hasSent = lastSentLine() > 0;
  const [onlyNew, setOnlyNew] = useState(hasSent);
  const [files, setFiles] = useState<File[]>([]);
  const [recordBytes, setRecordBytes] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const configured = uploadConfig() !== null;

  useEffect(() => {
    let live = true;
    fullDebug.backend
      ?.stats()
      .then(s => live && setRecordBytes(s.bytes))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const busy = status.kind === 'busy';

  const send = async () => {
    setStatus({ kind: 'busy', phase: { phase: 'preparing' } });
    try {
      const { upload } = await sendRecord(
        { note, includeSecrets, onlyNew, files },
        phase => setStatus({ kind: 'busy', phase })
      );
      setStatus({ kind: 'done', ref: upload.slice(0, 8) });
    } catch (error) {
      // A failed send is a warning: it must not open the error pop-up.
      recordUiFailure('send', error);
      setStatus({
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const share = async () => {
    try {
      await shareRecord(includeSecrets);
    } catch (error) {
      recordUiFailure('share', error);
      setStatus({
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const filesSize = files.reduce((s, f) => s + f.size, 0);
  let progress: { label: string; ratio: number } | null = null;
  if (status.kind === 'busy') {
    const p = status.phase;
    if (p.phase === 'preparing') progress = { label: t('preparing'), ratio: 0 };
    else if (p.phase === 'hashing')
      progress = { label: t('hashing'), ratio: p.total ? p.done / p.total : 0 };
    else
      progress = {
        label: t('sending', {
          done: formatBytes(p.done),
          total: formatBytes(p.total),
        }),
        ratio: p.total ? p.done / p.total : 0,
      };
  }

  return (
    <div className="fixed inset-0 z-[10001] flex items-end sm:items-center justify-center bg-black/50 p-3">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-card p-4 text-foreground shadow-xl"
      >
        <h2 className="text-lg font-semibold mb-3">{t('dialog_title')}</h2>

        <label className="block text-sm font-medium mb-1" htmlFor="fd-note">
          {t('note_label')}
        </label>
        <textarea
          id="fd-note"
          className="w-full min-h-[96px] rounded-lg border border-border bg-background p-2 text-sm"
          placeholder={t('note_placeholder')}
          value={note}
          disabled={busy}
          onChange={e => setNote(e.target.value)}
        />

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSecrets}
            disabled={busy}
            onChange={e => setIncludeSecrets(e.target.checked)}
          />
          {t('include_secrets')}
        </label>
        {hasSent && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyNew}
              disabled={busy}
              onChange={e => setOnlyNew(e.target.checked)}
            />
            {t('only_new')}
          </label>
        )}

        <div className="mt-3">
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              const picked = Array.from(e.target.files ?? []);
              setFiles(prev => [...prev, ...picked].slice(0, MAX_ATTACHMENTS));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={busy || files.length >= MAX_ATTACHMENTS}
            className="rounded-full border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={() => input.current?.click()}
          >
            {t('add_files')}
          </button>
          <span className="ml-2 text-xs text-muted-foreground">
            {t('files_limit', { count: MAX_ATTACHMENTS })}
          </span>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate">
                    {f.name} ({formatBytes(f.size)})
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="underline text-muted-foreground"
                    onClick={() =>
                      setFiles(prev => prev.filter((_, j) => j !== i))
                    }
                  >
                    {t('remove_file')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {recordBytes !== null &&
            t('size_logs', { size: formatBytes(recordBytes) })}
          {files.length > 0 &&
            ` · ${t('size_files', { size: formatBytes(filesSize) })}`}
        </p>

        {!configured && (
          <p className="mt-2 text-xs text-destructive">{t('not_configured')}</p>
        )}

        {progress && (
          <div className="mt-3">
            <div className="h-2 w-full rounded bg-muted overflow-hidden">
              <div
                className="h-2 bg-primary transition-all"
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs">{progress.label}</p>
          </div>
        )}
        {status.kind === 'done' && (
          <p className="mt-3 text-sm text-green-600">
            {t('success', { ref: status.ref })}
          </p>
        )}
        {status.kind === 'failed' && (
          <p className="mt-3 text-sm text-destructive break-words">
            {t('failure', { error: status.error })}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 justify-end">
          {status.kind !== 'done' && (
            <button
              type="button"
              className="rounded-full border border-border px-4 py-2 text-sm"
              disabled={busy}
              onClick={() => void share()}
            >
              {t('share_instead')}
            </button>
          )}
          <button
            type="button"
            className="rounded-full border border-border px-4 py-2 text-sm"
            disabled={busy}
            onClick={onClose}
          >
            {status.kind === 'done' ? t('close') : t('cancel')}
          </button>
          {status.kind !== 'done' && configured && (
            <button
              type="button"
              className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => void send()}
            >
              {status.kind === 'failed' ? t('retry') : t('send')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
