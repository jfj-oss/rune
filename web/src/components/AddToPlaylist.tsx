import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ListMusic, ListPlus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { usePlaylistActions } from '../hooks/usePlaylistEdit';
import { useIsDesktop } from '../hooks/useMedia';
import { canAddTo, isRunePlaylist, loadRecent, orderByRecent, type RunePlaylistSummary } from '../lib/playlists';
import type { PlayItem } from '../lib/types';
import { usePlaylistUi } from '../store/playlistUi';

export interface AddTarget {
  /** "Glass Harbour · 10 tracks" — shown in the picker */
  what: string;
  resolve(): Promise<PlayItem[]> | PlayItem[];
  /** suggested name if the user starts a new playlist from here */
  newName?: string;
}

const QUICK = 5;

/** The editable (non-smart rune) playlists, most recently used first. */
export function useAddablePlaylists(enabled = true) {
  const q = useQuery({ queryKey: ['playlists'], queryFn: () => api.playlists(), enabled });
  const list = useMemo(() => orderByRecent((q.data ?? []).filter(canAddTo), loadRecent()), [q.data]);
  return { list: list as RunePlaylistSummary[], loading: q.isLoading };
}

/**
 * "Add to playlist ▸" for any menu. On desktop it unfolds in place (recent playlists + "New playlist…");
 * on touch it opens the bottom sheet, which is easier to hit.
 */
export function AddToPlaylistItem({ target, close }: { target: AddTarget; close(): void }) {
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const { list, loading } = useAddablePlaylists(open);
  const actions = usePlaylistActions();
  const ui = usePlaylistUi.getState();

  const sheet = () => { close(); ui.openPicker({ title: 'Add to playlist', what: target.what, resolve: target.resolve, newName: target.newName }); };
  const add = async (p: RunePlaylistSummary) => {
    close();
    try { await actions.addItems(p.id, p.name, await target.resolve()); } catch { /* resolve failed: the caller toasts */ }
  };

  return (
    <>
      <button className={`menu__item menu__item--sub${open ? ' is-open' : ''}`} role="menuitem" aria-haspopup="true" aria-expanded={open} onClick={() => (desktop ? setOpen((o) => !o) : sheet())}>
        <ListPlus size={16} />
        <span>Add to playlist</span>
        <ChevronRight size={15} className="menu__check menu__chev" />
      </button>
      {open && (
        <div className="menu__sub" role="menu" aria-label="Add to playlist">
          <button className="menu__item" role="menuitem" onClick={() => { close(); ui.openNew({ name: target.newName, resolve: target.resolve, what: target.what }); }}>
            <Plus size={16} /><span>New playlist…</span>
          </button>
          {loading && <div className="menu__hint">Loading…</div>}
          {list.slice(0, QUICK).map((p) => (
            <button key={p.id} className="menu__item" role="menuitem" onClick={() => void add(p)} title={p.name}>
              <ListMusic size={16} /><span className="menu__txt">{p.name}</span>{!isRunePlaylist(p.id) && <i className="menu__dot" title="Spotify playlist — takes local files only" />}
            </button>
          ))}
          {list.length > QUICK && (
            <button className="menu__item menu__item--dim" role="menuitem" onClick={sheet}><span>All playlists ({list.length})…</span></button>
          )}
          {!loading && list.length === 0 && <div className="menu__hint">No playlists yet</div>}
        </div>
      )}
    </>
  );
}

