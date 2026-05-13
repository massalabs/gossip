import { describe, expect, it, beforeEach } from 'vitest';
import {
  addLogSink,
  configureLogging,
  logger,
  resetLoggingForTests,
  setLogSinks,
  type LogSink,
} from '../../src/utils/logs.js';

describe('shared logger', () => {
  beforeEach(() => {
    resetLoggingForTests();
  });

  it('does not emit without configured sinks', () => {
    const entries: unknown[][] = [];
    addLogSink((_level, _message, args) => entries.push([...args]));

    logger.error('release-safe by default');

    expect(entries).toEqual([]);
  });

  it('emits through configured sinks when enabled', () => {
    const entries: Array<{ level: string; message: unknown; args: unknown[] }> =
      [];
    const sink: LogSink = (level, message, args) => {
      entries.push({ level, message, args: [...args] });
    };

    configureLogging({ enabled: true, minLevel: 'debug', persist: true });
    setLogSinks([sink]);

    logger.info('hello', { count: 1 });

    expect(entries).toEqual([
      {
        level: 'info',
        message: 'hello',
        args: ['hello', { count: 1 }],
      },
    ]);
  });

  it('enforces minimum log level centrally', () => {
    const levels: string[] = [];
    configureLogging({ enabled: true, minLevel: 'warn', persist: false });
    setLogSinks([level => levels.push(level)]);

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(levels).toEqual(['warn', 'error']);
  });
});
