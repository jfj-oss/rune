import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ChevronUp, Copy, Folder, FolderPlus, Loader2, Music2, Smartphone, X } from 'lucide-react';
import { ApiError } from '../api';
import { setupApi } from '../setupApi';
import { needsRestart, redirectUris, tailscaleServeCommand, validClientId, type SetupStatus } from '../lib/setup';

const msg = (e: unknown): string => (e instanceof ApiError ? e.serverMessage ?? e.message : e instanceof Error ? e.message : String(e));

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="setup__copy">
      <code className="mono">{text}</code>
      <button type="button" className="btn btn--sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => undefined); }}>
        {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** A small folder browser: walk the PC's folders and add one. rune only ever reads them. */
function FolderPicker({ start, onPick }: { start: string; onPick: (path: string) => void }) {
  const [at, setAt] = useState<string | undefined>(start || undefined);
  const q = useQuery({ queryKey: ['setup-dirs', at], queryFn: () => setupApi.dirs(at), retry: false });
  const d = q.data;
  return (
    <div className="setup__picker">
      <div className="setup__pickhead">
        <button type="button" className="btn btn--sm" disabled={!d?.parent} onClick={() => d?.parent && setAt(d.parent)} aria-label="Up one folder"><ChevronUp size={14} /> Up</button>
        <span className="mono setup__pickpath">{d?.path ?? at ?? '…'}</span>
        <button type="button" className="btn btn--sm btn--primary" disabled={!d} onClick={() => d && onPick(d.path)}><FolderPlus size={14} /> Use this folder</button>
      </div>
      {q.isError && <p className="status--bad setup__note">{msg(q.error)}</p>}
      <ul className="setup__dirs">
        {d?.dirs.length === 0 && <li className="muted">No subfolders here.</li>}
        {d?.dirs.map((name) => (
          <li key={name}><button type="button" className="setup__dir" onClick={() => setAt(`${d.path === '/' ? '' : d.path}/${name}`)}><Folder size={14} /> {name}</button></li>
        ))}
      </ul>
    </div>
  );
}

function MusicStep({ s, onSaved }: { s: SetupStatus; onSaved: () => void }) {
  const [roots, setRoots] = useState<string[]>(s.libraryRoots);
  const [typed, setTyped] = useState('');
  const [browse, setBrowse] = useState(false);
  const save = useMutation({ mutationFn: (list: string[]) => setupApi.saveConfig({ libraryRoots: list }), onSuccess: onSaved });
  const add = (p: string) => { const t = p.trim(); if (t && !roots.includes(t)) setRoots([...roots, t]); setTyped(''); setBrowse(false); };
  return (
    <section className="statuscard setup__card" id="music">
      <h2 className="statuscard__head"><Music2 size={17} /> 1 · Music folders</h2>
      <p className="muted">Pick the folder (or folders) that hold your music files. rune only ever <b>reads</b> them: it never moves, renames or edits a file.</p>
      <ul className="setup__roots">
        {roots.length === 0 && <li className="muted">No folder yet.</li>}
        {roots.map((r) => (
          <li key={r}><span className="mono">{r}</span><button type="button" className="btn-icon" aria-label={`Remove ${r}`} onClick={() => setRoots(roots.filter((x) => x !== r))}><X size={14} /></button></li>
        ))}
      </ul>
      <form className="setup__row" onSubmit={(e) => { e.preventDefault(); add(typed); }}>
        <input className="setup__input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`${s.home}/Music`} aria-label="Music folder path" spellCheck={false} />
        <button type="submit" className="btn" disabled={!typed.trim()}>Add</button>
        <button type="button" className="btn" onClick={() => setBrowse(!browse)}><Folder size={15} /> {browse ? 'Close' : 'Browse…'}</button>
      </form>
      {browse && <FolderPicker start={s.home} onPick={add} />}
      <div className="setup__actions">
        <button type="button" className="btn btn--primary" disabled={roots.length === 0 || save.isPending} onClick={() => save.mutate(roots)}>
          {save.isPending ? <Loader2 size={15} className="spin" /> : null} Save music folders
        </button>
        {save.isSuccess && !save.isPending && <span className="status--ok">Saved{s.canRestart ? ': press “Apply and restart” below to scan' : ''}</span>}
        {save.isError && <span className="status--bad">{msg(save.error)}</span>}
      </div>
    </section>
  );
}

function SpotifyStep({ s, onSaved }: { s: SetupStatus; onSaved: () => void }) {
  const [id, setId] = useState(s.spotifyClientId);
  const save = useMutation({ mutationFn: () => setupApi.saveConfig({ spotifyClientId: id.trim() }), onSuccess: onSaved });
  const uris = redirectUris(s);
  return (
    <section className="statuscard setup__card" id="spotify">
      <h2 className="statuscard__head"><Music2 size={17} /> 2 · Spotify <span className="setup__opt">optional</span></h2>
      <p className="muted">Skip this and rune is a fully working local player. To also play Spotify, you make your own free Spotify “app”: it is only a key for your own account, so nothing is shared with anyone. Needs Spotify Premium to play.</p>
      <ol className="setup__steps">
        <li>Open the <a className="link link--strong" href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify developer dashboard</a>, log in and press <b>Create app</b>. Any name and description will do.</li>
        <li>
          Under <b>Redirect URIs</b>, paste {uris.length > 1 ? 'these (one each)' : 'this exactly'}, then press Add:
          {uris.map((u) => <CopyLine key={u} text={u} />)}
          <span className="muted">Spotify only accepts <span className="mono">127.0.0.1</span> over plain http, so the Connect button below must be pressed in a browser on this PC.</span>
        </li>
        <li>Under <b>Which API/SDKs are you planning to use?</b> tick <b>Web API</b> and <b>Web Playback SDK</b>. Accept the terms and Save.</li>
        <li>Open the app’s <b>Settings</b> and copy the <b>Client ID</b> (there is no secret to copy) into the box below.</li>
      </ol>
      <p className="muted setup__note">A new app is in <b>development mode</b>. That works for you as its owner with no allowlist; you only need <b>User Management</b> to let other people log in with it.</p>
      <form className="setup__row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <input className="setup__input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID (32 letters and digits)" aria-label="Spotify client ID" spellCheck={false} autoComplete="off" />
        <button type="submit" className="btn btn--primary" disabled={save.isPending || (id.trim() !== '' && !validClientId(id))}>Save client ID</button>
      </form>
      {save.isError && <p className="status--bad setup__note">{msg(save.error)}</p>}
      <div className="setup__actions">
        {s.spotifyActive && !s.spotifyPending ? (
          <a className="btn btn--primary" href="/api/spotify/login">Connect Spotify</a>
        ) : (
          <button type="button" className="btn" disabled>Connect Spotify</button>
        )}
        <span className="muted">{s.spotifyActive && !s.spotifyPending ? 'Opens Spotify’s login; you return here when it is done.' : s.spotifyPending || save.isSuccess ? 'Press “Apply and restart” below first.' : 'Save your client ID first.'}</span>
      </div>
    </section>
  );
}

function SoloistStep({ s, onKey }: { s: SetupStatus; onKey: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const saveKey = useMutation({ mutationFn: () => setupApi.saveKey(key.trim()), onSuccess: () => { setKey(''); onKey(); void qc.invalidateQueries({ queryKey: ['setup'] }); } });
  const pair = useQuery({ queryKey: ['setup-pair'], queryFn: () => setupApi.pairState(), refetchInterval: (q) => (q.state.data?.running ? 1500 : false) });
  const start = useMutation({ mutationFn: () => setupApi.pair(), onSuccess: (st) => qc.setQueryData(['setup-pair'], st) });
  const p = pair.data;
  const so = s.soloist;
  return (
    <section className="statuscard setup__card" id="soloist">
      <h2 className="statuscard__head"><Music2 size={17} /> 3 · Soloist <span className="setup__opt">optional · Linux · needs Premium</span></h2>
      <p className="muted"><a className="link link--strong" href="https://developer.spotify.com/documentation/soloist" target="_blank" rel="noreferrer">Spotify Soloist</a> is Spotify’s own small, headless player. With it rune plays Spotify on this PC <b>without the Spotify app</b>, with no Web API traffic, and can stream it to your phone. You download it yourself from Spotify; rune never bundles it.</p>
      <ol className="setup__steps">
        <li>Download the official Linux build from <a className="link link--strong" href="https://developer.spotify.com/documentation/soloist" target="_blank" rel="noreferrer">developer.spotify.com/documentation/soloist</a> and put it at <span className="mono">{so.binary}</span>, then make it executable (<span className="mono">chmod +x</span>).
          <span className={so.binaryInstalled ? 'status--ok' : 'status--warn'}> {so.binaryInstalled ? 'Found.' : 'Not found yet.'}</span></li>
        <li>On the same page create a Soloist <b>API key</b> and paste it here. rune saves it to <span className="mono">{so.keyFile}</span> (readable only by you) and never shows it again.
          <span className={so.keySaved ? 'status--ok' : 'status--warn'}> {so.keySaved ? 'A key is saved.' : 'No key yet.'}</span></li>
      </ol>
      <form className="setup__row" onSubmit={(e) => { e.preventDefault(); saveKey.mutate(); }} autoComplete="off">
        <input className="setup__input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={so.keySaved ? 'Paste a new key to replace the saved one' : 'Soloist API key'} aria-label="Soloist API key" autoComplete="off" spellCheck={false} />
        <button type="submit" className="btn btn--primary" disabled={!key.trim() || saveKey.isPending}>Save key</button>
      </form>
      {saveKey.isError && <p className="status--bad setup__note">{msg(saveKey.error)}</p>}
      {saveKey.isSuccess && <p className="status--ok setup__note">Key saved.</p>}
      <p className="muted setup__note">Then <b>pair</b> it with your Spotify account once: press Pair, and follow the instructions it prints below.</p>
      <div className="setup__actions">
        <button type="button" className="btn" disabled={!so.binaryInstalled || !so.keySaved || p?.running || start.isPending} onClick={() => start.mutate()}>
          {p?.running ? <Loader2 size={15} className="spin" /> : null} {p?.running ? 'Pairing…' : 'Pair Soloist'}
        </button>
        {start.isError && <span className="status--bad">{msg(start.error)}</span>}
        {p && !p.running && p.exitCode === 0 && <span className="status--ok">Paired. Apply and restart below.</span>}
        {p && !p.running && p.exitCode !== null && p.exitCode !== 0 && <span className="status--bad">Pairing ended with an error (code {p.exitCode}).</span>}
      </div>
      {p?.output ? <pre className="setup__pre mono" aria-label="Pairing output">{p.output}</pre> : null}
      <p className="muted setup__note">Soloist builds expire after 90 days. When rune says so, download the current build and replace the file.</p>
    </section>
  );
}

function PhoneStep({ s, onSaved }: { s: SetupStatus; onSaved: () => void }) {
  const [url, setUrl] = useState(s.publicUrl);
  const save = useMutation({ mutationFn: () => setupApi.saveConfig({ publicUrl: url.trim() }), onSuccess: onSaved });
  return (
    <section className="statuscard setup__card" id="phone">
      <h2 className="statuscard__head"><Smartphone size={17} /> 4 · Phone access <span className="setup__opt">optional</span></h2>
      <p className="muted">rune only listens on this PC by default. To use it from your phone away from home, install <a className="link link--strong" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> on the PC and the phone (same account), then serve rune over HTTPS inside your private tailnet:</p>
      <CopyLine text={tailscaleServeCommand(s.port)} />
      <p className="muted setup__note">Tailscale prints the address, which looks like <span className="mono">https://&lt;pc-name&gt;.&lt;your-tailnet&gt;.ts.net:8445</span>. Open it on the phone. Paste it here too, so a Spotify login started from the phone comes back to the right place (and add its <span className="mono">/api/spotify/callback</span> address as a second Redirect URI in step 2).</p>
      <form className="setup__row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <input className="setup__input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://<pc-name>.<your-tailnet>.ts.net:8445" aria-label="Phone address" spellCheck={false} />
        <button type="submit" className="btn" disabled={save.isPending}>Save address</button>
      </form>
      {save.isError && <p className="status--bad setup__note">{msg(save.error)}</p>}
      {save.isSuccess && <p className="status--ok setup__note">Saved.</p>}
      <p className="muted setup__note">Only people on your tailnet can reach it. There is more in <span className="mono">docs/IOS.md</span> if you want rune as an iPhone app.</p>
    </section>
  );
}

/** Apply: restart rune so folders, the Spotify app id and the Soloist key take effect, then wait for it to come back. */
function ApplyBar({ s, keySaved }: { s: SetupStatus; keySaved: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'manual'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const pending = needsRestart(s, keySaved);
  const apply = async () => {
    try {
      const r = await setupApi.restart();
      if (!r.restarting) { setPhase('manual'); return; }
    } catch { /* the server may drop the connection as it restarts */ }
    setPhase('restarting');
    const started = Date.now();
    const poll = async () => {
      try {
        const st = await setupApi.status();
        if (Date.now() - started > 2500) {
          await qc.invalidateQueries({ queryKey: ['setup'] });
          setPhase('idle');
          if (!st.needsSetup) nav('/');
          return;
        }
      } catch { /* still down */ }
      if (Date.now() - started < 60_000) timer.current = window.setTimeout(() => void poll(), 1000);
      else setPhase('manual');
    };
    timer.current = window.setTimeout(() => void poll(), 1200);
  };
  if (!pending && phase === 'idle') return null;
  return (
    <section className="statuscard setup__card setup__apply">
      {phase === 'manual' ? (
        <p>Saved. rune is not running under a service that can restart it, so stop it and start it again yourself. After that it scans your music.</p>
      ) : (
        <>
          <p>{phase === 'restarting' ? 'Restarting rune…' : 'You changed settings. rune restarts to use them, then scans your music (a big library takes a while).'}</p>
          <button type="button" className="btn btn--primary" disabled={phase === 'restarting'} onClick={() => void apply()}>
            {phase === 'restarting' ? <Loader2 size={15} className="spin" /> : null} Apply and restart
          </button>
        </>
      )}
    </section>
  );
}

export default function Setup() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup'], queryFn: () => setupApi.status(), staleTime: 0, retry: 1 });
  const [keySaved, setKeySaved] = useState(false);
  const s = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['setup'] });
  return (
    <div className="page page--settings page--setup">
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">{s?.needsSetup ? 'Welcome to rune' : 'Set up rune'}</h1>
          <p className="pagehead__sub">{s?.needsSetup ? 'Pick your music and you are ready. Everything else is optional.' : 'Music folders, Spotify, Soloist and phone access'}</p>
        </div>
        {!s?.needsSetup && <div className="libhead__actions"><Link className="btn btn--sm" to="/settings">Back to settings</Link></div>}
      </header>
      {q.isError ? <p className="status--bad">Could not reach the rune server.</p> : !s ? <p className="muted">Loading…</p> : (
        <div className="setup">
          <MusicStep key={s.libraryRoots.join('|')} s={s} onSaved={refresh} />
          <ApplyBar s={s} keySaved={keySaved} />
          <SpotifyStep s={s} onSaved={refresh} />
          <SoloistStep s={s} onKey={() => setKeySaved(true)} />
          <PhoneStep s={s} onSaved={refresh} />
          <p className="muted setup__foot">Settings are saved in <span className="mono">{s.configFile}</span>. You can come back to this page any time from Settings.</p>
        </div>
      )}
    </div>
  );
}
