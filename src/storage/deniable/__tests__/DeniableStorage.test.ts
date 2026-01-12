/**
 * Tests for DeniableStorage class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DeniableStorage } from '../DeniableStorage';
import type { StorageAdapter } from '../types';

/**
 * In-memory adapter for testing
 */
class MemoryAdapter implements StorageAdapter {
  private addressingBlob: Uint8Array | null = null;
  private dataBlob: Uint8Array | null = null;

  async initialize(): Promise<void> {
    // No-op for memory adapter
  }

  async readAddressingBlob(): Promise<Uint8Array> {
    if (!this.addressingBlob) {
      throw new Error('Addressing blob not found');
    }
    return this.addressingBlob;
  }

  async writeAddressingBlob(blob: Uint8Array): Promise<void> {
    this.addressingBlob = new Uint8Array(blob);
  }

  async readDataBlob(): Promise<Uint8Array> {
    if (!this.dataBlob) {
      throw new Error('Data blob not found');
    }
    return this.dataBlob;
  }

  async writeDataBlob(blob: Uint8Array): Promise<void> {
    this.dataBlob = new Uint8Array(blob);
  }

  async getDataBlobSize(): Promise<number> {
    return this.dataBlob?.length || 0;
  }

  async secureWipe(): Promise<void> {
    this.addressingBlob = null;
    this.dataBlob = null;
  }

  // Helper for testing
  reset(): void {
    this.addressingBlob = null;
    this.dataBlob = null;
  }
}

describe('DeniableStorage', () => {
  let adapter: MemoryAdapter;
  let storage: DeniableStorage;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    storage = new DeniableStorage({ adapter });
  });

  describe('initialize', () => {
    it('should create addressing and data blobs on first init', async () => {
      await storage.initialize();

      const addressingBlob = await adapter.readAddressingBlob();
      const dataBlob = await adapter.readDataBlob();

      expect(addressingBlob.length).toBe(2 * 1024 * 1024); // 2MB
      expect(dataBlob.length).toBeGreaterThan(0); // Has initial padding
    });

    it('should not recreate blobs if already initialized', async () => {
      await storage.initialize();
      const firstDataBlob = await adapter.readDataBlob();

      await storage.initialize();
      const secondDataBlob = await adapter.readDataBlob();

      expect(firstDataBlob).toEqual(secondDataBlob);
    });

    it('should be idempotent', async () => {
      await storage.initialize();
      await storage.initialize();
      await storage.initialize();

      const addressingBlob = await adapter.readAddressingBlob();
      expect(addressingBlob.length).toBe(2 * 1024 * 1024);
    });
  });

  describe('createSession', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should create a new session and encrypt data', async () => {
      const data = new TextEncoder().encode('Secret session data');
      await storage.createSession('my-password', data);

      // Verify session can be unlocked
      const result = await storage.unlockSession('my-password');
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.data)).toBe('Secret session data');
    });

    it('should create multiple sessions with different passwords', async () => {
      const data1 = new TextEncoder().encode('Session 1');
      const data2 = new TextEncoder().encode('Session 2');
      const data3 = new TextEncoder().encode('Session 3');

      await storage.createSession('password1', data1);
      await storage.createSession('password2', data2);
      await storage.createSession('password3', data3);

      const result1 = await storage.unlockSession('password1');
      const result2 = await storage.unlockSession('password2');
      const result3 = await storage.unlockSession('password3');

      expect(new TextDecoder().decode(result1!.data)).toBe('Session 1');
      expect(new TextDecoder().decode(result2!.data)).toBe('Session 2');
      expect(new TextDecoder().decode(result3!.data)).toBe('Session 3');
    });

    it('should handle large data', async () => {
      const largeData = new Uint8Array(10 * 1024 * 1024); // 10 MB
      crypto.getRandomValues(largeData);

      await storage.createSession('large-pass', largeData);

      const result = await storage.unlockSession('large-pass');
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(largeData);
    });

    it('should handle empty data', async () => {
      const emptyData = new Uint8Array(0);
      await storage.createSession('empty-pass', emptyData);

      const result = await storage.unlockSession('empty-pass');
      expect(result).not.toBeNull();
      expect(result!.data.length).toBe(0);
    });

    it('should throw if not initialized', async () => {
      const uninitStorage = new DeniableStorage({ adapter: new MemoryAdapter() });
      const data = new TextEncoder().encode('test');

      await expect(uninitStorage.createSession('pass', data)).rejects.toThrow(
        'Storage not initialized',
      );
    });
  });

  describe('unlockSession', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should return null for non-existent session', async () => {
      const result = await storage.unlockSession('non-existent-password');
      expect(result).toBeNull();
    });

    it('should return null for wrong password', async () => {
      const data = new TextEncoder().encode('secret');
      await storage.createSession('correct-password', data);

      const result = await storage.unlockSession('wrong-password');
      expect(result).toBeNull();
    });

    it('should return session metadata', async () => {
      const data = new TextEncoder().encode('test data');
      const beforeCreate = Date.now();

      await storage.createSession('password', data);

      const afterCreate = Date.now();
      const result = await storage.unlockSession('password');

      expect(result).not.toBeNull();
      expect(result!.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(result!.createdAt).toBeLessThanOrEqual(afterCreate);
      expect(result!.updatedAt).toBe(result!.createdAt);
    });

    it('should handle unicode data correctly', async () => {
      const unicodeData = new TextEncoder().encode('Hello 🌍! Привет! 你好!');
      await storage.createSession('unicode-pass', unicodeData);

      const result = await storage.unlockSession('unicode-pass');
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.data)).toBe('Hello 🌍! Привет! 你好!');
    });
  });

  describe('updateSession', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should update existing session data', async () => {
      const originalData = new TextEncoder().encode('original data');
      await storage.createSession('password', originalData);

      const newData = new TextEncoder().encode('updated data');
      await storage.updateSession('password', newData);

      const result = await storage.unlockSession('password');
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.data)).toBe('updated data');
    });

    it('should update timestamps', async () => {
      const data = new TextEncoder().encode('data');
      await storage.createSession('password', data);

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newData = new TextEncoder().encode('new data');
      await storage.updateSession('password', newData);

      const result = await storage.unlockSession('password');
      expect(result).not.toBeNull();
      expect(result!.updatedAt).toBeGreaterThan(result!.createdAt);
    });

    it('should handle size changes', async () => {
      const smallData = new TextEncoder().encode('small');
      await storage.createSession('password', smallData);

      const largeData = new Uint8Array(5 * 1024 * 1024); // 5 MB
      crypto.getRandomValues(largeData);
      await storage.updateSession('password', largeData);

      const result = await storage.unlockSession('password');
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(largeData);
    });

    it('should throw if session does not exist', async () => {
      const data = new TextEncoder().encode('data');

      await expect(storage.updateSession('non-existent', data)).rejects.toThrow(
        'Session not found',
      );
    });

    it('should preserve createdAt timestamp', async () => {
      const data = new TextEncoder().encode('data');
      await storage.createSession('password', data);

      const result1 = await storage.unlockSession('password');
      const originalCreatedAt = result1!.createdAt;

      await storage.updateSession('password', new TextEncoder().encode('new data'));

      const result2 = await storage.unlockSession('password');
      expect(result2!.createdAt).toBe(originalCreatedAt);
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should delete a session', async () => {
      const data = new TextEncoder().encode('to be deleted');
      await storage.createSession('password', data);

      // Verify session exists
      let result = await storage.unlockSession('password');
      expect(result).not.toBeNull();

      // Delete it
      await storage.deleteSession('password');

      // Verify session is gone
      result = await storage.unlockSession('password');
      expect(result).toBeNull();
    });

    it('should throw if session does not exist', async () => {
      await expect(storage.deleteSession('non-existent')).rejects.toThrow(
        'Session not found',
      );
    });

    it('should not affect other sessions', async () => {
      await storage.createSession('pass1', new TextEncoder().encode('data1'));
      await storage.createSession('pass2', new TextEncoder().encode('data2'));
      await storage.createSession('pass3', new TextEncoder().encode('data3'));

      await storage.deleteSession('pass2');

      const result1 = await storage.unlockSession('pass1');
      const result2 = await storage.unlockSession('pass2');
      const result3 = await storage.unlockSession('pass3');

      expect(result1).not.toBeNull();
      expect(result2).toBeNull();
      expect(result3).not.toBeNull();
    });

    it('should securely wipe data', async () => {
      const sensitiveData = new TextEncoder().encode('TOP SECRET');
      await storage.createSession('password', sensitiveData);

      await storage.deleteSession('password');

      // Try to find the original data in storage (should not exist)
      const dataBlob = await adapter.readDataBlob();
      const dataStr = new TextDecoder().decode(dataBlob);

      // The plaintext should not be present
      expect(dataStr).not.toContain('TOP SECRET');
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should return storage statistics', async () => {
      const stats = await storage.getStats();

      expect(stats.addressingBlobSize).toBe(2 * 1024 * 1024);
      expect(stats.dataBlobSize).toBeGreaterThan(0);
    });

    it('should reflect data blob growth', async () => {
      const stats1 = await storage.getStats();

      await storage.createSession('pass', new TextEncoder().encode('data'));

      const stats2 = await storage.getStats();
      expect(stats2.dataBlobSize).toBeGreaterThan(stats1.dataBlobSize);
    });
  });

  describe('secureWipeAll', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should wipe all storage', async () => {
      await storage.createSession('pass1', new TextEncoder().encode('data1'));
      await storage.createSession('pass2', new TextEncoder().encode('data2'));

      await storage.secureWipeAll();

      // Adapter should have no data
      await expect(adapter.readAddressingBlob()).rejects.toThrow();
      await expect(adapter.readDataBlob()).rejects.toThrow();
    });
  });

  describe('multi-session scenarios', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should handle many sessions', async () => {
      const sessionCount = 20;

      // Create sessions
      for (let i = 0; i < sessionCount; i++) {
        const data = new TextEncoder().encode(`Session ${i} data`);
        await storage.createSession(`password-${i}`, data);
      }

      // Verify all sessions
      for (let i = 0; i < sessionCount; i++) {
        const result = await storage.unlockSession(`password-${i}`);
        expect(result).not.toBeNull();
        expect(new TextDecoder().decode(result!.data)).toBe(`Session ${i} data`);
      }
    });

    it('should handle mixed operations', async () => {
      // Create
      await storage.createSession('pass1', new TextEncoder().encode('data1'));
      await storage.createSession('pass2', new TextEncoder().encode('data2'));
      await storage.createSession('pass3', new TextEncoder().encode('data3'));

      // Update
      await storage.updateSession('pass2', new TextEncoder().encode('updated2'));

      // Delete
      await storage.deleteSession('pass1');

      // Create new
      await storage.createSession('pass4', new TextEncoder().encode('data4'));

      // Verify final state
      expect(await storage.unlockSession('pass1')).toBeNull();
      expect(new TextDecoder().decode((await storage.unlockSession('pass2'))!.data)).toBe(
        'updated2',
      );
      expect(new TextDecoder().decode((await storage.unlockSession('pass3'))!.data)).toBe(
        'data3',
      );
      expect(new TextDecoder().decode((await storage.unlockSession('pass4'))!.data)).toBe(
        'data4',
      );
    });
  });

  describe('edge cases', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should handle empty password', async () => {
      const data = new TextEncoder().encode('data with empty password');
      await storage.createSession('', data);

      const result = await storage.unlockSession('');
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.data)).toBe('data with empty password');
    });

    it('should handle very long password', async () => {
      const longPassword = 'a'.repeat(1000);
      const data = new TextEncoder().encode('data');

      await storage.createSession(longPassword, data);

      const result = await storage.unlockSession(longPassword);
      expect(result).not.toBeNull();
    });

    it('should handle special characters in password', async () => {
      const password = '🔐 p@ssw0rd! #123 🚀 \n\t"\'\\';
      const data = new TextEncoder().encode('data');

      await storage.createSession(password, data);

      const result = await storage.unlockSession(password);
      expect(result).not.toBeNull();
    });

    it('should distinguish similar passwords', async () => {
      await storage.createSession('password', new TextEncoder().encode('data1'));
      await storage.createSession('password1', new TextEncoder().encode('data2'));
      await storage.createSession('password ', new TextEncoder().encode('data3'));

      const result1 = await storage.unlockSession('password');
      const result2 = await storage.unlockSession('password1');
      const result3 = await storage.unlockSession('password ');

      expect(new TextDecoder().decode(result1!.data)).toBe('data1');
      expect(new TextDecoder().decode(result2!.data)).toBe('data2');
      expect(new TextDecoder().decode(result3!.data)).toBe('data3');
    });
  });
});
