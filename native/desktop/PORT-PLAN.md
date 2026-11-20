# rune desktop on GPUI: port plan

Scope: the **desktop** app (Linux/KDE Wayland first, macOS Apple Silicon second). It replaces the web UI on the two
computers; the phone keeps the web UI, so the server API (`CONTRACTS.md`, `native/PROTOCOL.md`) stays the single contract
and nothing in `server/` changes for this port. The app is a remote control for a server zone: it holds **no queue
logic** (CONTRACTS.md, "One queue"), it shows `PlayerState` and sends `PlayerCommand`s.

Layout: `native/desktop/` is its own Cargo workspace (own `Cargo.lock`, copied from `native/linux` so every crate version
matches: the same `gpui-kit = "=0.9.1"` pin as rune mini and the mega port). It depends on `../linux/core`
(`rune-mini-core`) by path. Core changes are additive only (new module `library`, `Client::json`/`send_json`), because
`native/linux/app` and `native/mac` share that crate and another agent is editing them.

Status words: **done** (in this branch, checked against the web in a screenshot pair), **next** (plain work),
**hard** (needs a GPUI component that does not exist or real design), **web-only** (deliberately not ported).

## How the web gets its data, and so how this app does

- REST for everything (`web/src/api.ts`, `browseApi.ts`, `discoverApi.ts`, `listenApi.ts`, `playlistApi.ts`), with
  TanStack Query caching. Native: one `Data` store (`data.rs`) with typed fetches that run on GPUI's background executor
  through core's blocking `Client`, a small keyed cache with a "stale after 30 s" rule like the web's `staleTime`, and
  invalidation on the websocket's `library-changed`.
- Player: websocket `/api/ws?slim=1` + `GET /api/player/:zone`, reduced by **core's `Model`** (already used by rune mini:
  slim-event queue reuse, reconnect with jitter, "offline" state). Commands go through core's `Net` worker. Reused as is.
- Covers: `/api/cover/:id?size=200|600|full`. Fetched on a small thread pool, **decoded off the UI thread**, kept in an
  LRU **by (album, size)** as GPU-ready `RenderImage`s; the grid asks for 200 (cards) or 600 (hero) exactly as the web's
  `srcset` does.

## What core already gives, and what is added

| Reused unchanged | Used for |
|---|---|
| `model.rs` (`Model`, `Player`, `QueueItem`, `ZoneInfo`, `pickable_zones`) | player state, queue, zone list, slim events |
| `net.rs` (`Net`: ws thread + ordered REST worker, `Client`, `image`) | websocket, reconnect, player commands, covers |
| `commands.rs` (`UiCommand` -> request) | play/pause/next/prev/seek/volume/shuffle/repeat/jump/remove/move |
| `reconnect.rs`, `config.rs` | back-off, `~/.config/rune-desktop` style config + token file (own dir) |
| `keys.rs` | NOT reused (mini's panel keys differ from the web's `Shortcuts.tsx`); the web table is in `shortcuts.rs` |

Added to core (new files only): `library.rs` (typed `AlbumSummary`, `Album`, `Track` with disc/number/format, `Artist`,
`SearchResults`, `PlaylistSummary`, `PlaylistDetail`, `Page<T>`; same field names as `shared/src/index.ts`),
`client_ext.rs` (`Client::get_json`, `Client::send_json(method, path, body)` with the server's `{error}` text, used by every
page). The signal path is not in core's `WireState` (adding a field would touch tests that other agents also edit): the
app reads it from `GET /api/player/:zone` when the current track changes.

## Web page / component -> native module

Native modules live in `native/desktop/app/src/`.

### Shell (web: `Shell`, `Sidebar`, `TopBar`, `Toast`, `Popover`, `Dialog`)
| Web | Native | Status |
|---|---|---|
| `Shell.tsx` grid, scroll restore per route | `shell.rs` (layout, router outlet, per-route scroll offsets) | done |
| `Sidebar.tsx` (collapsible, 11 items, "New playlist") | `sidebar.rs` | done (collapse done) |
| `TopBar.tsx` back/forward, search field, rescan/settings menu | `topbar.rs` | done: nav + search + menu with Rescan; Volume levelling, auto-radio, Duplicates, Background rows are phase 5 |
| `Toast.tsx` | `toast.rs` | done |
| `Popover.tsx` / `TrackMenu.tsx` context + dropdown menus | `menu.rs` (one overlay menu, anchored, keyboard + click-away) | done |
| `Dialog.tsx`, `PlaylistDialogs.tsx` (new / rename / delete) | `dialog.rs` | done: new playlist, confirm delete; smart-playlist builder phase 4 |
| `Ambient.tsx`, `DitherBackdrop.tsx`, `lib/dither.ts`, glass blur | `backdrop.rs` | **phase 6**; phase 1 draws the flat `#0f1013` (the web's "Off" setting) with the glass tint |
| `Logo.tsx` (dot logo) | `logo.rs` | done (static dots) |
| `MobileTabs`, `MiniPlayer`, `MobileBack`, `UpdateChip` mobile bits | - | web-only |
| `FirstRunGate`, `Setup.tsx` | `setup.rs`: a first-run "server address" screen only | next (phase 1 reads `--url`/config; no screen yet) |
| routing (`App.tsx` routes) | `route.rs` `Route` enum + history stack (back/forward like `window.history`) | done |

### Player (web: `components/player/*`, `store/player.ts`, `player/*`)
| Web | Native | Status |
|---|---|---|
| `NowPlayingBar.tsx` (art, title row with like + menu, artists, album) | `playerbar.rs` | done |
| `parts.tsx` `Transport`, `PlayPause`, `SeekBar`, `VolumeControl`, `SignalDot`, `ZonePicker` | `playerbar.rs`, `slider.rs` | done (seek is the plain slider; the **waveform seek** is phase 3) |
| `Slider.tsx`, `VolumeSlider.tsx` | `slider.rs` (drag, click, wheel, keyboard) | done |
| `Queue.tsx` drawer (380 px; click row = jump, x = remove, Clear, drag reorder) | `queue.rs` | done: jump, remove, clear, current row; **drag reorder** next (phase 2) |
| `NowPlaying.tsx` full screen (huge cover, up next, About excerpt) | `nowplaying.rs` | phase 2 |
| `Waveform.tsx`, `usePeaks` | `waveform.rs` | phase 3 |
| `store/player.ts` zone routing: `ownCopies`, `routeItems`, twins, Spotify fallbacks, `PlayOnSheet` | `playroute.rs` | phase 1 sends `play` to the chosen zone (pc by default, local + Spotify tracks as the server accepts them); the twin/fallback logic is phase 4 |
| `player/engine.ts`, `tabPlayer.ts`, `browser.ts`, `zoneEngine.ts`, `hybrid.ts`, `oneTab.ts`, `phoneSoloist.ts` (a browser tab that **sounds** a `browser:<id>` zone) | `audio/` (symphonia + cpal, `TabPlan`/`TabReport`) | **phase 9, needed on the MacBook** (see "Open decision") |
| `MediaSession.tsx` | MPRIS (Linux) / `MPRemoteCommandCenter` (Mac); reuse `core/mpris_meta.rs` and the mini app's `desktop.rs` pattern | phase 7 |

### Library pages
| Web | Native | Status |
|---|---|---|
| `Albums.tsx` (header, source seg, find box, facet chips, sort, grid/list, virtualised) | `pages/albums.rs`, `widgets/grid.rs`, `widgets/albumcard.rs` | done: header, source seg, find, sort, grid + list view, virtualised, paged load; Label/Year facet popovers next (phase 2) |
| `AlbumCard.tsx`, `Cover.tsx`, `PageSkeleton`, `Pin.tsx` mark | `widgets/albumcard.rs`, `covers.rs` | done (hover play button, format badge, pin mark, initials tile, skeleton) |
| `Album.tsx` hero + tabs + `TrackList.tsx` + "More by" | `pages/album.rs` | done: hero (cover, kind, title, meta, tags, Play/Shuffle/Queue/more), track list (disc headers, playing row, per-track menu, hover play), "More by"; **ASCII wave hero**, tab strip, Review / About / Credits / Connections / Editions / Your plays / Fix match are **phase 5** |
| `Artists.tsx` (derived from albums, avatar grid) | `pages/artists.rs` | done |
| `Artist.tsx` hero (mosaic), bio, discography, appears on, similar | `pages/artist.rs` | done: hero with cover mosaic, bio, Play/Shuffle, Albums, Appears on, Similar; MusicBrainz discography sections + `artist-info` photo are phase 5 |
| `Playlists.tsx` (cards, find, new, mine/Spotify sections) | `pages/playlists.rs` | done |
| `Playlist.tsx` hero + `PlaylistTracks` | `pages/playlist.rs` | done: hero, play/shuffle/queue, track rows, remove, delete; drag reorder, multi-select, inline rename, image, hotkey, m3u8, Spotify scope notes are phase 4 |
| `Search.tsx` (top result, albums, artists, tracks, keyboard nav) | `pages/search.rs` | done (debounced; arrows + Enter) |
| `Tracks.tsx`, `Genres.tsx` (+ `GenrePage`) | `pages/tracks.rs`, `pages/genres.rs` | phase 2 |
| `Home.tsx` + `DiscoverRow` | `pages/home.rs` | phase 2 |
| `Discover.tsx`, `lib/discover.ts`, `components/discover/*`, `SongRadio`, `newSongs` | `pages/discover.rs` | phase 4 |
| `Radio.tsx`, `lib/radio.ts`, `store/radio.ts` | `pages/radio.rs` | phase 4 |
| `People.tsx`, `Person.tsx` | `pages/people.rs` | phase 5 |
| `Stats.tsx`, `discover/Charts.tsx` | `pages/stats.rs` | phase 5 |
| `Duplicates.tsx` | `pages/duplicates.rs` | phase 5 |
| `Settings.tsx`, `UpdateCard/UpdateChip` | `pages/settings.rs` | phase 5 (update card: the native app updates by the release process, not the server's self-update) |
| `album/Reception.tsx`, `Notes`, `Credits`, `Editions`, `Connections`, `GlassStars`, `ReviewPreview` | `album/*.rs` + markdown-ish prose (serif) | phase 5 |
| `AsciiWaves`, `WaveCover`, `lib/waveCover.ts`, `dotLogo` | `ascii.rs` (the mega port's glyph-sprite technique) | phase 6 |

### Actions and state
| Web | Native | Status |
|---|---|---|
| `hooks/usePlay.ts` (play album, shuffle, enqueue, play next) | `actions.rs` | done |
| `AddToPlaylist.tsx`, `usePlaylistEdit` | `actions.rs` + menu submenu | done: recent playlists, new playlist, picker; undo toast |
| `Pin.tsx`, `/api/pins` | `actions.rs` | done (albums and playlists) |
| `Liked.tsx`, `/api/tracks/liked` | `actions.rs` | done (Spotify tracks only, as the web) |
| `Shortcuts.tsx` + `lib/keys.ts` | `shortcuts.rs` | done: Space, E/R, 1-4, Q, Z, X, G, F, `/`, album key (default A); user-chosen playlist hotkeys and the album-key setting are phase 5 |
| websocket live updates, `library-changed` -> refetch | `data.rs` | done |

## Phases and honest estimates

"Estimate" is calendar time of focused agent work including the screenshot-pair checks and tests; the first number is
what I would bet on, the second what it costs if GPUI fights back. Phase 1 is what this commit delivers.

| # | Phase | What | Estimate |
|---|---|---|---|
| 1 | Skeleton | shell, player bar, queue drawer, Albums / Album / Artists / Artist / Playlists / Playlist / Search, actions, menus, shortcuts, live updates, covers cache, e2e, perf numbers | built here (about 1 long session) |
| 2 | Finish the basics | Home, Tracks, Genres + genre page, Now Playing full screen, queue drag-reorder, Albums facets (label/year), playlist drag-reorder + multi-select + inline rename, waveform seek bar, window-size breakpoints and sidebar collapse persistence | 2 to 3 days |
| 3 | Album page, fully | tab strip with scroll-spy, Review (reception prose, score chips, quotes), About (editions, artist notes, background), Credits, Connections, Your plays, Fix match dialog, review preview | 2 to 3 days (prose layout and links inside prose are the risky part: GPUI has `StyledText` but no inline links in flowing text; plan: a small run-based text element) |
| 4 | Discover + Radio + playlists complete | Discover rows and `lib/discover.ts` logic, song radio, Radio page, smart-playlist builder, m3u8 import/export, Play-on sheet, twins/Spotify routing, hotkeys | 3 to 4 days |
| 5 | The rest of the pages | People, Person, Stats (charts drawn with paths), Duplicates, Settings (+ ambient/levelling/auto-radio), setup screen | 3 days |
| 6 | The look | dither backdrop (port `lib/dither.ts` + the WebGL shader to a wgpu/offscreen texture or the mega glyph-sprite approach), ASCII album hero, wave covers, glass blur under sidebar/bar | 3 to 5 days; **hard**: GPUI has no `backdrop-filter`, so true glass needs either a pre-blurred copy of the backdrop texture or the same "dim tint" fallback the web already uses |
| 7 | OS integration | MPRIS + media keys (Linux), `MPRemoteCommandCenter` + NowPlaying (Mac), tray/dock, notifications on track change, single instance, window state, desktop file, Mac build script | 2 days |
| 8 | Hardening | idle CPU/RAM pass, 10k-album soak, Wayland + X11 + Mac screenshots, accessibility labels, error/offline states on every page, crash-safe config | 2 days |
| 9 | Own-audio zone (**decision needed**) | the web's "This browser" zone, native: a `browser:<id>` zone that this app **sounds itself** (symphonia decode, cpal output, gapless run from `TabPlan`, `TabReport`s back) so the MacBook plays without a PC; bit-perfect is out of scope (CoreAudio resampling) | 5 to 8 days; **hard**: gapless + seeking over Range streams + FLAC cue tracks |

Total to "replaces the web UI on the PC": phases 1-8, roughly 3 to 4 weeks of agent time. The MacBook only becomes useful on
its own with phase 9 (without it the Mac app is a remote control of the PC's zone, exactly like rune mini).

## Deliberately NOT ported

- `Setup.tsx` as a multi-step wizard (library roots, MusicBrainz, Spotify OAuth, Soloist pairing): done once on the
  server from a browser; the native app only asks for the server address. Spotify OAuth in particular needs a browser.
- All mobile layout: `MobileTabs`, `MiniPlayer`, `MobileBack`, the < 900 px branches of every page, safe-area insets,
  swipe-to-close, iOS volume hints, `phoneSoloist.ts` (HLS stream to a phone), `PlayOnSheet` as a bottom sheet (it is a
  menu here), `isHandheld`, PWA install, `?mock=1` mock mode (the native tests use a real silent server instead).
- The self-updater UI (`UpdateCard`, `UpdateChip`): it updates the *server* from git; the native app ships through the
  release process. A one-line "server has an update" notice can come back in phase 5 if wanted.
- `ErrorBoundary`, `clientLog`, build-id reload prompt (`hello.build`): a native app has no stale bundle.
- `SongRadio`'s "preview" audio (`lib/previews.ts`, 30 s clips): needs the own-audio engine (phase 9) first.
- Browser-only plumbing: `scrollRoot`, `useMedia`, `frameRate`, `oneTab`, `preferLocal`, `capabilities`, localStorage
  keys (replaced by `~/.config/rune-desktop/state.json`).

## Decisions taken (2026-11-20)

1. **Mac is not a remote control**: it plays on its own, so phase 9 (own audio) is built right after phase 2 (done below).
2. **Glass** is the plain dim tint (no blur). 3. Config stays in `~/.config/rune-desktop/`.

## Open decisions for the user (superseded by the list above)

1. **MacBook audio**: ship the Mac build as a remote control first (phases 1-8) or wait for phase 9?
2. **Backdrop**: the web's default is the dither backdrop. Phase 1 compares against the web with `?ambient=off`
   (flat `#0f1013`). Phase 6 ports the dither; is "glass" without real blur acceptable?
3. **Config dir**: `~/.config/rune-desktop/` (separate from rune mini so the two never fight over `config.json`).

## Method (the mega lesson)

Every page is built from a **web | native screenshot pair at the same window size** (`tools/shots.sh`: the web in headless
Chromium on ANGLE/Vulkan with `--password-store=basic --use-mock-keychain --mute-audio` against `?ambient=off`; the native app in a
private headless KWin; both against the same generated 60-album server from `server/tests/e2e/desktopServe.ts`). Anything that
animates (hover fades, queue drawer slide, toast) is checked as a frame sequence. Code reading alone does not count.

## Phase 1 results (this branch)

Built and checked in web | native pairs at 1280x800 (tools/shots.sh; ambient "off" on the web side): Albums (grid, list view
via toolbar), Album, Artists, Artist, Playlists, Playlist, Search, plus the queue drawer. Known, deliberate differences in those
pairs: Label/Year facet chips (phase 2), waveform seek bar (phase 3), About/Review tabs and the credits/"Your plays" blocks
(phase 3/5), ASCII/dither/blurred-mosaic hero backdrops and the animated logo (phase 6), editable playlist chrome (phase 4).
No animation exists yet (queue drawer slide, hover fades, route fade), so there are no frame sequences; they come with phase 2.

Measured on the 2,000-album generated library (Ryzen 7 7800X3D, RTX 4090, private headless KWin 1280x800, release build;
`tools/native-perf.py` and `tools/web-perf.mjs`, web = headless Chromium on ANGLE/Vulkan):

| | web (Chromium) | rune-desktop |
|---|---|---|
| idle RSS (PSS, whole process tree) | 596 MB | 193 MB |
| idle CPU | 38 % of a core | 0.2 % |
| after scrolling 1,200 albums of covers | 859 MB | 292 MB (covers held: 84 MB budget) |
| scroll, 300 frames at 40 px/frame | p50/p95/max 16.7/16.7/16.8 ms | 16.7/16.8/18.5 ms |
| scroll, 300 frames at 200 px/frame | 16.7/16.7/16.8 ms, 0 over 20 ms | 16.7/16.8/59.8 ms, 4 over 20 ms |

The 4 slow frames at 200 px/frame are covers arriving (decode is off the UI thread; the texture upload is not).
Not yet verified: a real keyboard/pointer pass through KWin's fake-input protocol (the e2e drives the same action code through a
test control port instead), HiDPI, X11, and macOS.


## Phase 2 results (branch gpui-desktop-2)

Built and checked in web | native pairs at 1280x800 (tools/shots.sh, tools/pair.sh): Home (greeting, Recently added / Recently
played / Spotify / Rediscover, horizontal scrollers with arrows), Tracks (filter, sort + direction, sortable header, virtualised),
Genres (mosaic tiles, filter) and a genre page, Now Playing full screen (cover, title, waveform, transport, volume, signal path, Up
next; Esc or the chevron closes; the dither backdrop is phase 6), the waveform seek bar (peaks from `/api/peaks`, the web's
song-shaped stand-in for Spotify), queue drag-reorder (grip), Albums Label/Year facets (scrolling list menus, removable chips),
playlist drag-reorder, multi-select (shift / ctrl-click, Select mode, Delete key, add to playlist, remove) and inline rename.
Window-size handling: pages already re-flow their grids; the sidebar collapse is remembered in `state.json`.
Not in the pairs yet: the Now Playing "Critical reception / About" cards (phase 3 brings the prose), the playlist hero's
tinted card and its Hotkey / "Show in rune mini" / sort buttons (phase 4).

## Phase 9 results: the app sounds its own zone

`audio/`: `source.rs` (HTTP byte source with `Range` re-opens), `pipeline.rs` (symphonia decode, channel mix, rubato resample,
the timeline of songs in the frame stream), `engine.rs` (decode thread + ring buffer + cpal output, or a silent real-time clock
with `RUNE_DESKTOP_AUDIO=null`), `tabplayer.rs` (the web's `TabPlayer`: follows the server's `TabPlan`, reports started / ended /
paused / position / failed in order, goes on down the run without a round trip). The zone is `browser:<id>` (id kept in
`state.json`), listed in the zone picker as "This computer (<host>)"; it is the default zone on macOS. It keeps playing while
another zone is on screen (a second `Model` follows it). The stream is the original file (`fmt=orig`, `accept=flac,mp3,aac,m4a,
wav,aiff,vorbis`; opus and wma are transcoded by the server), the server's `X-Rune-Gain-Db` levelling is applied, volume is the
zone's volume (linear). The output opens at the song's own rate when the device offers it, otherwise the device default with a
sinc resampler. Tests: unit (timeline, resampler, mixer, TabPlayer with a mock engine), engine tests against a tiny ranged HTTP
server in real time (gapless across 44.1 and 48 kHz, pause, ranged seek, a missing file), and the desktop e2e (the server's zone
follows the app: play, skip, seek, pause, songs ending by themselves). NOT verified here: the cpal path on a real sound device
and on macOS (CoreAudio), because the rig is silent by rule; bit-perfect output stays out of scope (CoreAudio resamples).

## Phase 3 results: the album page, fully

Checked in web | native pairs (tools/pair.sh; native paths in the report): hero with the average rating (glass stars drawn as paths,
tally, chips on open), sticky tab strip with scroll-spy (Tracks / Review / About / Credits; the strip is also drawn as an
overlay once the hero has scrolled away), Review (reception prose with Read more, scores column, pull quotes, "Read in context"),
About (facts, editions table, other versions, artist notes with the verified pill, background), Credits (grouped, merged,
track references), Your plays (tiles + sparkline path), Connections (the "With A (role), B" line is the run-based text element:
links wrap across lines), More by, Fix match (banner, menu item, candidate dialog, apply) and the review preview sheet (score,
excerpt, stored text, where the reception mentions the critic with the term marked; "Open original" hands the address to the
browser instead of an iframe). The pure rules (scores, credits, sentences, dates) are ported with tests in `albumlogic.rs`.
Known differences: the section cards' glass backdrop and the ASCII hero (phase 6); the review preview has no embedded "Original" view.
The seeded fixture (reviews, credits, plays) lives in `server/tests/e2e/desktopServe.ts` (RUNE_DESKTOP_SEED=0 to leave it out).
