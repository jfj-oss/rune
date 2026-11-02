// Tiny FIFO semaphore. The cover thumbnailer uses it to keep at most N ffmpeg
// processes alive at once: a grid of 200 px covers used to spawn one per tile
// (hundreds on a big screen, which starves the machine).

export interface Semaphore {
  /** Wait for a slot. Resolves immediately when fewer than `max` are held. */
  acquire(): Promise<void>;
  /** Give a slot back; the oldest waiter runs next (FIFO). */
  release(): void;
  /** Slots currently held (including one being handed to a waiter). */
  active(): number;
  /** Queued waiters. */
  waiting(): number;
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  return {
    acquire() {
      if (active < limit) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => queue.push(resolve));
    },
    release() {
      const next = queue.shift();
      if (next) {
        // Hand the slot straight to the next waiter: `active` stays the same.
        next();
      } else if (active > 0) {
        active--;
      }
    },
    active() {
      return active;
    },
    waiting() {
      return queue.length;
    },
  };
}
