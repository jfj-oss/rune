# Liner — UI layout spec

Goal: the feel of Roon (dark, art-first, magazine-like album pages, everything is a link),
in our own visual identity. **Do not copy Roon's logo, icons, artwork, or exact assets.** Use
an open icon set (Lucide).

## Visual language
- Dark only for v1. Tokens (CSS custom properties on `:root`):
  - `--bg: #0f1013` · `--surface: #17181d` · `--surface-2: #1f2027` · `--line: #2a2b33`
  - `--text: #ececf1` · `--text-2: #a4a5b0` · `--text-3: #6d6e7a`
  - `--accent: #8f7cff` (lavender), `--accent-2: #b9adff`, `--ok: #4fd18b` (signal path bit-perfect), `--warn: #e8b04a`
  - Radius 8 px (covers 4 px), shadows soft and large on hero art.
- Type: **Inter** for UI (Google Fonts), **Source Serif 4** for long prose (reviews, bios, notes) — the "liner notes" voice. Sizes: hero title 44/48 desktop, 28 mobile; section heads 13 px uppercase tracking .08em `--text-3`; body 15.
- Art is king: covers large, never cropped (1:1), lazy-loaded `/api/cover/:id?size=200|600|full`, with a placeholder tile showing initials while loading.
- Hero backdrops: the album cover blurred (≥60 px) and darkened (gradient to `--bg`), behind the page header.
- Every artist name, credit person, genre, label, year is a link (to artist page / filtered library).
- Motion: 150–200 ms fades/slides; no bouncy springs.

## Shell — desktop (≥ 900 px)
```
┌──────────┬─────────────────────────────────────────────────────────────┐
│ Sidebar  │ Top bar:  ‹ ›  [ Search…                         ]  ⚙       │
│  Home    ├─────────────────────────────────────────────────────────────┤
│  Albums  │                                                             │
│  Artists │                  routed page (scrolls)                      │
│  Tracks  │                                                             │
│  Genres  │                                                             │
│  ──────  │                                                             │
│  Spotify │                                                             │
│  Playlists│                                                            │
│          │                                                             │
├──────────┴─────────────────────────────────────────────────────────────┤
│ Now-playing bar (88px): [art] Title / Artist·Album │ ⏮ ⏯ ⏭  ━━━●━━ 2:13/4:01 │ ⇄ ↻ │ ●signal │ zone ▾ │ vol │ ☰queue │
└────────────────────────────────────────────────────────────────────────┘
```
- Sidebar 220 px, collapsible to icons. Source filter in Albums: All / Local / Spotify chips.
- Queue = right drawer (380 px) over the page, drag to reorder, × to remove, "Clear".
- Signal dot: green `--ok` when signalPath contains "bit-perfect", amber otherwise, grey for Spotify; click → popover listing signalPath steps vertically with arrows.
- Zone picker: "This PC (speakers)", "This browser", Spotify Connect devices (e.g. "iPhone — Spotify").
- Clicking the now-playing art opens the **Now Playing** full screen.

## Shell — mobile (< 900 px, iPhone first, installable PWA, safe-area insets)
- Bottom tab bar: Home · Library · Search · Queue. Mini-player (64 px) docked above it: art, title/artist, ⏯, progress hairline on top edge. Tap → full Now Playing sheet (swipe down to close).
- Pages are single column; hero art 72% width centered; track rows 56 px tall touch targets.

## Pages

### Home
- "Recently added" horizontal row of album cards (cover 180, title, artist).
- "Recently played", "From Spotify — your saved albums" rows (Spotify row hidden until connected).
- "Rediscover" — random 8 albums not played in 90 days (grid).

### Albums (library grid)
- Toolbar: count ("412 albums"), sort (Date added / Artist / Title / Year), source chips, view toggle (grid/list).
- Grid: responsive cards min 170 px; cover, title (1 line ellipsis), artist (link), small format badge bottom-left of cover on hover ("FLAC 24/96", "Spotify" with green dot).
- Virtualized for thousands of items.

### Album page (the centrepiece)
```
[ blurred cover backdrop ...................................................... ]
  ┌────────┐  ALBUM
  │ cover  │  Title of the Album                 (hero, 44px)
  │  300px │  Artist Name  ·  1977  ·  Label  ·  10 tracks, 41 min
  │        │  [FLAC 24/96]  Rock · Soft Rock (genre chips)
  └────────┘  [▶ Play]  [⇄ Shuffle]  [+ Queue]  ⋯ (Fix match, Open folder)
              ◎ 84 Metacritic   AOTY 79   Pitchfork 8.1   ← score chips row
──────────────────────────────────────────────────────────────────────────────
 Tracks | Review | About | Credits                 (sticky tab strip, anchors)
──────────────────────────────────────────────────────────────────────────────
 TRACKS   #  Title                               Artist (if differs)   4:01  ⋯
          disc headers "Disc 2" when multi-disc; playing row shows animated bars
──────────────────────────────────────────────────────────────────────────────
 CRITICAL RECEPTION                        (two columns ≥1200px: prose | scores)
   Serif paragraph from Wikipedia reception, max ~10 lines, "Read more" expands
   — source line: "From Wikipedia ↗"
   Quote cards (horizontal scroll on mobile):
     “short excerpt …”      — Outlet, Author ↗
──────────────────────────────────────────────────────────────────────────────
 IN THE ARTIST'S WORDS
   Serif blocks; a "Verified artist" pill when verifiedArtist; per-track notes
   show the track title as a small heading that links to the track row.
   Source line under each ("Genius ↗").
 BACKGROUND
   Recording/background prose (Wikipedia), same styling.
──────────────────────────────────────────────────────────────────────────────
 CREDITS   grid of person chips: round avatar (initials fallback), name (link),
           role(s) underneath; grouped: Performers / Production / Writing.
           Track-specific credits show "tracks 2, 5" in --text-3.
──────────────────────────────────────────────────────────────────────────────
 MORE BY ARTIST   row of album cards
```
- Empty states: no details yet → subtle "Looking up reviews…" shimmer; nothing found → "No reviews found for this album" and hide the section's tab.
- Low match confidence (< 0.7) → amber banner at top: "This album may be matched wrongly. Fix match" → dialog listing `candidates` (title, artist, year, tracks, country, score) with radio + Apply.
- Spotify albums use the same page; format badge "Spotify"; no Fix match.

### Artist page
- Wide hero: artist image (or blurred mosaic of their covers) with name 56 px over a gradient.
- Bio (serif, 6 lines + Read more, source link).
- Discography grid: "Albums", "Appears on" sections. "Similar artists" chip row.

### Search
- Single box in the top bar (mobile: Search tab). Results as sections: Top result card, Albums row, Artists row, Tracks list (8). Local and Spotify results mixed with a small source badge. Debounced 200 ms; ↑↓/Enter keyboard navigation on desktop.

### Now Playing (full screen)
- Background: blurred art. Left: huge cover (min(60vh, 50vw)). Right (desktop) or below (mobile): title (serif 34), artist · album links, seek bar with times, transport row, volume, signal path line, "Up next" (3 items), and a short "About this album" excerpt from reception/background (tap → album page).
- Esc / swipe down closes.

## States & data
- All data via a typed client `web/src/api.ts` using types from `@liner/shared`. A mock mode (`?mock=1` or `VITE_MOCK=1`) serves rich fixture data (≥ 30 albums, one with full details: scores, 4 quotes, artist notes incl. per-track, 20 credits; one multi-disc; one low-confidence; a few Spotify) so the UI can be built before the server is done.
- Live updates: websocket `/api/ws` `ServerEvent` → player state store.
- Player store: Zustand. Routing: React Router. Server cache: TanStack Query.

## v1.1 — Ambient background + liquid glass (user request 2026-11-01)

### Ambient background (whole app)
- The app background slowly cycles through three dark hues, crossfading continuously:
  1. **Solarized blue** — base `#002b36` with a `#073642` lift (Solarized base03/base02)
  2. **Indigo purple** (from the user's screenshot) — top `#290893`, mid `#1f0862`, low `#190c41`, fades to `#150f25`
  3. **Dark green** — `#0B3A0B` (exact, user-specified), deepening to ~`#061f06`
- Shape: a vertical gradient — the hue is saturated at the top of the viewport and sinks into near-black at the bottom (like the screenshot: bright band at top → `#150f25`-ish at the bottom). Optionally one or two very large, soft radial blobs drifting slowly for depth.
- Timing: full cycle ~90 s (≈30 s per colour), eased crossfades, never a visible jump. Must respect `prefers-reduced-motion` (then: static, pick one colour) and offer a setting: Ambient colours: Cycle / Blue / Purple / Green / Off (Off = the current flat `--bg`).
- Performance: animate only `opacity`/`transform` of stacked fixed layers (or a single `@property`-registered colour custom property) — never repaint the whole page per frame. Must stay smooth on a MacBook Air and iPhone; check that scrolling the album grid does not drop frames.
- Content surfaces that currently use `--bg` must become transparent so the ambient shows through; cards/rows keep subtle translucent surfaces (`rgba(255,255,255,.04–.06)`).
- Album page hero keeps its cover-tinted gradient on top of the ambient.

### Liquid glass — sidebar (left) and now-playing bar (bottom); on mobile the bottom tab bar + mini-player
- Apple-style "liquid glass": translucent panel showing the moving ambient behind it — `backdrop-filter: blur(28–40px) saturate(160–180%)`, a faint white fill (`rgba(255,255,255,.06–.10)`), a 1 px inner highlight on the edge facing the content (top edge for the bottom bar, right edge for the sidebar) `rgba(255,255,255,.18)`, a soft outer shadow, and a subtle vertical gradient sheen (lighter at top → transparent) like the screenshot's top band.
- Optional specular touch: a very faint diagonal highlight gradient across the panel; no heavy noise textures.
- Text/icons on glass must keep WCAG AA contrast against every ambient colour (check all three: blue, purple, green). Raise text opacity or add a slight dark tint under the glass if needed.
- Fallback when `backdrop-filter` is unsupported: a solid `rgba(15,16,19,.85)` panel.
- The sidebar and bar float over content: page content scrolls underneath the bottom bar (add bottom padding so the last row is reachable).

### Accent check
- The lavender accent `#8f7cff` sits poorly on the purple phase. Verify contrast of accent buttons/links on all three phases; if needed, shift the Play button to a light fill (`#ece9ff` text dark) or brighten accent to `#a99bff` during the purple phase.
