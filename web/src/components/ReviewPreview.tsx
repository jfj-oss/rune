import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Loader2, ShieldOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { browseApi } from '../browseApi';
import { useIsDesktop } from '../hooks/useMedia';
import { hostOf } from '../lib/format';
import { highlightSegments } from '../lib/reviewContext';
import { formatScoreValue, normalizeScore, scoreSuffix, scoreTone } from '../lib/scores';
import { usePreview, type PreviewItem } from '../store/preview';

const FOCUSABLE = 'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Mounted once: shows whatever `usePreview.open(...)` was given as a side sheet (desktop) or bottom sheet (mobile). */
export function ReviewPreviewHost() {
  const item = usePreview((s) => s.item);
  if (!item) return null;
  return createPortal(<Sheet key={`${item.kind}|${item.title}|${item.url}`} item={item} />, document.body);
}

function Sheet({ item }: { item: PreviewItem }) {
  const close = usePreview((s) => s.close);
  const desktop = useIsDesktop();
  const [view, setView] = useState<'summary' | 'original'>('summary');
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; t0: number; dy: number } | null>(null);

  const requestClose = useCallback(() => {
    if (reduceMotion()) return close();
    setClosing(true);
    window.setTimeout(close, 170);
  }, [close]);

  // focus the sheet, trap Tab inside it, close on Escape, give focus back afterwards
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); requestClose(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0]!, last = els[els.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (!panel.current.contains(active)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, [requestClose]);

  // mobile: drag the grabber / header down to dismiss
  const onDown = (e: React.PointerEvent) => {
    if (desktop || (e.target as HTMLElement).closest('button, a')) return;
    drag.current = { y0: e.clientY, t0: e.timeStamp, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    panel.current?.style.setProperty('transition', 'none');
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    panel.current?.style.setProperty('transform', `translateY(${d.dy}px)`);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    panel.current?.style.removeProperty('transition');
    const fast = d.dy / Math.max(1, e.timeStamp - d.t0) > 0.6;
    if (d.dy > 110 || (fast && d.dy > 30)) requestClose();
    else panel.current?.style.removeProperty('transform');
  };

  const label = item.label;
  return (
    <div className={`pv${closing ? ' is-closing' : ''}`}>
      <div className="pv__scrim" onMouseDown={requestClose} />
      <div
        ref={panel}
        className={`pv__panel${view === 'original' ? ' pv__panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${item.title} — ${label}`}
        tabIndex={-1}
      >
        <div className="pv__grab" aria-hidden onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}><i /></div>
        <header className="pv__head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {view === 'original' ? (
            <button className="pv__back" onClick={() => setView('summary')}><ArrowLeft size={16} /> Back</button>
          ) : (
            <span className="eyebrow">{label}</span>
          )}
          <span className="pv__spacer" />
          <button className="btn-icon" aria-label="Close preview" onClick={requestClose}><X size={18} /></button>
        </header>
        {view === 'summary' ? <Summary item={item} onOpenOriginal={() => setView('original')} /> : <Original item={item} />}
      </div>
    </div>
  );
}

function Summary({ item, onOpenOriginal }: { item: PreviewItem; onOpenOriginal(): void }) {
  const s = item.score;
  const n = s ? normalizeScore(s) : 0;
  const ctx = item.context;
  const tone = scoreTone(n);
  const attr = item.attribution ?? (ctx && ctx.sentences.length > 0 ? { source: ctx.source, url: ctx.url } : undefined);
  return (
    <>
    <div className="pv__body">
      <h2 className="pv__title">{item.title}</h2>
      {item.author && <p className="pv__by">by {item.author}</p>}

      {s && (
        <div className="pv__score" aria-label={`Score ${formatScoreValue(s)} out of ${s.scale}`}>
          <b className={`pv__val pv__val--${tone}`}>{formatScoreValue(s)}<small>{s.scale >= 100 ? ' / 100' : ` ${scoreSuffix(s)}`}</small></b>
          <span className="srow__bar"><i className={`srow__fill srow__fill--${tone}`} style={{ width: `${n}%` }} /></span>
          <span className="pv__meta">{s.reviewCount ? `${s.reviewCount.toLocaleString('en-US')} ratings · ` : ''}normalised {Math.round(n)}/100</span>
        </div>
      )}

      {item.quote && <blockquote className="pv__quote">“{item.quote}”</blockquote>}
      {item.quote && <p className="pv__meta">Short excerpt from {item.title}{item.author ? `, ${item.author}` : ''} · {hostOf(item.url)}</p>}

      {item.text && (
        <div className="pv__text prose">
          {item.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}

      {item.kind === 'score' && !item.quote && !(ctx && ctx.sentences.length > 0) && (
        <p className="pv__empty">rune has no text from this review stored, only the score. Open original to read it on {hostOf(item.url)}.</p>
      )}

      {ctx && ctx.sentences.length > 0 && (
        <section className="pv__ctx" aria-label="In the Wikipedia reception">
          <h3 className="eyebrow">Mentioned in the {ctx.source} reception</h3>
          {ctx.sentences.map((t, i) => (
            <p key={i} className="pv__ctxp">
              {highlightSegments(t, ctx.terms).map((seg, k) => seg.hit ? <mark key={k}>{seg.text}</mark> : <span key={k}>{seg.text}</span>)}
            </p>
          ))}
        </section>
      )}
    </div>
      <footer className="pv__foot">
        {attr && <Attribution source={attr.source} url={attr.url} />}
        <div className="pv__actions">
          <button className="btn btn--primary" onClick={onOpenOriginal}>Open original</button>
          <span className="pv__host">{hostOf(item.url)}</span>
        </div>
      </footer>
    </>
  );
}

function Attribution({ source, url }: { source: string; url: string }) {
  const wiki = /wikipedia/i.test(source);
  return (
    <p className="pv__attr">
      {wiki ? 'Text from ' : 'From '}
      <a href={url} target="_blank" rel="noopener noreferrer" className="link">{source}<span aria-hidden> ↗</span></a>
      {wiki ? <>, available under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer" className="link">CC BY-SA 4.0</a>.</> : '.'}
    </p>
  );
}

function Original({ item }: { item: PreviewItem }) {
  const check = useQuery({ queryKey: ['frame-ok', item.url], queryFn: () => browseApi.frameOk(item.url), staleTime: 10 * 60_000, retry: false });
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const embeddable = check.data === true;
  useEffect(() => {
    if (!embeddable) return;
    const t = window.setTimeout(() => setSlow(true), 9000);
    return () => window.clearTimeout(t);
  }, [embeddable]);

  const openBtn = (
    <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Open in browser ↗</a>
  );

  if (check.isLoading) {
    return (
      <div className="pv__state" role="status">
        <Loader2 size={22} className="spin" aria-hidden />
        <p>Checking whether {hostOf(item.url)} can be previewed…</p>
      </div>
    );
  }
  if (!embeddable) {
    return (
      <div className="pv__state pv__state--blocked">
        <ShieldOff size={26} aria-hidden />
        <h3>This site doesn’t allow previews</h3>
        <p>{hostOf(item.url)} can’t be shown inside rune.</p>
        <a className="btn btn--primary" href={item.url} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
      </div>
    );
  }
  return (
    <div className="pv__frame">
      <div className="pv__framebar">
        <span title={item.url}>{hostOf(item.url)}</span>
        <a className="link" href={item.url} target="_blank" rel="noopener noreferrer">Open in browser ↗</a>
      </div>
      <div className="pv__framewrap">
        {!loaded && (
          <div className="pv__state pv__state--over" role="status">
            <Loader2 size={22} className="spin" aria-hidden />
            <p>{slow ? 'Still loading — this site may be slow or blocking previews.' : 'Loading the original page…'}</p>
            {slow && openBtn}
          </div>
        )}
        <iframe
          title={`${item.title} — original page`}
          src={item.url}
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          loading="eager"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}
