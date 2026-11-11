import { useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, type ApiError } from '../api';
import { useUi } from '../store/ui';
import { MenuItem } from './Popover';

/** Pin / unpin an album (`la:`/`sp:`) or playlist (`pl:`) to the top of its Library list; every list that shows it refreshes. */
export function usePin(id: string, pinned: boolean | undefined) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = useCallback(async () => {
    if (busy) return;
    const next = pinned !== true;
    setBusy(true);
    try {
      await api.setPinned(id, next);
      const playlist = id.startsWith('pl:');
      void qc.invalidateQueries({ queryKey: playlist ? ['playlist', id] : ['album', id] });
      void qc.invalidateQueries({ queryKey: playlist ? ['playlists'] : ['albums'] });
      useUi.getState().toast(next ? (playlist ? 'Pinned to the top of Playlists' : 'Pinned to the top of Albums') : 'Unpinned');
    } catch (e) {
      useUi.getState().toast((e as ApiError).serverMessage ?? (next ? 'Could not pin it — is the rune server reachable?' : 'Could not unpin it'));
    } finally {
      setBusy(false);
    }
  }, [busy, id, pinned, qc]);
  return { toggle, busy };
}

/** "Pin to Library" / "Unpin" in a page's … menu. */
export function PinMenuItem({ id, pinned, close }: { id: string; pinned: boolean | undefined; close(): void }) {
  const { toggle } = usePin(id, pinned);
  return (
    <MenuItem icon={pinned ? <PinOff size={16} /> : <Pin size={16} />} onClick={() => { close(); void toggle(); }}>
      {pinned ? 'Unpin' : 'Pin to Library'}
    </MenuItem>
  );
}

/** The small pin mark on a card or row. */
export function PinMark({ className = '' }: { className?: string }) {
  return <span className={`pinmark ${className}`} title="Pinned" aria-label="Pinned"><Pin size={11} fill="currentColor" /></span>;
}
