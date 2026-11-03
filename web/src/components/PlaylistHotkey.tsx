import { Keyboard, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isKeyChoice, keyCapture, keyOwner } from '../lib/keys';
import { useUi } from '../store/ui';

/** "Hotkey" button on a playlist's page: click, then press a letter or digit; that key opens this playlist anywhere. */
export function PlaylistHotkey({ id, name }: { id: string; name: string }) {
  const keys = useUi((s) => s.playlistKeys);
  const setKey = useUi((s) => s.setPlaylistKey);
  const current = Object.entries(keys).find(([, p]) => p.id === id)?.[0] ?? '';
  const [listening, setListening] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  // keep the stored name in step if the playlist is renamed
  useEffect(() => { if (current && keys[current]?.name !== name) setKey(id, name, current); }, [current, id, name, keys, setKey]);

  useEffect(() => {
    if (!listening) return;
    keyCapture.active = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key.toLowerCase();
      if (k === 'escape') { setListening(false); return; }
      if (k === 'backspace' || k === 'delete') { setKey(id, name, ''); setListening(false); return; }
      if (!isKeyChoice(k)) { useUi.getState().toast('Use a letter or a number'); return; }
      const { albumKey, playlistKeys } = useUi.getState();
      const owner = keyOwner(k, albumKey, playlistKeys, id);
      if (owner) { useUi.getState().toast(`${k.toUpperCase()} is already used for ${owner}`); return; }
      setKey(id, name, k);
      setListening(false);
    };
    // a click anywhere else stops listening (the button's own click toggles it)
    const cancel = (e: PointerEvent) => { if (!btn.current?.contains(e.target as Node)) setListening(false); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', cancel, true);
    return () => {
      keyCapture.active = false;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', cancel, true);
    };
  }, [listening, id, name, setKey]);

  return (
    <span className="hotkeybtn">
      <button
        ref={btn}
        className={`btn${listening ? ' is-listening' : ''}`}
        onClick={() => setListening((v) => !v)}
        title={current ? `Press ${current.toUpperCase()} anywhere in rune to open this playlist` : 'Choose a key that opens this playlist from anywhere'}
        aria-pressed={listening}
      >
        <Keyboard size={16} />
        {listening ? 'Press a key…' : current ? <>Hotkey <kbd>{current.toUpperCase()}</kbd></> : 'Hotkey'}
      </button>
      {current && !listening && (
        <button className="btn btn--icon hotkeybtn__clear" aria-label="Remove the hotkey" title="Remove the hotkey" onClick={() => setKey(id, name, '')}><X size={15} /></button>
      )}
    </span>
  );
}
