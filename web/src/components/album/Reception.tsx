import type { AlbumDetails, CriticQuote, CriticScore } from '@liner/shared';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { aggregateScore, formatScoreValue, normalizeScore, SCORE_SCALE_HINT, scoreSuffix, scoreTone } from '../../lib/scores';
import { quotesNotInReception } from '../../lib/reviewContext';
import { GlassStars } from './GlassStars';
import { quotePreview, scoreHasText, scorePreview, textPreview } from '../../lib/previews';
import { hostOf } from '../../lib/format';
import { usePreview } from '../../store/preview';
import { SourceLink } from '../Rows';

/**
 * Serif prose clamped to `lines`; "Read more" expands it in place (smooth height transition) into a
 * scrollable view of the full stored text, "Show less" folds it back.
 */
export function Prose({ text, lines = 10, className = '', maxHeight = 560, fill }: {
  text: string; lines?: number; className?: string; maxHeight?: number;
  /** Grow the folded view to use the height of a column beside it: `beside` is that column, `own` the column the prose
   *  sits in (everything in it besides the prose is subtracted). Ignored when the columns are stacked. */
  fill?: { beside: React.RefObject<HTMLElement | null>; own: React.RefObject<HTMLElement | null> };
}) {
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
      let collapsed = Math.round(lh * lines);
      const b = fill?.beside.current, o = fill?.own.current, c = clip.current;
      if (b && o && c) {
        const br = b.getBoundingClientRect(), or = o.getBoundingClientRect();
        // side by side (the scores column starts level with this one): use the free height beside it, in whole lines
        if (Math.abs(br.top - or.top) < 48) {
          const rest = or.height - c.getBoundingClientRect().height;
          const room = Math.floor((br.height - rest) / lh) * lh;
          if (room > collapsed) collapsed = Math.round(room);
        }
      }
      const next = { full: Math.ceil(el.scrollHeight), collapsed };
      setDims((d) => (d && d.full === next.full && d.collapsed === next.collapsed ? d : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (fill?.beside.current) ro.observe(fill.beside.current);
    return () => ro.disconnect();
  }, [text, lines, fill]);

  const capBase = Math.min(maxHeight, Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * 0.7));
  // never smaller than the folded view, or "Read more" would shrink it
  const cap = Math.max(capBase, dims?.collapsed ?? 0);
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

/** Scores with stored text open the preview; bare numbers go straight to the site (marked with an external-link icon).
    The colour is the score itself on one scale (see SCORE_SCALE_HINT), never whether rune has text for it. */
function scoreAction(s: CriticScore, details: AlbumDetails | undefined, open: (i: ReturnType<typeof scorePreview>) => void) {
  const has = scoreHasText(s, details);
  return {
    tone: scoreTone(normalizeScore(s)),
    external: !has,
    props: has
      ? { as: 'button' as const, type: 'button' as const, onClick: () => open(scorePreview(s, details)), 'aria-haspopup': 'dialog' as const }
      : { as: 'a' as const, href: s.url, target: '_blank', rel: 'noopener noreferrer' },
  };
}

function ScoreLink({ props, className, title, children }: { props: ReturnType<typeof scoreAction>['props']; className: string; title?: string; children: React.ReactNode }) {
  if (props.as === 'a') {
    const { as: _a, ...rest } = props;
    return <a {...rest} className={className} title={title ? `${title} — opens ${hostOf(props.href)}` : `Opens ${hostOf(props.href)}`}>{children}</a>;
  }
  const { as: _b, ...rest } = props;
  return <button {...rest} className={className} title={title}>{children}</button>;
}

export function ScoreChip({ s, details }: { s: CriticScore; details?: AlbumDetails }) {
  const open = usePreview((p) => p.open);
  const { tone, props, external } = scoreAction(s, details, open);
  return (
    <ScoreLink props={props} className={`score score--${tone}`} title={`${s.outlet}: ${formatScoreValue(s)}${scoreSuffix(s)} (${Math.round(normalizeScore(s))}/100)${s.reviewCount ? `, ${s.reviewCount} reviews` : ''}`}>
      <b>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      <span>{s.outlet}</span>
      {external && <ExternalLink size={12} aria-hidden className="score__ext" />}
    </ScoreLink>
  );
}

function ScoreRow({ s, details }: { s: CriticScore; details: AlbumDetails }) {
  const n = normalizeScore(s);
  const open = usePreview((p) => p.open);
  const { tone, props } = scoreAction(s, details, open);
  return (
    <ScoreLink props={props} className="srow">
      <span className="srow__top">
        <span className="srow__outlet">{s.outlet}{props.as === 'a' ? <ExternalLink size={13} aria-hidden /> : <ChevronRight size={14} aria-hidden />}</span>
        <b className={`srow__val srow__val--${tone}`}>{formatScoreValue(s)}<small>{scoreSuffix(s)}</small></b>
      </span>
      <span className="srow__bar"><i className={`srow__fill srow__fill--${tone}`} style={{ width: `${n}%` }} /></span>
      {s.reviewCount ? <span className="srow__meta">{s.reviewCount.toLocaleString('en-US')} reviews</span> : null}
    </ScoreLink>
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
  const mainRef = useRef<HTMLDivElement>(null);
  const scoresRef = useRef<HTMLElement>(null);
  const fill = useMemo(() => ({ beside: scoresRef, own: mainRef }), []);
  const open = usePreview((p) => p.open);
  // an excerpt already printed word for word in the reception text above is not repeated as a pull quote
  const shownQuotes = quotesNotInReception(quotes, reception?.value);
  return (
    <div className="recep">
      <div className="recep__main" ref={mainRef}>
        {reception && (
          <>
            <Prose text={reception.value} lines={10} fill={scores.length > 0 ? fill : undefined} />
            <SourceLink source={reception.source} url={reception.url} onPreview={() => open(textPreview('Critical reception', 'Critical reception', reception))} />
          </>
        )}
        {shownQuotes.length > 0 && <div className="quotes">{shownQuotes.map((q, i) => <QuoteCard key={i} q={q} details={details} />)}</div>}
      </div>
      {scores.length > 0 && (
        <aside className="recep__scores" aria-label="Critic scores" ref={scoresRef}>
          <h3 className="eyebrow">Scores</h3>
          <ScoreLegend />
          {scores.map((s) => <ScoreRow key={s.outlet} s={s} details={details} />)}
        </aside>
      )}
    </div>
  );
}

/** The one colour scale every score uses, spelled out. */
export function ScoreLegend() {
  return (
    <p className="scale" title={SCORE_SCALE_HINT}>
      <span className="scale__k scale__k--high">75+ high</span>
      <span className="scale__k scale__k--mid">55–74 mid</span>
      <span className="scale__k scale__k--low">under 55 low</span>
      <span className="scale__n">Every score is scaled to 100 first.</span>
    </p>
  );
}

/** Hero: the average rating plus a "N scores" toggle; the individual chips stay folded until asked for. */
export function HeroScores({ scores, details }: { scores: AlbumDetails['scores']; details: AlbumDetails }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const agg = aggregateScore(scores);
  const tally = { high: 0, mid: 0, low: 0 };
  for (const s of scores) tally[scoreTone(normalizeScore(s))]++;
  const critics = `${scores.length} critic score${scores.length === 1 ? '' : 's'}`;
  return (
    <div className="hscores">
      <button
        type="button"
        className="ahero__stars"
        aria-expanded={open}
        aria-controls={id}
        title={agg ? `Average of ${agg.count} scores: ${agg.mean}/100. ${SCORE_SCALE_HINT}` : SCORE_SCALE_HINT}
        onClick={() => setOpen((o) => !o)}
      >
        {agg && <><GlassStars value={agg.stars} /><b>{agg.stars.toFixed(1)}</b></>}
        <span>{critics}</span>
        <span className="hscores__tally" aria-hidden>
          {tally.high > 0 && <i className="score--high">{tally.high}</i>}
          {tally.mid > 0 && <i className="score--mid">{tally.mid}</i>}
          {tally.low > 0 && <i className="score--low">{tally.low}</i>}
        </span>
        <ChevronDown size={15} aria-hidden className={`hscores__chev${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div id={id} className="hscores__panel">
          <div className="ahero__scores" aria-label="Critic scores">{scores.map((s) => <ScoreChip key={s.outlet} s={s} details={details} />)}</div>
          <ScoreLegend />
        </div>
      )}
    </div>
  );
}
