rune for Linux

  ./install.sh      installs rune for you (no root needed) and starts it
  ./uninstall.sh    removes it again (your music is never touched)

Then open "rune" from the app menu. The first time, your browser opens rune's setup page:
  1. pick your music folder (optional; rune only reads it)
  2. "Sign in with Spotify" with your own Spotify Premium account (optional)
     If Spotify says you are not allowed, send the email address of your Spotify account to whoever gave you rune.
     Spotify songs play through the Spotify app: flatpak install flathub com.spotify.Client

rune checks for a new version once a day and asks before it updates. To update by hand: rune-update

Needs: mpv, ffmpeg and pactl (install.sh tells you the command if one is missing), and a graphics driver with Vulkan.
rune runs only on this PC (127.0.0.1:4545); nothing is shared with anyone.
