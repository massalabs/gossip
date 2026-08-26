import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import PortableBackupStartupGate from '../../src/components/PortableBackupStartupGate';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  registerPlugin: () => ({}),
}));

vi.mock('../../src/services/portableBackupNative', () => ({
  listInterruptedNativeBackups: mocks.list,
}));

vi.mock('../../src/components/ui/LoadingScreen', () => ({
  default: () => <div>checking-native-backup</div>,
}));

vi.mock('../../src/pages/PortableBackup', () => ({
  default: () => <div>native-backup-recovery</div>,
}));

describe('Android portable backup startup gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('does not mount account routes before the native journal is checked', async () => {
    mocks.list.mockReturnValue(new Promise(() => {}));
    await render(
      <PortableBackupStartupGate>
        <div>account-routes</div>
      </PortableBackupStartupGate>
    );

    await expect
      .element(page.getByText('checking-native-backup'))
      .toBeVisible();
    await expect
      .element(page.getByText('account-routes'))
      .not.toBeInTheDocument();
  });

  it('forces recovery before account routes when an output is pending', async () => {
    let resolve!: (outputs: Array<{ token: string; name: string }>) => void;
    mocks.list.mockReturnValue(
      new Promise<Array<{ token: string; name: string }>>(done => {
        resolve = done;
      })
    );
    await render(
      <PortableBackupStartupGate>
        <div>account-routes</div>
      </PortableBackupStartupGate>
    );
    await act(async () => {
      resolve([{ token: 'opaque-token', name: 'pending.gossipbackup' }]);
    });

    await expect
      .element(page.getByText('native-backup-recovery'))
      .toBeVisible();
    await expect
      .element(page.getByText('account-routes'))
      .not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('gossip:portable-backup-result')).toBe(
      'interrupted'
    );
  });

  it('mounts account routes only after a clear journal result', async () => {
    let resolve!: (outputs: []) => void;
    mocks.list.mockReturnValue(
      new Promise<[]>(done => {
        resolve = done;
      })
    );
    await render(
      <PortableBackupStartupGate>
        <div>account-routes</div>
      </PortableBackupStartupGate>
    );
    await act(async () => {
      resolve([]);
    });

    await expect.element(page.getByText('account-routes')).toBeVisible();
  });
});
