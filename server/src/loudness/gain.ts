// Gain math for ReplayGain-style normalisation.
//
// Reference: ReplayGain 2.0 targets -18 LUFS and limits true peak to -1 dBTP.
//   gain         = TARGET_LUFS - loudness
//   peak ceiling = TRUE_PEAK_CEILING - truePeak
//   applied      = min(gain, peak ceiling)   (and never more than MAX_BOOST_DB)
//
// All values are in dB. Loudness is LUFS, true peak is dBTP.

import type { NormalizeMode } from '../config.js';

export const TARGET_LUFS = -18;
export const TRUE_PEAK_CEILING_DBTP = -1;
/** Guard against a near-silent track getting an absurd boost. */
export const MAX_BOOST_DB = 24;

export interface EnergyEntry {
  lufs: number;
  /** Weight of this track in the album mean (duration in ms). */
  durationMs?: number | null;
}

/** Unrounded gain: target minus loudness, capped so truePeak + gain <= -1 dBTP. */
export function computeGainDb(lufs: number, truePeakDb?: number | null): number {
  if (!Number.isFinite(lufs)) return 0;
  let gain = TARGET_LUFS - lufs;
  if (truePeakDb != null && Number.isFinite(truePeakDb)) {
    gain = Math.min(gain, TRUE_PEAK_CEILING_DBTP - truePeakDb);
  }
  if (gain > MAX_BOOST_DB) gain = MAX_BOOST_DB;
  return gain;
}

/**
 * Gain in 0.1 dB steps, rounded toward zero so the true-peak ceiling still holds
 * after rounding (rounding up could push the peak past -1 dBTP).
 */
export function appliedGainDb(lufs: number, truePeakDb?: number | null): number {
  const raw = computeGainDb(lufs, truePeakDb);
  return Math.floor(raw * 10 + 1e-9) / 10;
}

/** -18 LUFS - ReplayGain's -18 dB reference: a -6 dB RG track gain implies -12 LUFS. */
export function lufsFromReplayGain(gainDb: number): number {
  return TARGET_LUFS - gainDb;
}

/**
 * Album loudness as an energy-weighted mean of track loudness. LUFS is a
 * logarithmic scale, so averaging must happen in linear energy
 * (10^(lufs/10)) weighted by track duration.
 */
export function energyWeightedLufs(entries: readonly EnergyEntry[]): number | null {
  let energy = 0;
  let weight = 0;
  let fallbackEnergy = 0;
  let fallbackCount = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.lufs)) continue;
    const linear = Math.pow(10, entry.lufs / 10);
    fallbackEnergy += linear;
    fallbackCount += 1;
    const w = entry.durationMs != null && Number.isFinite(entry.durationMs) && entry.durationMs > 0
      ? entry.durationMs
      : 0;
    if (w > 0) {
      energy += linear * w;
      weight += w;
    }
  }
  if (weight > 0) return 10 * Math.log10(energy / weight);
  if (fallbackCount > 0) return 10 * Math.log10(fallbackEnergy / fallbackCount);
  return null;
}

/** "+1.2" / "-7.5" / "0.0" — used in signal path text and logs. */
export function formatSignedDb(db: number, digits = 1): string {
  const rounded = Number(db.toFixed(digits));
  const magnitude = Math.abs(rounded).toFixed(digits);
  if (rounded > 0) return `+${magnitude}`;
  if (rounded < 0) return `-${magnitude}`;
  return magnitude;
}

/** mpv filter string, e.g. "volume=-7.5dB". */
export function mpvVolumeFilter(gainDb: number): string | undefined {
  if (Math.abs(gainDb) < 0.05) return undefined;
  return `volume=${gainDb.toFixed(1)}dB`;
}

/** Value of mpv's per-file `af=` option, or undefined when no gain is applied. */
export function mpvAfOption(gainDb: number): string | undefined {
  const filter = mpvVolumeFilter(gainDb);
  return filter ? `af=${filter}` : undefined;
}

export interface ReplayGainTags {
  trackGainDb?: number;
  albumGainDb?: number;
  /** Peak as dBFS derived from the linear REPLAYGAIN_TRACK_PEAK tag. */
  trackPeakDb?: number;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /[-+]?\d+(?:\.\d+)?/.exec(value);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read REPLAYGAIN_TRACK_GAIN / REPLAYGAIN_ALBUM_GAIN / REPLAYGAIN_TRACK_PEAK from
 * a tag map. Keys are compared case- and punctuation-insensitively because
 * ffprobe, music-metadata and Vorbis comments all spell them differently.
 */
export function parseReplayGainTags(tags: Record<string, string | undefined>): ReplayGainTags {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    normalized[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
  }
  const out: ReplayGainTags = {};
  const track = parseNumber(normalized.replaygaintrackgain);
  if (track !== undefined) out.trackGainDb = track;
  const album = parseNumber(normalized.replaygainalbumgain);
  if (album !== undefined) out.albumGainDb = album;

  // REPLAYGAIN_TRACK_PEAK is a linear sample peak (e.g. 0.988), not dBTP.
  const peak = parseNumber(normalized.replaygaintrackpeak);
  if (peak !== undefined && peak > 0) out.trackPeakDb = 20 * Math.log10(peak);
  return out;
}

export function isNormalizeMode(value: unknown): value is NormalizeMode {
  return value === 'off' || value === 'track' || value === 'album';
}
