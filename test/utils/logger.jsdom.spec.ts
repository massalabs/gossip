import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLoggingForTests } from '@massalabs/gossip-sdk/utils/logs.js';
import { configureAppLogging, logger } from '../../src/utils/logger';
import { useDebugLogs } from '../../src/stores/useDebugLogs';

describe('app logger wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useDebugLogs.getState().clear();
    resetLoggingForTests();
  });

  it('writes debug-mode logger calls to the mobile debug-console store', () => {
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);

    useDebugLogs.getState().clear();
    configureAppLogging();

    logger.info('debug sink test', { value: 1 });

    expect(consoleInfo).toHaveBeenCalledWith('debug sink test', { value: 1 });
    expect(useDebugLogs.getState().logs).toMatchObject([
      {
        level: 'info',
        msg: 'debug sink test',
        data: ['debug sink test', { value: 1 }],
      },
    ]);
  });
});
