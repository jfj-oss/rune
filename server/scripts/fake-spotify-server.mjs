// Local fake of the Spotify Accounts + Web API used by the end-to-end self-check.
// Started as a child process by selfcheck-simulated.ts and killed by PID afterwards.
import http from 'node:http';

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const IMG = (id) => [
  { url: `http://img.example/${id}-64.jpg`, width: 64, height: 64 },
  { url: `http://img.example/${id}-640.jpg`, width: 640, height: 640 },
];
const ARTIST = { id: 'beatles-sp', name: 'The Beatles', images: IMG('beatles') };
const albumRef = (id, name, release_date) => ({
  id,
  name,
  artists: [ARTIST],
  images: IMG(id),
  release_date,
});
const track = (id, name, n, album) => ({
  id,
  name,
  artists: [ARTIST],
  album,
  disc_number: 1,
  track_number: n,
  duration_ms: 200_000 + n,
  uri: `spotify:track:${id}`,
});

const abbey = albumRef('abbey', 'Abbey Road', '1969-09-26');
const letItBe = albumRef('letitbe', 'Let It Be', '1970-05-08');
const t1 = track('t1', 'Come Together', 1, abbey);
const t2 = track('t2', 'Something', 2, abbey);
const t3 = track('t3', "Maxwell's Silver Hammer", 3, abbey);
const t10 = track('t10', 'Two Of Us', 1, letItBe);

const savedAlbums = [
  {
    added_at: '2024-02-01T00:00:00Z',
    album: {
      ...abbey,
      album_type: 'album',
      label: 'Apple',
      genres: ['rock'],
      total_tracks: 2,
      tracks: { items: [t1, t2], total: 2, limit: 50, offset: 0, next: null },
    },
  },
  {
    added_at: '2024-03-01T00:00:00Z',
    album: {
      ...letItBe,
      album_type: 'album',
      label: 'Apple',
      genres: ['rock'],
      total_tracks: 1,
      tracks: { items: [t10], total: 1, limit: 50, offset: 0, next: null },
    },
  },
];

const DEVICE = {
  id: 'dev1',
  is_active: true,
  is_private_session: false,
  is_restricted: false,
  name: 'Sim Phone',
  type: 'Smartphone',
  volume_percent: 55,
};

const allTracks = new Map([t1, t2, t3, t10].map((t) => [t.id, t]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let body = '';
  if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body,
    authorization: req.headers.authorization ?? null,
  });

  if (url.pathname === '/__requests') return send(res, 200, requests);

  if (url.pathname === '/api/token' && req.method === 'POST') {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') === 'authorization_code') {
      return send(res, 200, {
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'streaming user-library-read',
      });
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== 'refresh-1') {
        return send(res, 400, { error: 'invalid_grant' });
      }
      return send(res, 200, { access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 });
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  if (url.pathname === '/v1/me' && req.method === 'GET') {
    return send(res, 200, { id: 'sim-user', display_name: 'Sim Listener', product: 'premium' });
  }

  if (url.pathname === '/v1/me/albums' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const items = offset === 0 ? savedAlbums : [];
    return send(res, 200, { items, total: savedAlbums.length, limit, offset, next: null });
  }

  if (url.pathname === '/v1/tracks' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return send(res, 200, { tracks: ids.map((id) => allTracks.get(id) ?? null) });
  }

  if (url.pathname === '/v1/me/player/devices' && req.method === 'GET') {
    return send(res, 200, { devices: [DEVICE] });
  }

  if (url.pathname === '/v1/me/player' && req.method === 'GET') {
    return send(res, 200, {
      device: DEVICE,
      repeat_state: 'off',
      shuffle_state: false,
      progress_ms: 54_321,
      is_playing: true,
      item: t2,
      currently_playing_type: 'track',
    });
  }

  if (url.pathname === '/v1/me/player/queue' && req.method === 'GET') {
    return send(res, 200, { currently_playing: t2, queue: [t3] });
  }

  if (url.pathname.startsWith('/v1/me/player/')) {
    // play/pause/next/... are recorded above; Spotify returns 204 for all of them.
    return send(res, 204);
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
