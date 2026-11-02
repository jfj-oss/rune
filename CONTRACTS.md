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
- `libraryRoots`: `["/mnt/BIG data/Music"]`
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
| `GET /zones` | `{ id: Zone, name: string, kind: 'pc'\|'browser'\|'spotify' }[]` |
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
- The music library at `/mnt/BIG data/Music` is the user's real files: READ ONLY. Never write,
  rename, retag or delete anything there. Tests use fixtures generated into a temp dir.
- No network in unit tests (record fixtures as JSON).
- Checks before you finish: `pnpm -C server typecheck` and `pnpm -C server test`.
- Commit on your branch with trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Report ONCE at the end: what you built, files, test results, anything left undone. Kill your
  own background jobs first. No interim reports.

## Browser zone is hybrid (Spotify Web Playback SDK)
`web/src/player/hybrid.ts`: the browser zone keeps ONE queue; local tracks play through `<audio>`, Spotify tracks through the
SDK player (`spotifySdk.ts`, device name `rune — <This Mac>`; desktop browsers only, not iOS). Spotify tracks on a zone that cannot
play them (PC speakers, or the browser zone on iPhone) open the "Play on…" sheet (`routing.ts`, `PlayOnSheet.tsx`).
