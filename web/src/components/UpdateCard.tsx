import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { ApiError, api } from '../api';
import type { UpdateStatus } from '../lib/types';

const STAGE_LABEL: Record<NonNullable<UpdateStatus['stage']>, string> = {
  downloading: 'Downloading',
  installing: 'Installing',
  building: 'Building',
  'waiting-for-music': 'Restarts when the music stops',
  restarting: 'Restarting',
  'restart-needed': 'Update ready — restart rune',
};

/** Settings "Updates" section: current commit, a check/update button and the running step. */
export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef<UpdateStatus | null>(null);
  const runningRef = useRef(false);
  const waitingRef = useRef(false);
  const sawOfflineRef = useRef(false);
  statusRef.current = status;
  runningRef.current = running;
  waitingRef.current = waiting;

  async function check(): Promise<UpdateStatus | null> {
    try {
      const s = await api.updateStatus();
      setStatus(s);
      setError(null);
      // After a systemd restart the server is briefly unreachable; reload once it is back.
      if (waitingRef.current && sawOfflineRef.current) window.location.reload();
      return s;
    } catch {
      sawOfflineRef.current = true;
      return null;
    }
  }

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stop) return;
      await check();
      const fast = runningRef.current || waitingRef.current || statusRef.current?.stage != null;
      timer = setTimeout(loop, fast ? 1000 : 15_000);
    };
    void loop();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function onInstall() {
    setRunning(true);
    setError(null);
    try {
      const res = await api.updateInstall();
      if (res.ok && res.stage === 'restarting') {
        setWaiting(true);
        setRunning(false);
        // keep polling; check() reloads once the server has gone away and come back
      } else {
        if (!res.ok) setError(res.error);
        setRunning(false);
        await check();
      }
    } catch (e) {
      setRunning(false);
      setError(e instanceof ApiError && e.serverMessage ? e.serverMessage : e instanceof Error ? e.message : String(e));
      void check();
    }
  }

  const s = status;
  const stage = s?.stage ?? null;
  const busy = running || stage != null || waiting;

  const diverged = (s?.ahead ?? 0) > 0 && (s?.behind ?? 0) > 0;
  const unpublished = (s?.ahead ?? 0) > 0 && (s?.behind ?? 0) === 0;
  const newer = (s?.behind ?? 0) > 0 && (s?.ahead ?? 0) === 0;

  let buttonLabel = 'Check for updates';
  let buttonOnClick: (() => void) | null = () => void check();
  let buttonDisabled = false;

  if (busy) {
    buttonLabel = stage ? STAGE_LABEL[stage] : waiting ? 'Restarting' : 'Working';
    buttonOnClick = null;
    buttonDisabled = true;
  } else if (stage === 'restart-needed') {
    buttonLabel = STAGE_LABEL['restart-needed'];
    buttonOnClick = null;
    buttonDisabled = true;
  } else if (newer) {
    buttonLabel = 'Update now';
    buttonOnClick = () => void onInstall();
  } else if (unpublished || diverged || (s && !s.supported)) {
    buttonOnClick = null;
    buttonDisabled = true;
  }

  return (
    <section className="statuscard updatecard">
      <h2 className="statuscard__head"><GitBranch size={17} /> Updates</h2>

      <div className="statusrow">
        <span className="statusrow__k">This copy</span>
        <span className="statusrow__v mono">{s?.current ?? '—'}</span>
      </div>
      {s?.supported && (
        <div className="statusrow">
          <span className="statusrow__k">Latest</span>
          <span className="statusrow__v mono">{s.latest ?? '—'}</span>
        </div>
      )}
      {newer && (
        <div className="statusrow">
          <span className="statusrow__k">Newer code</span>
          <span className="statusrow__v status--ok">{s!.behind} {s!.behind === 1 ? 'commit' : 'commits'} behind</span>
        </div>
      )}
      {unpublished && (
        <p className="updatecard__note">This copy has {s!.ahead} {s!.ahead === 1 ? 'change' : 'changes'} that are not published.</p>
      )}
      {diverged && <p className="updatecard__note">This copy and the published copy have diverged.</p>}
      {s && !s.supported && <p className="updatecard__note">Updates are not available for this copy.</p>}
      {s?.dirty && <p className="updatecard__note status--warn">Tracked files are changed — update blocked.</p>}
      {s?.playing && !busy && <p className="updatecard__note status--warn">Music is playing — update blocked until it stops.</p>}

      {error && (
        <p className="updatecard__note updatecard__note--error">
          <AlertTriangle size={14} /> {error}
        </p>
      )}

      <div className="updatecard__actions">
        <button className="btn btn--sm" type="button" disabled={buttonDisabled || !buttonOnClick} onClick={() => buttonOnClick?.()}>
          {busy ? <Loader2 size={15} className="spin" /> : stage === 'restart-needed' ? <Check size={15} /> : newer ? <Download size={15} /> : <RefreshCw size={15} />}
          {buttonLabel}
        </button>
      </div>
    </section>
  );
}
