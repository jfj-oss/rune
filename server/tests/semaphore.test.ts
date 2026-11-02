import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../src/api/semaphore.js';

describe('semaphore', () => {
  it('admits at most `max` holders', async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active()).toBe(2);
    expect(sem.waiting()).toBe(0);

    let admitted = false;
    const blocked = sem.acquire().then(() => {
      admitted = true;
    });
    expect(sem.waiting()).toBe(1);
    await Promise.resolve();
    expect(admitted).toBe(false); // no slot until release()

    sem.release(); // hands the slot to the waiter, active stays 2
    expect(sem.active()).toBe(2);
    expect(sem.waiting()).toBe(0);
    await blocked;
    expect(admitted).toBe(true);
  });

  it('releases waiters in FIFO order', async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    const order: number[] = [];
    const w1 = sem.acquire().then(() => order.push(1));
    const w2 = sem.acquire().then(() => order.push(2));
    const w3 = sem.acquire().then(() => order.push(3));
    expect(sem.waiting()).toBe(3);

    sem.release();
    await w1;
    expect(order).toEqual([1]);
    expect(sem.active()).toBe(1);

    sem.release();
    await w2;
    expect(order).toEqual([1, 2]);

    sem.release();
    await w3;
    expect(order).toEqual([1, 2, 3]);
    expect(sem.waiting()).toBe(0);
    expect(sem.active()).toBe(1);

    sem.release();
    expect(sem.active()).toBe(0);
    sem.release(); // extra releases never push the count negative
    expect(sem.active()).toBe(0);
  });

  it('treats nonsensical limits as one slot', async () => {
    const sem = createSemaphore(0);
    await sem.acquire();
    expect(sem.active()).toBe(1);
    let admitted = false;
    void sem.acquire().then(() => {
      admitted = true;
    });
    expect(sem.waiting()).toBe(1);
    sem.release();
    await Promise.resolve();
    expect(admitted).toBe(true);
  });
});
