/**
 * SyncStore Tests
 *
 * Tests for the syncStore Zustand store that manages synchronization
 * of async tasks to prevent concurrent execution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useSyncStore,
  SyncKey,
  SyncKeyNotFreeError,
} from '../../src/stores/syncStore';

describe('SyncStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useSyncStore.setState({
      isRunning: {
        [SyncKey.RESEND_ANNOUNCEMENT]: false,
        [SyncKey.FETCH_ANNOUNCEMENT]: false,
      },
    });
  });

  describe('Initial State', () => {
    it('should initialize with all sync keys set to false', () => {
      const isRunning = useSyncStore.getState().isRunning;

      expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
      expect(isRunning[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
    });
  });

  describe('areRunning', () => {
    it('should return false when no keys are running', () => {
      const areRunning = useSyncStore.getState().areRunning;

      expect(areRunning([SyncKey.RESEND_ANNOUNCEMENT])).toBe(false);
      expect(areRunning([SyncKey.FETCH_ANNOUNCEMENT])).toBe(false);
      expect(
        areRunning([SyncKey.RESEND_ANNOUNCEMENT, SyncKey.FETCH_ANNOUNCEMENT])
      ).toBe(false);
    });

    it('should return true when all specified keys are running', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const areRunning = useSyncStore.getState().areRunning;

      // Acquire lock for RESEND_ANNOUNCEMENT
      await executeIfLockFree([SyncKey.RESEND_ANNOUNCEMENT], [], async () => {
        // While inside, check if it's running
        expect(areRunning([SyncKey.RESEND_ANNOUNCEMENT])).toBe(true);
        return 'done';
      });
    });

    it('should return false when not all specified keys are running', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const areRunning = useSyncStore.getState().areRunning;

      // Acquire lock for only one key
      await executeIfLockFree([SyncKey.RESEND_ANNOUNCEMENT], [], async () => {
        // Check if both keys are running (should be false)
        expect(
          areRunning([SyncKey.RESEND_ANNOUNCEMENT, SyncKey.FETCH_ANNOUNCEMENT])
        ).toBe(false);
        return 'done';
      });
    });

    it('should return false when called with empty array', () => {
      const areRunning = useSyncStore.getState().areRunning;
      expect(areRunning([])).toBe(false);
    });
  });

  describe('executeIfLockFree', () => {
    it('should successfully execute function when locks are free', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      const result = await executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [SyncKey.FETCH_ANNOUNCEMENT],
        async () => {
          return 'success';
        }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('success');
      }
    });

    it('when called with empty arrays should run function without locking any key', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const isRunning = () => useSyncStore.getState().isRunning;

      // Set a flag to ensure our function ran
      let ran = false;

      const result = await executeIfLockFree(
        [], // no acquireSyncKeys
        [], // no notRunningSyncKeys
        async () => {
          ran = true;
          // No key should be locked
          expect(isRunning()[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
          expect(isRunning()[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
          return 'ok';
        }
      );

      // Function should have run
      expect(ran).toBe(true);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('ok');

      // Afterward, still nothing locked
      expect(isRunning()[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
      expect(isRunning()[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
    });

    it('called without acquire key but with exclude key should work', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const isRunning = () => useSyncStore.getState().isRunning;

      // RESEND_ANNOUNCEMENT is not running at the start
      expect(isRunning()[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);

      // Should execute successfully, even though we're specifying notRunningSyncKeys
      let ran = false;
      const result = await executeIfLockFree(
        [], // no acquireSyncKeys
        [SyncKey.RESEND_ANNOUNCEMENT], // exclude key, but it's not running
        async () => {
          ran = true;
          // During execution, still nothing is running
          expect(isRunning()[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
          expect(isRunning()[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
          return 'exclude-but-not-acquire';
        }
      );

      expect(ran).toBe(true);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('exclude-but-not-acquire');
      // Confirm that nothing is running after execution
      expect(isRunning()[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
      expect(isRunning()[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
    });

    it('should return error when notRunningSyncKeys are already running', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      // First, acquire a lock
      const firstExecution = executeIfLockFree(
        [SyncKey.FETCH_ANNOUNCEMENT],
        [],
        async () => {
          // Wait a bit to ensure lock is held
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'first';
        }
      );

      // Try to execute with notRunningSyncKeys that includes the running key
      const secondResult = await executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [SyncKey.FETCH_ANNOUNCEMENT], // This key is running, so should fail
        async () => {
          return 'should not execute';
        }
      );

      expect(secondResult.success).toBe(false);
      if (!secondResult.success) {
        expect(secondResult.error).toBeInstanceOf(SyncKeyNotFreeError);
        expect(
          (secondResult.error as SyncKeyNotFreeError).notAvailableSyncKeys
        ).toContain(SyncKey.FETCH_ANNOUNCEMENT);
      }

      // Wait for first execution to complete
      await firstExecution;
    });

    it('should acquire locks for acquireSyncKeys', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      await executeIfLockFree([SyncKey.RESEND_ANNOUNCEMENT], [], async () => {
        // Check that the lock is acquired (get current state inside function)
        const isRunning = useSyncStore.getState().isRunning;
        expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(true);
        return 'done';
      });
    });

    it('should release locks after successful execution', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      await executeIfLockFree([SyncKey.RESEND_ANNOUNCEMENT], [], async () => {
        return 'success';
      });

      // After execution, lock should be released (get current state)
      const isRunning = useSyncStore.getState().isRunning;
      expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
    });

    it('should release locks after function throws error', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      await executeIfLockFree([SyncKey.RESEND_ANNOUNCEMENT], [], async () => {
        throw new Error('Test error');
      });

      // After error, lock should still be released (get current state)
      const isRunning = useSyncStore.getState().isRunning;
      expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
    });

    it('should return error result when function throws', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const testError = new Error('Test error');

      const result = await executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [],
        async () => {
          throw testError;
        }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(SyncKeyNotFreeError);
        expect((result.error as SyncKeyNotFreeError).error).toBe(testError);
      }
    });

    it('should handle non-Error thrown values', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      const result = await executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [],
        async () => {
          throw 'String error';
        }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(SyncKeyNotFreeError);
        expect((result.error as SyncKeyNotFreeError).error).toBeInstanceOf(
          Error
        );
        expect((result.error as SyncKeyNotFreeError).error?.message).toBe(
          'String error'
        );
      }
    });

    it('should acquire multiple locks simultaneously', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      await executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT, SyncKey.FETCH_ANNOUNCEMENT],
        [],
        async () => {
          // Both locks should be acquired (get current state inside function)
          const isRunning = useSyncStore.getState().isRunning;
          expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(true);
          expect(isRunning[SyncKey.FETCH_ANNOUNCEMENT]).toBe(true);
          return 'done';
        }
      );

      // Both locks should be released (get current state after execution)
      const isRunning = useSyncStore.getState().isRunning;
      expect(isRunning[SyncKey.RESEND_ANNOUNCEMENT]).toBe(false);
      expect(isRunning[SyncKey.FETCH_ANNOUNCEMENT]).toBe(false);
    });

    it('should prevent concurrent execution when notRunningSyncKeys includes acquireSyncKeys', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;

      const executionOrder: string[] = [];

      // First execution acquires the key
      const firstExecution = executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [],
        async () => {
          executionOrder.push('first-start');
          await new Promise(resolve => setTimeout(resolve, 50));
          executionOrder.push('first-end');
          return 'first';
        }
      );

      // Small delay to ensure first one starts and acquires the lock
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second execution should fail because the key is already running
      const secondResult = await executeIfLockFree(
        [SyncKey.FETCH_ANNOUNCEMENT],
        [SyncKey.RESEND_ANNOUNCEMENT], // This key is running, so should fail
        async () => {
          executionOrder.push('second-start');
          return 'second';
        }
      );

      await firstExecution;

      // First should execute, second should fail
      expect(executionOrder).toContain('first-start');
      expect(executionOrder).toContain('first-end');
      expect(executionOrder).not.toContain('second-start');
      expect(secondResult.success).toBe(false);
    });

    it('should allow concurrent execution when acquireSyncKeys and notRunningSyncKeys are disjoint', async () => {
      const executeIfLockFree = useSyncStore.getState().executeIfLockFree;
      const order: string[] = [];

      // Promise controls
      let firstStarted: (() => void) | undefined;
      let secondStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>(resolve => {
        firstStarted = resolve;
      });
      const secondStartedPromise = new Promise<void>(resolve => {
        secondStarted = resolve;
      });

      // First execution: acquires RESEND_ANNOUNCEMENT
      const first = executeIfLockFree(
        [SyncKey.RESEND_ANNOUNCEMENT],
        [SyncKey.RESEND_ANNOUNCEMENT],
        async () => {
          order.push('first-start');
          if (firstStarted) firstStarted();
          // Wait for the second to start to ensure overlap
          await secondStartedPromise;
          order.push('first-end');
          return '1';
        }
      );

      // Second execution: acquires FETCH_ANNOUNCEMENT
      const second = executeIfLockFree(
        [SyncKey.FETCH_ANNOUNCEMENT],
        [SyncKey.FETCH_ANNOUNCEMENT],
        async () => {
          order.push('second-start');
          if (secondStarted) secondStarted();
          // Wait for the first to start to ensure overlap
          await firstStartedPromise;
          order.push('second-end');
          return '2';
        }
      );

      // Both should run concurrently without blocking
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(order).toContain('first-start');
      expect(order).toContain('second-start');
      expect(order).toContain('first-end');
      expect(order).toContain('second-end');
      // Confirm no blocking -- either can start first
      expect(order.indexOf('first-start')).toBeLessThan(
        order.indexOf('first-end')
      );
      expect(order.indexOf('second-start')).toBeLessThan(
        order.indexOf('second-end')
      );
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
    });
  });

  describe('SyncKeyNotFreeError', () => {
    it('should create error with notAvailableSyncKeys', () => {
      const keys = [SyncKey.RESEND_ANNOUNCEMENT, SyncKey.FETCH_ANNOUNCEMENT];
      const error = new SyncKeyNotFreeError(keys);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SyncKeyNotFreeError);
      expect(error.name).toBe('SyncKeyNotFreeError');
      expect(error.notAvailableSyncKeys).toEqual(keys);
      expect(error.message).toContain('resend announcement');
      expect(error.message).toContain('fetch announcement');
    });

    it('should create error with wrapped error', () => {
      const wrappedError = new Error('Wrapped error');
      const error = new SyncKeyNotFreeError([], wrappedError);

      expect(error.error).toBe(wrappedError);
      expect(error.message).toBe('Wrapped error');
      expect(error.notAvailableSyncKeys).toEqual([]);
    });
  });
});
