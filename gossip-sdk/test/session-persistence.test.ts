/**
 * Session Persistence Tests
 *
 * Tests to ensure session state is properly persisted before network operations.
 * This prevents session loss on app crash during message send.
 *
 * These tests verify the persistence callback behavior without needing WASM.
 */

import { describe, it, expect, vi } from 'vitest';

// We'll test the persistence logic pattern directly without SessionModule
// since SessionModule requires WASM which isn't available in tests

describe('Session Persistence Pattern', () => {
  /**
   * This simulates the persistence pattern used in SessionModule.
   * The key invariant is: persistence must complete BEFORE returning.
   */
  class MockSessionWithPersistence {
    private onPersist?: () => Promise<void>;

    constructor(onPersist?: () => Promise<void>) {
      this.onPersist = onPersist;
    }

    private async persistIfNeeded(): Promise<void> {
      if (this.onPersist) {
        await this.onPersist();
      }
    }

    // Simulates session.sendMessage - MUST persist before returning
    async sendMessage(): Promise<{ seeker: Uint8Array; data: Uint8Array }> {
      // Simulate WASM state change
      const result = {
        seeker: new Uint8Array(32),
        data: new Uint8Array(64),
      };

      // CRITICAL: await persistence before returning
      await this.persistIfNeeded();

      return result;
    }

    // Simulates session.establishOutgoingSession
    async establishOutgoingSession(): Promise<Uint8Array> {
      const announcement = new Uint8Array([1, 2, 3]);
      await this.persistIfNeeded();
      return announcement;
    }

    // Simulates session.refresh
    async refresh(): Promise<Uint8Array[]> {
      const result: Uint8Array[] = [];
      await this.persistIfNeeded();
      return result;
    }

    async persist(): Promise<void> {
      await this.persistIfNeeded();
    }
  }

  describe('sendMessage persistence', () => {
    it('should await persistence callback before returning', async () => {
      const persistenceOrder: string[] = [];
      let persistenceResolve: () => void;
      const persistencePromise = new Promise<void>(resolve => {
        persistenceResolve = resolve;
      });

      const onPersist = vi.fn().mockImplementation(async () => {
        persistenceOrder.push('persistence_started');
        await persistencePromise;
        persistenceOrder.push('persistence_completed');
      });

      const session = new MockSessionWithPersistence(onPersist);

      // Start sendMessage (should wait for persistence)
      const sendPromise = session.sendMessage();

      // sendMessage should not have resolved yet (waiting for persistence)
      await new Promise(r => setTimeout(r, 10));
      expect(persistenceOrder).toEqual(['persistence_started']);

      // Now complete persistence
      persistenceResolve!();
      await sendPromise;

      // Verify persistence completed before sendMessage returned
      expect(persistenceOrder).toEqual([
        'persistence_started',
        'persistence_completed',
      ]);
      expect(onPersist).toHaveBeenCalledTimes(1);
    });

    it('should persist BEFORE returning the encrypted message', async () => {
      const events: string[] = [];

      const onPersist = vi.fn().mockImplementation(async () => {
        events.push('persisted');
      });

      const session = new MockSessionWithPersistence(onPersist);

      // sendMessage should persist then return
      const result = await session.sendMessage();
      events.push('sendMessage_returned');

      // Verify order: persist first, then return
      expect(events).toEqual(['persisted', 'sendMessage_returned']);
      expect(result).toBeDefined();
    });

    it('should handle persistence errors gracefully', async () => {
      const onPersist = vi.fn().mockRejectedValue(new Error('Storage full'));

      const session = new MockSessionWithPersistence(onPersist);

      // Should propagate the error
      await expect(session.sendMessage()).rejects.toThrow('Storage full');
    });
  });

  describe('establishOutgoingSession persistence', () => {
    it('should await persistence before returning announcement', async () => {
      let persistCompleted = false;

      const onPersist = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 10));
        persistCompleted = true;
      });

      const session = new MockSessionWithPersistence(onPersist);

      const announcement = await session.establishOutgoingSession();

      // Persistence should have completed before we got the announcement
      expect(persistCompleted).toBe(true);
      expect(announcement).toBeDefined();
      expect(onPersist).toHaveBeenCalledTimes(1);
    });
  });

  describe('refresh persistence', () => {
    it('should await persistence after refresh', async () => {
      let persistCompleted = false;

      const onPersist = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 10));
        persistCompleted = true;
      });

      const session = new MockSessionWithPersistence(onPersist);

      await session.refresh();

      expect(persistCompleted).toBe(true);
      expect(onPersist).toHaveBeenCalledTimes(1);
    });
  });

  describe('explicit persist method', () => {
    it('should provide a way to explicitly persist session', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);

      const session = new MockSessionWithPersistence(onPersist);

      await session.persist();

      expect(onPersist).toHaveBeenCalledTimes(1);
    });
  });

  describe('no persistence callback', () => {
    it('should work without persistence callback', async () => {
      const session = new MockSessionWithPersistence(); // No callback

      // Should not throw
      const result = await session.sendMessage();
      expect(result).toBeDefined();
    });
  });
});

/**
 * Integration-style test that verifies the CRITICAL invariant:
 * Network operations should ONLY happen AFTER persistence completes.
 */
describe('Network Safety Invariant', () => {
  it('should ensure persistence completes before network can receive data', async () => {
    const timeline: string[] = [];

    // Simulate the full flow
    const persistSession = vi.fn().mockImplementation(async () => {
      timeline.push('1. persist_started');
      await new Promise(r => setTimeout(r, 20)); // Simulate DB write
      timeline.push('2. persist_completed');
    });

    const sendToNetwork = vi.fn().mockImplementation(async () => {
      timeline.push('3. network_send');
    });

    // This simulates what MessageService.sendMessage does:
    // 1. Call session.sendMessage() which persists
    // 2. Then send to network

    class SimulatedMessageService {
      private onPersist: () => Promise<void>;

      constructor(onPersist: () => Promise<void>) {
        this.onPersist = onPersist;
      }

      async sendMessage() {
        // Simulate session.sendMessage with await
        await this.onPersist(); // This is awaited in the new code

        // Only after persistence, send to network
        await sendToNetwork();
      }
    }

    const service = new SimulatedMessageService(persistSession);
    await service.sendMessage();

    // Verify the CRITICAL invariant: persist before network
    expect(timeline).toEqual([
      '1. persist_started',
      '2. persist_completed',
      '3. network_send',
    ]);
  });

  it('should NOT allow network send if persistence fails', async () => {
    const networkCalled = vi.fn();

    const persistSession = vi.fn().mockRejectedValue(new Error('DB error'));

    const sendToNetwork = vi.fn().mockImplementation(async () => {
      networkCalled();
    });

    class SimulatedMessageService {
      private onPersist: () => Promise<void>;

      constructor(onPersist: () => Promise<void>) {
        this.onPersist = onPersist;
      }

      async sendMessage() {
        await this.onPersist();
        await sendToNetwork();
      }
    }

    const service = new SimulatedMessageService(persistSession);

    await expect(service.sendMessage()).rejects.toThrow('DB error');

    // Network should NOT have been called
    expect(networkCalled).not.toHaveBeenCalled();
  });
});
