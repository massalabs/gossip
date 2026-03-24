import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Capacitor before importing shareService
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    share: vi.fn(),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {},
  Directory: {},
}));

import { shareMessage } from '../../src/services/shareService';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';

const mockIsNative = vi.mocked(Capacitor.isNativePlatform);
const mockShare = vi.mocked(Share.share);

function setNavigatorShare(fn: typeof navigator.share | undefined) {
  Object.defineProperty(navigator, 'share', {
    value: fn,
    writable: true,
    configurable: true,
  });
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsNative.mockReturnValue(false);
  setNavigatorShare(undefined);
  setClipboard(vi.fn().mockResolvedValue(undefined));
});

describe('shareMessage', () => {
  describe('empty text', () => {
    it('does nothing when text is empty', async () => {
      await shareMessage('');
      expect(mockShare).not.toHaveBeenCalled();
    });
  });

  describe('native platform (iOS/Android)', () => {
    beforeEach(() => {
      mockIsNative.mockReturnValue(true);
    });

    it('calls Share.share with the message text', async () => {
      mockShare.mockResolvedValue({ activityType: 'com.example.app' });
      await shareMessage('Hello world');
      expect(mockShare).toHaveBeenCalledWith({
        title: 'Gossip',
        text: 'Hello world',
        dialogTitle: 'Gossip',
      });
    });

    it('silently swallows user cancellation', async () => {
      mockShare.mockRejectedValue(new Error('User cancelled'));
      await expect(shareMessage('Hello')).resolves.toBeUndefined();
    });

    it('silently swallows AbortError', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      mockShare.mockRejectedValue(err);
      await expect(shareMessage('Hello')).resolves.toBeUndefined();
    });

    it('rethrows non-cancellation errors', async () => {
      mockShare.mockRejectedValue(new Error('Permission denied'));
      await expect(shareMessage('Hello')).rejects.toThrow('Permission denied');
    });
  });

  describe('web platform', () => {
    it('calls navigator.share when available', async () => {
      const webShare = vi.fn().mockResolvedValue(undefined);
      setNavigatorShare(webShare);

      await shareMessage('Hello web');
      expect(webShare).toHaveBeenCalledWith({
        title: 'Gossip',
        text: 'Hello web',
      });
    });

    it('silently swallows cancellation from navigator.share', async () => {
      const err = new Error('User cancelled');
      setNavigatorShare(vi.fn().mockRejectedValue(err));
      await expect(shareMessage('Hello')).resolves.toBeUndefined();
    });

    it('falls back to clipboard when navigator.share throws a non-cancellation error', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      setNavigatorShare(vi.fn().mockRejectedValue(new Error('Share failed')));
      setClipboard(writeText);

      await shareMessage('Hello fallback');
      expect(writeText).toHaveBeenCalledWith('Hello fallback');
    });

    it('falls back to clipboard when navigator.share is unavailable', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard(writeText);

      await shareMessage('Hello clipboard');
      expect(writeText).toHaveBeenCalledWith('Hello clipboard');
    });

    it('throws when clipboard also fails', async () => {
      setClipboard(vi.fn().mockRejectedValue(new Error('Clipboard denied')));
      await expect(shareMessage('Hello')).rejects.toThrow('Clipboard denied');
    });
  });
});
