// Signal-path wording for the PC zone. Once the per-file volume filter runs,
// the path is no longer bit-perfect; say what it is instead.
import { formatSignedDb } from '../loudness/gain.js';

export function levelingLabel(gainDb: number, volume: number): string {
  if (gainDb !== 0) return `volume-leveled ${formatSignedDb(gainDb)} dB`;
  if (volume !== 100) return `volume ${volume}%`;
  return 'bit-perfect';
}
