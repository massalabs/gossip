/**
 * Promise Queue
 *
 * Ensures async operations are executed sequentially.
 * Used to serialize session manager operations per contact.
 */

type QueuedTask<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/**
 * A simple promise queue that executes tasks sequentially.
 * Tasks are processed in FIFO order.
 */
export class PromiseQueue {
  private queue: QueuedTask<unknown>[] = [];
  private processing = false;

  /**
   * Add a task to the queue. Returns a promise that resolves
   * when the task completes.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processNext();
    });
  }

  /**
   * Process the next task in the queue.
   */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const task = this.queue.shift()!;

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  /**
   * Check if the queue is currently processing.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get the number of pending tasks.
   */
  get pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Manages multiple queues keyed by string (e.g., contact ID).
 * Creates queues lazily on first use.
 */
export class QueueManager {
  private queues = new Map<string, PromiseQueue>();

  /**
   * Get or create a queue for the given key.
   */
  getQueue(key: string): PromiseQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new PromiseQueue();
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * Enqueue a task for a specific key.
   */
  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.getQueue(key).enqueue(fn);
  }

  /**
   * Clear all queues.
   */
  clear(): void {
    this.queues.clear();
  }
}
