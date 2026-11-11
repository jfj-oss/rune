import { AlertTriangle, ArrowUpCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../lib/types';
import { useUpdater } from '../store/updater';
import { Dialog } from './Dialog';

const CHIP_LABEL: Record<NonNullable<UpdateStatus['stage']>, string> = {
  downloading: 'downloading',
  installing: 'installing',
  building: 'building',
  'waiting-for-music': 'after this song',
  restarting: 'restarting',
  'restart-needed': 'restart rune',
};

/**
 * "update" chip: appears only when a newer rune is ready (published, or committed on this PC and not running yet).
 * One tap opens a confirm; the chip then shows the running step and the page reloads when the server is back.
 * Shares its state and polling with the Settings → Updates card (store/updater.ts).
 */
export function UpdateChip({ className = '' }: { className?: string }) {
  const { status, running, waiting, error } = useUpdater();
  const install = useUpdater((u) => u.install);
  const [asking, setAsking] = useState(false);
  useEffect(() => useUpdater.getState().watch(), []);

  const stage = status?.stage ?? null;
  const busy = running || waiting || stage != null;
  const failed = !busy && error != null && status?.supported === true;
  if (!status?.supported || !(status.available || busy || failed)) return null;

  const label = busy ? (stage ? CHIP_LABEL[stage] : waiting ? 'restarting' : 'starting') : failed ? 'update failed' : 'update';
  const spin = busy && stage !== 'restart-needed';

  return (
    <>
      <button
        type="button"
        className={`chip chip--update${failed ? ' is-failed' : ''}${busy ? ' is-busy' : ''} ${className}`}
        disabled={busy}
        aria-label={busy ? `rune update: ${label}` : 'Update rune'}
        aria-live="polite"
        onClick={() => setAsking(true)}
      >
        {spin ? <Loader2 size={14} className="spin" /> : failed ? <AlertTriangle size={14} /> : <ArrowUpCircle size={14} />}
        <span>{label}</span>
      </button>
      {asking && (
        <Dialog
          title={failed ? 'Update failed' : 'Update rune now?'}
          className="dialog--confirm"
          onClose={() => setAsking(false)}
          footer={
            <>
              <button className="btn btn--sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
              <button className="btn btn--sm btn--primary" type="button" autoFocus onClick={() => { setAsking(false); void install(); }}>
                {failed ? 'Try again' : 'Update'}
              </button>
            </>
          }
        >
          {failed && <p className="dialog__lead updatecard__note--error">{error}</p>}
          <p className="dialog__lead">It waits for the song that&rsquo;s playing.</p>
        </Dialog>
      )}
    </>
  );
}
