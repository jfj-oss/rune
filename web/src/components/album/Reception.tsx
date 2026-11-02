import type { AlbumDetails, CriticQuote, CriticScore } from '@liner/shared';
import { ChevronRight } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatScoreValue, normalizeScore, scoreSuffix, scoreTone } from '../../lib/scores';
import { quotePreview, scorePreview, textPreview } from '../../lib/previews';
import { usePreview } from '../../store/preview';
import { SourceLink } from '../Rows';

/**
 * Serif prose clamped to `lines`; "Read more" expands it in place (smooth height transition) into a
 * scrollable view of the full stored text, "Show less" folds it back.
 */
export function Prose({ text, lines = 10, className = '', maxHeight = 560 }: { text: string; lines?: number; className?: string; maxHeight?: number }) {
  const clip = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dims, setDims] = useState<{ full: number; collapsed: number } | null>(null);
  const [more, setMore] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 28;
      const next = { full: Math.ceil(el.scrollHeight), collapsed: Math.round(lh * lines) };
      setDims((d) => (d && d.full === next.full && d.collapsed === next.collapsed ? d : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines]);

  const cap = Math.min(maxHeight, Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * 0.7));
  const overflow = !!dims && dims.full > dims.collapsed + 4;
  const scrollable = open && !!dims && dims.full > cap;
  const height = !dims ? undefined : open ? Math.min(dims.full, cap) : overflow ? dims.collapsed : dims.full;

  const checkMore = () => {
    const el = clip.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 6);
  };
  useLayoutEffect(() => { if (scrollable) checkMore(); else setMore(false); }, [scrollable, height]);

  const toggle = () => {
    if (open && clip.current) clip.current.scrollTo({ top: 0, behavior: 'smooth' });
    setOpen((o) => !o);
  };
  const faded = (!open && overflow) || (scrollable && more);

  return (
    <div className={className}>
      <div
        ref={clip}
        id={id}
        className={`prose__clip${scrollable ? ' prose__clip--scroll' : ''}${faded ? ' prose__clip--fade' : ''}`}
        style={{ height, overflowY: scrollable ? 'auto' : 'hidden' }}
        onScroll={checkMore}
        tabIndex={scrollable ? 0 : undefined}
        aria-label={scrollable ? 'Full text, scrollable' : undefined}
      >
        <div ref={inner} className="prose">
          {text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </div>
      {overflow && (
        <button className="readmore" onClick={toggle} aria-expanded={open} aria-controls={id}>
          {open ? 'Show less' : 'Read more'}
          {open && scrollable && <span className="readmore__hint"> · scroll for the rest</span>}
        </button>
      )}
    </div>
  );
}

export function ScoreChip({ s, details }: { s: CriticScore; details?: AlbumDetails }) {
  const n = normalizeScore(s);
  const open = usePreview((p) => p.open);
  return (
    <button
      type="button"
      className={`score score--${scoreTone(n)}`}
      onClick={() => open(scorePreview(s, details))}
      aria-haspopup="dialog"
      title={`${s.outlet}${s.reviewCount ? ` — ${s.reviewCount} reviews` : ''}`}
    >
      <b>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      <span>{s.outlet}</span>
    </button>
  );
}

function ScoreRow({ s, details }: { s: CriticScore; details: AlbumDetails }) {
  const n = normalizeScore(s);
  const open = usePreview((p) => p.open);
  return (
    <button type="button" className="srow" onClick={() => open(scorePreview(s, details))} aria-haspopup="dialog">
      <span className="srow__top">
        <span className="srow__outlet">{s.outlet}<ChevronRight size={14} aria-hidden /></span>
        <b className={`srow__val srow__val--${scoreTone(n)}`}>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      </span>
      <span className="srow__bar"><i className={`srow__fill srow__fill--${scoreTone(n)}`} style={{ width: `${n}%` }} /></span>
      {s.reviewCount ? <span className="srow__meta">{s.reviewCount.toLocaleString('en-US')} reviews</span> : null}
    </button>
  );
}

function QuoteCard({ q, details }: { q: CriticQuote; details: AlbumDetails }) {
  const open = usePreview((p) => p.open);
  const go = () => open(quotePreview(q, details));
  return (
    <figure
      className="quote"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}
    >
      <blockquote>“{q.quote}”</blockquote>
      <figcaption>
        <span>— {q.outlet}{q.author ? `, ${q.author}` : ''}</span>
        <span className="quote__more" aria-hidden>Read in context <ChevronRight size={13} /></span>
      </figcaption>
    </figure>
  );
}

export function Reception({ details }: { details: AlbumDetails }) {
  const { reception, scores, quotes } = details;
  const open = usePreview((p) => p.open);
  return (
    <div className="recep">
      <div className="recep__main">
        {reception && (
          <>
            <Prose text={reception.value} lines={10} />
            <SourceLink source={reception.source} url={reception.url} onPreview={() => open(textPreview('Critical reception', 'Critical reception', reception))} />
          </>
        )}
        {quotes.length > 0 && <div className="quotes">{quotes.map((q, i) => <QuoteCard key={i} q={q} details={details} />)}</div>}
      </div>
      {scores.length > 0 && (
        <aside className="recep__scores" aria-label="Critic scores">
          <h3 className="eyebrow">Scores</h3>
          {scores.map((s) => <ScoreRow key={s.outlet} s={s} details={details} />)}
        </aside>
      )}
    </div>
  );
}
