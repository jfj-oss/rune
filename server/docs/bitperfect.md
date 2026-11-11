# Bit-perfect playback on the PC zone

Status: proposal. Nothing on the system was changed by this investigation (the only
runtime changes during testing were temporary PipeWire metadata and a null sink, both
restored/removed).

Goal: every sample rate in the library plays through the DAC without sample-rate
conversion. The library has ~45 albums at 24/96 and 24/192, so this mostly means
stopping PipeWire from forcing the graph clock to 48 kHz.

## TL;DR

- The PC's current PipeWire config allows only 48 kHz (`clock.allowed-rates = [ 48000 ]`),
  so **every** rate except 48 kHz is resampled, including 44.1 kHz CDs.
- Add one drop-in file listing the rates the active DAC supports, then restart PipeWire.
  This is the safe, system-wide fix (other apps keep working).
- Keep rune/mpv volume at 100. mpv's volume is software gain; anything below 100 is not
  bit-perfect. Use the DAC/amp's own volume.
- Optional, maximum isolation: bypass PipeWire with `mpv --ao=alsa
  --audio-device=alsa/hw:CARD=E30,DEV=0 --audio-exclusive=yes`. This blocks all other
  audio while playing.

## Hardware on this PC (example)

| device | ALSA | rates | notes |
|---|---|---|---|
| Topping E30 USB DAC | card 3, device 0 — `hw:CARD=E30,DEV=0` | 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000 | S32_LE, 32-bit container / 24-bit altset; also DSD_U32_BE |
| Realtek ALC897 onboard | card 2, device 0 — `hw:CARD=Generic_1,DEV=0` | 32000, 44100, 48000, 88200, 96000, 192000 (no 176400) | default sink today |

Source: `/proc/asound/card3/stream0`, `/proc/asound/card2/codec#0`.

- `wpctl status` / `pactl info`: the **default sink is currently the ALC897**
  (`alsa_output.pci-0000_11_00.6.analog-stereo`), not the E30. PipeWire exposes the E30 as
  `E30 Headphones` (`alsa_output.usb-Topping_E30-00.HiFi__Headphones__sink`).
- `server/src/config.ts` defaults `audioDevice` to `pipewire`, i.e. mpv plays to whichever
  sink is the PipeWire default. With no `server/config.json`, rune therefore uses the
  ALC897 today.
- For the largest rate set, make the E30 the default sink (or point rune at it — see
  "Pointing rune at the E30"). Both DACs do 24/96 and 24/192; the E30 additionally does
  176.4 kHz.

## Current behaviour (measured)

`server/scripts/bitperfect-check.ts` plays a 24-bit tone at each rate through mpv
(`--ao=pipewire`, volume 100) into a temporary null sink and compares:
- mpv `audio-params` (decoder input),
- mpv `audio-out-params` (the stream PipeWire accepted),
- PipeWire's live graph clock from `pw-top`.

Current config (`~/.config/pipewire` and `~/.config/wireplumber` do not exist; stock
defaults, PipeWire 1.6.10):

```
rate    input (mpv)        output (mpv)       graph     mpv  graph  verdict
44100   s32 44100 Hz 2ch   s32 44100 Hz 2ch   48000 Hz  ok   BAD    NOT bit-perfect (PipeWire graph 48000 Hz)
48000   s32 48000 Hz 2ch   s32 48000 Hz 2ch   48000 Hz  ok   ok     bit-perfect
88200   s32 88200 Hz 2ch   s32 88200 Hz 2ch   48000 Hz  ok   BAD    NOT bit-perfect (PipeWire graph 48000 Hz)
96000   s32 96000 Hz 2ch   s32 96000 Hz 2ch   48000 Hz  ok   BAD    NOT bit-perfect (PipeWire graph 48000 Hz)
176400  s32 176400 Hz 2ch  s32 176400 Hz 2ch  48000 Hz  ok   BAD    NOT bit-perfect (PipeWire graph 48000 Hz)
192000  s32 192000 Hz 2ch  s32 192000 Hz 2ch  48000 Hz  ok   BAD    NOT bit-perfect (PipeWire graph 48000 Hz)

Summary: 1/6 rates bit-perfect through mpv + PipeWire.
```

Key facts behind the diagnosis:

1. mpv negotiates the stream at the file's native rate, so `audio-params` ==
   `audio-out-params` for every rate. **mpv is not resampling.** PipeWire does it
   downstream, which mpv cannot see.
2. `pw-metadata -n settings` shows `clock.rate = 48000` and
   `clock.allowed-rates = [ 48000 ]`. Because allowed-rates has one entry, the graph
   clock cannot follow the stream.
3. `clock.rate` in the metadata does **not** follow allowed-rates switching on PipeWire
   1.6.10 (it stayed 48000 even with a 96 kHz stream and 96 kHz allowed). The live graph
   rate must be read from `pw-top` (the driver row's RATE column). That is what the
   checker and rune's signal path use.
4. With `clock.allowed-rates` temporarily extended at runtime to
   `[ 44100 48000 88200 96000 176400 192000 ]`, the same checker reported **3/3
   bit-perfect** for 44.1/48/96 kHz (each rate's sink running at its native rate), then
   the metadata was restored to `[ 48000 ]`. So the config change below is the fix.

PipeWire's stock defaults:

```
/usr/share/pipewire/pipewire.conf
    #default.clock.rate          = 48000
    #default.clock.allowed-rates = [ 48000 ]
    #default.clock.quantum       = 1024
```

## Proposed config (recommended): PipeWire rate switching

Create `~/.config/pipewire/pipewire.conf.d/10-rune-rates.conf`:

```conf
# Liner: let PipeWire switch the graph clock to the track's native rate.
# Keep the list limited to rates the active output device supports.
context.properties = {
    default.clock.rate          = 48000
    default.clock.allowed-rates = [ 44100 48000 88200 96000 176400 192000 ]
}
```

If the **ALC897** stays the active sink, omit `176400` (that codec does not support it):

```conf
    default.clock.allowed-rates = [ 44100 48000 88200 96000 192000 ]
```

If the **E30** is the active sink (recommended), the full list above is correct.

Apply:

```sh
mkdir -p ~/.config/pipewire/pipewire.conf.d
cat > ~/.config/pipewire/pipewire.conf.d/10-rune-rates.conf <<'EOF'
# Liner: let PipeWire switch the graph clock to the track's native rate.
context.properties = {
    default.clock.rate          = 48000
    default.clock.allowed-rates = [ 44100 48000 88200 96000 176400 192000 ]
}
EOF
systemctl --user restart pipewire.service pipewire-pulse.service wireplumber.service
```

This briefly interrupts all audio (including any running playback). For a quick test
without a restart you can set the same value at runtime only:

```sh
pw-metadata -n settings 0 clock.allowed-rates '[ 44100 48000 88200 96000 176400 192000 ]'
# revert (runtime only):
pw-metadata -n settings 0 clock.allowed-rates '[ 48000 ]'
```

The drop-in persists; the runtime form does not.

### Pointing rune at the E30

To make the E30 the system default sink:

```sh
wpctl status                       # find the E30 node id under Sinks
wpctl set-default <id>             # e.g. 54 today; ids change across restarts
# or:
pactl set-default-sink alsa_output.usb-Topping_E30-00.HiFi__Headphones__sink
```

Or point only rune at it (does not change the system default):

```sh
export RUNE_AUDIO_DEVICE=pipewire/alsa_output.usb-Topping_E30-00.HiFi__Headphones__sink
```

(or `"audioDevice": "pipewire/alsa_output.usb-Topping_E30-00.HiFi__Headphones__sink"` in
`server/config.json`).

The graph clock is global, so the default sink only decides which DAC receives it. Both
DACs support 44.1/48/88.2/96/192; the E30 also supports 176.4.

### Verify after applying

```sh
# 1. Config was loaded (metadata mirrors the config's allowed-rates)
pw-metadata -n settings | grep -E "clock\.(rate|allowed-rates)"

# 2. Play a 24/96 track, then read the live graph clock (driver row):
pw-top -b -n 3 | grep -E '^R'
#    the driver row's RATE column should be 96000

# 3. The DAC is actually clocked at 96 kHz (E30; card number may change):
cat /proc/asound/E30/pcm0p/sub0/hw_params
#    rate: 96000 (96000/1)   format: S32_LE

# 4. PipeWire pipeline check (null sink, silent):
pnpm -C server exec tsx scripts/bitperfect-check.ts
#    expect 6/6 bit-perfect with the E30 list (5/6 if 176400 is omitted)

# 5. In rune, the PC zone signal path should read
#    "FLAC 24/96 > mpv > <device> 96 kHz > PipeWire graph 96 kHz > bit-perfect"
```

Note: step 4 uses a null sink, so it validates PipeWire, not the DAC's hardware clock.
Step 3 (or `pw-top`) is the hardware proof.

## Optional: ALSA exclusive (bypass PipeWire entirely)

mpv can open the DAC's raw `hw` PCM and skip PipeWire, its graph, and its volume layer:

```sh
mpv --ao=alsa --audio-device=alsa/hw:CARD=E30,DEV=0 --audio-exclusive=yes \
    --volume=100 --volume-max=100 --replaygain=no --no-video --no-terminal track.flac
```

Trade-offs:

- **Blocks all other audio while playing.** The raw hw device is exclusive; browser
  audio, Spotify, notifications etc. cannot use the DAC. PipeWire may also fail to open
  the device while mpv holds it, and vice versa: stop other playback before starting.
- No OS mixer volume. Use the DAC/amp's volume; keep mpv volume at 100.
- Device names by card number (`hw:3,0`) are unstable across reboots. Use
  `hw:CARD=E30,DEV=0`.
- No hot-plug handling: if the DAC is unplugged, playback fails instead of falling back.
- It is genuinely bit-perfect only with volume 100 and no conversion; the E30 accepts
  16/24-bit at all supported rates, and mpv/ALSA clamps to the file's rate.

Rune does not currently pass `--audio-exclusive` (that would be a further change, not part
of this reporting-only work). Setting `RUNE_AUDIO_DEVICE=alsa/hw:CARD=E30,DEV=0` makes the
zone use the ALSA `hw` PCM (which normally prevents other openers) but not mpv's explicit
exclusive flag. Prefer the PipeWire option unless isolation matters more than concurrent
audio.

## Volume rules

- **mpv `--volume` is software gain.** The PC zone's volume slider sets this property, so
  any value below 100% scales the samples and ceases to be bit-perfect. Keep rune's
  volume at 100 and control loudness on the DAC/amp.
- `--volume-max=100` prevents accidental boost above unity. (The zone currently sets
  `--volume=100` at startup.)
- ReplayGain is disabled by the zone (`--replaygain=no`); keep it off.
- PipeWire's sink volume is normally mapped by WirePlumber to the ALSA hardware mixer for
  these devices (ALC897 `Master`/`Headphone`, E30 `E30`), so attenuation happens in the
  device rather than by scaling the samples. If a device falls back to a software mixer,
  set the sink volume to 100% for bit-perfect playback.

## Revert

```sh
rm ~/.config/pipewire/pipewire.conf.d/10-rune-rates.conf
systemctl --user restart pipewire.service pipewire-pulse.service wireplumber.service
```

Then confirm `pw-metadata -n settings | grep clock.allowed-rates` shows `[ 48000 ]` again.
If the default sink was changed, reset it with `wpctl set-default <old id>` or
`pactl set-default-sink <old name>`.

## Risks and caveats

- Rate switching re-clocks the graph at track start. Some systems emit a small click or
  glitch; some applications may stutter for a moment.
- If several sinks/devices have active streams at different rates, the graph can only run
  at one rate and the others resample. A Bluetooth headset, for example, may pin the
  graph to its own rate. Pause other audio for pure bit-perfect playback.
- Apps that keep a 48 kHz stream open can keep the graph at 48 kHz even during 96 kHz
  playback. Check `pw-top`; close/pause other audio if needed.
- Keep `clock.force-rate` at 0 (it overrides switching). Check
  `pw-metadata -n settings | grep force-rate`.
- Only list rates the active device supports. A rate the DAC rejects can fail playback or
  silently fall back to resampling; e.g. do not list 176400 while the ALC897 is active.
- 352.8/384 kHz are supported by the E30 but not proposed here (rare material, more
  switching churn). Add them later if the library grows.
- This does not change rune's queueing/gapless behaviour. `--gapless-audio=weak` still
  applies; tracks at different rates may cause a re-clock between them.
- DSD/DoP support (the E30 advertises `DSD_U32_BE`) is out of scope.
- PipeWire's `clock.rate` metadata is not the live graph rate on 1.6.10; always use
  `pw-top` (or the checker) when verifying.
