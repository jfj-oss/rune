import { Check, ExternalLink, Globe, Monitor, Smartphone, Speaker } from 'lucide-react';
import { useEffect } from 'react';
import { plural } from '../lib/format';
import { detectIOS } from '../lib/volume';
import type { PlaySource, ZoneInfo } from '../lib/types';
import { playableZones, spotifyDeepLink, spotifyDeviceHint } from '../player/routing';
import { usePlayer } from '../store/player';
import { capsFrom, restingNotice, useSpotify } from '../store/spotify';
import { usePhoneStream } from '../store/phoneStream';
import { isHandheld } from '../lib/device';
import { Dialog } from './Dialog';

const icons = { pc: Speaker, browser: Globe, spotify: Smartphone } as const;
const hint = {
  pc: 'Local files, bit-perfect',
  browser: 'In this browser',
  spotify: 'Spotify Connect',
} as const;
const hintFor = (z: ZoneInfo, need: PlaySource) => {
  if (z.kind === 'spotify') return spotifyDeviceHint(z);
  if (z.kind !== 'pc') return hint[z.kind];
  if (z.spotifyDeviceId) return `Local files, and Spotify through the Spotify app “${z.spotifyDeviceName ?? 'on the PC'}”`;
  return need === 'spotify' ? 'Local files, and Spotify (rune starts the app)' : hint.pc;
};

/** "Play on…" — shown when the selected zone can't play what was just pressed (e.g. Spotify on the PC speakers). */
export function PlayOnSheet() {
  const req = useSpotify((s) => s.chooser);
  const close = useSpotify((s) => s.closeChooser);
  const zones = usePlayer((s) => s.zones);
  const zone = usePlayer((s) => s.zone);
  const connected = useSpotify((s) => s.connected);
  const supported = useSpotify((s) => s.supported);
  const phase = useSpotify((s) => s.sdk.phase);
  const playOn = usePlayer((s) => s.playOn);
  const refresh = usePlayer((s) => s.refreshZones);
  const restingUntil = useSpotify((s) => s.restingUntil);
  const refreshStatus = useSpotify((s) => s.refreshStatus);

  // Connect devices appear and disappear (the phone's Spotify app): read the list at once on opening, then keep
  // looking while the sheet is open (the server's short cache keeps the interval from spending a request each time).
  // The status says whether Spotify is resting (daily limit): then the sheet says so before a tap can fail.
  useEffect(() => {
    if (!req) return;
    void refresh({ fresh: true });
    void refreshStatus();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [req, refresh, refreshStatus]);

  if (!req) return null;
  const resting = req.need === 'spotify' ? restingNotice(restingUntil) : null;
  const ios = typeof navigator === 'undefined' ? null : detectIOS(navigator.userAgent, navigator.maxTouchPoints);
  const caps = capsFrom({ connected, supported, sdk: { phase, deviceId: null } });
  const options = playableZones(zones, req.need, caps);
  const cur = zones.find((z) => z.id === zone);
  const link = req.need === 'spotify' ? spotifyDeepLink(req.items, req.context) : null;
  const first = req.items[req.startIndex]?.album;
  const what = req.items.length > 1 && first ? `“${first.title}” · ${plural(req.items.length, 'track')}` : req.items[0]?.track.title ?? '';

  return (
    <Dialog title="Play on…" onClose={close} className="dialog--sheet">
      <p className="dialog__lead">
        {req.need === 'spotify' ? 'Spotify tracks can’t play on' : 'Local files can’t play on'} <b>{cur?.name ?? 'this zone'}</b>. Pick where to hear <b>{what}</b>.
      </p>
      {resting && <p className="sheet__note sheet__note--resting" role="status">{resting}</p>}
      <div className="sheet__list" role="menu">
        {options.map(({ zone: z, label }) => {
          const I = icons[z.kind] ?? Monitor;
          return (
            <button
              key={z.id}
              className="sheet__opt"
              role="menuitem"
              disabled={z.isRestricted === true}
              title={z.isRestricted ? 'This device is in a private session; Spotify does not let rune control it' : undefined}
              onClick={() => {
                close();
                // Soloist picked from a phone: the phone hears it (the stream starts inside this tap).
                if (z.soloist && isHandheld() && !usePhoneStream.getState().listening) void usePhoneStream.getState().start();
                void playOn(z.id, req);
              }}
            >
              <I size={20} />
              <span className="sheet__txt"><b>{label}</b><small>{z.kind === 'browser' && req.need === 'spotify' ? 'Spotify Web Player in this browser' : z.soloist && isHandheld() ? 'Spotify on the PC, no app · you hear it on this phone' : hintFor(z, req.need)}</small></span>
              {z.id === zone && <Check size={16} className="menu__check" />}
            </button>
          );
        })}
        {link && (
          <a className="sheet__opt" role="menuitem" href={link} onClick={close}>
            <ExternalLink size={20} />
            <span className="sheet__txt"><b>Open in Spotify app</b><small>It then shows up here as a Spotify Connect device</small></span>
          </a>
        )}
      </div>
      {req.need === 'spotify' && !caps.sdk && (
        <p className="sheet__note">
          {connected ? (
            ios ? (
              <>Spotify can’t play inside {ios === 'iPhone' ? 'an iPhone' : 'an iPad'}'s browser. Open the Spotify app on the phone, then pick it above (its Connect device appears here once it is awake).</>
            ) : supported ? (
              'Spotify Premium is needed to play inside the browser.'
            ) : (
              'This browser can’t play Spotify itself. Open the Spotify app on this device, then pick it above.'
            )
          ) : (
            'Spotify is not connected.'
          )}
        </p>
      )}
      {req.need === 'spotify' && cur?.kind === 'pc' && !cur.spotifyDeviceId && (
        <p className="sheet__note"><b>Want Spotify on the Linux speakers?</b> Pick the Linux PC speakers — rune starts Spotify on the PC for this and moves the music there.</p>
      )}
      {options.length === 0 && !link && <p className="sheet__note">Nothing is available right now. Open Spotify on a phone or computer so it appears as a device.</p>}
      <p className="sheet__note sheet__note--dim">Your choice is remembered for this session.</p>
    </Dialog>
  );
}
