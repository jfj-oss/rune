# rune

A Roon-style music player for your own computer: your local music library and Spotify in one place, with album
pages, reviews, radio, playlists and a dithered ambient look. It runs as a small server on your PC; you use it in a
browser tab (and from your phone over your own network).

Built for Linux. It may run elsewhere but is only tested there.

## Install

On Linux, one command (details, options and troubleshooting are in [INSTALL.md](INSTALL.md)):

```sh
git clone https://github.com/jfj-oss/rune.git ~/.local/share/rune && ~/.local/share/rune/scripts/install.sh
```

It checks for Node 22, pnpm, mpv, ffmpeg and PipeWire (printing the install command for your distro if any is missing),
builds rune, and offers to run it as a systemd user service. Then open **http://127.0.0.1:4545**: a setup page asks for
your music folder and, optionally, your own Spotify app, Soloist key and phone access. rune only ever reads your music
folders; it never changes your files.

### By hand

```sh
git clone https://github.com/jfj-oss/rune.git
cd rune
pnpm install
pnpm --filter @liner/web build
cd server && npx tsx src/main.ts
```

Settings go in `server/config.json` (kept on your computer, in `.gitignore`), or use the setup page:

```json
{
  "libraryRoots": ["/home/YOU/Music"],
  "audioDevice": "pipewire"
}
```

Megatron can play your local music into a voice call from its "Play into call" picker. Megatron's own browser
(`http://127.0.0.1:7420`) and desktop app origins are allowed automatically. For a Megatron opened from another
device, add its address to `corsOrigins`:

```json
{ "corsOrigins": ["http://192.168.1.10:7420"] }
```

Only search, album/playlist details, cover art and the audio stream are exposed. Spotify audio is never streamed, and
Megatron filters Spotify tracks out of everything it plays.

## Spotify (optional)

Each person uses **their own** Spotify app ID (free, two minutes):

1. Go to https://developer.spotify.com/dashboard, log in, **Create app**.
2. Redirect URI: `http://127.0.0.1:4545/api/spotify/callback`. Tick **Web API** and **Web Playback SDK**.
3. Copy the **Client ID** (there is no secret: rune uses PKCE) into `server/config.json`:
   `"spotifyClientId": "your-client-id"`
4. The setup page (Settings, Set up rune) does steps 2-4 for you. Otherwise restart rune, then in a browser on the same PC open **Settings** and press **Connect Spotify** next to "Spotify:
   Not connected" (or open `http://127.0.0.1:4545/api/spotify/login` directly) and approve the login.

New Spotify apps are in "development mode": only accounts you add under **User Management** in the dashboard can log
in, which is fine for your own use.

## Notes

- Data (database, covers, caches) lives in `~/.local/share/liner`. Delete that folder to start over.
- Tests: `pnpm test` (they never call the real Spotify API).

## Spotify Soloist (optional): Spotify with no desktop app, and on your phone

[Spotify Soloist](https://developer.spotify.com/documentation/soloist) is Spotify's own headless Connect client. With it,
rune gets a **Spotify (Soloist)** zone that plays Spotify on the PC without the desktop app and without a single Web API
request, and a phone can listen to that zone through rune (the sound goes into a silent PipeWire sink, `rune-phone`, that
rune encodes to HLS at `/api/soloist/stream/live.m3u8`).

Once:

1. Install the `soloist` binary at `~/.local/bin/soloist` (Spotify's builds expire after 90 days; rune says "Soloist build
   expired: update it" when that happens).
2. Create a Soloist API key in the developer dashboard (Premium) and put it in `~/.config/rune/soloist-key`
   (`chmod 600`). rune never logs it.
3. Pair it: `soloist -n rune -k "$(cat ~/.config/rune/soloist-key)" --pair` (the session is kept in Soloist's data dir).

rune starts and supervises Soloist itself when both files exist (`soloist.enabled: false` in `config.json` turns it off;
`soloist.deviceName`, `wsPort` (4547), `sink`, `hlsKbps` are the other keys).

While Soloist is running and signed in, it is also how the **Linux PC speakers** zone plays Spotify songs: no desktop app
is started, no Connect device is polled, and no Web API request is made (local files stay on mpv in the same queue, and
only one of them sounds at a time). The Soloist zone is therefore folded into the PC speakers zone and never listed on
its own while it can play.

On a **phone** (iPhone, iPad, Android: no Web Playback SDK there), Spotify songs on the phone's own zone ("This iPhone")
play through Soloist by default: rune switches Soloist's sound to the stream and the phone plays it in one `<audio>`
element, lock screen included, with no Spotify app involved. Local files keep playing in the phone's own player, and a
mixed queue hands over between the two the way the PC does between mpv and Soloist. There is one Soloist, and the newest
request wins: a phone starting a Spotify song while the PC plays through Soloist takes the sound over (the PC's page says
"Spotify moved to the phone" and its signal path ends "to the phone"); Play on the PC brings it back to the speakers. When
Soloist cannot play (not installed, no key, not paired, crashed, or its build expired), both the PC speakers zone and the
phone go back to the Spotify app route and say why in one line, e.g. "Soloist needs updating (its build expired) — using
the Spotify app".
