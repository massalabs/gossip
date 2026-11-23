/**
 * Interface events for the debug log of the full debug build (`src: 'ui'`).
 *
 * One global, cheap mechanism instead of code in each component: listeners
 * on the document (capture phase) and one MutationObserver. Each handler
 * returns at once while no debug sink is installed, so a release build only
 * pays a function call per click.
 *
 * Never logged: keys, input values, text typed into fields. A click inside a
 * field gives only the field's name or label.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { debugLogEnabled, dlog } from '@massalabs/gossip-sdk/utils/debugLog.js';
import { errFields } from '@massalabs/gossip-sdk/utils/debugFields.js';

const TEXT_MAX = 40;
const LONG_TASK_MS = 200;
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]';
const TOAST_SELECTOR = '[role="status"]';

let installed = false;

/** A route with long tokens (user IDs, group keys) cut to 8 characters. */
export function routeOf(pathname: string): string {
  return pathname
    .split('/')
    .map(part => (part.length > 16 ? `${part.slice(0, 8)}…` : part))
    .join('/');
}

function capped(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
}

/** The nearest meaningful identifier of what was clicked. */
export function describeTarget(target: Element): Record<string, unknown> {
  const field = target.closest(FIELD_SELECTOR);
  if (field) {
    // Only what names the field, never what it holds.
    return {
      field: true,
      tag: field.tagName.toLowerCase(),
      testid: field.getAttribute('data-testid') ?? undefined,
      name:
        field.getAttribute('name') ??
        field.getAttribute('aria-label') ??
        field.getAttribute('id') ??
        undefined,
    };
  }
  const el =
    target.closest('[data-testid], [aria-label], button, a, [role]') ?? target;
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
  const out: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
  const testid = el.getAttribute('data-testid');
  const aria = el.getAttribute('aria-label');
  if (testid) out.testid = testid;
  if (aria) out.label = capped(aria);
  if (!testid && !aria) {
    out.role = role;
    if (role === 'button' || role === 'a' || role === 'menuitem') {
      out.text = capped(el.textContent);
    }
  }
  return out;
}

function onClick(event: Event): void {
  if (!debugLogEnabled()) return;
  try {
    const target = event.target;
    if (!(target instanceof Element)) return;
    dlog('ui', 'ui.click', {
      ...describeTarget(target),
      route: routeOf(location.pathname),
    });
  } catch {
    // Only a log.
  }
}

function onVisibility(): void {
  if (!debugLogEnabled()) return;
  dlog(
    'app',
    document.visibilityState === 'visible'
      ? 'app.foreground'
      : 'app.background',
    { route: routeOf(location.pathname) },
    { lvl: 'info' }
  );
}

function onError(event: ErrorEvent): void {
  if (!debugLogEnabled()) return;
  dlog(
    'app',
    'app.error',
    {
      ...errFields(event.error ?? event.message),
      file: event.filename,
      line: event.lineno,
      col: event.colno,
    },
    { lvl: 'error' }
  );
}

function onRejection(event: PromiseRejectionEvent): void {
  if (!debugLogEnabled()) return;
  dlog('app', 'app.unhandled_rejection', errFields(event.reason), {
    lvl: 'error',
  });
}

/** Dialogs and toasts that appear or go, as the DOM shows them. */
function watchDom(): void {
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  const open = new WeakSet<Element>();
  const describeDialog = (d: Element) => ({
    testid: d.getAttribute('data-testid') ?? undefined,
    label: capped(
      d.getAttribute('aria-label') ??
        (d.getAttribute('aria-labelledby')
          ? document.getElementById(d.getAttribute('aria-labelledby')!)
              ?.textContent
          : null)
    ),
    route: routeOf(location.pathname),
  });
  const visit = (node: Node, added: boolean) => {
    if (!(node instanceof Element)) return;
    const dialogs = node.matches(DIALOG_SELECTOR)
      ? [node]
      : Array.from(node.querySelectorAll(DIALOG_SELECTOR));
    for (const d of dialogs) {
      if (added && !open.has(d)) {
        open.add(d);
        dlog('ui', 'ui.dialog.open', describeDialog(d));
      } else if (!added && open.has(d)) {
        open.delete(d);
        dlog('ui', 'ui.dialog.close', describeDialog(d));
      }
    }
    if (!added) return;
    const toasts = node.matches(TOAST_SELECTOR)
      ? [node]
      : Array.from(node.querySelectorAll(TOAST_SELECTOR));
    for (const t of toasts) {
      const text = (t.textContent ?? '').trim();
      if (!text) continue;
      // The text the app shows may name a contact: content.
      dlog(
        'ui',
        'ui.toast',
        { size: text.length, route: routeOf(location.pathname) },
        { c: { text } }
      );
    }
  };
  new MutationObserver(records => {
    if (!debugLogEnabled()) return;
    try {
      for (const r of records) {
        r.addedNodes.forEach(n => visit(n, true));
        r.removedNodes.forEach(n => visit(n, false));
      }
    } catch {
      // Only a log.
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/** Main-thread freezes over 200 ms, where the browser reports them. */
function watchLongTasks(): void {
  try {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      return;
    }
    new PerformanceObserver(list => {
      if (!debugLogEnabled()) return;
      for (const e of list.getEntries()) {
        if (e.duration < LONG_TASK_MS) continue;
        dlog(
          'ui',
          'ui.long_task',
          { route: routeOf(location.pathname), name: e.name },
          { lvl: 'warn', dur: Math.round(e.duration) }
        );
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Not supported here.
  }
}

/** Installs the global listeners once. */
export function installDebugUiEvents(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', onClick, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  if (document.body) {
    watchDom();
  } else {
    document.addEventListener('DOMContentLoaded', watchDom, { once: true });
  }
  watchLongTasks();
}

/** Logs each route change (`ui.route`); rendered once inside the router. */
export function DebugRouteLogger(): null {
  const { pathname } = useLocation();
  useEffect(() => {
    dlog('ui', 'ui.route', { route: routeOf(pathname) });
  }, [pathname]);
  return null;
}

/** A named user action that a click alone does not describe. */
export function logUiAction(
  action: string,
  fields?: Record<string, unknown>
): void {
  dlog('ui', 'ui.action', { action, ...fields });
}
