import { create } from 'zustand';
import { ApiError, api } from '../api';
import type { UpdateStatus } from '../lib/types';

/** Idle polling: the server checks origin at most this often anyway, so there is no point asking faster. */
export const UPDATE_POLL_MS = 15 * 60_000;
/** While an install runs the status is read every second to show the step (cheap: no git fetch, no Spotify). */
const BUSY_POLL_MS = 1000;
/** A page focus / visibility change re-reads the status, but never more often than this. */
const FOCUS_MIN_GAP_MS = 60_000;

interface UpdaterStore {
  status: UpdateStatus | null;
  /** The install request is in flight. */
  running: boolean;
  /** The server said it is restarting; reload as soon as it is back. */
  waiting: boolean;
  error: string | null;
  /** `force` makes the server fetch origin now (Settings "Check for updates"). */
  check(force?: boolean): Promise<UpdateStatus | null>;
  install(): Promise<void>;
  /** Start polling (ref-counted: the chip and the Settings card share one loop). Returns a stop function. */
  watch(): () => void;
}

let sawOffline = false;
let watchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastCheckAt = 0;
let onFocus: (() => void) | undefined;

export const useUpdater = create<UpdaterStore>((set, get) => {
  const busy = () => {
    const s = get();
    return s.running || s.waiting || s.status?.stage != null;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (watchers === 0) return;
    timer = setTimeout(async () => {
      await get().check();
      schedule();
    }, busy() ? BUSY_POLL_MS : UPDATE_POLL_MS);
  };

  return {
    status: null,
    running: false,
    waiting: false,
    error: null,

    async check(force = false) {
      lastCheckAt = Date.now();
      try {
        const s = await api.updateStatus(force);
        set({ status: s, error: get().running ? null : get().error });
        // After a systemd restart the server is briefly unreachable; reload once it is back.
        if (get().waiting && sawOffline) window.location.reload();
        return s;
      } catch {
        sawOffline = true;
        return null;
      }
    },

    async install() {
      set({ running: true, error: null });
      schedule();
      try {
        const res = await api.updateInstall();
        if (res.ok && res.stage === 'restarting') {
          sawOffline = false;
          set({ waiting: true, running: false });
        } else {
          set({ running: false, error: res.ok ? null : res.error });
          await get().check();
        }
      } catch (e) {
        if (e instanceof ApiError) {
          set({ running: false, error: e.serverMessage ?? e.message });
          void get().check();
        } else {
          // The server may drop the connection as it restarts: wait for it to come back.
          sawOffline = true;
          set({ waiting: true, running: false });
        }
      }
      schedule();
    },

    watch() {
      watchers++;
      if (watchers === 1) {
        void get().check().then(schedule);
        onFocus = () => {
          if (document.visibilityState === 'hidden') return;
          if (Date.now() - lastCheckAt < FOCUS_MIN_GAP_MS) return;
          void get().check().then(schedule);
        };
        document.addEventListener('visibilitychange', onFocus);
        window.addEventListener('focus', onFocus);
      } else if (!get().status) {
        void get().check().then(schedule);
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        watchers--;
        if (watchers === 0) {
          if (timer) clearTimeout(timer);
          if (onFocus) {
            document.removeEventListener('visibilitychange', onFocus);
            window.removeEventListener('focus', onFocus);
          }
        }
      };
    },
  };
});
