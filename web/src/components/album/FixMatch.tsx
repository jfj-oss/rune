import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { plural } from '../../lib/format';
import { useUi } from '../../store/ui';
import { Dialog } from '../Dialog';

export function FixMatchBanner({ onFix }: { onFix(): void }) {
  return (
    <div className="banner" role="status">
      <AlertTriangle size={18} />
      <span>This album may be matched wrongly.</span>
      <button className="banner__btn" onClick={onFix}>Fix match</button>
    </div>
  );
}

export function FixMatchDialog({ albumId, onClose }: { albumId: string; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const cands = useQuery({ queryKey: ['candidates', albumId], queryFn: () => api.candidates(albumId) });
  const [sel, setSel] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: (mb: string) => api.match(albumId, mb),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['album', albumId] }), qc.invalidateQueries({ queryKey: ['details', albumId] }), qc.invalidateQueries({ queryKey: ['albums'] })]);
      toast('Match updated');
      onClose();
    },
    onError: () => toast('Could not apply that match'),
  });
  const list = cands.data ?? [];
  return (
    <Dialog
      title="Fix match"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!sel || apply.isPending} onClick={() => sel && apply.mutate(sel)}>{apply.isPending ? 'Applying…' : 'Apply'}</button>
        </>
      }
    >
      <p className="muted dialog__lead">Pick the release that matches your files. rune will re-fetch credits, cover art and reviews for it.</p>
      {cands.isLoading ? (
        <div className="cands">{[0, 1, 2].map((i) => <div key={i} className="skel skel--cand shimmer" />)}</div>
      ) : list.length === 0 ? (
        <p className="muted">No candidate releases were found.</p>
      ) : (
        <div className="cands" role="radiogroup" aria-label="Candidate releases">
          {list.map((c) => (
            <label key={c.musicbrainzReleaseId} className={`cand${sel === c.musicbrainzReleaseId ? ' is-sel' : ''}`}>
              <input type="radio" name="cand" checked={sel === c.musicbrainzReleaseId} onChange={() => setSel(c.musicbrainzReleaseId)} />
              <span className="cand__main">
                <b>{c.title}</b>
                <span>{c.artist}{c.year ? ` · ${c.year}` : ''} · {plural(c.trackCount, 'track')}{c.country ? ` · ${c.country}` : ''}</span>
              </span>
              <span className="cand__score" title="Match score">{Math.round(c.score * 100)}%</span>
            </label>
          ))}
        </div>
      )}
    </Dialog>
  );
}
