// Validation at the HTTP boundary (src/api/playerCommand.ts): every command the web
// client sends must pass untouched, anything malformed must be a short 400 message.
import { describe, expect, it } from 'vitest';
import { parsePlayerCommand, type PlayerRequest } from '../src/api/playerCommand.js';

function accepted(body: unknown): PlayerRequest {
  const parsed = parsePlayerCommand(body);
  if (!parsed.ok) throw new Error(`expected ${JSON.stringify(body)} to be accepted: ${parsed.error}`);
  return parsed.command;
}

function rejected(body: unknown, error: string): void {
  expect(parsePlayerCommand(body)).toEqual({ ok: false, error });
}

describe('parsePlayerCommand: commands the web client sends', () => {
  it('accepts every plain transport/shuffle/repeat command', () => {
    for (const type of ['pause', 'resume', 'next', 'prev', 'clear'] as const) {
      expect(accepted({ type })).toEqual({ type });
    }
    expect(accepted({ type: 'shuffle', on: true })).toEqual({ type: 'shuffle', on: true });
    for (const mode of ['off', 'all', 'one'] as const) {
      expect(accepted({ type: 'repeat', mode })).toEqual({ type: 'repeat', mode });
    }
  });

  it('accepts play with all its optional hand-over fields', () => {
    expect(accepted({ type: 'play', trackIds: ['l:a', 'sp:b'], startIndex: 2, positionMs: 74_000, paused: true })).toEqual({
      type: 'play',
      trackIds: ['l:a', 'sp:b'],
      startIndex: 2,
      positionMs: 74_000,
      paused: true,
    });
    // An empty list is legal (the hybrid backend uses it to keep its own queue).
    expect(accepted({ type: 'play', trackIds: [] })).toEqual({ type: 'play', trackIds: [] });
  });

  it('accepts enqueue, seek, jump, remove, volume and move', () => {
    expect(accepted({ type: 'enqueue', trackIds: ['l:a'], next: true })).toEqual({ type: 'enqueue', trackIds: ['l:a'], next: true });
    expect(accepted({ type: 'seek', positionMs: 0 })).toEqual({ type: 'seek', positionMs: 0 });
    expect(accepted({ type: 'jump', index: 0 })).toEqual({ type: 'jump', index: 0 });
    expect(accepted({ type: 'remove', queueId: 'q:abc' })).toEqual({ type: 'remove', queueId: 'q:abc' });
    expect(accepted({ type: 'move', queueId: 'q:abc', toIndex: 1 })).toEqual({ type: 'move', queueId: 'q:abc', toIndex: 1 });
  });

  it('clamps volume to 0..100 instead of rejecting it', () => {
    expect(accepted({ type: 'volume', volume: 42.5 })).toEqual({ type: 'volume', volume: 42.5 });
    expect(accepted({ type: 'volume', volume: -5 })).toEqual({ type: 'volume', volume: 0 });
    expect(accepted({ type: 'volume', volume: 150 })).toEqual({ type: 'volume', volume: 100 });
  });
});

describe('parsePlayerCommand: malformed bodies', () => {
  it('rejects a non-object body or a missing type', () => {
    rejected(null, 'player command must be a JSON object');
    rejected('volume', 'player command must be a JSON object');
    rejected([], 'player command must be a JSON object');
    rejected({}, 'player command needs a type');
    rejected({ type: 7 }, 'player command needs a type');
  });

  it('rejects an unknown command without echoing the body', () => {
    rejected({ type: 'nope' }, 'unknown player command');
    rejected({ type: 'nope', secret: 'internal' }, 'unknown player command');
  });

  it('rejects bad volume and seek numbers', () => {
    rejected({ type: 'volume' }, 'volume must be a number between 0 and 100');
    rejected({ type: 'volume', volume: null }, 'volume must be a number between 0 and 100');
    rejected({ type: 'volume', volume: 'loud' }, 'volume must be a number between 0 and 100');
    rejected({ type: 'seek' }, 'seek positionMs must be a number of milliseconds (0 or more)');
    rejected({ type: 'seek', positionMs: -1 }, 'seek positionMs must be a number of milliseconds (0 or more)');
    rejected({ type: 'seek', positionMs: '1000' }, 'seek positionMs must be a number of milliseconds (0 or more)');
  });

  it('rejects bad enums and booleans', () => {
    rejected({ type: 'repeat', mode: 'banana' }, 'repeat mode must be off, all or one');
    rejected({ type: 'repeat' }, 'repeat mode must be off, all or one');
    rejected({ type: 'shuffle', on: 'yes' }, 'shuffle on must be true or false');
  });

  it('rejects malformed play / enqueue / jump / remove / move fields', () => {
    rejected({ type: 'play', trackId: 123 }, 'play needs trackIds: an array of track ids');
    rejected({ type: 'play', trackIds: [1] }, 'play needs trackIds: an array of track ids');
    rejected({ type: 'play', trackIds: [] , startIndex: -1 }, 'play startIndex must be a whole number (0 or more)');
    rejected({ type: 'play', trackIds: [], startIndex: 1.5 }, 'play startIndex must be a whole number (0 or more)');
    rejected({ type: 'play', trackIds: [], positionMs: -1 }, 'play positionMs must be a number of milliseconds (0 or more)');
    rejected({ type: 'play', trackIds: [], paused: 'yes' }, 'play paused must be true or false');
    rejected({ type: 'enqueue', trackIds: 'l:a' }, 'enqueue needs trackIds: an array of track ids');
    rejected({ type: 'enqueue', trackIds: [], next: 1 }, 'enqueue next must be true or false');
    rejected({ type: 'jump', index: 1.5 }, 'jump index must be a whole number (0 or more)');
    rejected({ type: 'jump' }, 'jump index must be a whole number (0 or more)');
    rejected({ type: 'remove' }, 'remove needs a queueId');
    rejected({ type: 'remove', queueId: 42 }, 'remove needs a queueId');
    rejected({ type: 'move', toIndex: 1 }, 'move needs a queueId');
    rejected({ type: 'move', queueId: 'q:abc', toIndex: -1 }, 'move toIndex must be a whole number (0 or more)');
  });
});
