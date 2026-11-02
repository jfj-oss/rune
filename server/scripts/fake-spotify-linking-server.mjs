// Local fake of the Spotify Web API used by the Spotify-linking self-check.
// Started as a child process by selfcheck-linking.ts (killed by PID afterwards).
//
// argv[2] = port (0 = choose), argv[3] = fixture JSON written by the parent:
//   { albums: [{ id, title, artist, barcode, tracks: [{id,name,disc,number,durationMs}] }] }
//
// The search endpoint answers both `upc:<barcode>` and `album:"..." artist:"..."`
// queries. For title searches it deliberately returns an over-long "deluxe"
// candidate BEFORE the real album, so the linker's track-count verification has
// to reject it.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const albums = fixture.albums;

const requests = [];

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function page(items, offset = 0, limit = 50) {
  return { items, total: items.length, limit, offset, next: null, href: '' };
}

function albumObject(album) {
  return {
    id: album.id,
    name: album.title,
    album_type: 'album',
    artists: [{ id: 'sp-artist-' + album.id, name: album.artist, uri: 'spotify:artist:' + album.id }],
    images: [{ url: `http://img.example/${album.id}-640.jpg`, width: 640, height: 640 }],
    release_date: '2001-01-01',
    total_tracks: album.tracks.length,
    uri: 'spotify:album:' + album.id,
  };
}

function deluxeObject(album) {
  return {
    ...albumObject(album),
    id: 'deluxe:' + album.id,
    name: album.title + ' (Deluxe Edition)',
    total_tracks: album.tracks.length + 2,
  };
}

function trackObjects(album, extra = 0) {
  const tracks = album.tracks.map((t, i) => ({
    id: t.id,
    name: t.name,
    artists: [{ id: 'sp-artist-' + album.id, name: album.artist, uri: 'spotify:artist:' + album.id }],
    album: albumObject(album),
    disc_number: t.disc ?? 1,
    track_number: t.number ?? i + 1,
    duration_ms: t.durationMs,
    uri: 'spotify:track:' + t.id,
    type: 'track',
  }));
  for (let i = 0; i < extra; i++) {
    tracks.push({
      id: `deluxe-extra-${album.id}-${i}`,
      name: `Bonus Track ${i + 1}`,
      artists: [{ id: 'sp-artist-' + album.id, name: album.artist, uri: 'spotify:artist:' + album.id }],
      album: albumObject(album),
      disc_number: 1,
      track_number: album.tracks.length + i + 1,
      duration_ms: 999_990 + i,
      uri: `spotify:track:deluxe-extra-${album.id}-${i}`,
      type: 'track',
    });
  }
  return tracks;
}

function findById(id) {
  if (id.startsWith('deluxe:')) {
    const album = albums.find((a) => a.id === id.slice('deluxe:'.length));
    return album ? { album, extra: 2 } : undefined;
  }
  const album = albums.find((a) => a.id === id);
  return album ? { album, extra: 0 } : undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

  if (url.pathname === '/__requests') return send(res, 200, requests);

  if (url.pathname === '/v1/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20);

    const upc = /^upc:(\d+)$/.exec(q);
    if (upc) {
      const album = albums.find((a) => a.barcode && a.barcode === upc[1]);
      return send(res, 200, { albums: page(album ? [albumObject(album)] : [], 0, limit) });
    }

    const title = /album:"([^"]*)"/.exec(q)?.[1] ?? '';
    const artist = /artist:"([^"]*)"/.exec(q)?.[1] ?? '';
    const album = albums.find((a) => norm(a.title) === norm(title) && norm(a.artist) === norm(artist));
    if (!album) return send(res, 200, { albums: page([], 0, limit) });
    // Wrong edition first: the linker must reject it by track count.
    return send(res, 200, { albums: page([deluxeObject(album), albumObject(album)], 0, limit) });
  }

  const tracksMatch = /^\/v1\/albums\/([^/]+)\/tracks$/.exec(url.pathname);
  if (tracksMatch && req.method === 'GET') {
    const found = findById(decodeURIComponent(tracksMatch[1]));
    if (!found) return send(res, 404, { error: 'not_found' });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const tracks = trackObjects(found.album, found.extra).slice(offset, offset + limit);
    return send(res, 200, page(tracks, offset, limit));
  }

  send(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  const address = server.address();
  console.log(`LISTEN ${address.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
