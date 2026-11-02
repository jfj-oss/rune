import { describe, expect, it } from 'vitest';
import { createLocalSearchCache } from '../src/search/local-cache.js';

describe('local search cache', () => {
  it('computes once per key within the TTL, then recomputes', () => {
    let clock = 1_000;
    let calls = 0;
    const cache = createLocalSearchCache<{ n: number }>({
      ttlMs: 15_000,
      now: () => clock,
    });
    const compute = () => ({ n: ++calls });

    const first = cache.get('zebra', compute);
    expect(cache.get('zebra', compute)).toBe(first);
    expect(calls).toBe(1);

    // A different query has its own entry.
    const other = cache.get('yak', compute);
    expect(other).not.toBe(first);
    expect(calls).toBe(2);

    clock += 14_999;
    expect(cache.get('zebra', compute)).toBe(first);
    expect(calls).toBe(2);

    clock += 1; // exactly 15 s after the first computation: stale
    expect(cache.get('zebra', compute)).not.toBe(first);
    expect(calls).toBe(3);
  });

  it('clear() drops everything for the next library change', () => {
    let calls = 0;
    const cache = createLocalSearchCache<number>({ now: () => 0 });
    const compute = () => ++calls;
    cache.get('a', compute);
    cache.get('b', compute);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    cache.get('a', compute);
    expect(calls).toBe(3);
  });

  it('bounds memory by evicting the oldest query', () => {
    let calls = 0;
    const cache = createLocalSearchCache<number>({ now: () => 0, maxEntries: 2 });
    const compute = () => ++calls;
    cache.get('a', compute);
    cache.get('b', compute);
    expect(cache.size()).toBe(2);
    cache.get('c', compute); // evicts 'a'
    expect(cache.size()).toBe(2);
    cache.get('a', compute);
    expect(calls).toBe(4);
    expect(cache.size()).toBe(2);
  });
});
