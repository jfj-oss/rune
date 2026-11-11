import { useEffect } from 'react';
import { AlertTriangle, Check, Download, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '../lib/types';
import { useUpdater } from '../store/updater';

export const STAGE_LABEL: Record<NonNullable<UpdateStatus['stage']>, string> = {
  downloading: 'Downloading',
  installing: 'Installing',
  building: 'Building',
  'waiting-for-music': 'Restarts when the music stops',
  restarting: 'Restarting',
  'restart-needed': 'Update ready — restart rune',
};

/** Settings "Updates" section: current commit, a check/update button and the running step. Shares its state with the top-bar chip. */
export function UpdateCard() {
  const { status, running, waiting, error } = useUpdater();
  const check = useUpdater((u) => u.check);
  const install = useUpdater((u) => u.install);
  useEffect(() => useUpdater.getState().watch(), []);
  const onInstall = () => void install();

  const s = status;
  const local = s?.pendingLocal === true;
  const stage = s?.stage ?? null;
  const busy = running || stage != null || waiting;

  const diverged = (s?.ahead ?? 0) > 0 && (s?.behind ?? 0) > 0;
  const unpublished = (s?.ahead ?? 0) > 0 && (s?.behind ?? 0) === 0 && !local;
  const newer = ((s?.behind ?? 0) > 0 && (s?.ahead ?? 0) === 0) || (local && !diverged);

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
    buttonOnClick = onInstall;
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
      {s?.supported && s.running && s.running !== s.current && (
        <div className="statusrow">
          <span className="statusrow__k">Running</span>
          <span className="statusrow__v mono">{s.running}</span>
        </div>
      )}
      {newer && (
        <div className="statusrow">
          <span className="statusrow__k">Newer code</span>
          <span className="statusrow__v status--ok">
            {(s!.behind ?? 0) > 0 ? `${s!.behind} ${s!.behind === 1 ? 'commit' : 'commits'} behind` : 'on this PC, not running yet'}
          </span>
        </div>
      )}
      {unpublished && (
        <p className="updatecard__note">This copy has {s!.ahead} {s!.ahead === 1 ? 'change' : 'changes'} that are not published.</p>
      )}
      {diverged && <p className="updatecard__note">This copy and the published copy have diverged.</p>}
      {s && !s.supported && <p className="updatecard__note">Updates are not available for this copy.</p>}
      {s?.dirty && <p className="updatecard__note status--warn">Tracked files are changed — update blocked.</p>}
      {s?.playing && !busy && <p className="updatecard__note status--warn">Music is playing — the restart waits until it stops.</p>}

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
