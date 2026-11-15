import { describe, expect, it } from 'vitest';
import { shuffledList } from './player';

const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]!; };

describe('shuffledList', () => {
  it('keeps the chosen song first and mixes the rest', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const { list, start } = shuffledList(items, 2, seq([0, 0, 0, 0]));
    expect(start).toBe(0);
    expect(list[0]).toBe('c');
    expect([...list].sort()).toEqual(items);
    expect(list.slice(1)).not.toEqual(['a', 'b', 'd', 'e']);
  });

  it('mixes the whole list for Shuffle play', () => {
    const items = ['a', 'b', 'c', 'd'];
    const { list } = shuffledList(items, -1, seq([0, 0, 0]));
    expect([...list].sort()).toEqual(items);
    expect(list).not.toEqual(items);
  });

  it('does not change the input', () => {
    const items = [1, 2, 3];
    shuffledList(items, 0);
    expect(items).toEqual([1, 2, 3]);
  });

  it('handles empty and single lists', () => {
    expect(shuffledList([], 0).list).toEqual([]);
    expect(shuffledList(['x'], 0).list).toEqual(['x']);
  });
});
