import { describe, expect, it } from 'vitest';
import { createClientPresence } from '../src/api/presence.js';

describe('client presence', () => {
  it('treats a new client as visible until it says otherwise (older clients never say)', () => {
    const presence = createClientPresence();
    const client = {};
    presence.add(client);
    expect(presence.hasVisible()).toBe(true);
  });

  it('a hidden client does not count as watching', () => {
    const presence = createClientPresence();
    const client = {};
    presence.add(client);
    expect(presence.setVisible(client, false)).toBe(false);
    expect(presence.hasVisible()).toBe(false);
  });

  it('counts any visible client and forgets closed ones', () => {
    const presence = createClientPresence();
    const hidden = {};
    const shown = {};
    presence.add(hidden);
    presence.add(shown);
    presence.setVisible(hidden, false);
    expect(presence.hasVisible()).toBe(true); // the second tab is still shown
    presence.remove(shown);
    expect(presence.hasVisible()).toBe(false);
    presence.remove(hidden);
    expect(presence.hasVisible()).toBe(false);
  });

  it('signals hidden → visible exactly once (the server wakes the zones on that signal)', () => {
    const presence = createClientPresence();
    const client = {};
    presence.add(client);
    presence.setVisible(client, false);
    expect(presence.setVisible(client, true)).toBe(true); // wake
    expect(presence.setVisible(client, true)).toBe(false); // already visible: no extra wake
    expect(presence.hasVisible()).toBe(true);
  });

  it('views: a client that never says views every zone; one that says views only those, while visible', () => {
    const presence = createClientPresence();
    const old = {};
    const tab = {};
    presence.add(old);
    expect(presence.viewing('spotify:a')).toBe(true);
    presence.remove(old);
    presence.add(tab);
    expect(presence.setViewing(tab, ['pc', 'spotify:a'])).toEqual([]); // it viewed everything before
    expect(presence.viewing('spotify:a')).toBe(true);
    expect(presence.viewing('spotify:b')).toBe(false);
    expect(presence.setViewing(tab, ['spotify:b'])).toEqual(['spotify:b']); // newly viewed: wake it
    expect(presence.viewing('spotify:a')).toBe(false);
    presence.setVisible(tab, false);
    expect(presence.viewing('spotify:b')).toBe(false);
    presence.remove(tab);
    expect(presence.viewing('spotify:b')).toBe(false);
  });
});
