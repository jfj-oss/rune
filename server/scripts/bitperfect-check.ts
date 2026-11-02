// Bit-perfect check for the PC zone: plays a generated 24-bit tone at each sample
// rate through mpv -> PipeWire to a temporary null sink, then compares mpv's input
// and output params plus PipeWire's live graph rate. Nothing is played audibly:
// every rate gets its own null sink, created and removed by this script.
//
//   pnpm -C server exec tsx scripts/bitperfect-check.ts
//   pnpm -C server exec tsx scripts/bitperfect-check.ts --rates 44100,96000
//   pnpm -C server exec tsx scripts/bitperfect-check.ts --mpv-only
//
// Exit code 0 when every rate is bit-perfect; 1 otherwise. With --mpv-only only a
// client-side resample (mpv's in/out params differ) counts as a failure, which is
// useful on machines without a running PipeWire.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MpvIpc } from '../src/play/mpv-ipc.js';

const DEFAULT_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const TONE_SECONDS = 2;
const CHANNELS = 2;

interface Options {
  rates: number[];
  mpvOnly: boolean;
  help: boolean;
}

interface MpvAudioParams {
  samplerate?: number;
  'channel-count'?: number;
  format?: string;
}

interface Result {
  rate: number;
  input?: MpvAudioParams;
  output?: MpvAudioParams;
  graphRate?: number;
  error?: string;
}

interface Cleanup {
  moduleId?: number;
  child?: ChildProcess;
  dir?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { rates: [...DEFAULT_RATES], mpvOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--mpv-only') {
      options.mpvOnly = true;
    } else if (arg === '--rates') {
      const value = argv[++i];
      if (!value) throw new Error('--rates needs a comma-separated list');
      const rates = value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((rate) => Number.isFinite(rate) && rate > 0);
      if (rates.length === 0) throw new Error('--rates: no valid sample rates');
      options.rates = rates;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage(): void {
  console.log(`Usage: tsx scripts/bitperfect-check.ts [options]

  --rates <list>   comma-separated sample rates (default ${DEFAULT_RATES.join(',')})
  --mpv-only       only fail when mpv resamples; ignore the PipeWire graph rate
  -h, --help       show this help`);
}

function requireCommand(bin: string): void {
  const res = spawnSync('which', [bin], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`required command not found: ${bin}`);
  }
}

/** Write a 24-bit PCM WAV sine tone at `sampleRate` (mono content mirrored to stereo). */
function writeToneWav(path: string, sampleRate: number): void {
  const bytesPerSample = 3;
  const blockAlign = CHANNELS * bytesPerSample;
  const frames = sampleRate * TONE_SECONDS;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const amplitude = 0.25 * 0x7fffff;
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 1000 * frame) / sampleRate) * amplitude);
    for (let channel = 0; channel < CHANNELS; channel++) {
      buffer.writeIntLE(sample, offset, 3);
      offset += bytesPerSample;
    }
  }
  writeFileSync(path, buffer);
}

function loadNullSink(name: string, rate: number): number {
  const res = spawnSync(
    'pactl',
    ['load-module', 'module-null-sink', `sink_name=${name}`, `rate=${rate}`, `channels=${CHANNELS}`],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`pactl load-module failed: ${(res.stderr ?? '').trim() || res.error?.message || 'unknown error'}`);
  }
  const id = Number((res.stdout ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`unexpected pactl load-module output: ${res.stdout ?? ''}`);
  }
  return id;
}

function unloadModule(id: number): void {
  spawnSync('pactl', ['unload-module', String(id)], { encoding: 'utf8' });
}

async function waitForSink(name: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const res = spawnSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8' });
    const found =
      res.status === 0 &&
      (res.stdout ?? '')
        .split('\n')
        .some((line) => line.split('\t')[1] === name);
    if (found) return;
    await sleep(100);
  }
  throw new Error(`null sink ${name} did not appear`);
}

/** PipeWire's live graph clock rate, read from the running driver row in pw-top. */
function queryGraphRate(): number | undefined {
  const res = spawnSync('pw-top', ['-b', '-n', '2'], { encoding: 'utf8', timeout: 5_000 });
  if (res.status !== 0 || !res.stdout) return undefined;
  for (const line of res.stdout.split('\n')) {
    // Driver rows carry a non-zero quantum: S ID QUANT RATE ...
    const match = /^R\s+\d+\s+(\d+)\s+(\d+)\s/.exec(line);
    if (match && Number(match[1]) > 0) {
      const rate = Number(match[2]);
      if (rate > 0) return rate;
    }
  }
  return undefined;
}

async function getParams(ipc: MpvIpc, name: string): Promise<MpvAudioParams | undefined> {
  const res = await ipc.command(['get_property', name]).catch(() => undefined);
  const data = res?.data;
  return data && typeof data === 'object' ? (data as MpvAudioParams) : undefined;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        finish();
      }, 1_000);
    }, timeoutMs);
    let killTimer: NodeJS.Timeout | undefined;
    child.once('exit', finish);
  });
}

async function probeRate(rate: number, wavPath: string, socketPath: string, sinkName: string): Promise<Result> {
  const child = spawn(
    'mpv',
    [
      '--no-video',
      '--audio-display=no',
      '--no-terminal',
      '--idle=yes',
      '--ao=pipewire',
      `--audio-device=pipewire/${sinkName}`,
      `--input-ipc-server=${socketPath}`,
      '--volume=100',
      '--gapless-audio=no',
      '--replaygain=no',
      '--loop-file=inf',
      wavPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });

  let ipc: MpvIpc | undefined;
  try {
    ipc = await MpvIpc.connect(socketPath, { timeoutMs: 10_000 });
    const deadline = Date.now() + 8_000;
    let input: MpvAudioParams | undefined;
    let output: MpvAudioParams | undefined;
    while (Date.now() < deadline) {
      input = await getParams(ipc, 'audio-params');
      output = await getParams(ipc, 'audio-out-params');
      if (input?.samplerate && output?.samplerate) break;
      await sleep(100);
    }
    if (!input?.samplerate || !output?.samplerate) {
      return { rate, input, output, error: `mpv produced no audio params${stderr.trim() ? `: ${stderr.trim()}` : ''}` };
    }
    // The tone loops, so the graph is running while pw-top samples it.
    return { rate, input, output, graphRate: queryGraphRate() };
  } catch (err) {
    return { rate, error: (err as Error).message };
  } finally {
    if (ipc) {
      await ipc.command(['quit']).catch(() => undefined);
      ipc.close();
    }
    await waitForExit(child, 2_000);
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // best effort
    }
  }
}

function formatParams(params?: MpvAudioParams): string {
  if (!params) return '-';
  const format = params.format ?? '?';
  const rate = params.samplerate ? `${params.samplerate} Hz` : '? Hz';
  const channels = params['channel-count'] ? `${params['channel-count']}ch` : '';
  return `${format} ${rate} ${channels}`.replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }

  try {
    requireCommand('mpv');
    requireCommand('pactl');
    requireCommand('pw-top');
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
    return;
  }

  const cleanup: Cleanup = {};
  const onInterrupt = (): void => {
    if (cleanup.moduleId !== undefined) unloadModule(cleanup.moduleId);
    if (cleanup.child) {
      try {
        cleanup.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    if (cleanup.dir) rmSync(cleanup.dir, { recursive: true, force: true });
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  cleanup.dir = mkdtempSync(join(tmpdir(), 'liner-bp-check-'));
  const dir = cleanup.dir;
  const results: Result[] = [];

  console.log('Liner bit-perfect check');
  console.log('  pipeline: 24-bit WAV -> mpv (--ao=pipewire, volume 100) -> temporary null sink');
  console.log('  input/output params from mpv IPC; graph rate from pw-top (live driver clock)');
  console.log('');

  try {
    for (const rate of options.rates) {
      const sinkName = `liner_bp_check_${process.pid}_${rate}`;
      const wavPath = join(dir, `tone-${rate}.wav`);
      const socketPath = join(dir, `mpv-${rate}.sock`);
      writeToneWav(wavPath, rate);

      let moduleId: number | undefined;
      try {
        moduleId = loadNullSink(sinkName, rate);
        cleanup.moduleId = moduleId;
        await waitForSink(sinkName);
        results.push(await probeRate(rate, wavPath, socketPath, sinkName));
      } catch (err) {
        results.push({ rate, error: (err as Error).message });
      } finally {
        if (moduleId !== undefined) {
          unloadModule(moduleId);
          cleanup.moduleId = undefined;
        }
        await sleep(100);
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    rmSync(dir, { recursive: true, force: true });
  }

  const header = ['rate', 'input (mpv)', 'output (mpv)', 'graph', 'mpv', 'graph', 'verdict'];
  const rows = results.map((result) => {
    const inRate = result.input?.samplerate;
    const outRate = result.output?.samplerate;
    const mpvPass = inRate !== undefined && outRate !== undefined && inRate === outRate;
    const graphPass =
      result.graphRate !== undefined && inRate !== undefined ? result.graphRate === inRate : undefined;
    let verdict: string;
    if (result.error) {
      verdict = `error: ${result.error}`;
    } else if (!mpvPass) {
      verdict = `NOT bit-perfect (mpv resampled ${inRate ?? '?'} -> ${outRate ?? '?'})`;
    } else if (graphPass === false) {
      verdict = `NOT bit-perfect (PipeWire graph ${result.graphRate} Hz)`;
    } else if (graphPass === undefined) {
      verdict = 'bit-perfect? (graph rate unknown)';
    } else {
      verdict = 'bit-perfect';
    }
    return {
      result,
      mpvPass,
      graphPass,
      cells: [
        String(result.rate),
        formatParams(result.input),
        formatParams(result.output),
        result.graphRate !== undefined ? `${result.graphRate} Hz` : '?',
        result.error ? '-' : mpvPass ? 'ok' : 'BAD',
        graphPass === undefined ? '?' : graphPass ? 'ok' : 'BAD',
        verdict,
      ],
    };
  });

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row.cells[index]?.length ?? 0)),
  );
  const render = (cells: string[]): string =>
    cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ');
  console.log(render(header));
  for (const row of rows) console.log(render(row.cells));

  const failures = rows.filter(
    (row) =>
      Boolean(row.result.error) ||
      !row.mpvPass ||
      (!options.mpvOnly && row.graphPass === false),
  );
  const bitPerfect = rows.filter(
    (row) => !row.result.error && row.mpvPass && row.graphPass === true,
  ).length;

  console.log('');
  console.log(`Summary: ${bitPerfect}/${results.length} rates bit-perfect through mpv + PipeWire.`);
  if (rows.some((row) => row.graphPass === false)) {
    console.log('PipeWire resampled at least one rate. See server/docs/bitperfect.md:');
    console.log('  ~/.config/pipewire/pipewire.conf.d/10-rune-rates.conf');
    console.log('limits the graph to 48 kHz today; add the DAC-supported rates and restart PipeWire.');
  }
  if (rows.some((row) => row.graphPass === undefined)) {
    console.log('Graph rate could not be read for some rates (is PipeWire running?); those rows only');
    console.log('verify mpv did not resample.');
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
