import { ArrowRight, Check, Monitor, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Smartphone, Speaker, Volume1, Volume2, VolumeX, Globe } from 'lucide-react';
import { useState } from 'react';
import { formatDuration } from '../../lib/format';
import { usePosition } from '../../hooks/usePosition';
import { currentItem, usePlayer, useSignalPath } from '../../store/player';
import { Popover } from '../Popover';
import { detectIOS } from '../../lib/volume';
import { Slider } from './Slider';
import { VolumeSlider } from './VolumeSlider';

export function SeekBar({ showTimes = true, className = '' }: { showTimes?: boolean; className?: string }) {
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const pos = usePosition();
  const [drag, setDrag] = useState<number | null>(null);
  const dur = currentItem(state)?.track.durationMs ?? 0;
  const shown = drag ?? pos;
  return (
    <div className={`seek ${className}`}>
      {showTimes && <span className="seek__t">{formatDuration(shown)}</span>}
      <Slider
        label="Seek"
        className="slider--seek"
        value={shown}
        max={dur}
        step={250}
        disabled={!dur}
        onChange={setDrag}
        onCommit={(v) => { setDrag(null); void command({ type: 'seek', positionMs: v }); }}
      />
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
  const v = local ?? volume;
  if (v > 0) lastAudible = v;
  const ios = typeof navigator === 'undefined' ? null : detectIOS(navigator.userAgent, navigator.maxTouchPoints);
  // iOS ignores <audio>.volume, so a page slider cannot change loudness for this device's own zone.
  if (ios && zoneKind === 'browser') {
    return <div className={`volume volume--hint ${className}`}>Use the {ios} volume buttons</div>;
  }
  const Icon = v === 0 ? VolumeX : v < 40 ? Volume1 : Volume2;
  const set = (x: number) => { setLocal(x); void command({ type: 'volume', volume: x }); };
  return (
    <div className={`volume ${className}`}>
      <button className="btn-icon" aria-label={v === 0 ? 'Unmute' : 'Mute'} onClick={() => { setLocal(null); void command({ type: 'volume', volume: v === 0 ? lastAudible : 0 }); }}>
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
  const setZone = usePlayer((s) => s.setZone);
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
      {(close) => (
        <>
          <div className="popover__title">Play on</div>
          {zones.map((z) => {
            const I = kindIcon[z.kind] ?? Monitor;
            return (
              <button key={z.id} className={`menu__item${z.id === zone ? ' is-current' : ''}`} onClick={() => { void setZone(z.id); close(); }}>
                <I size={16} />
                <span>{z.name}</span>
                {z.id === zone && <Check size={16} className="menu__check" />}
              </button>
            );
          })}
        </>
      )}
    </Popover>
  );
}
