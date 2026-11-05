import { describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { createSpeakerGuard, type SpeakerZone } from '../src/play/oneSpeaker.js';

const st = (status: PlayerState['status']) => ({ status }) as PlayerState;
const zone = (status: PlayerState['status']) => {
  const z = { status, state: () => st(z.status), command: vi.fn(async () => { z.status = 'paused'; }) };
  return z as typeof z & SpeakerZone;
};

describe('the PC speakers play one thing at a time', () => {
  it('a song starting on mpv pauses the Spotify app', () => {
    const pc = zone('playing');
    const sp = zone('playing');
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }).changed('pc', st('playing'));
    expect(sp.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pc.command).not.toHaveBeenCalled();
  });
  it('Spotify starting (autoplay, the app itself) pauses mpv', () => {
    const pc = zone('playing');
    const sp = zone('playing');
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }).changed('spotify', st('playing'));
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
  });
  it('a player that keeps playing (next track, a poll) stops nothing', () => {
    const pc = zone('playing');
    const sp = zone('paused');
    const g = createSpeakerGuard({ pc: () => pc, spotify: () => sp });
    g.changed('pc', st('playing'));
    sp.status = 'playing';
    g.changed('pc', st('playing'));
    expect(sp.command).not.toHaveBeenCalled();
  });
  it('leaves a paused player alone, and copes with no Spotify app', () => {
    const sp = zone('paused');
    const g = createSpeakerGuard({ pc: () => undefined, spotify: () => sp });
    g.changed('spotify', st('playing'));
    g.changed('pc', st('playing'));
    expect(sp.command).not.toHaveBeenCalled();
  });
});
