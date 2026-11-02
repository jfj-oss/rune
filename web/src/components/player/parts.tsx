import { ArrowRight, Check, Monitor, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Smartphone, Speaker, Volume1, Volume2, VolumeX, Globe, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { formatDuration } from '../../lib/format';
import { usePosition } from '../../hooks/usePosition';
import { usePeaks } from '../../hooks/usePeaks';
import { isLiveTrack } from '../../lib/listenTypes';
import type { ZoneInfo } from '../../lib/types';
import { isMixedQueue } from '../../player/pc';
import { currentItem, usePlayer, useSignalPath } from '../../store/player';
import { Popover } from '../Popover';
import { detectIOS } from '../../lib/volume';
import { Slider } from './Slider';
import { VolumeSlider } from './VolumeSlider';
import { Waveform } from './Waveform';
import { shownVolume, useVolumeHold } from '../../store/volumeHold';

interface SeekBarProps {
  showTimes?: boolean;
  className?: string;
  /** Peak resolution: ~400 fits the bar, ~800 the Now Playing sheet. */
  buckets?: number;
}

export function SeekBar({ showTimes = true, className = '', buckets = 400 }: SeekBarProps) {
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const pos = usePosition();
  const [drag, setDrag] = useState<number | null>(null);
  const cur = currentItem(state);
  // a new song never inherits a half-finished drag of the previous one
  const curKey = cur ? `${state.index}:${cur.track.id}` : '';
  useEffect(() => { setDrag(null); }, [curKey]);
  const live = isLiveTrack(cur?.track);
  const dur = cur?.track.durationMs ?? 0;
  const shown = drag ?? pos;
  const peaks = usePeaks(cur?.track, buckets);
  const seek = (ms: number) => void command({ type: 'seek', positionMs: ms });

  if (live) {
    return (
      <div className={`seek seek--live ${className}`}>
        <span className="livepill"><i />LIVE</span>
        <span className="seek__live">Live stream · no seeking</span>
      </div>
    );
  }

  const wave = peaks.status === 'ready' && peaks.data && dur > 0 ? peaks.data.data : null;
  return (
    <div className={`seek ${wave ? 'seek--wave' : ''} ${className}`}>
      {showTimes && <span className="seek__t">{formatDuration(shown)}</span>}
      {wave ? (
        <Waveform
          data={wave}
          positionMs={shown}
          durationMs={dur}
          onSeek={seek}
          className={peaks.generated ? 'wave--approx' : ''}
        />
      ) : (
        <Slider
          label="Seek"
          className="slider--seek"
          value={shown}
          max={dur}
          step={250}
          disabled={!dur}
          onChange={setDrag}
          onCommit={(v) => { setDrag(null); seek(v); }}
        />
      )}
      {showTimes && <span className="seek__t seek__t--r">{formatDuration(dur)}</span>}
    </div>
  );
}

export function PlayPause({ size = 40, className = '' }: { size?: number; className?: string }) {
  const status = usePlayer((s) => s.state.status);
  const hasQueue = usePlayer((s) => s.state.queue.length > 0);
  const command = usePlayer((s) => s.command);
  const playing = status === 'playing' || status === 'loading';
  return (
    <button
      className={`btn-round btn-round--primary ${className}`}
      style={{ width: size, height: size }}
      aria-label={playing ? 'Pause' : 'Play'}
      disabled={!hasQueue}
      onClick={() => void command({ type: playing ? 'pause' : 'resume' })}
    >
      {playing ? <Pause size={size * 0.45} fill="currentColor" /> : <Play size={size * 0.45} fill="currentColor" style={{ marginLeft: size * 0.05 }} />}
    </button>
  );
}

export function Transport({ big = false, extras = true }: { big?: boolean; extras?: boolean }) {
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const hasQueue = state.queue.length > 0;
  const next = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  const px = big ? 26 : 20;
  return (
    <div className={`transport${big ? ' transport--big' : ''}`}>
      {extras && (
        <button className={`btn-icon${state.shuffle ? ' is-on' : ''}`} aria-label="Shuffle" aria-pressed={state.shuffle} onClick={() => void command({ type: 'shuffle', on: !state.shuffle })}>
          <Shuffle size={px - 4} />
        </button>
      )}
      <button className="btn-icon" aria-label="Previous" disabled={!hasQueue} onClick={() => void command({ type: 'prev' })}>
        <SkipBack size={px} fill="currentColor" />
      </button>
      <PlayPause size={big ? 64 : 40} />
      <button className="btn-icon" aria-label="Next" disabled={!hasQueue} onClick={() => void command({ type: 'next' })}>
        <SkipForward size={px} fill="currentColor" />
      </button>
      {extras && (
        <button className={`btn-icon${state.repeat !== 'off' ? ' is-on' : ''}`} aria-label={`Repeat: ${state.repeat}`} onClick={() => void command({ type: 'repeat', mode: next })}>
          {state.repeat === 'one' ? <Repeat1 size={px - 4} /> : <Repeat size={px - 4} />}
        </button>
      )}
    </div>
  );
}

/** Volume to restore on unmute: the last non-zero level, shared by every VolumeControl. */
let lastAudible = 60;

export function VolumeControl({ className = '' }: { className?: string }) {
  const volume = usePlayer((s) => s.state.volume);
  const zoneKind = usePlayer((s) => s.zones.find((z) => z.id === s.zone)?.kind);
  const command = usePlayer((s) => s.command);
  const [local, setLocal] = useState<number | null>(null);
  // After a change (here or via the E/R keys), keep showing the chosen level for a few seconds:
  // Spotify devices answer with older levels meanwhile, which made the slider jump back and forth.
  const held = useVolumeHold();
  const v = local ?? shownVolume(volume, held);
  const sendTimer = useRef<{ t: ReturnType<typeof setTimeout> | null; last: number; pending: number | null }>({ t: null, last: 0, pending: null });
  useEffect(() => {
    if (held.v === null) return;
    const t = setTimeout(() => useVolumeHold.getState().clear(), Math.max(0, held.until - Date.now()));
    return () => clearTimeout(t);
  }, [held.v, held.until]);
  if (v > 0) lastAudible = v;
  const ios = typeof navigator === 'undefined' ? null : detectIOS(navigator.userAgent, navigator.maxTouchPoints);
  // iOS ignores <audio>.volume, so a page slider cannot change loudness for this device's own zone.
  if (ios && zoneKind === 'browser') {
    return <div className={`volume volume--hint ${className}`}>Use the {ios} volume buttons</div>;
  }
  const Icon = v === 0 ? VolumeX : v < 40 ? Volume1 : Volume2;
  // While dragging, send at most ~6 volume commands a second (plus the final value).
  const send = (x: number) => {
    const st = sendTimer.current;
    st.pending = x;
    const wait = 160 - (Date.now() - st.last);
    if (wait <= 0 && !st.t) { st.last = Date.now(); st.pending = null; void command({ type: 'volume', volume: x }); return; }
    if (!st.t) st.t = setTimeout(() => {
      st.t = null; st.last = Date.now();
      if (st.pending != null) { const p = st.pending; st.pending = null; void command({ type: 'volume', volume: p }); }
    }, Math.max(0, wait));
  };
  const set = (x: number) => { setLocal(x); held.hold(x); send(x); };
  return (
    <div className={`volume ${className}`}>
      <button className="btn-icon" aria-label={v === 0 ? 'Unmute' : 'Mute'} onClick={() => { const x = v === 0 ? lastAudible : 0; setLocal(null); held.hold(x); void command({ type: 'volume', volume: x }); }}>
        <Icon size={18} />
      </button>
      <VolumeSlider value={v} onChange={set} onCommit={() => setLocal(null)} />
    </div>
  );
}

export function SignalDot({ placement = 'top-end', withLabel = false }: { placement?: 'top-end' | 'bottom-end' | 'top-start'; withLabel?: boolean }) {
  const { steps, tone } = useSignalPath();
  const label = tone === 'ok' ? 'Bit-perfect' : tone === 'warn' ? 'Signal path' : steps.length ? 'Spotify' : 'Idle';
  return (
    <Popover
      placement={placement}
      panelClassName="signal"
      trigger={({ toggle, open }) => (
        <button className={`signaldot${withLabel ? ' signaldot--label' : ''}`} onClick={toggle} aria-expanded={open} aria-label={`Signal path: ${label}`} title="Signal path">
          <i className={`signaldot__dot signaldot__dot--${tone}`} />
          {withLabel && <span>{label}</span>}
        </button>
      )}
    >
      {() => (
        <>
          <div className="popover__title">Signal path</div>
          {steps.length === 0 ? (
            <p className="popover__muted">Nothing is playing.</p>
          ) : (
            <ol className="signal__steps">
              {steps.map((s, i) => (
                <li key={i} className={/bit-perfect/i.test(s) ? 'signal__step signal__step--ok' : 'signal__step'}>
                  {i > 0 && <ArrowRight size={12} className="signal__arrow" style={{ transform: 'rotate(90deg)' }} />}
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Popover>
  );
}

const kindIcon = { pc: Speaker, browser: Globe, spotify: Smartphone } as const;

export function ZonePicker({ placement = 'top-end', compact = false }: { placement?: 'top-end' | 'bottom-end'; compact?: boolean }) {
  const zones = usePlayer((s) => s.zones);
  const zone = usePlayer((s) => s.zone);
  const cur = zones.find((z) => z.id === zone);
  const Icon = kindIcon[cur?.kind ?? 'pc'] ?? Monitor;
  return (
    <Popover
      placement={placement}
      panelClassName="zones"
      trigger={({ toggle, open }) => (
        <button className="zonebtn" onClick={toggle} aria-expanded={open} aria-label="Choose playback zone">
          <Icon size={16} />
          {!compact && <span className="zonebtn__name">{cur?.name ?? 'Zone'}</span>}
        </button>
      )}
    >
      {(close) => <ZoneList close={close} />}
    </Popover>
  );
}

/** What a zone can play, as a one-line hint under its name. */
export function zoneHint(z: ZoneInfo, mixed: boolean): string | null {
  if (z.kind !== 'pc') return null;
  if (z.spotifyDeviceId) return mixed ? `Local + Spotify (“${z.spotifyDeviceName ?? 'Spotify app'}”) · keep a rune tab open` : `Local + Spotify (via “${z.spotifyDeviceName ?? 'the Spotify app'}”)`;
  return 'Local files · open the Spotify app on the PC for Spotify';
}

function ZoneList({ close }: { close(): void }) {
  const zones = usePlayer((s) => s.zones);
  const zone = usePlayer((s) => s.zone);
  const setZone = usePlayer((s) => s.setZone);
  const refresh = usePlayer((s) => s.refreshZones);
  const mixed = usePlayer((s) => isMixedQueue(s.state.queue));
  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  // the Spotify app on the PC (and phones) come and go: look again whenever the list is opened
  useEffect(() => { void refresh(); void api.hiddenZones().then(setHidden, () => undefined); }, [refresh]);
  const toggleHidden = async (name: string, hide: boolean) => {
    try { setHidden(await api.setZoneHidden(name, hide)); await refresh(); } catch { /* server offline */ }
  };
  return (
    <>
      <div className="popover__title">Play on</div>
      {zones.map((z) => {
        const I = kindIcon[z.kind] ?? Monitor;
        const hint = zoneHint(z, mixed && z.id === zone);
        return (
          <div key={z.id} className="zonerow">
            <button className={`menu__item menu__item--zone${z.id === zone ? ' is-current' : ''}`} onClick={() => { void setZone(z.id); close(); }}>
              <I size={16} />
              <span className="zoneitem"><span>{z.name}</span>{hint && <small>{hint}</small>}</span>
              {z.id === zone && <Check size={16} className="menu__check" />}
            </button>
            {z.kind === 'spotify' && z.id !== zone && (
              <button className="btn-icon zonerow__hide" title={`Hide “${z.name}” from this list`} aria-label={`Hide ${z.name}`} onClick={() => void toggleHidden(z.name, true)}><EyeOff size={14} /></button>
            )}
          </div>
        );
      })}
      {hidden.length > 0 && (
        <div className="zones__hidden">
          <button className="zones__hiddenbtn" onClick={() => setShowHidden((v) => !v)}>{showHidden ? 'Hide' : 'Show'} hidden devices ({hidden.length})</button>
          {showHidden && hidden.map((n) => (
            <div key={n} className="zonerow zonerow--hidden">
              <span className="zoneitem"><span>{n}</span></span>
              <button className="btn btn--sm btn--ghost" onClick={() => void toggleHidden(n, false)}><Eye size={14} /> Show</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
