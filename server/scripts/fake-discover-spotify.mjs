// Local fake Spotify + ListenBrainz + MusicBrainz server for the Discover
// pipeline self-check. Prints "LISTEN <port>" once ready; the parent kills it
// by PID. No network, no real Spotify.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../tests/fixtures/discover/${name}`, import.meta.url), 'utf8'));

const LB_ARTISTS = fixture('lb-similar-artists.json');
const LB_RECORDINGS = fixture('lb-similar-recordings.json');
const MB_ISRC = fixture('mb-isrc.json');
const MB_RECORDING_SEARCH = fixture('mb-recording-search.json');
const MB_ARTIST_SEARCH = fixture('mb-artist-search.json');

const requests = [];
const artistNames = new Map();

const slug = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function spotifyTrack(id, title, artist, index = 0) {
  const albumId = `alb-${slug(artist)}-${index}`;
  return {
    id,
    name: title,
    artists: [{ id: `art-${slug(artist)}`, name: artist }],
    album: {
      id: albumId,
      name: `${title} Album`,
      artists: [{ id: `art-${slug(artist)}`, name: artist }],
      images: [{ url: `http://img.test/${albumId}.jpg`, width: 640, height: 640 }],
      release_date: '2020-01-01',
    },
    disc_number: 1,
    track_number: index + 1,
    duration_ms: 200000,
    uri: `spotify:track:${id}`,
    popularity: 100 - index,
  };
}

const topTracks = (name, count = 10) =>
  Array.from({ length: count }, (_, i) =>
    spotifyTrack(`top-${slug(name)}-${i}`, `${name} Song ${i}`, name, i),
  );

const paging = (items) => ({
  items,
  total: items.length,
  limit: 50,
  offset: 0,
  next: null,
});

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function search(url, res) {
  const q = url.searchParams.get('q') ?? '';
  const type = url.searchParams.get('type') ?? '';
  const artistName = /artist:"([^"]+)"/.exec(q)?.[1];
  const trackName = /track:"([^"]+)"/.exec(q)?.[1];
  if (type === 'artist') {
    if (!artistName) return send(res, 200, { artists: paging([]) });
    const id = slug(artistName);
    artistNames.set(id, artistName);
    return send(res, 200, {
      artists: paging([{ id, name: artistName, images: [], uri: `spotify:artist:${id}` }]),
    });
  }
  if (type === 'track') {
    if (trackName) {
      if (trackName === 'Dance Monkey') {
        return send(res, 200, { tracks: paging([spotifyTrack('cover-dance-monkey', trackName, 'Some Cover Band')]) });
      }
      const artist = artistName ?? 'Unknown';
      return send(res, 200, {
        tracks: paging([spotifyTrack(`rec-${slug(artist)}-${slug(trackName)}`, trackName, artist)]),
      });
    }
    if (artistName) return send(res, 200, { tracks: paging(topTracks(artistName)) });
  }
  return send(res, 200, {});
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/__')) requests.push(url.pathname + url.search);

  if (url.pathname === '/__requests') return send(res, 200, { count: requests.length, urls: requests });
  if (url.pathname === '/v1/search') return search(url, res);

  const top = /^\/v1\/artists\/([^/]+)\/top-tracks$/.exec(url.pathname);
  if (top) {
    const id = decodeURIComponent(top[1]);
    const name = artistNames.get(id);
    if (!name) return send(res, 404, { error: 'unknown artist' });
    return send(res, 200, { tracks: topTracks(name) });
  }

  if (url.pathname === '/v1/tracks') {
    const track = spotifyTrack('seed-spotify', 'Creep', 'Radiohead');
    track.external_ids = { isrc: 'USUG11904206' };
    return send(res, 200, { tracks: [track] });
  }

  if (url.pathname === '/labs/similar-artists/json') return send(res, 200, LB_ARTISTS);
  if (url.pathname === '/labs/similar-recordings/json') return send(res, 200, LB_RECORDINGS);
  if (url.pathname.startsWith('/mb/isrc/')) return send(res, 200, MB_ISRC);
  if (url.pathname.startsWith('/mb/recording')) return send(res, 200, MB_RECORDING_SEARCH);
  if (url.pathname.startsWith('/mb/artist')) return send(res, 200, MB_ARTIST_SEARCH);

  send(res, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`LISTEN ${typeof address === 'object' && address ? address.port : 0}`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
