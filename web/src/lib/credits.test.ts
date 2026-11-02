import { describe, expect, it } from 'vitest';
import type { Credit } from '@liner/shared';
import { classifyRole, formatTrackRefs, groupCredits } from './credits';

const a = (id: string, name = id) => ({ id, name });

describe('classifyRole', () => {
  it('sorts roles into groups', () => {
    expect(classifyRole('Producer')).toBe('Production');
    expect(classifyRole('Mixing Engineer')).toBe('Production');
    expect(classifyRole('Composer')).toBe('Writing');
    expect(classifyRole('Lyricist')).toBe('Writing');
    expect(classifyRole('Bass')).toBe('Performers');
    expect(classifyRole('Lead Vocals')).toBe('Performers');
  });
});

describe('groupCredits', () => {
  const credits: Credit[] = [
    { artist: a('p1', 'Pia'), role: 'Bass' },
    { artist: a('p1', 'Pia'), role: 'Backing Vocals', trackIds: ['t2'] },
    { artist: a('p1', 'Pia'), role: 'Backing Vocals', trackIds: ['t5'] },
    { artist: a('p1', 'Pia'), role: 'Producer' },
    { artist: a('p2', 'Quin'), role: 'Composer' },
  ];
  const groups = groupCredits(credits);
  it('orders groups and omits empty ones', () => {
    expect(groups.map((g) => g.name)).toEqual(['Performers', 'Production', 'Writing']);
    expect(groupCredits([{ artist: a('x'), role: 'Bass' }]).map((g) => g.name)).toEqual(['Performers']);
  });
  it('merges one person within a group and unions track ids', () => {
    const perf = groups[0]!.people;
    expect(perf).toHaveLength(1);
    expect(perf[0]!.roles).toEqual([
      { role: 'Bass', trackIds: undefined },
      { role: 'Backing Vocals', trackIds: ['t2', 't5'] },
    ]);
  });
  it('lists a person in several groups', () => {
    expect(groups[1]!.people[0]!.artist.id).toBe('p1');
  });
});

describe('formatTrackRefs', () => {
  const tracks = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((id) => ({ id }));
  it('formats singles, lists and ranges', () => {
    expect(formatTrackRefs(['t3'], tracks)).toBe('track 3');
    expect(formatTrackRefs(['t5', 't2'], tracks)).toBe('tracks 2, 5');
    expect(formatTrackRefs(['t2', 't3', 't4', 't7'], tracks)).toBe('tracks 2–4, 7');
    expect(formatTrackRefs(['t2', 't3'], tracks)).toBe('tracks 2, 3');
    expect(formatTrackRefs(['nope'], tracks)).toBe('');
  });
});
