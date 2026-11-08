# rune

A Roon-style music player for your own computer: your local music library and Spotify in one place, with album
pages, reviews, radio, playlists and a dithered ambient look. It runs as a small server on your PC; you use it in a
browser tab (and from your phone over your own network).

Built for Linux. It may run elsewhere but is only tested there.

## What you need

- **Node.js 22** and **pnpm** (`npm install -g pnpm`)
- **mpv** (plays local files on the PC): `sudo pacman -S mpv`, `sudo apt install mpv`, …
- A folder of music files (FLAC, MP3, …)
- Optional: a **Spotify Premium** account, for Spotify playback

## Install

```sh
git clone https://github.com/jfj-oss/rune.git
cd rune
pnpm install
pnpm --filter @liner/web build
```

Create `server/config.json` (it stays on your computer; it is in `.gitignore`):

```json
{
  "libraryRoots": ["/home/YOU/Music"],
  "audioDevice": "pipewire",
  "userAgent": "rune/0.1 (your-email-or-site)"
}
```

`libraryRoots` is one or more music folders. rune only reads them; it never changes your files.

Megatron can play your local music into a voice call from its "Play into call" picker. Megatron's own browser
(`http://127.0.0.1:7420`) and desktop app origins are allowed automatically. For a Megatron opened from another
device, add its address to `corsOrigins`:

```json
{ "corsOrigins": ["http://192.168.1.10:7420"] }
```

Only search, album/playlist details, cover art and the audio stream are exposed, and Spotify tracks are never sent
to Megatron.

Start it:

```sh
cd server && npx tsx src/main.ts
```

Open **http://127.0.0.1:4545** in your browser. The first scan of a big library takes a while.

To start it with your PC, make a systemd user service whose `ExecStart` is
`/path/to/rune/server/node_modules/.bin/tsx src/main.ts` with `WorkingDirectory` set to `/path/to/rune/server`.

## Spotify (optional)

Each person uses **their own** Spotify app ID (free, two minutes):

1. Go to https://developer.spotify.com/dashboard, log in, **Create app**.
2. Redirect URI: `http://127.0.0.1:4545/api/spotify/callback`. Tick **Web API** and **Web Playback SDK**.
3. Copy the **Client ID** (there is no secret: rune uses PKCE) into `server/config.json`:
   `"spotifyClientId": "your-client-id"`
4. Restart rune and press **Connect Spotify** in Settings, in a browser on the same PC.

New Spotify apps are in "development mode": only accounts you add under **User Management** in the dashboard can log
in, which is fine for your own use.

## Notes

- Data (database, covers, caches) lives in `~/.local/share/liner`. Delete that folder to start over.
- Tests: `pnpm test` (they never call the real Spotify API).
