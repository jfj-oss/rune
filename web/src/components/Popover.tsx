import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  className?: string;
  panelClassName?: string;
}

export function Popover({ trigger, children, placement = 'bottom-end', className = '', panelClassName = '' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  // The panel is drawn in a portal on <body> with fixed coordinates, so no stacking context on the page (a hero
  // with z-index, a sticky tab bar, a row with a filter) can paint over it.
  const [pos, setPos] = useState<CSSProperties>({});
  // Open upward when the panel would run under the player bar / off the bottom of the window.
  useLayoutEffect(() => {
    const el = panel.current;
    const host = ref.current;
    if (!open || !el || !host || !placement.startsWith('bottom')) { setFlip(false); return; }
    const check = () => {
      const h = el.offsetHeight + 8;
      const r = host.getBoundingClientRect();
      const below = window.innerHeight - 130 - r.bottom;
      setFlip(h > below && r.top - 60 > below);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, placement]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const host = ref.current; if (!host) return;
      const r = host.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const p = flip ? placement.replace('bottom', 'top') : placement;
      const y: CSSProperties = p.startsWith('bottom') ? { top: r.bottom + 8 } : { bottom: vh - r.top + 12 };
      const x: CSSProperties = p.endsWith('end') ? { right: Math.max(8, vw - r.right) } : { left: Math.max(8, r.left) };
      setPos({ position: 'fixed', ...y, ...x });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, flip, placement]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(panel.current && panel.current.contains(t))) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return (
    <div className={`pop${open ? ' pop--open' : ''} ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && createPortal(
        <div ref={panel} style={pos} className={`pop__panel pop__panel--portal pop__panel--${flip ? placement.replace('bottom', 'top') : placement} ${panelClassName}`}>{children(() => setOpen(false))}</div>,
        document.body,
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`menu__item${danger ? ' menu__item--danger' : ''}`} role="menuitem" onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
