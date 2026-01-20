import { describe, it, expect } from 'vitest';
import {
  generateUserId as generate,
  isValidUserId,
  decodeUserId,
} from 'gossip-sdk';

describe('utils/userId.ts - generate() (requires WASM)', () => {
  describe('generate()', () => {
    it('should generate a valid userId without password', async () => {
      const userId = await generate();

      expect(userId).toBeTruthy();
      expect(typeof userId).toBe('string');
      expect(userId.startsWith('gossip1')).toBe(true);
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate a valid userId with password', async () => {
      const userId = await generate('mypassword123');

      expect(userId).toBeTruthy();
      expect(typeof userId).toBe('string');
      expect(userId.startsWith('gossip1')).toBe(true);
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate same userId when called without password (deterministic)', async () => {
      // When no password is provided, the key derivation is deterministic
      const userId1 = await generate();
      const userId2 = await generate();

      expect(userId1).toBe(userId2);
    });

    it('should generate userId that can be decoded', async () => {
      const userId = await generate();
      const decoded = decodeUserId(userId);

      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBe(32);
    });

    it('should generate different userIds with different passwords', async () => {
      const userId1 = await generate('password1');
      const userId2 = await generate('password2');

      expect(userId1).not.toBe(userId2);
    });

    it('should handle empty string password', async () => {
      const userId = await generate('');

      expect(userId).toBeTruthy();
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate valid 32-byte decoded ids', async () => {
      for (let i = 0; i < 5; i++) {
        const userId = await generate();
        const decoded = decodeUserId(userId);
        expect(decoded.length).toBe(32);
      }
    });
  });
});
