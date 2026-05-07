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
  Filesystem: {
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
  },
  Directory: {
    Cache: 'CACHE',
  },
}));

import { shareFile, shareMessage } from '../../src/services/shareService';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

const mockIsNative = vi.mocked(Capacitor.isNativePlatform);
const mockShare = vi.mocked(Share.share);
const mockWriteFile = vi.mocked(Filesystem.writeFile);
const mockDeleteFile = vi.mocked(Filesystem.deleteFile);

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mockIsNative.mockReturnValue(false);
  mockWriteFile.mockResolvedValue({ uri: 'file:///cache/contact-qr-code.png' });
  mockDeleteFile.mockResolvedValue(undefined);
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

describe('shareFile', () => {
  describe('native platform (iOS/Android)', () => {
    beforeEach(() => {
      mockIsNative.mockReturnValue(true);
    });

    it('keeps the cached file available briefly after native share resolves', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'FileReader',
        class {
          result = 'data:image/png;base64,cG5n';
          onloadend: (() => void) | null = null;
          onerror: (() => void) | null = null;

          readAsDataURL() {
            this.onloadend?.();
          }
        }
      );
      mockShare.mockResolvedValue({ activityType: 'org.telegram.messenger' });

      await shareFile({
        blob: new Blob(['png'], { type: 'image/png' }),
        fileName: 'contact-qr-code.png',
        title: 'Gossip QR Code',
      });

      expect(mockWriteFile).toHaveBeenCalledWith({
        path: 'contact-qr-code.png',
        data: expect.any(String),
        directory: Directory.Cache,
      });
      expect(mockShare).toHaveBeenCalledWith({
        title: 'Gossip QR Code',
        files: ['file:///cache/contact-qr-code.png'],
        dialogTitle: 'Gossip QR Code',
      });
      expect(mockDeleteFile).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(mockDeleteFile).toHaveBeenCalledWith({
        path: 'contact-qr-code.png',
        directory: Directory.Cache,
      });
    });

    it('uses a unique native cache filename for each share', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'FileReader',
        class {
          result = 'data:image/png;base64,cG5n';
          onloadend: (() => void) | null = null;
          onerror: (() => void) | null = null;

          readAsDataURL() {
            this.onloadend?.();
          }
        }
      );
      mockShare.mockResolvedValue({ activityType: 'org.telegram.messenger' });
      mockWriteFile.mockImplementation(async ({ path }) => ({
        uri: `file:///cache/${path}`,
      }));

      await shareFile({
        blob: new Blob(['png'], { type: 'image/png' }),
        fileName: 'contact-qr-code.png',
        title: 'Gossip QR Code',
      });
      await shareFile({
        blob: new Blob(['png'], { type: 'image/png' }),
        fileName: 'contact-qr-code.png',
        title: 'Gossip QR Code',
      });

      const firstPath = mockWriteFile.mock.calls[0][0].path;
      const secondPath = mockWriteFile.mock.calls[1][0].path;

      expect(firstPath).toMatch(/^contact-qr-code-.+\.png$/);
      expect(secondPath).toMatch(/^contact-qr-code-.+\.png$/);
      expect(firstPath).not.toBe(secondPath);
      expect(firstPath).not.toBe('contact-qr-code.png');
      expect(secondPath).not.toBe('contact-qr-code.png');

      await vi.runAllTimersAsync();

      expect(mockDeleteFile).toHaveBeenCalledWith({
        path: firstPath,
        directory: Directory.Cache,
      });
      expect(mockDeleteFile).toHaveBeenCalledWith({
        path: secondPath,
        directory: Directory.Cache,
      });
    });
  });
});
