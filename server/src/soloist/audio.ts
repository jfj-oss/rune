// Where Soloist's sound goes, and the stream the phone hears.
//
//   Soloist ──► PipeWire null sink "rune-phone" (silent on the PC) ──► ffmpeg (its monitor) ──► HLS ──► the phone
//   Soloist ──► the default output (PC speakers), by moving its stream there with pactl
//
// Soloist always starts into the null sink, so nothing is ever audible by accident; choosing the PC speakers moves the
// running stream. The encoder runs only while a phone is asking for the playlist, and writes to tmpfs (never to disk).
// A skip or seek starts a new "program" (a fresh ffmpeg and playlist), so the phone hears the change after about one
// segment instead of after its whole buffer.
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type SoloistOutput = 'pc' | 'phone';

export interface AudioRunner {
  run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }>;
  spawn(command: string, args: string[]): { kill(signal?: NodeJS.Signals): boolean; on(event: 'exit', fn: () => void): unknown };
}

const defaultRunner: AudioRunner = {
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 8000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
    }),
  spawn: (command, args) => nodeSpawn(command, args, { stdio: 'ignore' }),
};

export interface SoloistAudioOptions {
  sink?: string;
  /** tmpfs directory for the HLS programs (default $XDG_RUNTIME_DIR/rune-hls). */
  hlsDir?: string;
  kbps?: number;
  runner?: AudioRunner;
  now?: () => number;
  /** The encoder stops this long after the last playlist request (default 45 s). */
  idleMs?: number;
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

export const DEFAULT_SINK = 'rune-phone';
const SEGMENT_S = 1;

/** The sink-input ids of Soloist's streams, from `pactl list sink-inputs`. */
export function soloistSinkInputs(listing: string): string[] {
  const ids: string[] = [];
  for (const block of listing.split(/\n(?=Sink Input #)/)) {
    const id = /^Sink Input #(\d+)/m.exec(block)?.[1];
    if (id && /application\.(name|process\.binary) = "[^"]*soloist[^"]*"/i.test(block)) ids.push(id);
  }
  return ids;
}

/** ffmpeg arguments for one HLS program read from the sink's monitor. */
export function hlsArgs(sink: string, dir: string, kbps: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'pulse', '-i', `${sink}.monitor`,
    '-ac', '2', '-c:a', 'aac', '-b:a', `${kbps}k`,
    '-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    join(dir, 'index.m3u8'),
  ];
}

export class SoloistAudio {
  /** The PC speakers until a phone asks to hear it (then its sound moves to the silent sink the stream reads). */
  output: SoloistOutput = 'pc';
  readonly sink: string;
  private readonly runner: AudioRunner;
  private readonly root: string;
  private readonly kbps: number;
  private readonly now: () => number;
  private moduleId: string | null = null;
  private gen = 0;
  private encoder: { kill(signal?: NodeJS.Signals): boolean } | null = null;
  private lastAsked = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SoloistAudioOptions = {}) {
    this.sink = opts.sink ?? DEFAULT_SINK;
    this.runner = opts.runner ?? defaultRunner;
    this.root = opts.hlsDir ?? join(process.env.XDG_RUNTIME_DIR ?? '/dev/shm', 'rune-hls');
    this.kbps = Math.max(64, Math.min(320, opts.kbps ?? 256));
    this.now = opts.now ?? Date.now;
  }

  /** Make the silent sink (once; an existing one is reused and left alone at shutdown). */
  async ensureSink(): Promise<boolean> {
    const list = await this.runner.run('pactl', ['list', 'short', 'sinks']);
    if (list.ok && new RegExp(`^\\d+\\s+${this.sink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(list.stdout)) return true;
    const made = await this.runner.run('pactl', ['load-module', 'module-null-sink', `sink_name=${this.sink}`, 'rate=44100', 'channels=2', `sink_properties=device.description=${this.sink}`]);
    if (!made.ok) {
      this.opts.log?.({ sink: this.sink }, 'could not create the phone sink (is PipeWire running?)');
      return false;
    }
    this.moduleId = made.stdout.trim() || null;
    return true;
  }

  /** Send Soloist's sound to the PC speakers or to the phone sink. Safe to call again whenever its stream (re)appears. */
  async setOutput(output: SoloistOutput): Promise<void> {
    this.output = output;
    if (output === 'pc') this.stopEncoder();
    await this.applyOutput();
  }

  async applyOutput(): Promise<number> {
    const list = await this.runner.run('pactl', ['list', 'sink-inputs']);
    if (!list.ok) return 0;
    const target = this.output === 'phone' ? this.sink : '@DEFAULT_SINK@';
    const ids = soloistSinkInputs(list.stdout);
    for (const id of ids) await this.runner.run('pactl', ['move-sink-input', id, target]);
    return ids.length;
  }

  /** The current program's directory, starting the encoder if a phone is listening and none runs. */
  listen(): { gen: number; dir: string } | null {
    if (this.output !== 'phone') return null;
    this.lastAsked = this.now();
    if (!this.encoder) this.startEncoder();
    return { gen: this.gen, dir: this.dirOf(this.gen) };
  }

  /** A skip or seek: a fresh program, so the phone hears it at once. Does nothing while nobody listens. */
  restart(): void {
    if (!this.encoder) return;
    this.stopEncoder();
    this.startEncoder();
  }

  /** The playlist of the current program with segment paths the HTTP route serves; null until ffmpeg wrote one. */
  playlist(): string | null {
    const here = this.listen();
    if (!here) return null;
    const file = join(here.dir, 'index.m3u8');
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').replace(/^(seg\d+\.ts)$/gm, `g${here.gen}/$1`);
  }

  segmentPath(gen: number, name: string): string | null {
    if (!/^seg\d{5}\.ts$/.test(name) || !Number.isInteger(gen) || gen < 1) return null;
    const file = join(this.dirOf(gen), name);
    return existsSync(file) ? file : null;
  }

  async close(): Promise<void> {
    this.stopEncoder();
    rmSync(this.root, { recursive: true, force: true });
    if (this.moduleId) await this.runner.run('pactl', ['unload-module', this.moduleId]);
    this.moduleId = null;
  }

  private dirOf(gen: number): string {
    return join(this.root, `g${gen}`);
  }

  private startEncoder(): void {
    const old = this.gen;
    this.gen++;
    const dir = this.dirOf(this.gen);
    mkdirSync(dir, { recursive: true });
    if (old > 0) rmSync(this.dirOf(old), { recursive: true, force: true });
    const child = this.runner.spawn('ffmpeg', hlsArgs(this.sink, dir, this.kbps));
    this.encoder = child;
    child.on('exit', () => { if (this.encoder === child) this.encoder = null; });
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (this.encoder && this.now() - this.lastAsked > (this.opts.idleMs ?? 45_000)) this.stopEncoder();
      }, 5000);
      this.idleTimer.unref?.();
    }
  }

  private stopEncoder(): void {
    const child = this.encoder;
    this.encoder = null;
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}
