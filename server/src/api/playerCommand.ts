// Validation at the HTTP boundary for POST /api/player/:zone.
//
// The zone trusts its commands (it does arithmetic on volume, indexes the queue, …),
// so nothing reaches it until it has the right shape: a JSON body is just `unknown`
// until proven otherwise. Failures carry a short message the UI can show as a toast.
import type { PlayerCommand, PlayerState, TabReport } from '@liner/shared';

export type PlayerRequest = PlayerCommand;

export type ParsedPlayerCommand = { ok: true; command: PlayerRequest } | { ok: false; error: string };

const fail = (error: string): ParsedPlayerCommand => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isWholeAtLeast(v: unknown, min: number): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= min;
}

function isQueueId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function repeatMode(v: unknown): v is PlayerState['repeat'] {
  return v === 'off' || v === 'all' || v === 'one';
}

/** Parse one POST body into a command the zones can safely run, or a human 400 message. */
export function parsePlayerCommand(body: unknown): ParsedPlayerCommand {
  if (!isRecord(body)) return fail('player command must be a JSON object');
  const { type } = body;
  if (typeof type !== 'string') return fail('player command needs a type');

  switch (type) {
    case 'play': {
      if (!isStringArray(body.trackIds)) return fail('play needs trackIds: an array of track ids');
      const command: Extract<PlayerCommand, { type: 'play' }> = { type: 'play', trackIds: body.trackIds };
      if (body.startIndex !== undefined) {
        if (!isWholeAtLeast(body.startIndex, 0)) return fail('play startIndex must be a whole number (0 or more)');
        command.startIndex = body.startIndex;
      }
      if (body.positionMs !== undefined) {
        if (!isFiniteNumber(body.positionMs) || body.positionMs < 0) {
          return fail('play positionMs must be a number of milliseconds (0 or more)');
        }
        command.positionMs = body.positionMs;
      }
      if (body.paused !== undefined) {
        if (typeof body.paused !== 'boolean') return fail('play paused must be true or false');
        command.paused = body.paused;
      }
      if (body.shuffle !== undefined) {
        if (typeof body.shuffle !== 'boolean') return fail('play shuffle must be true or false');
        command.shuffle = body.shuffle;
      }
      return { ok: true, command };
    }
    case 'enqueue': {
      if (!isStringArray(body.trackIds)) return fail('enqueue needs trackIds: an array of track ids');
      const command: Extract<PlayerCommand, { type: 'enqueue' }> = { type: 'enqueue', trackIds: body.trackIds };
      if (body.next !== undefined) {
        if (typeof body.next !== 'boolean') return fail('enqueue next must be true or false');
        command.next = body.next;
      }
      return { ok: true, command };
    }
    case 'pause':
    case 'resume':
    case 'next':
    case 'prev':
      return { ok: true, command: { type } };
    case 'seek':
      if (!isFiniteNumber(body.positionMs) || body.positionMs < 0) {
        return fail('seek positionMs must be a number of milliseconds (0 or more)');
      }
      return { ok: true, command: { type: 'seek', positionMs: body.positionMs } };
    case 'jump':
      if (!isWholeAtLeast(body.index, 0)) return fail('jump index must be a whole number (0 or more)');
      return { ok: true, command: { type: 'jump', index: body.index } };
    case 'remove':
      if (!isQueueId(body.queueId)) return fail('remove needs a queueId');
      return { ok: true, command: { type: 'remove', queueId: body.queueId } };
    case 'move':
      if (!isQueueId(body.queueId)) return fail('move needs a queueId');
      if (!isWholeAtLeast(body.toIndex, 0)) return fail('move toIndex must be a whole number (0 or more)');
      return { ok: true, command: { type: 'move', queueId: body.queueId, toIndex: body.toIndex } };
    case 'clear':
      return { ok: true, command: { type: 'clear' } };
    case 'volume':
      if (!isFiniteNumber(body.volume)) return fail('volume must be a number between 0 and 100');
      return { ok: true, command: { type: 'volume', volume: Math.min(100, Math.max(0, body.volume)) } };
    case 'shuffle':
      if (typeof body.on !== 'boolean') return fail('shuffle on must be true or false');
      return { ok: true, command: { type: 'shuffle', on: body.on } };
    case 'repeat':
      if (!repeatMode(body.mode)) return fail('repeat mode must be off, all or one');
      return { ok: true, command: { type: 'repeat', mode: body.mode } };
    default:
      return fail('unknown player command');
  }
}

/** Parse a browser tab's report about its own player (POST /api/player/:zone/report). */
export function parseTabReport(body: unknown): { ok: true; report: TabReport } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'report must be a JSON object' };
  const { type, token, queueId, positionMs } = body;
  if (!isWholeAtLeast(token, 0) || !isQueueId(queueId) || queueId.length > 200) return { ok: false, error: 'report needs a token and a queueId' };
  const base = { token, queueId };
  const pos = isFiniteNumber(positionMs) && positionMs >= 0 ? Math.round(positionMs) : null;
  switch (type) {
    case 'ended':
      return { ok: true, report: { ...base, type } };
    case 'started':
    case 'paused':
    case 'resumed':
    case 'position': {
      if (pos === null) return { ok: false, error: `${type} needs positionMs` };
      if (type === 'started') {
        const d = isFiniteNumber(body.durationMs) && body.durationMs > 0 ? Math.round(body.durationMs) : undefined;
        return { ok: true, report: { ...base, type, positionMs: pos, ...(d ? { durationMs: d } : {}) } };
      }
      return { ok: true, report: { ...base, type, positionMs: pos } };
    }
    case 'failed':
      return { ok: true, report: { ...base, type, message: typeof body.message === 'string' ? body.message.slice(0, 300) : 'The browser could not play this song.' } };
    default:
      return { ok: false, error: 'unknown report type' };
  }
}
