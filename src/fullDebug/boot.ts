/**
 * Starts the full debug build's record, before the SDK, the database or any
 * login: file sink of the logger, `dlog` sink, crash capture, the error
 * pop-up and the send dialog (in their own React root). Loaded only when
 * FULL_DEBUG (src/main.tsx), so a normal build has none of it.
 */
import { addLogSink } from '@massalabs/gossip-sdk/utils/logs.js';
import { setDebugLogSink } from '@massalabs/gossip-sdk/utils/debugLog.js';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Recorder } from './recorder';
import { StorageLockWindow } from './promptGate';
import { logCallToEvent, stripLine, type Level } from './serialize';
import { createBackend } from './writers';
import { fullDebug, recordUiFailure, requestErrorPrompt } from './state';
import { APP_BUILD_ID, APP_VERSION } from '../config/version';
import { registerFullDebugTexts } from './texts';

let booted = false;

function errorReason(f: Record<string, unknown>): string {
  try {
    const msg = f.msg ?? f.message ?? '';
    const err = f.error as { message?: unknown } | undefined;
    return String(err?.message ?? msg ?? '').slice(0, 200);
  } catch {
    return '';
  }
}

export async function bootFullDebug(): Promise<void> {
  if (booted) return;
  booted = true;

  const backend = createBackend(stripLine);
  const recorder = new Recorder({ writer: backend.writer });
  fullDebug.backend = backend;
  fullDebug.recorder = recorder;

  // No pop-up for the errors of a re-login's closed storage (promptGate.ts);
  // the line stays in the record, and popup.suppressed says it was spared.
  const lockWindow = new StorageLockWindow();
  recorder.onEvent(event => lockWindow.observe(event));
  recorder.onError(event => {
    lockWindow.check(
      () => requestErrorPrompt(errorReason(event.f)),
      () =>
        recorder.record({
          src: 'app',
          ev: 'popup.suppressed',
          lvl: 'debug',
          f: { reason: 'storage_locked', src: event.src, ev: event.ev },
        })
    );
  });

  // The ~390 existing logger calls: `ev:"log"`, `f:{msg,args}`.
  addLogSink((level, _message, args) => {
    recorder.record(logCallToEvent(level as Level, args));
  });
  // Structured events of the app and the SDK.
  setDebugLogSink(event => recorder.record(event));

  recorder.record({
    src: 'app',
    ev: 'app.start',
    lvl: 'info',
    f: {
      appVersion: APP_VERSION,
      build: APP_BUILD_ID,
      platform: Capacitor.getPlatform(),
      backend: backend.kind,
      url: location.pathname,
    },
  });

  void backend
    .setWebInfo({
      appVersion: APP_VERSION,
      build: APP_BUILD_ID,
      commit: import.meta.env.VITE_APP_BUILD_ID ?? 'unknown',
      apiUrl: import.meta.env.VITE_GOSSIP_API_URL ?? '',
      userAgent: navigator.userAgent,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
    })
    .catch(() => {});

  // Crashes: uncaught errors and unhandled promise failures.
  window.addEventListener('error', e => {
    recorder.record({
      src: 'app',
      ev: 'crash.error',
      lvl: 'error',
      f: {
        message: e.message,
        file: e.filename,
        line: e.lineno,
        col: e.colno,
        error: e.error,
      },
    });
  });
  window.addEventListener('unhandledrejection', e => {
    recorder.record({
      src: 'app',
      ev: 'crash.unhandled_rejection',
      lvl: 'error',
      f: { error: e.reason },
    });
  });

  // Write at once when the app goes to the background.
  const lifecycle = (state: string) => {
    recorder.record({ src: 'app', ev: 'app.' + state, lvl: 'info', f: {} });
    void recorder.flushAll();
  };
  document.addEventListener('visibilitychange', () => {
    lifecycle(
      document.visibilityState === 'hidden' ? 'background' : 'foreground'
    );
    if (document.visibilityState === 'visible') void checkNativeErrors();
  });
  window.addEventListener('pagehide', () => lifecycle('pagehide'));
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('pause', () => lifecycle('pause')).catch(() => {});
  }
  window.addEventListener('online', () =>
    recorder.record({ src: 'app', ev: 'net.online', lvl: 'info', f: {} })
  );
  window.addEventListener('offline', () =>
    recorder.record({ src: 'app', ev: 'net.offline', lvl: 'info', f: {} })
  );

  // Errors seen natively (previous run crashed, ANR): ask to send them.
  const checkNativeErrors = async () => {
    try {
      const errors = await backend.takeNativeErrors();
      if (errors.length > 0) requestErrorPrompt(errors.join('; '));
    } catch {
      // ignore
    }
  };
  setTimeout(() => void checkNativeErrors(), 3000);

  try {
    registerFullDebugTexts();
  } catch (error) {
    recordUiFailure('texts', error);
  }
  try {
    const { mountFullDebugOverlay } = await import('./ui/Overlay');
    mountFullDebugOverlay();
  } catch (error) {
    recordUiFailure('mount', error);
  }
}
