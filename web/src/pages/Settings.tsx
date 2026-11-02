import { useQuery } from '@tanstack/react-query';
import { Activity, Check, Database, HardDrive, Palette, Plug, RefreshCw, Server } from 'lucide-react';
import { Empty } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import { LibraryTabs } from './Albums';
import { formatBytes, formatListening, formatStamp } from '../lib/discover';
import { AMBIENT_LABEL, AMBIENTS, DITHER_AMBIENTS, useUi } from '../store/ui';

/** Background picker (the desktop top-bar menu has the same list); shared by every device. */
function AmbientPicker() {
  const ambient = useUi((s) => s.ambient);
  const setAmbient = useUi((s) => s.setAmbient);
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
    </section>
  );
}

const OPTIONAL_JOB_LABEL: Record<string, string> = { matching: 'Metadata matching', details: 'Album details', loudness: 'Loudness analysis' };

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
          <p className="pagehead__sub">Background and server status</p>
        </div>
        <div className="libhead__actions">
          <button className="btn btn--sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw size={15} className={q.isFetching ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </header>

      <AmbientPicker />

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
                <span className={`statusrow__v ${h.spotify.connected ? 'status--ok' : 'status--warn'}`}>{h.spotify.connected ? 'Connected' : 'Not connected'}</span>
              </div>
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
