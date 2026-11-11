import { create } from 'zustand';
import { api } from '../api';
import { clientLog } from '../clientLog';
import { usePlayer } from './player';
import { useUi } from './ui';

/** The Soloist zone's live stream, played by this phone (native HLS: it keeps going on the lock screen). */
export const PHONE_STREAM_URL = '/api/soloist/stream/live.m3u8';

interface PhoneStreamStore {
  /** This page plays the Soloist stream. */
  listening: boolean;
  /** Start from a tap: switches Soloist's sound to the phone and plays the stream in one <audio> element. */
  start(): Promise<void>;
  /** Stop here and send Soloist's sound back to the PC speakers. */
  stop(): Promise<void>;
}

let el: HTMLAudioElement | null = null;
let lastRev: number | undefined;
let subscribed = false;

/** One element for the whole session (iOS unlocks an element on the first tap and keeps it unlocked). */
function element(): HTMLAudioElement {
  if (el) return el;
  el = new Audio();
  el.preload = 'auto';
  el.addEventListener('error', () => {
    if (!usePhoneStream.getState().listening) return;
    // A program that ended (a skip or seek): the player reloads the same URL and lands on the new one.
    setTimeout(() => reload(), 400);
  });
  el.addEventListener('stalled', () => { if (usePhoneStream.getState().listening) setTimeout(() => reload(), 800); });
  return el;
}

function reload(): void {
  const a = element();
  if (!usePhoneStream.getState().listening) return;
  a.src = `${PHONE_STREAM_URL}?t=${Date.now()}`;
  a.load();
  void a.play().catch((err: unknown) => clientLog('warn', 'phone stream: play refused', { err: String(err) }));
}

/** The zone bumps `rev` on every new program (play, skip, seek): that is the cue to join it. */
function watchZone(): void {
  if (subscribed) return;
  subscribed = true;
  usePlayer.subscribe((s) => {
    const st = usePhoneStream.getState();
    if (!st.listening) return;
    if (s.zone !== 'soloist') { void st.stop(); return; }
    const rev = s.state.rev;
    if (rev !== undefined && rev !== lastRev) {
      lastRev = rev;
      if (s.state.status === 'playing' || s.state.status === 'loading') reload();
    }
    const a = element();
    if (s.state.status === 'paused' && !a.paused) a.pause();
    else if (s.state.status === 'playing' && a.paused && a.src) void a.play().catch(() => undefined);
  });
}

export const usePhoneStream = create<PhoneStreamStore>((set, get) => ({
  listening: false,
  async start() {
    const a = element();
    // Inside the tap: a silent play() unlocks the element even before the stream URL is known to work.
    try { const p = a.play(); a.pause(); void p?.catch(() => undefined); } catch { /* not allowed here */ }
    set({ listening: true });
    watchZone();
    try {
      const r = await api.soloistOutput('phone');
      if (r.problem) useUi.getState().toast(r.problem);
    } catch {
      useUi.getState().toast('Could not switch Soloist to this phone — is the server reachable?');
      set({ listening: false });
      return;
    }
    lastRev = usePlayer.getState().state.rev;
    const s = usePlayer.getState().state;
    if (s.zone === 'soloist' && (s.status === 'playing' || s.status === 'loading')) reload();
  },
  async stop() {
    if (!get().listening) return;
    set({ listening: false });
    const a = element();
    a.pause();
    a.removeAttribute('src');
    a.load();
    await api.soloistOutput('pc').catch(() => undefined);
  },
}));
