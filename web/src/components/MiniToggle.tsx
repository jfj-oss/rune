import { Circle } from 'lucide-react';
import { miniColor } from '../lib/miniPlaylists';
import { useMiniToggle } from '../hooks/useMiniPlaylists';
import { MenuItem } from './Popover';

function MiniDot({ on, color }: { on: boolean; color: number | undefined }) {
  const c = on && color !== undefined ? miniColor(color) : undefined;
  return <Circle size={16} fill={c ?? 'none'} color={c} />;
}

/** "Show in rune mini" / "Remove from rune mini" in a playlist page's … menu, next to Pin. */
export function MiniMenuItem({ id, name, close }: { id: string; name: string; close(): void }) {
  const { on, color, toggle } = useMiniToggle(id, name);
  return (
    <MenuItem icon={<MiniDot on={on} color={color} />} onClick={() => { close(); void toggle(); }}>
      {on ? 'Remove from rune mini' : 'Show in rune mini'}
    </MenuItem>
  );
}

/** The same switch as a button on the playlist's page. */
export function MiniButton({ id, name }: { id: string; name: string }) {
  const { on, color, toggle, busy } = useMiniToggle(id, name);
  return (
    <button className="btn" aria-pressed={on} disabled={busy} onClick={() => void toggle()} title="A coloured dot on the rune mini that shuffle-plays this playlist">
      <MiniDot on={on} color={color} /> Show in rune mini
    </button>
  );
}
