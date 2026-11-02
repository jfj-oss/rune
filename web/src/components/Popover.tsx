import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  return (
    <div className={`pop ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div ref={panel} className={`pop__panel pop__panel--${flip ? placement.replace('bottom', 'top') : placement} ${panelClassName}`}>{children(() => setOpen(false))}</div>}
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
