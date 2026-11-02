import { ListMusic, Lock, Plus, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlaylistActions } from '../hooks/usePlaylistEdit';
import { encId, plural } from '../lib/format';
import type { PlayItem } from '../lib/types';
import { playlistApi } from '../playlistApi';
import { usePlaylistUi, type NewPlaylistRequest, type PickerRequest } from '../store/playlistUi';
import { useAddablePlaylists } from './AddToPlaylist';
import { Dialog } from './Dialog';
import { PlaylistCover } from './PlaylistCover';
import { FIELDS, SORTS, blankRule, ruleToSpec, specComplete, type RuleDraft } from '../lib/smartRules';
import { isRunePlaylist, type SmartField } from '../lib/playlists';

// ------------------------------------------------------------------ new playlist
function NewPlaylistDialog({ req }: { req: NewPlaylistRequest }) {
  const close = usePlaylistUi((s) => s.closeNew);
  const openSmart = usePlaylistUi((s) => s.openSmart);
  const actions = usePlaylistActions();
  const nav = useNavigate();
  const [name, setName] = useState(req.name ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    let items: PlayItem[] | undefined;
    try { items = req.resolve ? await req.resolve() : undefined; } catch { items = undefined; }
    const d = await actions.create(n, { description: description.trim() || undefined, items });
    setBusy(false);
    if (!d) return;
    close();
    if (!req.resolve) nav(`/playlist/${encId(d.id)}`);
  };

  return (
    <Dialog
      title="New playlist"
      onClose={close}
      className="dialog--sheet dialog--form"
      footer={(
        <>
          <button className="btn btn--ghost" type="button" onClick={close}>Cancel</button>
          <button className="btn btn--primary" type="submit" form="newpl" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create'}</button>
        </>
      )}
    >
      <form id="newpl" onSubmit={submit} className="form">
        {req.what && <p className="form__lead">Starts with <b>{req.what}</b>.</p>}
        <label className="field">
          <span className="field__label">Name</span>
          <input ref={input} className="field__input" value={name} maxLength={200} placeholder="My playlist" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Description <i>optional</i></span>
          <textarea className="field__input field__input--area" rows={2} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="form__hint">Mix local files and Spotify tracks freely — it all plays from one queue.</p>
        {!req.resolve && (
          <button type="button" className="linkbtn" onClick={() => { close(); openSmart(); }}><Sparkles size={14} /> Make a smart playlist from rules instead</button>
        )}
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ picker (also the mobile "Add to playlist" sheet)
function PlaylistPicker({ req }: { req: PickerRequest }) {
  const close = usePlaylistUi((s) => s.closePicker);
  const openNew = usePlaylistUi((s) => s.openNew);
  const { list, loading } = useAddablePlaylists();
  const actions = usePlaylistActions();
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => list.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())), [list, filter]);

  const pick = async (id: string, name: string) => {
    close();
    try { await actions.addItems(id, name, await req.resolve()); } catch { /* resolve failed */ }
  };

  return (
    <Dialog title={req.title} onClose={close} className="dialog--sheet dialog--picker">
      <p className="form__lead"><b>{req.what}</b></p>
      <button className="sheet__opt sheet__opt--new" onClick={() => { close(); openNew({ name: req.newName, resolve: req.resolve, what: req.what }); }}>
        <Plus size={20} />
        <span className="sheet__txt"><b>New playlist…</b><small>Create it and add these tracks</small></span>
      </button>
      {list.length > 6 && (
        <label className="filterbox picker__filter">
          <Search size={15} />
          <input type="search" value={filter} placeholder="Find a playlist" onChange={(e) => setFilter(e.target.value)} />
          {filter && <button type="button" className="btn-icon" aria-label="Clear" onClick={() => setFilter('')}><X size={14} /></button>}
        </label>
      )}
      <div className="sheet__list picker__list" role="menu">
        {loading && <p className="sheet__note">Loading…</p>}
        {shown.map((p) => (
          <button key={p.id} className="sheet__opt" role="menuitem" onClick={() => void pick(p.id, p.name)}>
            <span className="picker__cover"><PlaylistCover id={p.id} name={p.name} albumIds={p.coverAlbumIds} iconSize={18} /></span>
            <span className="sheet__txt"><b>{p.name}</b><small>{plural(p.trackCount, 'track')}{!isRunePlaylist(p.id) ? ' · Spotify' : ''}</small></span>
          </button>
        ))}
        {!loading && list.length === 0 && <p className="sheet__note">You don’t have any playlists yet — create the first one above.</p>}
        {!loading && list.length > 0 && shown.length === 0 && <p className="sheet__note">No playlist called “{filter}”.</p>}
      </div>
      <p className="sheet__note sheet__note--dim"><Lock size={11} /> Spotify playlists take local files only — Spotify songs can’t be added to them yet.</p>
    </Dialog>
  );
}

// ------------------------------------------------------------------ smart playlist rule builder
function SmartPlaylistDialog() {
  const close = usePlaylistUi((s) => s.closeSmart);
  const actions = usePlaylistActions();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [rules, setRules] = useState<RuleDraft[]>([blankRule('genre')]);
  const [sortField, setSortField] = useState('artist');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'ok' | 'unavailable' | 'error'; count?: number; sample?: string[] }>({ state: 'idle' });

  const lim = limit.trim() === '' ? undefined : Math.max(1, Math.min(10_000, Math.round(Number(limit)) || 0)) || undefined;
  const spec = useMemo(() => ({ rules: rules.map(ruleToSpec), match, sort: `${sortField}:${sortDir}`, ...(lim ? { limit: lim } : {}) }), [rules, match, sortField, sortDir, lim]);
  const complete = specComplete(rules);
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    if (!complete) { setPreview({ state: 'idle' }); return; }
    setPreview((p) => ({ ...p, state: 'loading' }));
    let live = true;
    const t = setTimeout(() => {
      playlistApi.previewSmart(JSON.parse(specKey)).then(
        (r) => { if (live) setPreview(r ? { state: 'ok', count: r.count, sample: r.sample } : { state: 'unavailable' }); },
        () => { if (live) setPreview({ state: 'error' }); },
      );
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [specKey, complete]);

  const update = (i: number, patch: Partial<RuleDraft>) => setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !complete || busy) return;
    setBusy(true);
    const d = await actions.createSmart({ name: name.trim(), ...spec });
    setBusy(false);
    if (d) { close(); nav(`/playlist/${encId(d.id)}`); }
  };

  return (
    <Dialog
      title="New smart playlist"
      onClose={close}
      className="dialog--form dialog--smart"
      footer={(
        <>
          <span className="smart__count" aria-live="polite">
            {preview.state === 'ok' && <><b>{preview.count}</b> {preview.count === 1 ? 'track matches' : 'tracks match'} right now</>}
            {preview.state === 'loading' && 'Counting…'}
            {preview.state === 'unavailable' && 'It fills itself from your library once created'}
            {preview.state === 'error' && 'Could not count matches'}
            {preview.state === 'idle' && (complete ? '' : 'Fill in every rule to see how many tracks match')}
          </span>
          <button className="btn btn--ghost" type="button" onClick={close}>Cancel</button>
          <button className="btn btn--primary" type="submit" form="smartpl" disabled={!name.trim() || !complete || busy}>{busy ? 'Creating…' : 'Create'}</button>
        </>
      )}
    >
      <form id="smartpl" onSubmit={create} className="form">
        <label className="field">
          <span className="field__label">Name</span>
          <input className="field__input" autoFocus value={name} maxLength={200} placeholder="Jazz I haven’t played lately" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="smart__match">
          <span>Include tracks that match</span>
          <select className="field__input field__input--sm" aria-label="Match mode" value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')}>
            <option value="all">all of these rules</option>
            <option value="any">any of these rules</option>
          </select>
        </div>

        <div className="rules">
          {rules.map((r, i) => {
            const f = FIELDS[r.field];
            const op = f.ops.find((o) => o.op === r.op) ?? f.ops[0]!;
            return (
              <div className="rule" key={i}>
                <select className="field__input field__input--sm" aria-label="Field" value={r.field} onChange={(e) => setRules((rs) => rs.map((x, k) => (k === i ? blankRule(e.target.value as SmartField) : x)))}>
                  {Object.entries(FIELDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <select className="field__input field__input--sm" aria-label="Operator" value={op.op} onChange={(e) => update(i, { op: e.target.value })}>
                  {f.ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                {!op.noValue && (
                  <div className="rule__values">
                    {f.kind === 'enum' ? (
                      <select className="field__input field__input--sm" aria-label="Value" value={r.a} onChange={(e) => update(i, { a: e.target.value })}>
                        {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input className="field__input field__input--sm" aria-label="Value" type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'} inputMode={f.kind === 'number' ? 'numeric' : undefined} placeholder={f.placeholder} value={r.a} onChange={(e) => update(i, { a: e.target.value })} />
                    )}
                    {op.op === 'between' && (
                      <>
                        <span className="rule__and">and</span>
                        <input className="field__input field__input--sm" aria-label="Upper value" type={f.kind === 'date' ? 'date' : 'number'} inputMode={f.kind === 'number' ? 'numeric' : undefined} value={r.b} onChange={(e) => update(i, { b: e.target.value })} />
                      </>
                    )}
                  </div>
                )}
                <button type="button" className="btn-icon rule__x" aria-label="Remove rule" disabled={rules.length === 1} onClick={() => setRules((rs) => rs.filter((_, k) => k !== i))}><X size={16} /></button>
              </div>
            );
          })}
          <button type="button" className="linkbtn" onClick={() => setRules((rs) => [...rs, blankRule('year')])}><Plus size={14} /> Add rule</button>
        </div>

        <div className="smart__row">
          <label className="field field--inline">
            <span className="field__label">Sort by</span>
            <select className="field__input field__input--sm" value={sortField} onChange={(e) => setSortField(e.target.value)}>
              {SORTS.map((s) => <option key={s.field} value={s.field}>{s.label}</option>)}
            </select>
          </label>
          <label className="field field--inline">
            <span className="field__label">Order</span>
            <select className="field__input field__input--sm" value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
              <option value="asc">A → Z / oldest first</option>
              <option value="desc">Z → A / newest first</option>
            </select>
          </label>
          <label className="field field--inline">
            <span className="field__label">Limit</span>
            <input className="field__input field__input--sm" type="number" min={1} inputMode="numeric" placeholder="no limit" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
        </div>
        {preview.state === 'ok' && preview.sample && preview.sample.length > 0 && (
          <p className="form__hint smart__sample"><ListMusic size={13} /> e.g. {preview.sample.join(' · ')}</p>
        )}
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ host
export function PlaylistDialogsHost() {
  const picker = usePlaylistUi((s) => s.picker);
  const newPlaylist = usePlaylistUi((s) => s.newPlaylist);
  const smart = usePlaylistUi((s) => s.smart);
  return (
    <>
      {picker && <PlaylistPicker req={picker} />}
      {newPlaylist && <NewPlaylistDialog req={newPlaylist} />}
      {smart && <SmartPlaylistDialog />}
    </>
  );
}
