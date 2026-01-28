/**
 * Gossip Storage End-to-End Tests
 *
 * Tests the full storage layer with wa-sqlite integration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getStorage, getNodeFs } from './setup';

describe('Storage E2E Tests', () => {
  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================

  describe('Session Management', () => {
    it('should initialize storage with 2MB addressing blob', async () => {
      const storage = getStorage();

      await storage.createSession('test-password');

      const stats = getNodeFs().getStats();
      expect(stats.addressingSize).toBe(2 * 1024 * 1024);
    });

    it('should create a new session', async () => {
      const storage = getStorage();

      expect(storage.isUnlocked()).toBe(false);

      const success = await storage.createSession('test-password-123');

      expect(success).toBe(true);
      expect(storage.isUnlocked()).toBe(true);
    });

    it('should lock and unlock session with correct password', async () => {
      const storage = getStorage();

      await storage.createSession('my-secret-password');
      expect(storage.isUnlocked()).toBe(true);

      // Lock session
      await storage.lockSession();
      expect(storage.isUnlocked()).toBe(false);

      // Unlock with correct password
      const success = await storage.unlockSession('my-secret-password');
      expect(success).toBe(true);
      expect(storage.isUnlocked()).toBe(true);
    });

    it('should reject unlock with wrong password', async () => {
      const storage = getStorage();

      await storage.createSession('correct-password');
      await storage.lockSession();

      // Try to unlock with wrong password
      const success = await storage.unlockSession('wrong-password');

      expect(success).toBe(false);
      expect(storage.isUnlocked()).toBe(false);
    });

    it('should maintain session state across operations', async () => {
      const storage = getStorage();

      await storage.createSession('password');

      // Perform some SQL operations
      await storage.sql('CREATE TABLE test (id INTEGER PRIMARY KEY)');
      await storage.sql('INSERT INTO test (id) VALUES (1)');
      storage.flushData();

      // Session should still be unlocked
      expect(storage.isUnlocked()).toBe(true);

      // Lock and verify
      await storage.lockSession();
      expect(storage.isUnlocked()).toBe(false);
    });
  });

  // ============================================================
  // SQL OPERATIONS
  // ============================================================

  describe('SQL Operations', () => {
    beforeEach(async () => {
      const storage = getStorage();
      await storage.createSession('test-password');
    });

    it('should create table and insert data', async () => {
      const storage = getStorage();

      await storage.sql(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'
      );

      await storage.sql("INSERT INTO users (name) VALUES ('Alice')");

      const result = await storage.sql('SELECT * FROM users');
      expect(result.rows.length).toBe(1);
      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rows[0]).toEqual([1, 'Alice']);
    });

    it('should select data', async () => {
      const storage = getStorage();

      await storage.sql(
        'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)'
      );
      await storage.sql(
        "INSERT INTO items (value) VALUES ('one'), ('two'), ('three')"
      );

      const result = await storage.sql('SELECT * FROM items ORDER BY id');

      expect(result.rows.length).toBe(3);
      expect(result.rows[0][1]).toBe('one');
      expect(result.rows[1][1]).toBe('two');
      expect(result.rows[2][1]).toBe('three');
    });

    it('should update data', async () => {
      const storage = getStorage();

      await storage.sql('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
      await storage.sql("INSERT INTO kv (key, value) VALUES ('foo', 'bar')");
      await storage.sql("UPDATE kv SET value = 'baz' WHERE key = 'foo'");

      const result = await storage.sql(
        "SELECT value FROM kv WHERE key = 'foo'"
      );

      expect(result.rows[0][0]).toBe('baz');
    });

    it('should delete data', async () => {
      const storage = getStorage();

      await storage.sql('CREATE TABLE temp (id INTEGER PRIMARY KEY)');
      await storage.sql('INSERT INTO temp (id) VALUES (1), (2), (3)');
      await storage.sql('DELETE FROM temp WHERE id = 2');

      const result = await storage.sql('SELECT COUNT(*) as count FROM temp');

      expect(result.rows[0][0]).toBe(2);
    });

    it('should handle binary data', async () => {
      const storage = getStorage();

      await storage.sql(
        'CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)'
      );
      await storage.sql("INSERT INTO blobs (data) VALUES (X'DEADBEEF')");

      const result = await storage.sql('SELECT HEX(data) as hex FROM blobs');

      expect(result.rows[0][0]).toBe('DEADBEEF');
    });

    it('should throw for invalid SQL', async () => {
      const storage = getStorage();

      await expect(
        storage.sql('SELECT * FROM nonexistent_table')
      ).rejects.toThrow();
    });
  });

  // ============================================================
  // DATA PERSISTENCE
  // ============================================================

  describe('Data Persistence', () => {
    it('should persist data across lock/unlock cycles', async () => {
      const storage = getStorage();

      await storage.createSession('persist-test-pwd');

      // Create table and insert data
      await storage.sql(
        'CREATE TABLE persist_test (id INTEGER PRIMARY KEY, value TEXT)'
      );
      await storage.sql(
        "INSERT INTO persist_test (value) VALUES ('persistent data')"
      );
      storage.flushData();

      // Lock session
      await storage.lockSession();

      // Unlock and verify data persisted
      const unlockSuccess = await storage.unlockSession('persist-test-pwd');
      expect(unlockSuccess).toBe(true);

      const result = await storage.sql('SELECT value FROM persist_test');
      expect(result.rows[0][0]).toBe('persistent data');
    });

    it('should flush data to disk', async () => {
      const storage = getStorage();

      await storage.createSession('flush-test');

      await storage.sql('CREATE TABLE flush_test (data TEXT)');
      await storage.sql("INSERT INTO flush_test (data) VALUES ('test')");
      const flushSuccess = storage.flushData();

      expect(flushSuccess).toBe(true);

      const stats = getNodeFs().getStats();
      expect(stats.flushCount).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // MULTI-SESSION SUPPORT
  // ============================================================

  describe('Multi-Session Support', () => {
    it('should support multiple sessions with different passwords', async () => {
      const storage = getStorage();

      // Create first session
      await storage.createSession('password-alice');
      await storage.sql('CREATE TABLE alice_data (id INTEGER PRIMARY KEY)');
      storage.flushData();
      // Capture root address AFTER flush (root block may move during flush)
      const aliceRoot = storage.getRootAddress();
      await storage.lockSession();

      // Create second session
      await storage.createSession('password-bob');
      await storage.sql('CREATE TABLE bob_data (id INTEGER PRIMARY KEY)');
      storage.flushData();
      const bobRoot = storage.getRootAddress();
      await storage.lockSession();

      // Sessions should have different root addresses
      expect(aliceRoot).not.toBe(bobRoot);

      // Unlock Alice's session
      expect(await storage.unlockSession('password-alice')).toBe(true);
      expect(storage.getRootAddress()).toBe(aliceRoot);
      await storage.lockSession();

      // Unlock Bob's session
      expect(await storage.unlockSession('password-bob')).toBe(true);
      expect(storage.getRootAddress()).toBe(bobRoot);
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe('Edge Cases', () => {
    it('should handle special characters in password', async () => {
      const storage = getStorage();

      const specialPassword = 'p@$$w0rd!#$%^&*()_+-=[]{}|;:,.<>?/~`éàü中文';
      const success = await storage.createSession(specialPassword);
      expect(success).toBe(true);

      await storage.lockSession();

      const unlockSuccess = await storage.unlockSession(specialPassword);
      expect(unlockSuccess).toBe(true);
    });

    it('should handle very long password', async () => {
      const storage = getStorage();

      const longPassword = 'a'.repeat(10000);
      const success = await storage.createSession(longPassword);
      expect(success).toBe(true);

      await storage.lockSession();

      const unlockSuccess = await storage.unlockSession(longPassword);
      expect(unlockSuccess).toBe(true);
    });

    it('should handle large text in SQL', async () => {
      const storage = getStorage();

      await storage.createSession('test');
      await storage.sql('CREATE TABLE docs (content TEXT)');

      const largeText = 'x'.repeat(50000);
      await storage.sql(`INSERT INTO docs (content) VALUES ('${largeText}')`);

      const result = await storage.sql(
        'SELECT LENGTH(content) as len FROM docs'
      );
      expect(result.rows[0][0]).toBe(50000);
    });
  });

  // ============================================================
  // STRESS TESTS
  // ============================================================

  // Skip locally - these are slow due to Argon2id key derivation
  describe.skip('Stress Tests', () => {
    it('should handle many inserts', async () => {
      const storage = getStorage();

      await storage.createSession('stress-test');
      await storage.sql(
        'CREATE TABLE stress (id INTEGER PRIMARY KEY, value INTEGER)'
      );

      // Insert 100 rows
      for (let i = 0; i < 100; i++) {
        await storage.sql(`INSERT INTO stress (value) VALUES (${i})`);
      }

      const result = await storage.sql('SELECT COUNT(*) as count FROM stress');
      expect(result.rows[0][0]).toBe(100);
    });

    it('should handle lock/unlock cycles', async () => {
      const storage = getStorage();

      await storage.createSession('cycle-test');
      await storage.sql('CREATE TABLE cycle_test (value INTEGER)');
      await storage.sql('INSERT INTO cycle_test (value) VALUES (42)');
      storage.flushData();

      // Perform 5 lock/unlock cycles
      for (let i = 0; i < 5; i++) {
        await storage.lockSession();
        expect(storage.isUnlocked()).toBe(false);

        const success = await storage.unlockSession('cycle-test');
        expect(success).toBe(true);
        expect(storage.isUnlocked()).toBe(true);

        // Verify data still accessible
        const result = await storage.sql('SELECT value FROM cycle_test');
        expect(result.rows[0][0]).toBe(42);
      }
    });
  });

  // ============================================================
  // FILESYSTEM VERIFICATION
  // ============================================================

  describe('Filesystem Verification', () => {
    it('should write to real files on disk', async () => {
      const storage = getStorage();

      await storage.createSession('fs-test');
      await storage.sql('CREATE TABLE fs_test (data TEXT)');
      await storage.sql("INSERT INTO fs_test (data) VALUES ('test data')");
      storage.flushData();

      const stats = getNodeFs().getStats();

      expect(stats.addressingSize).toBe(2 * 1024 * 1024);
      expect(stats.dataSize).toBeGreaterThan(0);
      expect(stats.writeCount).toBeGreaterThan(0);
    });

    it('should use addressing.bin and data.bin files', async () => {
      const storage = getStorage();

      // After init, addressing.bin should be exactly 2MB
      await storage.createSession('file-test');

      expect(getNodeFs().getSize(0)).toBe(2 * 1024 * 1024);

      await storage.sql('CREATE TABLE file_test (data TEXT)');
      await storage.sql("INSERT INTO file_test (data) VALUES ('data')");
      storage.flushData();

      // data.bin should now have data
      expect(getNodeFs().getSize(1)).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // SECURITY PROPERTIES
  // ============================================================

  describe('Security Properties', () => {
    it('should create random addressing blob (not zeros)', async () => {
      const storage = getStorage();

      await storage.createSession('security-test');

      // Read a sample of the addressing blob
      const sample = getNodeFs().read(0, 0, 1024);

      // Should not be all zeros
      const hasNonZero = sample.some(b => b !== 0);
      expect(hasNonZero).toBe(true);

      // Check entropy - count unique bytes
      const uniqueBytes = new Set(sample);
      expect(uniqueBytes.size).toBeGreaterThan(100);
    });

    it('should write different slots for different passwords', async () => {
      const storage = getStorage();

      // Create first session and capture blob
      await storage.createSession('password-1');
      const blob1 = new Uint8Array(getNodeFs().read(0, 0, 2 * 1024 * 1024));
      await storage.lockSession();

      // Create second session
      await storage.createSession('password-2');
      const blob2 = new Uint8Array(getNodeFs().read(0, 0, 2 * 1024 * 1024));
      await storage.lockSession();

      // Blobs should be different
      let differences = 0;
      for (let i = 0; i < blob1.length; i++) {
        if (blob1[i] !== blob2[i]) differences++;
      }

      // Should have at least 46 slots × 32 bytes = 1472 bytes different
      expect(differences).toBeGreaterThan(1000);
    });

    it('should not expose password in files', async () => {
      const storage = getStorage();
      const password = 'super-secret-password-12345';

      await storage.createSession(password);
      await storage.lockSession();

      // Read all file contents
      const addressing = getNodeFs().read(0, 0, getNodeFs().getSize(0));
      const data = getNodeFs().read(1, 0, getNodeFs().getSize(1));

      // Convert to string to search for password
      const addressingStr = Buffer.from(addressing).toString('utf8');
      const dataStr = Buffer.from(data).toString('utf8');

      // Password should not appear in plaintext
      expect(addressingStr).not.toContain(password);
      expect(dataStr).not.toContain(password);
    });
  });
});
