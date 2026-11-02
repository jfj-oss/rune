import { describe, expect, it } from 'vitest';
import type { SpotifyAlbum } from '../src/spotify/api.js';
import { SpotifyArtistPages } from '../src/spotify/artist.js';

const album = (id: string, name: string, group: string): SpotifyAlbum =>
  ({ id, name, album_type: group, release_date: '2020-01-01', images: [{ url: `http://img/${id}`, width: 640, height: 640 }], artists: [{ id: 'pb', name: 'Phoebe' }] }) as unknown as SpotifyAlbum;

describe('SpotifyArtistPages', () => {
  it('loads the artist with albums then singles, dedupes, and caches', async () => {
    let calls = 0;
    const api = {
      artist: async (id: string) => { calls++; expect(id).toBe('pb'); return { id, name: 'Phoebe', images: [{ url: 'http://img/pb', width: 640, height: 640 }] }; },
      allArtistAlbums: async (_id: string, group?: string) => { calls++; return group === 'album' ? [album('a1', 'Punisher', 'album')] : [album('s1', 'Single', 'single'), album('a1', 'Punisher', 'album')]; },
    };
    const pages = new SpotifyArtistPages(api);
    const p = await pages.get('ar:sp:pb')!;
    expect(p.name).toBe('Phoebe');
    expect(p.imageUrl).toBe('http://img/pb');
    expect(p.albums.map((a) => a.id)).toEqual(['sp:a1', 'sp:s1']);
    await pages.get('ar:sp:pb');
    expect(calls).toBe(3);
    expect(pages.get('ar:n:local')).toBeNull();
  });

  it('does not cache failures', async () => {
    let fail = true;
    const api = {
      artist: async (id: string) => { if (fail) throw new Error('429'); return { id, name: 'X' }; },
      allArtistAlbums: async () => [],
    };
    const pages = new SpotifyArtistPages(api);
    await expect(pages.get('ar:sp:x')!).rejects.toThrow('429');
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    await expect(pages.get('ar:sp:x')!).resolves.toMatchObject({ name: 'X' });
  });
});
