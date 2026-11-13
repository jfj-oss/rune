// Which requests come from a browser on the PC rune runs on (api/sameMachine.ts). Addresses here are documentation ones.
import { describe, expect, it } from 'vitest';
import { fromThisMachine } from '../src/api/sameMachine.js';

const OWN = ['127.0.0.1', '::1', '192.0.2.10', '100.64.0.7', 'fd00::7'];

describe('fromThisMachine', () => {
  it('a tab opened on http://localhost is on this machine', () => {
    expect(fromThisMachine({ remote: '127.0.0.1', host: 'localhost:4545' }, OWN)).toBe(true);
    expect(fromThisMachine({ remote: '::1', host: '[::1]:4545' }, OWN)).toBe(true);
    expect(fromThisMachine({ remote: '::ffff:127.0.0.1', host: '127.0.0.1:4545' }, OWN)).toBe(true);
  });

  it('through the proxy on this machine: the PC\'s own tab is here, a phone or another computer is not', () => {
    expect(fromThisMachine({ remote: '127.0.0.1', forwardedFor: '100.64.0.7', host: 'pc.example.net:8445' }, OWN)).toBe(true);
    expect(fromThisMachine({ remote: '127.0.0.1', forwardedFor: 'fd00::7', host: 'pc.example.net:8445' }, OWN)).toBe(true);
    expect(fromThisMachine({ remote: '127.0.0.1', forwardedFor: '100.64.0.99', host: 'pc.example.net:8445' }, OWN)).toBe(false);
    expect(fromThisMachine({ remote: '127.0.0.1', forwardedFor: ['100.64.0.99', '127.0.0.1'], host: 'pc.example.net' }, OWN)).toBe(false);
    expect(fromThisMachine({ remote: '127.0.0.1', forwardedFor: '100.64.0.99, 100.64.0.7' }, OWN)).toBe(false);
  });

  it('a proxy that names no client could be passing on anyone: not this machine', () => {
    expect(fromThisMachine({ remote: '127.0.0.1', host: 'pc.example.net:8445' }, OWN)).toBe(false);
    expect(fromThisMachine({ remote: '127.0.0.1' }, OWN)).toBe(false);
  });

  it('a direct connection from another machine is never believed, whatever it claims', () => {
    expect(fromThisMachine({ remote: '192.0.2.55', host: 'localhost:4545' }, OWN)).toBe(false);
    expect(fromThisMachine({ remote: '192.0.2.55', forwardedFor: '127.0.0.1', host: 'localhost' }, OWN)).toBe(false);
    expect(fromThisMachine({ remote: undefined, host: 'localhost' }, OWN)).toBe(false);
  });
});
