import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function SectionHead({ title, action, to }: { title: string; action?: ReactNode; to?: string }) {
  return (
    <div className="sechead">
      <h2 className="eyebrow">{title}</h2>
      {to ? <Link to={to} className="sechead__link">See all</Link> : null}
      {action}
    </div>
  );
}

/** Horizontal scroller with arrow buttons on hover (hidden on touch). */
export function HScroll({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * Math.max(300, ref.current.clientWidth * 0.8), behavior: 'smooth' });
  return (
    <div className={`hscroll ${className}`}>
      <button className="hscroll__btn hscroll__btn--l" aria-label="Scroll left" onClick={() => by(-1)}><ChevronLeft size={18} /></button>
      <div className="hscroll__track" ref={ref}>{children}</div>
      <button className="hscroll__btn hscroll__btn--r" aria-label="Scroll right" onClick={() => by(1)}><ChevronRight size={18} /></button>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** "From Wikipedia ›": with `onPreview` it opens the in-app preview instead of leaving rune. */
export function SourceLink({ source, url, prefix = 'From', onPreview }: { source: string; url: string; prefix?: string; onPreview?: () => void }) {
  return (
    <p className="sourceline">
      {prefix}{' '}
      {onPreview ? (
        <button type="button" className="link sourceline__btn" onClick={onPreview} aria-haspopup="dialog">{source}<span aria-hidden> ›</span></button>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer" className="link">{source}<span aria-hidden> ↗</span></a>
      )}
    </p>
  );
}
