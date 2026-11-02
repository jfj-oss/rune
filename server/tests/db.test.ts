import { describe, it, expect } from 'vitest';
import { openDb, ids, normalizeName } from '../src/db/index.js';

describe('db', () => {
  it('opens schema in memory', () => {
    const db = openDb(':memory:');
    const t = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
    expect(t.map((r) => r.name)).toContain('albums');
  });
  it('stable ids', () => {
    expect(ids.localTrack('/a/b.flac')).toBe(ids.localTrack('/a/b.flac'));
    expect(ids.localTrack('/a/b.flac', 1)).not.toBe(ids.localTrack('/a/b.flac', 2));
    expect(normalizeName('The Beatles')).toBe('beatles');
    expect(normalizeName('Blue Öyster Cult')).toBe('blue oyster cult');
  });
});
