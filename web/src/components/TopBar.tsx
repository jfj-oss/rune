import { ChevronLeft, ChevronRight, Check, Radio, RefreshCw, Search, Settings, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { listenApi } from '../listenApi';
import type { NormalizeMode } from '../lib/listenTypes';
import { useSearchNav } from '../store/searchNav';
import { useRadio } from '../store/radio';
import { AMBIENTS, useUi, type Ambient } from '../store/ui';
import { MenuItem, Popover } from './Popover';

const AMBIENT_LABEL: Record<Ambient, string> = { cycle: 'Cycle', blue: 'Blue', purple: 'Purple', slate: 'Slate', green: 'Green', off: 'Off' };

export function TopBar({ canBack, canForward }: { canBack: boolean; canForward: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const urlQ = loc.pathname === '/search' ? (params.get('q') ?? '') : '';
  const [value, setValue] = useState(urlQ);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useUi((s) => s.toast);
  const ambient = useUi((s) => s.ambient);
  const setAmbient = useUi((s) => s.setAmbient);
  const autoRadio = useRadio((s) => s.autoRadio);
  const setAutoRadio = useRadio((s) => s.setAutoRadio);

  useEffect(() => { setValue(urlQ); }, [urlQ]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/input|textarea/i.test(t.tagName)) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const go = (q: string, replace: boolean) => nav(q ? `/search?q=${encodeURIComponent(q)}` : '/search', { replace });
  const onChange = (q: string) => {
    setValue(q);
    clearTimeout(timer.current);
    if (!q.trim()) return;
    timer.current = setTimeout(() => go(q.trim(), loc.pathname === '/search'), 200);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const s = useSearchNav.getState();
    if (e.key === 'ArrowDown') { e.preventDefault(); s.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); s.move(-1); }
    else if (e.key === 'Enter') {
      clearTimeout(timer.current);
      const it = s.items[s.active];
      if (it && urlQ === value.trim()) it.activate();
      else if (value.trim()) go(value.trim(), loc.pathname === '/search');
    } else if (e.key === 'Escape') { setValue(''); input.current?.blur(); }
  };

  return (
    <header className="topbar">
      <div className="topbar__nav">
        <button className="btn-icon" aria-label="Back" disabled={!canBack} onClick={() => nav(-1)}><ChevronLeft size={20} /></button>
        <button className="btn-icon" aria-label="Forward" disabled={!canForward} onClick={() => nav(1)}><ChevronRight size={20} /></button>
      </div>
      <label className="search">
        <Search size={16} />
        <input
          ref={input}
          value={value}
          placeholder="Search albums, artists, tracks"
          aria-label="Search"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        {value ? <button className="search__clear" aria-label="Clear search" onClick={() => { setValue(''); input.current?.focus(); }}><X size={14} /></button> : <kbd>/</kbd>}
      </label>
      <Popover
        placement="bottom-end"
        trigger={({ toggle }) => <button className="btn-icon" aria-label="Settings" onClick={toggle}><Settings size={19} /></button>}
      >
        {(close) => (
          <div role="menu" className="menu">
            <MenuItem icon={<RefreshCw size={16} />} onClick={() => { close(); void api.scan().then(() => toast('Library rescan started')).catch(() => toast('Could not reach the server')); }}>Rescan library</MenuItem>
            <button className="menu__item" role="menuitemcheckbox" aria-checked={autoRadio} onClick={() => void setAutoRadio(!autoRadio)}>
              <Radio size={16} />
              <span>Auto-radio when the queue ends</span>
              {autoRadio && <Check size={16} className="menu__check" />}
            </button>
            <div className="popover__title">Volume levelling</div>
            <VolumeLevel />
            <div className="popover__title">Ambient colours</div>
            {AMBIENTS.map((a) => (
              <button key={a} className={`menu__item${ambient === a ? ' is-current' : ''}`} role="menuitemradio" aria-checked={ambient === a} onClick={() => setAmbient(a)}>
                <i className={`ambdot ambdot--${a}`} />
                <span>{AMBIENT_LABEL[a]}</span>
                {ambient === a && <Check size={16} className="menu__check" />}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </header>
  );
}

const LEVELS: { id: NormalizeMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'no loudness gain' },
  { id: 'track', label: 'Per track', hint: 'even out every track' },
  { id: 'album', label: 'Per album', hint: 'keep an album’s own dynamics' },
];

/** Off / per-track / per-album loudness gain (GET+POST /settings/normalize). */
function VolumeLevel() {
  const [mode, setMode] = useState<NormalizeMode | null>(null);
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    let alive = true;
    listenApi.normalize().then((m) => { if (alive) setMode(m); }).catch(() => { if (alive) setMode('off'); });
    return () => { alive = false; };
  }, []);
  const pick = async (m: NormalizeMode) => {
    if (!mode || m === mode) return;
    const prev = mode;
    setMode(m);
    try {
      setMode(await listenApi.setNormalize(m));
    } catch {
      setMode(prev);
      toast('Could not save the volume levelling setting');
    }
  };
  return (
    <div className="vlevel">
      <div className="seg seg--level" role="radiogroup" aria-label="Volume levelling">
        {LEVELS.map((l) => (
          <button key={l.id} role="radio" aria-checked={mode === l.id} className={mode === l.id ? 'is-active' : ''} disabled={!mode} title={l.hint} onClick={() => void pick(l.id)}>{l.label}</button>
        ))}
      </div>
      <p className="vlevel__hint"><Volume2 size={12} /> {mode === null ? 'Loading…' : mode === 'off' ? 'No loudness gain' : `From ${mode} loudness · local files`}</p>
    </div>
  );
}
