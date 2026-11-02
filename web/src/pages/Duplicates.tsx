import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, Copy, EyeOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Cover } from '../components/Cover';
import { Empty, SectionHead } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { duplicateKindLabel, formatVersionDetail, type DuplicateAlbumVersion, type DuplicateGroup } from '../lib/discover';
import { plural } from '../lib/format';
import { useUi } from '../store/ui';

export default function Duplicates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['duplicates'], queryFn: () => discoverApi.duplicates() });
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['duplicates'] }); };

  const hideOthers = async (g: DuplicateGroup) => {
    const targets = g.albums.filter((v) => v.albumId !== g.bestAlbumId && !v.hidden);
    if (targets.length === 0) return;
    setBusy(g.id);
    try {
      await Promise.all(targets.map((v) => discoverApi.hideAlbum(v.albumId)));
      await refresh();
      toast(`Hid ${plural(targets.length, 'version')} of “${g.title}”`);
    } catch {
      toast('Could not hide those versions');
    } finally {
      setBusy(null);
    }
  };

  const keepAll = async (g: DuplicateGroup) => {
    const targets = g.albums.filter((v) => v.hidden);
    if (targets.length === 0) return;
    setBusy(g.id);
    try {
      await Promise.all(targets.map((v) => discoverApi.unhideAlbum(v.albumId)));
      await refresh();
      toast(`Kept ${plural(targets.length, 'version')} of “${g.title}”`);
    } catch {
      toast('Could not keep those versions');
    } finally {
      setBusy(null);
    }
  };

  const unhide = async (v: DuplicateAlbumVersion) => {
    setBusy(v.albumId);
    try {
      await discoverApi.unhideAlbum(v.albumId);
      await refresh();
      toast(`Unhid “${v.title}”`);
    } catch {
      toast('Could not unhide that album');
    } finally {
      setBusy(null);
    }
  };

  const d = q.data;
  const hidden = d ? d.groups.flatMap((g) => g.albums.filter((v) => v.hidden).map((v) => ({ group: g, version: v }))) : [];

  return (
    <div className="page page--dupes">
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Duplicates</h1>
          <p className="pagehead__sub">
            {!d ? ' ' : `${plural(d.groups.length, 'group')} · ${plural(d.albumsScanned, 'album')} scanned`}
          </p>
        </div>
        <div className="libhead__actions">
          <button className="btn btn--sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw size={15} className={q.isFetching ? 'spin' : undefined} /> Rescan
          </button>
        </div>
      </header>

      {q.isError ? (
        <Empty title="Could not check for duplicates" icon={<Copy size={28} />}>Is the rune server running?</Empty>
      ) : !d ? (
        <div className="dupegroup" aria-live="polite">
          <div className="skel skel--title shimmer" /><div className="skel skel--line shimmer" /><div className="skel skel--line shimmer" style={{ width: '70%' }} />
        </div>
      ) : (
        <>
          <p className="dupenote">
            These albums look like the same release stored more than once. rune compares folder names, tags and track lists;
            hiding a version keeps its files on disk but takes it out of the library views.
          </p>

          {d.groups.length === 0 ? (
            <Empty title="No duplicates found" icon={<Copy size={28} />}>
              Every album in your library looks distinct. Rescan after adding new folders.
            </Empty>
          ) : (
            d.groups.map((g) => {
              const hiddenInGroup = g.albums.filter((v) => v.hidden).length;
              const otherCount = g.albums.filter((v) => v.albumId !== g.bestAlbumId && !v.hidden).length;
              return (
                <article key={g.id} className="dupegroup">
                  <header className="dupegroup__head">
                    <div className="dupegroup__ident">
                      <h2 className="dupegroup__title">{g.title}</h2>
                      <p className="dupegroup__artist">{g.artist}</p>
                    </div>
                    <span className="chip">{duplicateKindLabel(g.kind)}</span>
                  </header>
                  <p className="dupegroup__reason"><BadgeCheck size={16} /> <span>{g.reason}</span></p>

                  <div className="dupeversions">
                    {g.albums.map((v) => {
                      const best = v.albumId === g.bestAlbumId;
                      return (
                        <div key={v.albumId} className={`dupever${best ? ' is-best' : ''}${v.hidden ? ' is-hidden' : ''}`}>
                          <div className="dupever__art"><Cover album={{ id: v.albumId, title: v.title }} sizes="52px" /></div>
                          <div className="dupever__main">
                            <span className="dupever__name">{v.title}</span>
                            <span className="dupever__line">{[v.year ? String(v.year) : null, formatVersionDetail(v)].filter(Boolean).join(' · ')}</span>
                            {v.folderName ? <span className="dupever__folder" title={v.folderPath}>{v.folderName}</span> : null}
                            <span className="dupever__badges">
                              {best ? <span className="badge badge--best"><BadgeCheck size={11} /> Recommended</span> : null}
                              {v.hidden ? <span className="badge"><EyeOff size={11} /> Hidden</span> : null}
                              {v.matched && v.matchConfidence != null ? <span className="badge">Matched {Math.round(v.matchConfidence * 100)}%</span> : null}
                              {!v.hasCover ? <span className="badge">No cover</span> : null}
                            </span>
                          </div>
                          <div className="dupever__state">
                            {best ? <span className="dupever__best">Best pick</span> : v.hidden ? (
                              <button className="btn btn--sm" disabled={busy === v.albumId} onClick={() => void unhide(v)}>Unhide</button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <footer className="dupegroup__foot">
                    <button className="btn btn--sm" disabled={hiddenInGroup === 0 || busy === g.id} onClick={() => void keepAll(g)}>
                      <Check size={15} /> Keep all
                    </button>
                    <button className="btn btn--sm btn--primary" disabled={otherCount === 0 || busy === g.id} onClick={() => void hideOthers(g)}>
                      <EyeOff size={15} /> Hide the others{otherCount > 0 ? ` (${otherCount})` : ''}
                    </button>
                  </footer>
                </article>
              );
            })
          )}

          {hidden.length > 0 && (
            <section className="section hiddensec">
              <SectionHead title="Hidden albums" action={<span className="sechead__count"><EyeOff size={14} /> {hidden.length}</span>} />
              <p className="secnote">Hidden versions stay on disk but are left out of the album grid. Bring one back at any time.</p>
              <div className="hiddenlist">
                {hidden.map(({ group, version }) => (
                  <div key={version.albumId} className="hiddenrow">
                    <div className="hiddenrow__art"><Cover album={{ id: version.albumId, title: version.title }} sizes="44px" /></div>
                    <div className="hiddenrow__txt">
                      <span className="hiddenrow__name">{version.title}</span>
                      <span className="hiddenrow__sub">{group.title} · {formatVersionDetail(version)}</span>
                    </div>
                    <button className="btn btn--sm" disabled={busy === version.albumId} onClick={() => void unhide(version)}>Unhide</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
