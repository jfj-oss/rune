import { describe, expect, it } from 'vitest';
import type { DayStat, DiscographyReleaseGroup, DuplicateAlbumVersion } from './discover';
import {
  dailySeries,
  discogSectionOf,
  duplicateKindLabel,
  formatBytes,
  formatListening,
  formatShare,
  formatShortDate,
  formatStamp,
  formatVersionDetail,
  groupDiscography,
  normalizeBars,
  personInBucket,
  roleBucketOf,
  sparklinePath,
} from './discover';

describe('formatListening', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatListening(0)).toBe('0 min');
    expect(formatListening(42_000)).toBe('42 s');
    expect(formatListening(42 * 60_000)).toBe('42 min');
    expect(formatListening(12 * 3_600_000 + 40 * 60_000)).toBe('12 hr 40 min');
    expect(formatListening(3 * 3_600_000)).toBe('3 hr');
    expect(formatListening(-5)).toBe('0 min');
  });
});

describe('date formatting', () => {
  it('handles full and partial ISO dates', () => {
    expect(formatShortDate('1977-03-04')).toBe('4 Mar 1977');
    expect(formatShortDate('1977-03')).toBe('Mar 1977');
    expect(formatShortDate('1977')).toBe('1977');
    expect(formatShortDate(undefined)).toBe('');
  });
  it('formats epoch ms in local time', () => {
    expect(formatStamp(new Date(2026, 2, 12, 9).getTime())).toBe('12 Mar 2026');
    expect(formatStamp(null)).toBe('—');
  });
});

describe('shares / bytes', () => {
  it('rounds percentages to one decimal', () => {
    expect(formatShare(62.44)).toBe('62.4%');
    expect(formatShare(100)).toBe('100.0%');
  });
  it('picks a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(1.42 * 1024 ** 4)).toBe('1.4 TB');
  });
});

describe('normalizeBars', () => {
  it('scales to the maximum and keeps zeros', () => {
    expect(normalizeBars([0, 5, 10])).toEqual([0, 0.5, 1]);
    expect(normalizeBars([0, 0])).toEqual([0, 0]);
    expect(normalizeBars([])).toEqual([]);
  });
});

describe('dailySeries', () => {
  const day = (date: string, ms: number): DayStat => ({ date, ms });
  it('fills calendar gaps', () => {
    const to = new Date(2026, 0, 5, 12).getTime();
    const out = dailySeries([day('2026-01-01', 10), day('2026-01-03', 30)], null, to);
    expect(out).toEqual([
      { date: '2026-01-01', ms: 10 },
      { date: '2026-01-02', ms: 0 },
      { date: '2026-01-03', ms: 30 },
      { date: '2026-01-04', ms: 0 },
      { date: '2026-01-05', ms: 0 },
    ]);
  });
  it('starts at `from` and sums duplicate days', () => {
    const from = new Date(2025, 11, 30).getTime();
    const to = new Date(2026, 0, 1).getTime();
    const out = dailySeries([day('2026-01-01', 10), day('2026-01-01', 5)], from, to);
    expect(out).toEqual([
      { date: '2025-12-30', ms: 0 },
      { date: '2025-12-31', ms: 0 },
      { date: '2026-01-01', ms: 15 },
    ]);
  });
  it('downsamples long ranges into buckets that sum', () => {
    const byDay = Array.from({ length: 20 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, ms: 1 }));
    const out = dailySeries(byDay, null, new Date(2026, 0, 20).getTime(), 5);
    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ date: '2026-01-01', ms: 4 });
    expect(out.reduce((n, d) => n + d.ms, 0)).toBe(20);
  });
  it('returns nothing without data', () => {
    expect(dailySeries([], null, Date.now())).toEqual([]);
  });
});

describe('sparklinePath', () => {
  it('builds a path inside the viewBox', () => {
    const path = sparklinePath([{ date: 'a', ms: 0 }, { date: 'b', ms: 10 }], 100, 40, 4);
    expect(path.startsWith('M ')).toBe(true);
    expect(path).toContain('L ');
    expect(sparklinePath([])).toBe('');
  });
});

describe('role buckets', () => {
  it('maps roles to the browse filters', () => {
    expect(roleBucketOf('Producer')).toBe('producers');
    expect(roleBucketOf('Executive Producer')).toBe('producers');
    expect(roleBucketOf('Mixing Engineer')).toBe('engineers');
    expect(roleBucketOf('Mastering')).toBe('engineers');
    expect(roleBucketOf('Composer')).toBe('composers');
    expect(roleBucketOf('Lyricist')).toBe('composers');
    expect(roleBucketOf('Bass')).toBe('musicians');
    expect(roleBucketOf('Lead Vocals')).toBe('musicians');
  });
  it('matches a person by any role', () => {
    expect(personInBucket(['Producer', 'Bass'], 'producers')).toBe(true);
    expect(personInBucket(['Producer', 'Bass'], 'musicians')).toBe(true);
    expect(personInBucket(['Producer'], 'composers')).toBe(false);
    expect(personInBucket([], 'all')).toBe(true);
  });
});

describe('discography grouping', () => {
  const group = (title: string, type: string | undefined, date: string): DiscographyReleaseGroup => ({
    mbReleaseGroupId: `rg:${title}`,
    title,
    date,
    type,
    secondaryTypes: [],
    owned: true,
    albumIds: [],
  });
  it('maps types and omits empty sections', () => {
    expect(discogSectionOf(undefined)).toBe('albums');
    expect(discogSectionOf('Album')).toBe('albums');
    expect(discogSectionOf('EP')).toBe('eps');
    expect(discogSectionOf('Live')).toBe('live');
    expect(discogSectionOf('Compilation')).toBe('compilations');
    expect(discogSectionOf('Soundtrack')).toBe('other');
    const out = groupDiscography([
      group('A', 'Album', '1971'),
      group('B', 'Album', '1977'),
      group('C', 'EP', '1979'),
      group('D', 'Live', '1981'),
      group('E', 'Compilation', '1995'),
    ]);
    expect(out.map((s) => s.label)).toEqual(['Albums', 'EPs', 'Live', 'Compilations']);
    expect(out[0]!.items.map((i) => i.title)).toEqual(['B', 'A']);
    expect(groupDiscography([])).toEqual([]);
  });
});

describe('duplicate helpers', () => {
  it('labels group kinds and version details', () => {
    expect(duplicateKindLabel('release-group')).toBe('Same release');
    expect(duplicateKindLabel('same-title')).toBe('Same title and tracks');
    const v: DuplicateAlbumVersion = {
      albumId: 'a',
      title: 'T',
      artist: 'A',
      trackCount: 12,
      discCount: 2,
      lossless: true,
      hasCover: true,
      matched: true,
      hidden: false,
      recommended: true,
      format: 'FLAC 24/96',
    };
    expect(formatVersionDetail(v)).toBe('FLAC 24/96 · 12 tracks · 2 discs');
    expect(formatVersionDetail({ ...v, trackCount: 1, discCount: 1, format: undefined })).toBe('1 track');
  });
});
