/**
 * Queue utilities tests
 */

import { describe, it, expect } from 'vitest';
import { PromiseQueue, QueueManager } from '../../src/utils/queue.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('PromiseQueue', () => {
  it('executes tasks sequentially', async () => {
    const queue = new PromiseQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      order.push('first-start');
      await sleep(20);
      order.push('first-end');
    });

    queue.enqueue(async () => {
      order.push('second');
    });

    await sleep(50);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

describe('QueueManager', () => {
  it('queues tasks per key independently', async () => {
    const manager = new QueueManager();
    const order: string[] = [];

    manager.enqueue('a', async () => {
      order.push('a-1-start');
      await sleep(30);
      order.push('a-1-end');
    });

    manager.enqueue('b', async () => {
      order.push('b-1');
    });

    manager.enqueue('a', async () => {
      order.push('a-2');
    });

    await sleep(70);
    expect(order).toEqual(['a-1-start', 'b-1', 'a-1-end', 'a-2']);
  });
});
