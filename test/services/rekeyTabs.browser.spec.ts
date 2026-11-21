import { afterEach, describe, expect, it } from 'vitest';
import {
  claimRekey,
  holdSessionPresence,
  RekeyElsewhereError,
  waitForOtherWindows,
  waitForRekeyEnd,
  watchRekeyElsewhere,
} from '../../src/services/rekeyTabs';

// Real Web Locks and BroadcastChannel. Another window is played by a second
// BroadcastChannel on the same name and by locks held outside the module.
const CHANNEL_NAME = 'gossip-secure-storage-rekey-v1';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('rekeyTabs', () => {
  it('waits for every open account to close before the rekey may start', async () => {
    const otherWindow = holdSessionPresence();
    await settle();
    await expect(waitForOtherWindows(200)).rejects.toThrow();

    otherWindow();
    const release = await waitForOtherWindows(1_000);
    // While held, a window that opens an account waits for it.
    let reopened = false;
    const late = holdSessionPresence();
    cleanups.push(late);
    void navigator.locks.query().then(snapshot => {
      reopened =
        (snapshot.held ?? []).filter(
          lock => lock.name === 'gossip-secure-storage-session-v1'
        ).length > 1;
    });
    await settle();
    expect(reopened).toBe(false);
    release();
  });

  it('lets one window rekey at a time and announces it to the others', async () => {
    const other = new BroadcastChannel(CHANNEL_NAME);
    cleanups.push(() => other.close());
    const heard: unknown[] = [];
    other.onmessage = event => heard.push(event.data);

    const release = await claimRekey();
    await expect(claimRekey()).rejects.toBeInstanceOf(RekeyElsewhereError);
    await settle();
    expect(heard).toEqual(['rekey-start']);

    let ended = false;
    const end = waitForRekeyEnd().then(() => {
      ended = true;
    });
    await settle();
    expect(ended).toBe(false);
    release();
    await end;
    expect(ended).toBe(true);
  });

  it('notices a rekey announced by another window, or already running', async () => {
    const other = new BroadcastChannel(CHANNEL_NAME);
    cleanups.push(() => other.close());

    let calls = 0;
    const stop = watchRekeyElsewhere(() => {
      calls += 1;
    });
    cleanups.push(stop);
    other.postMessage('rekey-start');
    await settle();
    expect(calls).toBe(1);

    // Opened while another window holds the rekey lock: no message needed.
    let releaseOther!: () => void;
    const held = new Promise<void>(resolve => {
      releaseOther = resolve;
    });
    void navigator.locks.request(
      'gossip-secure-storage-rekey-v1',
      { mode: 'exclusive' },
      () => held
    );
    await settle();
    let late = 0;
    cleanups.push(
      watchRekeyElsewhere(() => {
        late += 1;
      })
    );
    await settle();
    expect(late).toBe(1);
    releaseOther();
  });
});
