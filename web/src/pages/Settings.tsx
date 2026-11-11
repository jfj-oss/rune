import { useQuery } from '@tanstack/react-query';
import { Activity, Check, Database, HardDrive, Keyboard, Palette, Plug, RefreshCw, Server } from 'lucide-react';
import { Empty } from '../components/Rows';
import { UpdateCard } from '../components/UpdateCard';
import { api, http, isMock } from '../api';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import { LibraryTabs } from './Albums';
import { formatBytes, formatListening, formatStamp } from '../lib/discover';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { ALBUM_KEY_CHOICES, FIXED_KEYS } from '../lib/keys';
import { encId } from '../lib/format';
import { AMBIENT_LABEL, AMBIENTS, DITHER_AMBIENTS, DOT_LABEL, DOT_SIZES, useUi } from '../store/ui';
import { useSpotify } from '../store/spotify';
import { LIKED_PLAYLIST_ID, missingWriteScope } from '../lib/playlists';

interface SpotifyUsage {
  blockedUntil: number | null;
  budget?: { daily: number; used24h: number; level: 'normal' | 'tight' | 'low' | 'out' };
}

const BUDGET_NOTE: Record<string, string> = {
  normal: '',
  tight: ' · checking less often',
  low: ' · background syncs paused',
  out: ' · budget used up, background paused',
};

/** The login predates a permission rune now needs (liking songs, editing Spotify playlists): offer the reconnect. */
function ScopeNote() {
  const scopes = useSpotify((s) => s.scopes);
  if (!scopes) return null;
  const missing = [missingWriteScope(scopes, LIKED_PLAYLIST_ID) && 'like songs', missingWriteScope(scopes, 'pl:sp:any') && 'edit your Spotify playlists'].filter(Boolean);
  if (!missing.length) return null;
  return <> · this login cannot {missing.join(' or ')} yet · <a className="link" href="/api/spotify/login">Reconnect Spotify</a></>;
}

/** Requests sent to Spotify in the last 24 h against rune's own daily budget, and any Spotify lockout. */
function SpotifyUsageRow() {
  const q = useQuery({
    queryKey: ['spotify-usage'],
    queryFn: () => http<SpotifyUsage>('/spotify/usage'),
    enabled: !isMock,
    refetchInterval: 60_000,
  });
  const u = q.data;
  if (!u) return null;
  if (u.blockedUntil && u.blockedUntil > Date.now()) {
    const at = new Date(u.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
      <div className="statusrow">
        <span className="statusrow__k">Spotify limit</span>
        <span className="statusrow__v status--bad">Locked out by Spotify until {at}</span>
      </div>
    );
  }
  if (!u.budget) return null;
  const { used24h, daily, level } = u.budget;
  const tone = level === 'normal' ? 'status--ok' : level === 'tight' ? 'status--warn' : 'status--bad';
  return (
    <div className="statusrow">
      <span className="statusrow__k">Spotify requests</span>
      <span className={`statusrow__v ${tone}`}>
        {used24h.toLocaleString('en-US')} / {daily.toLocaleString('en-US')} in 24 h{BUDGET_NOTE[level] ?? ''}
      </span>
    </div>
  );
}

/** The two colours of "Dither · Custom": the base dots and the highlights (e.g. purple with orange highlights). */
const DUOTONE_PRESETS: { name: string; mid: string; light: string }[] = [
  { name: 'Purple + orange', mid: '#5a2a9e', light: '#ff7a3d' },
  { name: 'Teal + gold', mid: '#0f5560', light: '#f2c14e' },
  { name: 'Red + cream', mid: '#7a1820', light: '#f3e2c0' },
  { name: 'Blue + pink', mid: '#1d3f8a', light: '#ff6fa8' },
];
function DuotonePick() {
  const d = useUi((s) => s.duotone);
  const setDuotone = useUi((s) => s.setDuotone);
  return (
    <div className="duopick">
      <label className="duopick__c"><input type="color" value={d.mid} onChange={(e) => setDuotone({ ...d, mid: e.target.value })} /><span><b>Base</b><span className="muted">Most of the dots</span></span></label>
      <label className="duopick__c"><input type="color" value={d.light} onChange={(e) => setDuotone({ ...d, light: e.target.value })} /><span><b>Highlights</b><span className="muted">The brightest parts</span></span></label>
      <div className="duopick__presets">
        {DUOTONE_PRESETS.map((p) => (
          <button key={p.name} type="button" className="duopick__preset" title={p.name} aria-label={p.name} onClick={() => setDuotone({ mid: p.mid, light: p.light })}
            style={{ background: `linear-gradient(135deg, ${p.mid} 0 55%, ${p.light} 55% 100%)` }} />
        ))}
      </div>
    </div>
  );
}

/** Background picker (the desktop top-bar menu has the same list); shared by every device. */
function AmbientPicker() {
  const ambient = useUi((s) => s.ambient);
  const setAmbient = useUi((s) => s.setAmbient);
  const dots = useUi((s) => s.dots);
  const setDots = useUi((s) => s.setDots);
  return (
    <section className="statuscard ambientpick">
      <h2 className="statuscard__head"><Palette size={17} /> Background</h2>
      <p className="muted">Shared by all your devices.</p>
      <div className="ambientpick__list" role="radiogroup" aria-label="Background">
        {[...DITHER_AMBIENTS, ...AMBIENTS].map((a) => (
          <button key={a} role="radio" aria-checked={ambient === a} className={`ambientpick__item${ambient === a ? ' is-current' : ''}`} onClick={() => setAmbient(a)}>
            <i className={`ambdot ambdot--${a}`} />
            <span>{AMBIENT_LABEL[a]}</span>
            {ambient === a && <Check size={15} />}
          </button>
        ))}
      </div>
      {ambient === 'dither-custom' && <DuotonePick />}
      <div className="dotpick">
        <div><b>Dot size</b><span className="muted">Grain of the Dither backgrounds</span></div>
        <div className="seg" role="radiogroup" aria-label="Dot size">
          {DOT_SIZES.map((d) => (
            <button key={d} role="radio" aria-checked={dots === d} className={dots === d ? 'is-active' : ''} onClick={() => setDots(d)}>{DOT_LABEL[d]}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The single-key shortcuts, plus the one key the user picks for "go to the playing album". */
function KeyboardCard() {
  const albumKey = useUi((s) => s.albumKey);
  const setAlbumKey = useUi((s) => s.setAlbumKey);
  const playlistKeys = useUi((s) => s.playlistKeys);
  const setPlaylistKey = useUi((s) => s.setPlaylistKey);
  const plEntries = Object.entries(playlistKeys).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="statuscard keyspick">
      <h2 className="statuscard__head"><Keyboard size={17} /> Keyboard</h2>
      <p className="muted">Work anywhere in rune, except while typing. The album and playlist keys are shared by all your devices.</p>
      <div className="dotpick">
        <div><b>Go to the playing album</b><span className="muted">Keys rune already uses are left out</span></div>
        <label className="select">
          <span>Key</span>
          <select value={albumKey} onChange={(e) => setAlbumKey(e.target.value)} aria-label="Key for the playing album">
            <option value="">Off</option>
            {ALBUM_KEY_CHOICES.filter((k) => !playlistKeys[k]).map((k) => <option key={k} value={k}>{k.toUpperCase()}</option>)}
          </select>
        </label>
      </div>
      <ul className="keyspick__list">
        {FIXED_KEYS.map((k) => (
          <li key={k.key}><kbd>{k.label}</kbd><span>{k.does}</span></li>
        ))}
        {plEntries.map(([k, p]) => (
          <li key={k}>
            <kbd>{k.toUpperCase()}</kbd>
            <Link to={`/playlist/${encId(p.id)}`} className="link">{p.name}</Link>
            <button className="btn-icon keyspick__rm" aria-label={`Remove the hotkey for ${p.name}`} title="Remove" onClick={() => setPlaylistKey(p.id, p.name, '')}><X size={14} /></button>
          </li>
        ))}
      </ul>
      <p className="muted keyspick__hint">Give a playlist its own key with the Hotkey button on the playlist’s page.</p>
    </section>
  );
}

const OPTIONAL_JOB_LABEL: Record<string, string> = { matching: 'Metadata matching', details: 'Album details', loudness: 'Loudness analysis' };

/** Files the last scan could not read, collapsed so the Library card stays compact. */
function ScanErrorsList() {
  const q = useQuery({ queryKey: ['scan-errors'], queryFn: () => api.scanErrors(), staleTime: 60_000 });
  const errors = q.data ?? [];
  if (errors.length === 0) return null;
  return (
    <details className="scanerrors">
      <summary>{errors.length} {errors.length === 1 ? 'file' : 'files'} could not be read</summary>
      <ul className="scanerrors__list">
        {errors.map((e) => (
          <li key={e.path}>
            <span className="scanerrors__path mono">{e.path}</span>
            <span className="scanerrors__reason">{e.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function Settings() {
  const q = useQuery({ queryKey: ['health'], queryFn: () => discoverApi.health(), refetchInterval: 30_000 });
  const h = q.data;
  const desktop = useIsDesktop();

  return (
    <div className="page page--settings">
      {!desktop && <LibraryTabs active="settings" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Settings</h1>
          <p className="pagehead__sub">Background, keyboard and server status</p>
        </div>
        <div className="libhead__actions">
          <button className="btn btn--sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw size={15} className={q.isFetching ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </header>

      <AmbientPicker />
      <KeyboardCard />
      <UpdateCard />

      {q.isError ? (
        <Empty title="Could not reach the rune server" icon={<Server size={28} />}>
          The web app is running, but the server did not answer <span className="mono">/api/health</span>.
        </Empty>
      ) : !h ? (
        <div className="statusgrid" aria-live="polite">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="statuscard"><div className="skel skel--title shimmer" style={{ width: '55%' }} /><div className="skel skel--line shimmer" /><div className="skel skel--line shimmer" style={{ width: '70%' }} /></div>
          ))}
        </div>
      ) : (
        <>
          <div className="statussummary">
            <span className={`statusdot${h.ok ? '' : ' statusdot--bad'}`} aria-hidden />
            <div>
              <b>{h.ok ? 'All systems running' : 'The server reported a problem'}</b>
              <span>rune {h.version} · up {formatListening(h.uptimeS * 1000)}</span>
            </div>
          </div>

          <div className="statusgrid">
            <section className="statuscard">
              <h2 className="statuscard__head"><HardDrive size={17} /> Library</h2>
              {h.library.roots.length === 0 ? <p className="muted secnote">No library roots configured.</p> : h.library.roots.map((root) => (
                <div key={root.path} className="statusroot">
                  <span className="statusroot__path mono">{root.path}</span>
                  <span className="statusroot__badges">
                    <span className={`badge${root.mounted ? ' badge--ok' : ' badge--bad'}`}>{root.mounted ? 'Mounted' : 'Missing'}</span>
                    <span className="badge">{root.readOnly ? 'Read-only' : 'Writable'}</span>
                  </span>
                  <span className="statusroot__free">{formatBytes(root.free)} free</span>
                </div>
              ))}
              <div className="statusrow"><span className="statusrow__k">Last scan</span><span className="statusrow__v">{formatStamp(h.library.lastScanAt)}</span></div>
              <ScanErrorsList />
            </section>

            <section className="statuscard">
              <h2 className="statuscard__head"><Database size={17} /> Database</h2>
              <div className="statusrow"><span className="statusrow__k">Albums</span><span className="statusrow__v">{h.db.albums.toLocaleString('en-US')}</span></div>
              <div className="statusrow"><span className="statusrow__k">Tracks</span><span className="statusrow__v">{h.db.tracks.toLocaleString('en-US')}</span></div>
              <div className="statusrow"><span className="statusrow__k">Library index</span><span className="statusrow__v">{h.db.sizeMB.toFixed(1)} MB</span></div>
            </section>

            <section className="statuscard">
              <h2 className="statuscard__head"><Plug size={17} /> Playback</h2>
              <div className="statusrow">
                <span className="statusrow__k">mpv</span>
                <span className={`statusrow__v ${h.mpv.alive ? 'status--ok' : 'status--bad'}`}>
                  {h.mpv.alive ? `Running${h.mpv.pid ? ` · PID ${h.mpv.pid}` : ''}` : 'Not running'}
                </span>
              </div>
              <div className="statusrow">
                <span className="statusrow__k">Spotify</span>
                <span className={`statusrow__v ${h.spotify.connected ? 'status--ok' : 'status--warn'}`}>
                  {h.spotify.connected ? <>Connected<ScopeNote /></> : <>Not connected · <a className="link" href="/api/spotify/login">Connect Spotify</a></>}
                </span>
              </div>
              {h.spotify.connected ? <SpotifyUsageRow /> : null}
            </section>

            <section className="statuscard">
              <h2 className="statuscard__head"><Activity size={17} /> Background jobs</h2>
              {Object.entries(h.jobs).map(([job, running]) => (
                <div key={job} className="statusrow">
                  <span className="statusrow__k">{OPTIONAL_JOB_LABEL[job] ?? job}</span>
                  <span className={`statusrow__v ${running ? 'status--ok' : 'statusrow__v--idle'}`}>{running ? 'Running' : 'Idle'}</span>
                </div>
              ))}
              {Object.values(h.jobs).every((v) => !v) ? <p className="sourceline">Nothing is running right now. No jobs queued.</p> : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
