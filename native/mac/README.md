# rune mini for the Mac

Swift + AppKit, modelled on Claude Summon (`~/projects/claude-summon`): one borderless `NSPanel`, Carbon
`RegisterEventHotKey` (no Accessibility permission, no event tap), no Dock icon (`LSUIElement`), a menu-bar icon, SwiftPM and
`scripts/build-app.sh` with ad-hoc signing. `Sources/RuneMiniCore` has everything that is not a window (and is tested);
`Sources/RuneMini` is the app.

**Status: written but not built or run.** The MacBook Air was asleep/unreachable when this was made, and the build machine has
no Swift toolchain for macOS. `RuneMiniCore` and its 19 tests were compiled and run in a Linux Swift 6.0 container (all pass).
The AppKit, MediaPlayer, AVFoundation and Carbon code could not be compiled anywhere, so expect to fix a typo or two on the
first `swift build`. Nothing about media-key routing or idle memory is measured.

## Build and install

    cd native && ./build-mac.sh install     # swift test, swift build -c release, bundle, ad-hoc sign, install
    open "/Applications/rune mini.app"

First run: a dialog asks for the server address (and an optional token). Saved in
`~/Library/Application Support/rune-mini/` (`config.json`; `token` with mode 600). Menu-bar icon: show/hide, zone, server,
hotkey presets (Option+Command+Space default), "Claim media keys with silent audio", quit. Keys: PROTOCOL.md.

## Lightness rules (as Summon's)

- No timer while hidden or idle. The websocket is a `URLSessionWebSocketTask` the OS wakes when a frame arrives; a reconnect
  timer exists only while the connection is down. After sleep (`NSWorkspace.didWakeNotification`) or when shown, one ping checks
  it; no answer in 3 s means reconnect.
- The only repeating timer is the progress redraw: panel visible, rune playing, Low Power Mode off, once a second with 0.25 s
  tolerance. Nothing animates per frame. The panel is one custom-drawn view (no subviews, no web view, no SwiftUI).
- The cover is decoded once at 192 px; at most two covers are kept.
- Target: 30-60 MB resident while idle. Not measured yet: measure with `footprint -p $(pgrep RuneMini)` after the first run.

## Media keys (what is known, what is not)

macOS sends the keyboard's media keys and the Control Center buttons to the **Now Playing app**: the app that most recently
published `MPNowPlayingInfoCenter` info while it was the one playing audio. rune mini plays no audio (rune's server does), so
publishing info alone may or may not make it the target, depending on the macOS version, and Music/Spotify may keep the keys.

What the app does:

1. `MPRemoteCommandCenter`: handlers for play, pause, toggle, next, previous, scrubbing (`changePlaybackPositionCommand`),
   shuffle and repeat, each mapped to the same server commands as the panel. They work with the panel hidden.
2. `MPNowPlayingInfoCenter`: title, artist, album, cover, duration, elapsed time, rate, and `playbackState`, updated only when
   rune's state changes (the system extrapolates the progress from elapsed time + rate; no timer).
3. The known trick for an app that plays nothing itself: while rune is playing, keep a **silent audio stream** running so macOS
   counts the app as playing. It is an `AVAudioPlayer` looping a 1-second in-memory WAV of digital zeros at volume 0, started
   when rune starts playing and stopped when it pauses or stops, so it costs nothing while idle. It is on by default; the menu
   item "Claim media keys with silent audio" turns it off. If the keys work without it on your macOS, switch it off.
4. If they still go to Music: quit Music, or run `launchctl unload -w /System/Library/LaunchAgents/com.apple.rcd.plist`
   (macOS routes keys through `rcd`; unloading it stops Music from grabbing them; it is not done by the app).
