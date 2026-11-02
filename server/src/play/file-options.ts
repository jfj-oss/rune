// mpv per-file `loadfile` options: cue slice bounds plus loudness leveling.
//
//   loadfile <path> replace -1 "start=2,end=6,af=volume=-7.5dB"
//
// Every option is a key=value pair joined by commas. The af filter string itself
// has no commas (only one volume filter), so this stays unambiguous.
import type { Track } from '@liner/shared';
import { mpvAfOption } from '../loudness/gain.js';

export interface FileOptionInput {
  cue?: Track['cue'];
  /** Position inside the logical track (ms) to start at. */
  startMs?: number;
  /** Applied loudness gain in dB; 0/undefined omits the filter. */
  gainDb?: number;
}

function trimSeconds(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * Build the per-file option string, or undefined when the file needs none.
 * Cue tracks use absolute positions (`start`/`end` are in the big file).
 */
export function buildFileOptions(input: FileOptionInput): string | undefined {
  const parts: string[] = [];
  const startMs = Math.max(0, input.startMs ?? 0);
  if (input.cue) {
    parts.push(`start=${trimSeconds((input.cue.startMs + startMs) / 1_000)}`);
    parts.push(`end=${trimSeconds(input.cue.endMs / 1_000)}`);
  } else if (startMs > 0) {
    parts.push(`start=${trimSeconds(startMs / 1_000)}`);
  }
  const af = mpvAfOption(input.gainDb ?? 0);
  if (af) parts.push(af);
  return parts.length > 0 ? parts.join(',') : undefined;
}
