/** Per-websocket visibility: a hidden tab (background, another Space) is not watching. */
export interface ClientPresence {
  /** A new client defaults to visible until it says otherwise (older clients never say). */
  add(client: object): void;
  remove(client: object): void;
  /** Returns true when the client went from hidden to visible (the caller wakes the zones). */
  setVisible(client: object, visible: boolean): boolean;
  /** Some connected client is visible. */
  hasVisible(): boolean;
}

export function createClientPresence(): ClientPresence {
  const visible = new Map<object, boolean>();
  return {
    add(client) {
      visible.set(client, true);
    },
    remove(client) {
      visible.delete(client);
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
  };
}
