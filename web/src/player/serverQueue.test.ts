import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { helloAction, holdNotice, usesServerQueue } from './serverQueue';
import { needsPcSpotify } from './pcStart';
import { emptyState } from './types';
import { mkItem, mkTrack } from './testkit';

const tab = { build: 'b1', pcServerQueue: false as boolean | null, playingHere: false };

describe('server queue on the page', () => {
  it('only a pc zone the server marks uses it', () => {
    expect(usesServerQueue({ kind: 'pc', serverQueue: true })).toBe(true);
    expect(usesServerQueue({ kind: 'pc' })).toBe(false);
    expect(usesServerQueue({ kind: 'spotify', serverQueue: true })).toBe(false);
    expect(usesServerQueue(undefined)).toBe(false);
  });

  it('the page never starts the Spotify app itself for a server-queue pc zone: the server does', () => {
    const items = [mkItem(mkTrack('sp:1', 'spotify'))];
    expect(needsPcSpotify({ id: 'pc', name: 'PC', kind: 'pc' }, items)).toBe(true);
    expect(needsPcSpotify({ id: 'pc', name: 'PC', kind: 'pc', serverQueue: true }, items)).toBe(false);
  });

  it('a tab that drives the pc zone the other way reloads; one playing in itself is told to', () => {
    expect(helloAction({ build: 'b1', serverQueue: true }, tab)).toBe('reload');
    expect(helloAction({ build: 'b1', serverQueue: true }, { ...tab, playingHere: true })).toBe('notice');
    expect(helloAction({ build: 'b1', serverQueue: false }, { ...tab, pcServerQueue: true })).toBe('reload');
  });

  it('a tab from another web build is told to reload; the same build, or no pc zone yet, is left alone', () => {
    expect(helloAction({ build: 'b2', serverQueue: false }, tab)).toBe('notice');
    expect(helloAction({ build: 'b1', serverQueue: false }, tab)).toBe('none');
    expect(helloAction({ build: 'b1', serverQueue: true }, { ...tab, pcServerQueue: null })).toBe('none');
    expect(helloAction({ build: null, serverQueue: false }, tab)).toBe('none');
    expect(helloAction({ build: 'b2', serverQueue: false }, { ...tab, dev: true })).toBe('none');
  });

  it('a hold is announced once, when it starts or its reason changes', () => {
    const base: PlayerState = { ...emptyState('pc') };
    const held: PlayerState = { ...base, hold: { reason: 'rate-limited', message: 'limit' } };
    expect(holdNotice(base, held)).toBe('limit');
    expect(holdNotice(held, { ...held, positionMs: 5 })).toBeNull();
    expect(holdNotice(held, { ...held, hold: { reason: 'takeover', message: 'other' } })).toBe('other');
    expect(holdNotice(held, base)).toBeNull();
  });
});
