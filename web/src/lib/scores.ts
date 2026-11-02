import type { CriticScore } from '@liner/shared';

/** Normalise a native-scale score to 0..100 (1 decimal). */
export function normalizeScore(s: Pick<CriticScore, 'score' | 'scale'>): number {
  if (!Number.isFinite(s.score) || !Number.isFinite(s.scale) || s.scale <= 0) return 0;
  const v = (s.score / s.scale) * 100;
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

export type ScoreTone = 'high' | 'mid' | 'low';

export function scoreTone(normalized: number): ScoreTone {
  if (normalized >= 75) return 'high';
  if (normalized >= 55) return 'mid';
  return 'low';
}

/** Value as the outlet prints it: 84, 8.1, 4.5. */
export function formatScoreValue(s: Pick<CriticScore, 'score' | 'scale'>): string {
  if (s.scale >= 100) return String(Math.round(s.score));
  return Number.isInteger(s.score) ? s.score.toFixed(1) : String(Math.round(s.score * 10) / 10);
}

/** "/10", "/5" suffix for non-percentage scales. */
export function scoreSuffix(s: Pick<CriticScore, 'scale'>): string {
  return s.scale >= 100 ? '' : `/${s.scale}`;
}
