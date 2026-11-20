# rune mini: the contract both apps use

rune mini is a small panel (Linux: GPUI in `linux/`; Mac: Swift + AppKit in `mac/`) that talks to an existing rune server.
It adds nothing to the server and has no queue of its own: the server owns the queue of every zone (CONTRACTS.md, "One
queue"); the panel shows state and sends commands. Every type is in `shared/src/index.ts` (`PlayerState`, `PlayerCommand`,
`ServerEvent`, `ClientEvent`) and the HTTP routes are in CONTRACTS.md. This file lists only what the panel uses.

## Connection

- Base URL: `http://host:port` or `https://host` (Tailscale serve gives https). Saved by the user; **nothing is built in**
  (the Linux default is `http://localhost:4545`, the Mac asks on first run).
- Auth: rune has none of its own. An optional token is sent as `Authorization: Bearer <token>` on every request and on the
  websocket handshake, for a proxy in front of rune that wants one. It is stored in a file named `token`, mode 600, next to
  `config.json` (`~/.config/rune-mini/` on Linux, `~/Library/Application Support/rune-mini/` on a Mac; `RUNE_MINI_CONFIG_DIR`
  overrides). `config.json` = `{ "url", "zone", ... }`.

## Reading

- `GET /api/zones` -> `ZoneInfo[]`. The picker offers: kind `pc`, then Soloist (`soloist: true`), then Spotify Connect devices
  (`kind: spotify`). `kind: browser` is left out, and so is the PC's own Spotify device (`spotifyDeviceId` of the pc zone, and
  its `spotifyZone`), as the web does (`web/src/player/routing.ts` `withoutPcDevice`). Read on connect, and when the panel
  is shown.
- `GET /api/player/:zone` -> `PlayerState` (full, with the queue). Used on connect, on show, after a zone change, and when a
  slim event arrives for a queue the panel never saw.
- websocket `GET /api/ws?slim=1` -> `ServerEvent` frames. `hello` first (ignored), then `player { state, queueRev }` for every
  zone. With `slim=1` an event whose queue did not change has no `state.queue`: the client keeps the last full queue per zone
  with its `queueRev` and reuses it when the rev matches, else it reads `GET /api/player/:zone` once (and not again while
  that read is out). `scan` and `library-changed` are ignored. Events of other zones are ignored.
- Client -> server frames: `{type:'presence', visible}` (the panel is on screen or not) and `{type:'viewing', zones:[zone]}`
  (so a Spotify Connect zone nobody looks at is not polled).
- `GET /api/mini/playlists` -> `{ playlists: [{ id, name, color }] }`: the playlists chosen in big rune ("Show in rune mini" on a
  playlist's page, or Settings -> rune mini), in order, at most 8, a playlist rune no longer has already left out. `color` is
  0..7, an index into the panel's eight dot colours (`linux/app/src/look.rs` `DOTS`, `mac/Sources/RuneMini/Theme.swift`); the
  server keeps it for as long as the playlist stays chosen and never gives two of them the same one. Read on connect, when the
  panel is shown, and whenever the websocket says `{type:'mini-playlists'}` (no payload; a change made over HTTP).
- Cover: `album.coverUrl` as given (a server path such as `/api/cover/<albumId>?size=200`, or an absolute Spotify CDN URL,
  fetched without the token), else `/api/cover/<albumId>?size=200`.
- Position: `positionMs` is current at the time the event is received. The panel extrapolates it with its own monotonic clock
  while `status == playing`, held to the song's `durationMs`. The server's `updatedAt` is never used (clock skew).

## Reconnect

500 ms, doubling, capped at 10 s, plus up to 20 % jitter; reset on the first frame after a connect (the web's policy in
`web/src/player/remote.ts`). On disconnect the cached queues are forgotten (events were missed) and the panel says
"offline". Idle cost: Linux wakes a read every 15 s hidden / 3 s shown and pings every 14 s; the Mac has no timer while
connected (the OS wakes the websocket task) and pings only after wake or when shown.

## Commands

All commands are `POST /api/player/:zone` with one `PlayerCommand`; the answer is the new `PlayerState` (used to update the
view at once; the websocket then confirms it).

| UI | body |
|---|---|
| play/pause | `{type:'pause'}` while playing/loading, `{type:'resume'}` while paused, `{type:'jump', index}` (cursor or 0) when stopped with a queue |
| next, previous | `{type:'next'}`, `{type:'prev'}` |
| seek | `{type:'seek', positionMs}`; relative seeks use the extrapolated position, clamped to `[0, duration - 500 ms]` |
| volume | `{type:'volume', volume}` 0..100, whole numbers, clamped |
| shuffle | `{type:'shuffle', on}` |
| repeat | `{type:'repeat', mode}` cycling off -> all -> one -> off |
| click a playlist dot, or key 1-8 | `GET /api/playlists/:id`, then `{type:'play', trackIds: <all of its track ids, in order>, startIndex: 0, shuffle: true}` on the zone shown (exactly what the web's Shuffle button sends). An empty playlist says so in the footer. |
| click / Enter on a queue row | `{type:'jump', index}` (index in the full queue, not in the filtered list) |
| remove | `{type:'remove', queueId}` |
| drag to reorder | `{type:'move', queueId, toIndex}` |

## The left edge: playlist dots

One small coloured circle per chosen playlist (the panel has 22 px for them; more than six wrap into two columns). Hover shows
the playlist's name and its key in the footer line; a click shuffle-plays it on the zone shown. The playlist whose shuffled
play made the queue now shown gets a ring (the panel remembers the first queue id and the length of the queue the click
returned; as soon as the queue is replaced or edited the ring goes, and a queue started elsewhere is not ringed). With
nothing chosen there is one dim "+" whose hover says "choose playlists in rune -> Show in rune mini".

The zones are not on the edge any more: the zone name in the footer ("playing · Linux PC speakers ›") is a button that
cycles through the zones (the picker's order, wrapping) when there is more than one, and the tray menu still lists them.

## Keys (the panel has the keyboard while shown)

| | compact | queue open |
|---|---|---|
| Space | play/pause | play/pause with an empty filter, else a space in the filter |
| Left / Right | previous / next | the same with an empty filter |
| Shift+Left / Right | seek -/+ 10 s | the same with an empty filter |
| Up / Down | volume -/+ 5 | pick the previous / next queue row |
| 1 - 8 | shuffle-play playlist N (dot N, left edge top to bottom) | typed into the filter (Ctrl/Cmd+1-8 still play) |
| S, R | shuffle, repeat | typed into the filter (Ctrl/Cmd+S, Ctrl/Cmd+R still toggle) |
| Q or Tab | open the queue | Tab closes it (Ctrl/Cmd+Q toggles it either way; some desktops keep Tab for focus) |
| typing | | filters the queue (every word must be in the title, an artist or the album) |
| Enter / Delete | | play / remove the picked row |
| Esc | hide | clear the filter, then close the queue, then hide |

The table is `linux/core/src/keys.rs` and `mac/Sources/RuneMiniCore/Keys.swift`, tested in both.

## Media keys

- Linux: an MPRIS player `org.mpris.MediaPlayer2.rune` (PlayPause, Play, Pause, Stop, Next, Previous, Seek, SetPosition,
  LoopStatus, Shuffle, Volume, Metadata with title, artists, album, art URL and length, Position). The rune server publishes
  **no** MPRIS player of its own: `server/src/spotify/mpris.ts` only reads the Spotify app's, and mpv runs without an MPRIS
  script. So there is no duplicate to fight with.
- Mac: `MPRemoteCommandCenter` + `MPNowPlayingInfoCenter` (see `mac/README.md`, "Media keys").
