import type { AlbumDetails, CriticQuote, CriticScore } from '@liner/shared';
import { ExternalLink } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { formatScoreValue, normalizeScore, scoreSuffix, scoreTone } from '../../lib/scores';
import { SourceLink } from '../Rows';

/** Serif prose with a max line count and a Read more toggle. */
export function Prose({ text, lines = 10, className = '' }: { text: string; lines?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollHeight > el.clientHeight + 4 || open);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, lines]);
  const paras = text.split(/\n{2,}/);
  return (
    <div className={className}>
      <div
        ref={ref}
        className={`prose${!open ? ' prose--clamp' : ''}${!open && overflow ? ' prose--fade' : ''}`}
        style={{ ['--lines' as string]: lines }}
      >
        {paras.map((p, i) => <p key={i}>{p}</p>)}
      </div>
      {overflow && <button className="readmore" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Show less' : 'Read more'}</button>}
    </div>
  );
}

export function ScoreChip({ s }: { s: CriticScore }) {
  const n = normalizeScore(s);
  return (
    <a className={`score score--${scoreTone(n)}`} href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.outlet}${s.reviewCount ? ` — ${s.reviewCount} reviews` : ''}`}>
      <b>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      <span>{s.outlet}</span>
    </a>
  );
}

function ScoreRow({ s }: { s: CriticScore }) {
  const n = normalizeScore(s);
  return (
    <a className="srow" href={s.url} target="_blank" rel="noopener noreferrer">
      <span className="srow__top">
        <span className="srow__outlet">{s.outlet}<ExternalLink size={12} aria-hidden /></span>
        <b className={`srow__val srow__val--${scoreTone(n)}`}>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      </span>
      <span className="srow__bar"><i className={`srow__fill srow__fill--${scoreTone(n)}`} style={{ width: `${n}%` }} /></span>
      {s.reviewCount ? <span className="srow__meta">{s.reviewCount.toLocaleString('en-US')} reviews</span> : null}
    </a>
  );
}

function QuoteCard({ q }: { q: CriticQuote }) {
  return (
    <figure className="quote">
      <blockquote>“{q.quote}”</blockquote>
      <figcaption>
        — <a href={q.url} target="_blank" rel="noopener noreferrer" className="link">{q.outlet}{q.author ? `, ${q.author}` : ''}<span aria-hidden> ↗</span></a>
      </figcaption>
    </figure>
  );
}

export function Reception({ details }: { details: AlbumDetails }) {
  const { reception, scores, quotes } = details;
  return (
    <div className="recep">
      <div className="recep__main">
        {reception && (
          <>
            <Prose text={reception.value} lines={10} />
            <SourceLink source={reception.source} url={reception.url} />
          </>
        )}
        {quotes.length > 0 && <div className="quotes">{quotes.map((q, i) => <QuoteCard key={i} q={q} />)}</div>}
      </div>
      {scores.length > 0 && (
        <aside className="recep__scores" aria-label="Critic scores">
          <h3 className="eyebrow">Scores</h3>
          {scores.map((s) => <ScoreRow key={s.outlet} s={s} />)}
        </aside>
      )}
    </div>
  );
}
