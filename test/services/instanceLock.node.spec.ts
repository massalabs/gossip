import { describe, expect, it, vi } from 'vitest';
import enCommon from '../../src/i18n/locales/en/common.json';
import frCommon from '../../src/i18n/locales/fr/common.json';
import ruCommon from '../../src/i18n/locales/ru/common.json';
import zhCommon from '../../src/i18n/locales/zh-CN/common.json';
import {
  INSTANCE_LOCK_NAME,
  holdInstanceLock,
  runSingleInstance,
} from '../../src/services/instanceLock';

/**
 * Web Locks as a browser gives them to the tabs of one origin: an exclusive
 * lock is held while its callback runs, and every lock of a tab is released
 * when the tab closes or crashes.
 */
class Browser {
  private held = new Map<string, number>();
  requests: { name: string; options: LockOptions }[] = [];

  tab(id: number) {
    const request = async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>
    ): Promise<unknown> => {
      this.requests.push({ name, options });
      if (this.held.has(name)) return callback(null);
      this.held.set(name, id);
      const done = callback({ name, mode: 'exclusive' } as Lock);
      void done.finally(() => {
        if (this.held.get(name) === id) this.held.delete(name);
      });
      return done;
    };
    return { request } as unknown as LockManager;
  }

  /** The tab is gone: the browser releases its locks. */
  crash(id: number) {
    for (const [name, holder] of this.held) {
      if (holder === id) this.held.delete(name);
    }
  }
}

describe('single instance of the web app', () => {
  it('lets one tab run and turns a second one away', async () => {
    const browser = new Browser();
    const first = await holdInstanceLock(browser.tab(1));
    const second = await holdInstanceLock(browser.tab(2));
    expect(first.state).toBe('held');
    expect(second.state).toBe('elsewhere');
    // Asked without waiting, exclusively, under one name for every account.
    expect(browser.requests).toEqual([
      {
        name: INSTANCE_LOCK_NAME,
        options: { mode: 'exclusive', ifAvailable: true },
      },
      {
        name: INSTANCE_LOCK_NAME,
        options: { mode: 'exclusive', ifAvailable: true },
      },
    ]);
  });

  it('frees the app for another tab once the running one closes', async () => {
    const browser = new Browser();
    const first = await holdInstanceLock(browser.tab(1));
    first.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await holdInstanceLock(browser.tab(2))).state).toBe('held');
  });

  it('frees the app for another tab once the running one crashed, leaving nothing behind', async () => {
    const browser = new Browser();
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem, getItem: () => null });
    try {
      expect((await holdInstanceLock(browser.tab(1))).state).toBe('held');
      browser.crash(1);
      expect((await holdInstanceLock(browser.tab(2))).state).toBe('held');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it('does not start a second instance at all', async () => {
    const browser = new Browser();
    const start = vi.fn(async () => {});
    const elsewhere = vi.fn();
    await runSingleInstance(start, elsewhere, browser.tab(1));
    await runSingleInstance(start, elsewhere, browser.tab(2));
    expect(start).toHaveBeenCalledOnce();
    expect(elsewhere).toHaveBeenCalledOnce();
  });

  it('runs without a guard where Web Locks are missing', async () => {
    const start = vi.fn(async () => {});
    const elsewhere = vi.fn();
    await runSingleInstance(start, elsewhere, undefined);
    expect(start).toHaveBeenCalledOnce();
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('says so in every language', () => {
    expect(enCommon.instance.open_elsewhere).toBe(
      'This account is open in another tab'
    );
    for (const locale of [frCommon, ruCommon, zhCommon]) {
      expect(locale.instance.open_elsewhere).toEqual(expect.any(String));
      expect(locale.instance.open_elsewhere).not.toBe(
        enCommon.instance.open_elsewhere
      );
    }
  });
});
