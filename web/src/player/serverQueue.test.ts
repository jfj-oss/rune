import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { helloAction, holdNotice } from './serverQueue';
import { pcSpotifyFallbackNotice } from './pcStart';
import { mkItem, mkTrack } from './testkit';
import { emptyState } from './types';

describe('hello', () => {
  const tab = { build: 'b1', playingHere: false };
  it('a tab from the build the server serves is left alone', () => {
    expect(helloAction({ build: 'b1' }, tab)).toBe('none');
    expect(helloAction({ build: null }, tab)).toBe('none');
  });
  it('a tab from another build is told to reload (not in dev)', () => {
    expect(helloAction({ build: 'b2' }, tab)).toBe('notice');
    expect(helloAction({ build: 'b2' }, { ...tab, playingHere: true })).toBe('notice');
    expect(helloAction({ build: 'b2' }, { ...tab, dev: true })).toBe('none');
  });
});

describe('hold notice', () => {
  const held = (zone: string, reason: 'rate-limited' | 'takeover'): PlayerState => ({ ...emptyState(zone), hold: { reason, message: `${reason}!` } });
  it('says why the queue stopped, once per reason', () => {
    expect(holdNotice(undefined, held('pc', 'takeover'))).toBe('takeover!');
    expect(holdNotice(held('pc', 'takeover'), held('pc', 'takeover'))).toBeNull();
    expect(holdNotice(held('pc', 'takeover'), held('pc', 'rate-limited'))).toBe('rate-limited!');
    expect(holdNotice(undefined, emptyState('pc'))).toBeNull();
  });
});

describe('Spotify on the pc zone', () => {
  it('names the stand-in only when Spotify songs head for the pc zone', () => {
    const pc = { id: 'pc', name: 'PC', kind: 'pc' as const, spotifyNotice: 'Soloist needs updating — using the Spotify app' };
    expect(pcSpotifyFallbackNotice(pc, [mkItem(mkTrack('sp:1', 'spotify'))])).toBe(pc.spotifyNotice);
    expect(pcSpotifyFallbackNotice(pc, [mkItem(mkTrack('l:1', 'local'))])).toBeNull();
    expect(pcSpotifyFallbackNotice({ ...pc, kind: 'browser' as never }, [mkItem(mkTrack('sp:1', 'spotify'))])).toBeNull();
  });
});
