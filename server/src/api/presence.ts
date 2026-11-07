/** Per-websocket visibility, and which zones each tab shows: a hidden tab (background, another Space) is not watching. */
export interface ClientPresence {
  /** A new client defaults to visible until it says otherwise (older clients never say). */
  add(client: object): void;
  remove(client: object): void;
  /** Returns true when the client went from hidden to visible (the caller wakes the zones). */
  setVisible(client: object, visible: boolean): boolean;
  /** Some connected client is visible. */
  hasVisible(): boolean;
  /**
   * The zones a tab shows or drives. A client that never says is taken to view every zone (older pages).
   * Returns the zones it views now and did not before (the caller wakes them).
   */
  setViewing(client: object, zones: string[]): string[];
  /** Some visible client views this zone. */
  viewing(zone: string): boolean;
}

/** At most this many zones per client are kept: a page shows one zone and drives one or two more. */
const MAX_VIEWED = 16;

export function createClientPresence(): ClientPresence {
  const visible = new Map<object, boolean>();
  /** Per client: the zones it said it views; absent = it never said (views everything). */
  const views = new Map<object, Set<string>>();
  return {
    add(client) {
      visible.set(client, true);
    },
    remove(client) {
      visible.delete(client);
      views.delete(client);
    },
    setVisible(client, next) {
      const before = visible.get(client) ?? true;
      visible.set(client, next);
      return next && !before;
    },
    hasVisible() {
      for (const v of visible.values()) if (v) return true;
      return false;
    },
    setViewing(client, zones) {
      const before = views.get(client);
      const now = new Set(zones.slice(0, MAX_VIEWED));
      views.set(client, now);
      // A client that never said viewed everything already.
      return before ? [...now].filter((z) => !before.has(z)) : [];
    },
    viewing(zone) {
      for (const [client, v] of visible) {
        if (!v) continue;
        const zones = views.get(client);
        if (!zones || zones.has(zone)) return true;
      }
      return false;
    },
  };
}
