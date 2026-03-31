// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInitErrorMessage, showInitError } from '../../src/utils/initError';

describe('getInitErrorMessage', () => {
  it('returns multi-tab message for createSyncAccessHandle error', () => {
    const error = new DOMException(
      'Failed to execute createSyncAccessHandle on FileSystemFileHandle'
    );
    expect(getInitErrorMessage(error)).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
  });

  it('returns multi-tab message for "another open Access Handle" error', () => {
    const error = new Error(
      'The requested file could not be read, there is another open Access Handle'
    );
    expect(getInitErrorMessage(error)).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
  });

  it('returns generic message for unrelated errors', () => {
    const error = new Error('Network failure');
    expect(getInitErrorMessage(error)).toBe(
      'Failed to start. Please restart the app.'
    );
  });

  it('returns generic message when error has no message property', () => {
    expect(getInitErrorMessage(null)).toBe(
      'Failed to start. Please restart the app.'
    );
    expect(getInitErrorMessage(undefined)).toBe(
      'Failed to start. Please restart the app.'
    );
    expect(getInitErrorMessage(42)).toBe(
      'Failed to start. Please restart the app.'
    );
    expect(getInitErrorMessage('string error')).toBe(
      'Failed to start. Please restart the app.'
    );
  });

  it('returns generic message when message is not a string', () => {
    const error = { message: 123 };
    expect(getInitErrorMessage(error)).toBe(
      'Failed to start. Please restart the app.'
    );
  });
});

describe('showInitError', () => {
  let rootDiv: HTMLDivElement;

  beforeEach(() => {
    rootDiv = document.createElement('div');
    rootDiv.id = 'root';
    document.body.appendChild(rootDiv);
  });

  afterEach(() => {
    rootDiv.remove();
  });

  it('renders multi-tab warning into the root element for OPFS lock error', () => {
    const error = new DOMException(
      'Failed to execute createSyncAccessHandle on FileSystemFileHandle'
    );
    showInitError(error);

    expect(rootDiv.textContent).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
  });

  it('renders multi-tab warning for "another open Access Handle" error', () => {
    const error = new Error(
      'there is another open Access Handle for this file'
    );
    showInitError(error);

    expect(rootDiv.textContent).toBe(
      'Another tab may have this app open. Please close other tabs and refresh.'
    );
  });

  it('renders generic error message for other errors', () => {
    showInitError(new Error('Something went wrong'));

    expect(rootDiv.textContent).toBe(
      'Failed to start. Please restart the app.'
    );
  });

  it('does not throw when root element is missing', () => {
    rootDiv.remove();
    expect(() => showInitError(new Error('boom'))).not.toThrow();
  });
});
