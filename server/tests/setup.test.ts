// First-run setup routes: folder checks, config merge, the Soloist key file (mode 600, never echoed), pairing output.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { registerSetupRoutes } from '../src/setup/index.js';

let root: string;
let app: FastifyInstance;
let restarts = 0;
let systemd = true;
const cfg = (): Config => ({
  libraryRoots: [], dataDir: join(root, 'data'), port: 4545, audioDevice: 'pipewire', userAgent: 'test',
  soloist: { binary: join(root, 'bin/soloist'), keyFile: join(root, 'cfg/soloist-key') },
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 1;
  killed = false;
  kill() { this.killed = true; return true; }
}
let child: FakeChild;
let spawnArgs: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rune-setup-test-'));
  process.env.RUNE_CONFIG_FILE = join(root, 'config.json');
  restarts = 0;
  systemd = true;
  app = Fastify();
  app.register(async (r) => {
    registerSetupRoutes(r, {
      cfg: cfg(), soloistRun: () => null, restart: () => { restarts++; }, underSystemd: () => systemd,
      spawn: (_b, a) => { spawnArgs = a; child = new FakeChild(); return child as never; },
    });
  }, { prefix: '/api' });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  delete process.env.RUNE_CONFIG_FILE;
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, remoteAddress, headers });

describe('setup status', () => {
  it('needs setup with no music folder, and offers the exact redirect URI', async () => {
    const res = await app.inject({ url: '/api/setup/status' });
    const s = res.json();
    expect(s.needsSetup).toBe(true);
    expect(s.redirectUri).toBe('http://127.0.0.1:4545/api/spotify/callback');
    expect(s.soloist).toMatchObject({ binaryInstalled: false, keySaved: false });
    expect(JSON.stringify(s)).not.toMatch(/horse/i);
  });
});

describe('setup config', () => {
  it('saves checked music folders, merging into the existing config file', async () => {
    const music = join(root, 'Music');
    mkdirSync(music);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ geniusToken: 'keep-me' }));
    const res = await post('/api/setup/config', { libraryRoots: [music, music] });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toEqual({ geniusToken: 'keep-me', libraryRoots: [music] });
  });

  it('rejects missing folders, files, relative paths and the disk root', async () => {
    writeFileSync(join(root, 'a-file'), 'x');
    for (const bad of [join(root, 'nope'), join(root, 'a-file'), 'Music', '/', '']) {
      const res = await post('/api/setup/config', { libraryRoots: [bad] });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(existsSync(join(root, 'config.json'))).toBe(false);
  });

  it('validates the Spotify client id and can clear it', async () => {
    expect((await post('/api/setup/config', { spotifyClientId: 'not an id' })).statusCode).toBe(400);
    const id = 'a'.repeat(32);
    expect((await post('/api/setup/config', { spotifyClientId: id })).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).spotifyClientId).toBe(id);
    expect((await post('/api/setup/config', { spotifyClientId: '' })).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).spotifyClientId).toBeUndefined();
  });

  it('refuses writes from another machine and from another site', async () => {
    expect((await post('/api/setup/config', { spotifyClientId: '' }, '192.168.1.9')).statusCode).toBe(403);
    expect((await post('/api/setup/config', { spotifyClientId: '' }, '127.0.0.1', { origin: 'http://evil.example', host: '127.0.0.1:4545' })).statusCode).toBe(403);
    expect((await post('/api/setup/restart', {}, '192.168.1.9')).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/setup/dirs', remoteAddress: '192.168.1.9' })).statusCode).toBe(403);
  });
});

describe('folder picker', () => {
  it('lists subfolders without hidden ones', async () => {
    mkdirSync(join(root, 'b')); mkdirSync(join(root, 'a')); mkdirSync(join(root, '.hidden')); writeFileSync(join(root, 'f.txt'), '');
    const res = await app.inject({ url: `/api/setup/dirs?path=${encodeURIComponent(root)}` });
    expect(res.json()).toMatchObject({ path: root, dirs: ['a', 'b'] });
  });
});

describe('soloist key and pairing', () => {
  it('writes the key with mode 600 and never echoes it', async () => {
    const key = 'sk_test_SECRET_VALUE_123';
    const res = await post('/api/setup/soloist-key', { key });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(key);
    const file = join(root, 'cfg/soloist-key');
    expect(readFileSync(file, 'utf8').trim()).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const status = await app.inject({ url: '/api/setup/status' });
    expect(status.body).not.toContain(key);
    expect(status.json().soloist.keySaved).toBe(true);
  });

  it('rejects an empty or multi-line key', async () => {
    expect((await post('/api/setup/soloist-key', { key: '  ' })).statusCode).toBe(400);
    expect((await post('/api/setup/soloist-key', { key: 'a b' })).statusCode).toBe(400);
  });

  it('pairs only when the binary and key exist, shows the output and hides the key', async () => {
    expect((await post('/api/setup/soloist-pair', {})).statusCode).toBe(409);
    mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin/soloist'), '#!/bin/sh\n', { mode: 0o755 });
    expect((await post('/api/setup/soloist-pair', {})).statusCode).toBe(409);
    await post('/api/setup/soloist-key', { key: 'sk_test_SECRET' });
    const started = await post('/api/setup/soloist-pair', {});
    expect(started.statusCode).toBe(200);
    expect(spawnArgs).toContain('--pair');
    child.stdout.emit('data', 'Open https://example.test/pair and enter code ABCD (key sk_test_SECRET)\n');
    const mid = (await app.inject({ url: '/api/setup/soloist-pair' })).json();
    expect(mid.running).toBe(true);
    expect(mid.output).toContain('enter code ABCD');
    expect(mid.output).not.toContain('sk_test_SECRET');
    child.emit('exit', 0);
    expect((await app.inject({ url: '/api/setup/soloist-pair' })).json()).toMatchObject({ running: false, exitCode: 0 });
  });
});

describe('restart', () => {
  it('restarts under systemd, and only says so otherwise', async () => {
    expect((await post('/api/setup/restart', {})).json()).toEqual({ ok: true, restarting: true });
    expect(restarts).toBe(1);
    systemd = false;
    expect((await post('/api/setup/restart', {})).json()).toEqual({ ok: true, restarting: false });
    expect(restarts).toBe(1);
  });
});

describe('phone address', () => {
  it('accepts an https address and rejects the rest', async () => {
    expect((await post('/api/setup/config', { publicUrl: 'http://x.test' })).statusCode).toBe(400);
    expect((await post('/api/setup/config', { publicUrl: 'https://my-pc.example-tailnet.ts.net:8445/' })).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).publicUrl).toBe('https://my-pc.example-tailnet.ts.net:8445');
  });
});
