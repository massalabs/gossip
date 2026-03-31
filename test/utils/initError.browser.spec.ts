// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect } from 'vitest';
import { parseInitError } from '../../src/utils/initError';

describe('parseInitError', () => {
  it('returns multi-tab result for createSyncAccessHandle error', () => {
    const error = new DOMException(
      'Failed to execute createSyncAccessHandle on FileSystemFileHandle'
    );
    const result = parseInitError(error);
    expect(result.title).toBe('App already open');
    expect(result.detail).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
    expect(result.showClear).toBe(false);
  });

  it('returns multi-tab result for "another open Access Handle" error', () => {
    const error = new Error(
      'The requested file could not be read, there is another open Access Handle'
    );
    const result = parseInitError(error);
    expect(result.title).toBe('App already open');
    expect(result.detail).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
    expect(result.showClear).toBe(false);
  });

  it('returns version conflict result for VersionError', () => {
    const error = new Error(
      'The requested database version is less than the existing version'
    );
    const result = parseInitError(error);
    expect(result.title).toBe('Database version conflict');
    expect(result.showClear).toBe(true);
  });

  it('returns generic result for unrelated errors', () => {
    const error = new Error('Network failure');
    const result = parseInitError(error);
    expect(result.title).toBe('Something went wrong');
    expect(result.detail).toBe(
      'An unexpected error occurred. Please restart the app.'
    );
    expect(result.showClear).toBe(false);
  });

  it('returns generic result when error has no message property', () => {
    expect(parseInitError(null).title).toBe('Something went wrong');
    expect(parseInitError(undefined).title).toBe('Something went wrong');
    expect(parseInitError(42).title).toBe('Something went wrong');
    expect(parseInitError('string error').title).toBe('Something went wrong');
  });

  it('returns generic result when error is not an Error instance', () => {
    const error = { message: 123 };
    expect(parseInitError(error).title).toBe('Something went wrong');
  });
});
