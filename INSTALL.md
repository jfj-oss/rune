# Installing rune on Linux

rune is a music player that runs as a small server on your own PC. You use it in a browser tab. Everything stays on
your computer: your own music folder, and (optionally) your own Spotify account, your own Spotify developer app and your
own Soloist key. Nothing is shared with anyone else.

## Install

```sh
git clone https://github.com/jfj-oss/rune.git ~/.local/share/rune && ~/.local/share/rune/scripts/install.sh
```

The installer checks what rune needs, gets and builds the code, writes a starting settings file, and asks before it
installs a **systemd user service** (`rune.service`) that starts rune when you log in. It never uses `sudo`: if something
is missing it prints the exact command for Arch/CachyOS, Debian/Ubuntu and Fedora, and you run it yourself.

What it needs:

| Needs | Why |
|---|---|
| `git` | gets rune and its updates |
| Node.js 22 or newer, and `pnpm` (or `corepack`, which the installer enables for you) | runs and builds rune |
| `mpv` | plays your music files |
| `ffmpeg` | audio analysis and the phone stream |
| PipeWire with `pactl` | sound output |
| a systemd user session | runs rune in the background (`--no-systemd` skips this) |

Useful options: `--yes` (no questions), `--dry-run` (print every step, change nothing), `--no-systemd` (do not touch
`systemctl`), `--dir PATH` (put rune somewhere else). `scripts/install.sh --help` lists them all.

## What to expect

1. When it finishes it prints **http://127.0.0.1:4545**. Open it.
2. The first page is the **setup page**. Pick your music folder(s) (rune only reads them, it never changes a file) and
   press **Apply and restart**. rune scans your library; a big one takes a while, and you can use rune meanwhile.
3. Spotify, Soloist and phone access are optional and explained on the same page. Local-only is a complete setup. You
   can come back any time from **Settings, Set up rune**.

rune listens on this PC only (`127.0.0.1`). To reach it from a phone, see "Phone access" on the setup page
(Tailscale) and `docs/IOS.md`.

Your settings are in `server/config.json` inside the install folder (never uploaded or committed). The library index
and caches are in `~/.local/share/liner`. A Soloist key, if you add one, is in `~/.config/rune/soloist-key`.

## Updates

rune checks the public repository by itself. When there is a newer version a chip appears in the top bar (and **Settings,
Updates** has a button): press it, and rune downloads, rebuilds and restarts itself, waiting for the song that is playing
to end. Or run the installer again (`scripts/install.sh`), which does a `git pull`.

## Troubleshooting

- **No sound.** rune plays through PipeWire. Check `pactl info` says *PipeWire* and `pactl list short sinks` lists your
  speakers or headphones. Set the right default output in your desktop's sound settings (or with `wpctl status` and
  `wpctl set-default <id>`). If your output is not the default, set `"audioDevice"` in `server/config.json` (for
  example `"pipewire/alsa_output.pci-0000_00_1f.3.analog-stereo"`; `mpv --audio-device=help` lists the names), then restart.
- **rune does not start / the page does not load.** `systemctl --user status rune.service` and
  `journalctl --user -u rune.service -e` say why. The usual causes are a missing tool (re-run the installer) or the port
  4545 being in use (set `"port"` in `server/config.json`).
- **My music does not show up.** Settings shows each folder as Mounted or Missing. External drives must be mounted
  before rune starts; rune will not scan a folder it cannot read.
- **Spotify: "Locked out" or error 429.** Spotify limits how often an app may ask. rune keeps its own daily budget and
  backs off by itself; wait until the time Settings shows. Do not press Connect repeatedly.
- **Spotify login fails.** The redirect address in your Spotify app must be exactly the one the setup page shows
  (`http://127.0.0.1:4545/api/spotify/callback`), and you must press Connect in a browser on the same PC.
- **Soloist says its build expired (every 90 days).** Download the current Soloist build from Spotify's developer site,
  replace `~/.local/bin/soloist`, and restart rune (`systemctl --user restart rune.service`). Your key and pairing stay.
- **Soloist does not pair or start.** The binary must be executable and at `~/.local/bin/soloist`, the key saved on the
  setup page, and Premium on the account you pair.
- **rune stops when I log out.** Run `loginctl enable-linger "$USER"` once to keep user services alive.

## Uninstall

```sh
~/.local/share/rune/scripts/install.sh --uninstall
```

stops and removes the service and keeps your settings and data. Add `--purge` to also delete rune's data
(`~/.local/share/liner`, `~/.config/rune`, and the code when rune cloned it into `~/.local/share/rune`). Your music files are
never touched.
