# rune mini

A summon-style player panel for [rune](../README.md): press a key anywhere, a small borderless panel shows what plays in a
rune zone (cover, title, progress, transport, shuffle/repeat/volume, and the queue), the keyboard controls it, Esc hides it.
No Dock or taskbar icon. The media keys control rune through the panel even while it is hidden.

| | Linux (KDE Wayland) | Mac (Apple silicon) |
|---|---|---|
| code | `linux/`: Rust + GPUI (gpui-kit 0.9.1, the pin mega uses) | `mac/`: Swift + AppKit, SwiftPM |
| panel | layer-shell overlay, opened on show and closed on hide | one `NSPanel`, ordered in and out |
| hotkey | xdg-desktop-portal GlobalShortcuts (default Meta+Alt+Space; the desktop's dialog has the last word) | Carbon `RegisterEventHotKey`, default Option+Command+Space (menu presets) |
| tray | StatusNotifierItem + dbusmenu (show, zones, config folder, quit) | `NSStatusItem` menu (show, zone, server, hotkey, silent audio, quit) |
| media keys | MPRIS `org.mpris.MediaPlayer2.rune` | `MPRemoteCommandCenter` + `MPNowPlayingInfoCenter` |

The contract both apps use (routes, websocket, commands, keys) is [PROTOCOL.md](PROTOCOL.md).

## Install (Linux)

Nothing is installed by the build. To install by hand:

    cd native/linux
    cargo build --release -p rune-mini            # binary: target/release/rune-mini
    install -Dm755 target/release/rune-mini ~/.local/bin/rune-mini
    install -Dm644 rune-mini.desktop ~/.local/share/applications/rune-mini.desktop
    rune-mini set-server http://localhost:4545     # or your server; add --token-file FILE if a proxy wants a token
    rune-mini --show                               # the first run asks the desktop to approve the shortcut (once)

For login start: copy the .desktop file to `~/.config/autostart/`. Without a GlobalShortcuts portal (or if you decline the
dialog) bind a key in System Settings -> Shortcuts to the command `rune-mini toggle`. A second `rune-mini` start also toggles
the running one. Settings are in `~/.config/rune-mini/` (`config.json`, `token` mode 600).

## Install (Mac)

On the Mac (needs Swift: Xcode or the Command Line Tools):

    cd native && ./build-mac.sh install            # builds, ad-hoc signs, copies to "/Applications/rune mini.app"
    open "/Applications/rune mini.app"             # first run asks for the server address

No Dock icon, no login item (add it yourself in System Settings -> General -> Login Items). See [mac/README.md](mac/README.md).

## Tests

- `cd native/linux && cargo test --offline`: state reduction, command mapping, keys, filter, reconnect policy, config and the
  mode-600 token file, MPRIS metadata mapping, the zone list.
- `cd native/mac && swift test`: the same table of cases in Swift (RuneMiniCore only; the app target builds on a Mac).
- End to end: `server/tests/e2e/mini.test.ts` starts a real rune server (silent FLACs, mpv on a null output, temp data dir,
  own port), runs the Linux core as the headless `rune-mini-probe` and checks that every command moves the server and that
  server-side changes reach the panel (including a server restart). It skips itself when the probe is not built
  (`cargo build -p rune-mini-core --bin rune-mini-probe`; `RUNE_MINI_PROBE` names the binary).
- `server/tests/e2e/miniServe.ts` starts the same silent server with cover art and a paused queue, for looking at the panel.
