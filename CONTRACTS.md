# Liner — architecture & contracts

Personal Roon-style music app: local library (FLAC/MP3, cue sheets) + Spotify, with rich
album pages (credits, critical reception, artist notes). Runs on the user's Linux PC; used
from the PC browser and an iPhone (installable web app).

## Layout
- `shared/src/index.ts` — ALL shared types. Do not change without the main session.
- `server/` — Node 22 + TypeScript, Fastify, better-sqlite3, Vitest. Runs on the PC.
  - `src/db/` — schema + migrations (`schema.sql`), `openDb(path)`.
  - `src/scan/` — library scanner (worker A).
  - `src/match/` — MusicBrainz matching + Cover Art Archive (worker B).
  - `src/play/` — mpv playback zone + HTTP streaming/transcoding (worker C).
  - `src/meta/` — reviews / artist notes (phase 2).
  - `src/api/` — Fastify routes, wires modules together.
- `web/` — React + Vite + TS UI (Sonnet UI agent). PWA.

## Config
`server/config.json` (gitignored values via env also allowed):
- `libraryRoots`: `["/music/library"]`
- `dataDir`: `~/.local/share/liner` (db, cover cache)
- `port`: 4545

## HTTP API (server, prefix /api)
| route | returns |
|---|---|
| `GET /library/albums?q&source&sort&offset&limit` | `Page<AlbumSummary>` |
| `GET /albums/:id` | `Album` |
| `GET /albums/:id/details` | `AlbumDetails` (phase 2; 404 until then) |
| `GET /artists/:id` | `Artist` |
| `GET /search?q` | `{ albums: AlbumSummary[], artists: ArtistRef[], tracks: Track[] }` |
| `GET /cover/:albumId?size=200\|600\|full` | image (jpeg/png), cached |
| `GET /stream/:trackId?fmt=orig\|opus\|aac&kbps=` | audio, supports Range for `orig` non-cue tracks |
| `GET /player/:zone` | `PlayerState` |
| `POST /player/:zone` body `PlayerCommand` | `PlayerState` |
| `POST /player/browser:<id>/report` body `TabReport` | `{ ok }` (the tab that sounds a browser zone tells the server what its player did) |
| `GET /zones` | `{ id: Zone, name: string, kind: 'pc'\|'browser'\|'spotify' }[]` (browser zones are not listed: each page names its own, `browser:<id>`) |
| `GET /spotify/status` · `GET /spotify/token` | `{connected,user}` · short-lived `{access_token, expires_at}` (Web Playback SDK in the browser) |
| `GET /playlists` · `GET /playlists/:id` | `PlaylistSummary[]` · `PlaylistDetail` (Liked Songs = `pl:sp:liked`) |
| `GET /albums/:id/saved` · `POST/DELETE /albums/:id/save` | `{saved}` · save / unsave a Spotify album |
| `POST /scan` | starts rescan |
| `POST /albums/:id/match` body `{ musicbrainzReleaseId }` | manual fix match |
| `WS /ws` | `ServerEvent` stream |

## Ids
- local track: `l:` + sha1(absolute path [+ `#` + cue track number]) first 16 hex
- local album: `la:` + sha1(album folder path [+ `#` + disc-group key]) first 16 hex
- artist: `ar:` + musicbrainz artist id when matched, else `ar:n:` + sha1(normalized name) 16 hex
- spotify: `sp:` + spotify id

## Rules for all workers
- Work only in your own git worktree/branch. Do not push. Never `git stash`.
- Never `pkill -f` / `pgrep -f`; kill only processes you started, by PID.
- The music library at `/music/library` is the real files: READ ONLY. Never write,
  rename, retag or delete anything there. Tests use fixtures generated into a temp dir.
- No network in unit tests (record fixtures as JSON).
- Checks before you finish: `pnpm -C server typecheck` and `pnpm -C server test`.
- Commit on your branch with trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Report ONCE at the end: what you built, files, test results, anything left undone. Kill your
  own background jobs first. No interim reports.

## One queue (the server's)
The server owns the queue of every zone (order, shuffle, repeat, next/prev, add, remove, move, play-from-here). The logic is
one module, `shared/src/queue.ts` (pure functions; the pc zone, browser zones, Soloist and the web's mock mode all use it).
Shuffle is a real reordering: the queue shown is the play order; turning it off leaves the order as it is.
- `server/src/play/driver.ts` `QueueDriver` is the queue + cursor + saved state. It hands a run of songs to ONE output at a time
  and the output reports facts back (started, ended, paused, resumed, failed, taken over). Outputs: `MpvOutput` (local files on
  the PC speakers, gapless), `SpotifyAppOutput`/`SoloistRunOutput` (Spotify songs on the PC), `TabOutput` (a browser tab).
- pc zone = one `QueueDriver` over mpv (`play/zone.ts` only plays the runs it is given: it has no queue of its own).
- Browser zone = `browser:<id>`, one `QueueDriver` per browser, made when a page first talks to it (`<id>` is kept in the
  browser's localStorage, `web/src/lib/clientId.ts`). The page (`web/src/player/browser.ts`, `tabPlayer.ts`) holds NO queue:
  it shows the server's state and sends button presses, and the ONE tab of that browser that sounds the zone follows
  `PlayerState.tab` (which run to play, a new load, a new seek) with its audio engine and reports back (`TabReport`). Spotify
  songs in the browser zone: the Web Playback SDK on a desktop, Soloist heard over a stream on a phone (`phoneSoloist.ts`).
  A quiet tab (locked phone) never pauses the zone: its position becomes unknown, the tab hands over to the next song of its run
  itself on audio `ended`, and on unlock/visibility/pagehide it sends what the server missed and re-reads the state. Only 30 min
  of silence releases the zone.
- Spotify Connect devices (`spotify:<device>`) keep Spotify's own queue (`server/src/spotify/zones.ts`); only a Shuffle play
  is mixed by rune before it is sent.
- Tests: `server/tests/e2e/` plays real silent FLACs through a real server (mpv on a null output) and a muted headless Chromium;
  it runs in `pnpm test`.
