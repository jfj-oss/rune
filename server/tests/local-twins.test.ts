import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { createLocalTwins, normTitle, parseTwinQueries } from '../src/play/localTwins.js';
import { ensureLinkSchema } from '../src/spotify/linking.js';

function seeded() {
  const db = openDb(':memory:');
  ensureLinkSchema(db);
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:1', 'The Smashing Pumpkins');
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:2', 'Lynyrd Skynyrd');
  db.prepare(`INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:1', 'local', 'Mellon Collie', 'ar:1', 1)`).run();
  db.prepare(`INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:2', 'local', 'Pronounced', 'ar:2', 1)`).run();
  const track = db.prepare(`INSERT INTO tracks (id, album_id, source, title, number, duration_ms) VALUES (?, ?, 'local', ?, ?, ?)`);
  track.run('l:1', 'la:1', 'Tonight, Tonight', 1, 255_000);
  track.run('l:2', 'la:1', 'Tonight, Tonight (Live)', 2, 280_000);
  track.run('l:3', 'la:2', 'Free Bird', 1, 552_000);
  track.run('l:4', 'la:1', 'Zero', 3, 160_000);
  db.prepare(`INSERT INTO track_links (track_id, spotify_track_id, linked_at) VALUES ('l:4', 'zeroSp', 1)`).run();
  return db;
}

const q = (id: string, title: string, artists: string[], durationMs: number) => ({ id, title, artists, durationMs });

describe('local twins: a Spotify track the user owns plays from the local file', () => {
  it('matches a remaster of the same song by title, artist and length', () => {
    const m = createLocalTwins(seeded()).find([q('sp:a', 'Tonight, Tonight - Remastered 2012', ['The Smashing Pumpkins'], 254_500)]);
    expect(m.get('sp:a')).toBe('l:1');
  });
  it('allows a few seconds of different fade or silence', () => {
    const m = createLocalTwins(seeded()).find([q('sp:b', 'Free Bird', ['Lynyrd Skynyrd'], 547_000)]);
    expect(m.get('sp:b')).toBe('l:3');
  });
  it('never swaps in a different version (live, other length, other artist)', () => {
    const m = createLocalTwins(seeded()).find([
      q('sp:c', 'Tonight, Tonight (Live)', ['The Smashing Pumpkins'], 255_000), // live is 280 s locally
      q('sp:d', 'Free Bird', ['Lynyrd Skynyrd'], 290_000), // the single edit
      q('sp:e', 'Free Bird', ['Somebody Else'], 552_000),
    ]);
    expect([...m.keys()]).toEqual([]);
  });
  it('uses the stored album link first, whatever the metadata says', () => {
    const m = createLocalTwins(seeded()).find([q('sp:zeroSp', 'Zero (2012 - Remaster)', [], 0)]);
    expect(m.get('sp:zeroSp')).toBe('l:4');
  });
  it('returns the local tracks as queue items with their album', () => {
    const items = createLocalTwins(seeded()).items([q('sp:a', 'Tonight, Tonight', ['The Smashing Pumpkins'], 255_000)]);
    expect(items['sp:a']?.track.id).toBe('l:1');
    expect(items['sp:a']?.track.source).toBe('local');
    expect(items['sp:a']?.album).toMatchObject({ id: 'la:1', title: 'Mellon Collie' });
  });
  it('normalises packaging words only', () => {
    expect(normTitle('Blue Moon - 1999 Remastered')).toBe('blue moon');
    expect(normTitle('My Way (feat. Monty)')).toBe('my way');
    expect(normTitle('Song (Acoustic)')).toBe('song acoustic');
    expect(normTitle('Raise Your Weapon - Wax Motif Remix')).toBe(normTitle('Raise Your Weapon (Wax Motif Remix)'));
  });
  it('validates the request body', () => {
    expect(parseTwinQueries(null)).toBeNull();
    expect(parseTwinQueries({ tracks: [{ id: 'sp:a', title: 'T', artists: ['A', 3], durationMs: 'x' }, { id: 5 }] })).toEqual([
      { id: 'sp:a', title: 'T', artists: ['A'], durationMs: 0 },
    ]);
  });
});
