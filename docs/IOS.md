# rune on iPhone

rune runs as a server on your computer and serves its web app from it. The iPhone app is a thin native
shell (Tauri 2, a WKWebView) around **your** rune server: it contains no music, no account and **no server
address baked in**. On first launch it asks for the address of your server, checks `<address>/api/health`,
remembers it on the phone, and then loads that server's web app.

The `.ipa` is **unsigned**. SideStore signs it with a free Apple ID and re-signs it every 7 days. No Apple
Developer account, certificate, team or provisioning profile is involved.

## 1. Build the .ipa (GitHub Actions)

1. Open the repository on GitHub, choose the **Actions** tab, pick **ios** on the left and press **Run
   workflow**. There is nothing to fill in, and no secrets are used.
2. Wait. The first run takes roughly 20–40 minutes: CocoaPods dependencies install (`pod install`), and
   Rust compiles every crate for the iPhone. Later runs reuse the caches.
3. When the run is green, open it and download the **rune-ipa** artifact. It is a `.zip` containing
   `rune.ipa`. Unzip it wherever you like and get it to the phone (AirDrop, iCloud Drive, Files…).

The app is deliberately unsigned so SideStore can sign it. The workflow never signs, and it fails the run
if it finds a `_CodeSignature` directory or `embedded.mobileprovision` in the app. It also fails if the
merged `Info.plist` has lost `UIBackgroundModes = audio` or `NSAllowsLocalNetworking`.

The Xcode project (`ios/src-tauri/gen/apple`) is generated during the run and is not committed. The Tauri
CLI version is pinned by `ios/package-lock.json`, so the generation is reproducible.

### Optional: building on a Mac

A Mac with full Xcode is not needed for the normal route. If you have one:

```sh
cd ios
npm ci
cd src-tauri
../node_modules/.bin/tauri ios init --skip-targets-install
../node_modules/.bin/tauri icon icons/ios-1024.png --ios-color "#14131c"
../node_modules/.bin/tauri ios build --no-sign --target aarch64
```

The iOS icon rules are the same as in the workflow: `tauri icon` writes RGBA PNGs, and iOS rejects icons
with an alpha channel. The workflow strips alpha with a JPEG round trip; do the same locally, or use the
artifact from GitHub Actions. `tauri ios init` records the Tauri CLI command inside the generated Xcode
project; if Xcode cannot find it (for example because `node` is not on its `PATH`), point that build phase
at an absolute path the way `.github/workflows/ios.yml` does.

## 2. Install SideStore

SideStore is installed once, with a computer, and then refreshes itself and its apps on the phone. Its
installation method changes with iOS releases, so follow the current guide at **https://sidestore.io**
rather than an old blog post. At the time of writing the shape of it is:

1. On the computer, generate a **pairing file** for the iPhone (the SideStore guide links the current tool,
   usually *jitterbugpair* on Windows/Linux). Plug the iPhone in and trust the computer.
2. Install **SideStore** onto the iPhone using the current official method (AltServer, or the installer the
   SideStore guide provides). Sign in with the **free Apple ID** when asked. That Apple ID is handled only by
   SideStore on the phone; this repo never sees it.
3. On the iPhone: Settings → General → VPN & Device Management → trust the developer certificate.
4. Install the **SideStore VPN profile** the guide supplies and import the pairing file. The VPN must be on
   when SideStore refreshes apps. It is a local VPN; it does not send traffic through a server.

If the guide and this document disagree, the guide wins.

## 3. Install rune

1. Open **SideStore → My Apps** (or the **+** button), choose `rune.ipa` and tap **Install**. SideStore signs
   it with the free Apple ID.
2. The first launch may ask to trust the developer again (Settings → General → VPN & Device Management).
3. Open rune. The first screen asks for your server's address (see below).

## 4. Connect to your server

rune listens on `0.0.0.0` by default, so the phone can reach it on your network. The port is `port` in
`server/config.json` (default **4545**).

On the connect screen, enter the address the phone should use:

- **Tailscale (recommended).** Install Tailscale on the PC and the iPhone. If you serve rune over HTTPS —
  for example Tailscale Serve with `tailscale serve --bg --https=8445 http://127.0.0.1:4545` — enter
  `https://<pc>.<your-tailnet>.ts.net:8445`. The tailnet encrypts the traffic and the certificate is valid,
  so the connection works away from home. If you use Tailscale Serve, set `publicUrl` in
  `server/config.json` to the same `https://…` address so Spotify's login redirect uses it too.
- **Home Wi-Fi only.** Enter the PC's LAN address over http, for example
  `http://192.168.1.20:4545`. iOS only allows plain http for local addresses (see the ATS note below).

The app checks `<address>/api/health` before accepting the address. It accepts any rune server that
answers with rune's health JSON, and shows the version it found. The address is saved in the app's own
sandbox (`server.txt` in its config directory) and never written to this repository.

### Changing the address

- **Long-press a page title** (the home greeting, an album or artist name, or any page heading) for about a
  second. The app opens the server screen with the saved address filled in.
- **On launch**, while the saved server is being opened, tap **Change server**.
- **On the connect screen**, the gear in the top-right corner explains the address options, shows the saved
  server and has **Forget saved server**. **Back to rune** returns to the saved server without changing it.

## 5. What works on the phone

- **Local files play in the app.** The browser/phone zone uses the web app's normal local playback. The app
  declares the iOS background-audio mode, so playback keeps going when the screen locks or the app is in
  the background. The lock screen and hardware controls come from the web app's Media Session integration
  (metadata, play/pause, previous/next, seek).
- **The rest of the web app** is the same as in a browser: library, albums, reviews, radio, playlists,
  Discover, stats, settings.
- **Spotify does not play inside the webview.** The Spotify Web Playback SDK is not available in iOS
  webviews. Spotify tracks play through Spotify Connect (the Spotify app on the phone or another device) or
  on the PC, exactly as they do elsewhere in rune. The shell gives the web app one capability flag,
  `window.__runeNative = { platform: 'ios' }`, set by the native side before the page's own scripts run, so
  the web app can choose the right Spotify path on iOS without user-agent sniffing.
- **The volume buttons** control the iPhone's system volume. iOS does not let a page set `<audio>.volume`,
  so an in-page volume slider cannot change the loudness of this device's own zone (the web app already
  accounts for this).

## 6. Limits of a free Apple ID

- **7-day signatures.** SideStore re-signs rune with the same Apple ID. Open SideStore with its VPN on,
  go to My Apps, and tap **Refresh All** every few days. If 7 days pass without a refresh, rune will not
  launch until SideStore refreshes it; nothing is lost. SideStore itself expires too, and must be kept
  refreshed first.
- **3 sideloaded apps** at a time and **10 App IDs per 7 days**, including SideStore. Remove another app or
  wait if you hit the limit.
- **No push notifications.** rune is suspended when it is in the background (audio playback is the
  exception); it catches up when opened again.
- **No background sync or scanning.** The phone is a client; the PC's rune server keeps running.
- **No in-app updates.** Run the **ios** workflow again and install the new `rune.ipa` in SideStore. The
  bundle identifier (`app.rune.ios`) is stable, so re-signing or reinstalling keeps the saved server
  address.

## 7. Troubleshooting

- **"Could not connect" / timeout.** Is rune running on the PC, is the port right, and is the phone on the
  same Tailscale network or Wi-Fi? Open `http://<pc>:<port>/` in Safari on the phone to rule out the app.
  A firewall on the PC must allow the port on the local interface.
- **"… is not a rune server" / no version.** The address answered, but not with rune's health JSON. Check
  that you did not enter a path (the app uses the address's origin) and that the port belongs to rune.
- **"did not accept the request" with an https address.** The server is probably plain http. Use
  `https://` only when your HTTPS proxy (for example Tailscale Serve) terminates TLS; otherwise use the
  LAN `http://` address.
- **Plain http to a hostname is blocked.** iOS's App Transport Security allowance covers local addresses
  only (`NSAllowsLocalNetworking`). Use the LAN IP, or use https over Tailscale. The app never enables
  arbitrary insecure loads.
- **You cannot get back to the server screen.** Relaunch the app and tap **Change server** while it opens,
  or long-press a page title. If the saved server no longer answers, the connect screen appears with an
  error after the check times out.
- **The build fails on GitHub.** Check the failed step. "Full Xcode and build tools" means the runner image
  changed; re-run once. "Generate the Xcode project" is usually `pod install` or a network hiccup; re-run.
  "Build the unsigned .ipa" is a real compile error; the Rust/Xcode output is in that step's log. The
  artifact is only uploaded on a green run.
- **SideStore says "Unable to install".** Usually the 3-app limit, an untrusted certificate, or the
  VPN/pairing file not set up. Re-read the current sidestore.io guide.
- **Audio stops in the background or on the lock screen.** Confirm the track is playing in the phone zone
  (not on the PC or a Spotify Connect device) and that the iPhone is not in Low Power Mode, which can pause
  background media. The build check guarantees the audio background mode is in the app's Info.plist.

## 8. For contributors

The shell is `ios/src-tauri` (Rust) plus `ios/ui` (the bundled connect screen). It creates one webview:

- The bundled `tauri://localhost/index.html` is the connect screen. It calls the Rust commands
  `get_server`, `connect_server` and `clear_server` through the Tauri global API.
- The remote server is loaded in the same webview; no Tauri IPC is granted to remote pages.
- A document-start script injects `window.__runeNative` and the long-press gesture. The gesture navigates
  to `https://rune-native.invalid/settings`; the Rust navigation handler cancels that navigation and loads
  the bundled connect screen instead. That is the whole native bridge — the web app needs nothing else.

`ios/src-tauri/Info.plist` is merged into the generated `Info.plist` by Tauri: background audio,
`NSAllowsLocalNetworking` (http only for local addresses; https is preferred) and the local-network usage
description. Minimum iOS is 15.0.

`cargo check` in `ios/src-tauri` builds the shell for the host (Linux/macOS) target. The iOS build itself
runs in `.github/workflows/ios.yml`.
