// Worker L: loudness normalisation (ReplayGain-style, EBU R128).
//
//   const loudness = createLoudness(db, cfg);
//   loudness.start();                       // background analysis, one ffmpeg at a time
//   registerLoudnessRoutes(r, loudness);    // GET/POST /api/settings/normalize
//
// Playback reads gains straight from the database (gainInfoForTrack /
// gainInfoForTrack) so the PC zone and stream routes need no service instance.
export {
  TARGET_LUFS,
  TRUE_PEAK_CEILING_DBTP,
  MAX_BOOST_DB,
  appliedGainDb,
  computeGainDb,
  energyWeightedLufs,
  formatSignedDb,
  isNormalizeMode,
  lufsFromReplayGain,
  mpvAfOption,
  mpvVolumeFilter,
  parseReplayGainTags,
  type EnergyEntry,
  type ReplayGainTags,
} from './gain.js';
export {
  analysisArgs,
  measureLoudness,
  parseEbur128Summary,
  probeTags,
  type AnalyzeSlice,
  type LoudnessResult,
  type MeasureOptions,
} from './ebur128.js';
export {
  createLoudness,
  ensureLoudnessSchema,
  gainInfoForTrack,
  getNormalizeMode,
  recomputeAlbumLoudness,
  setNormalizeMode,
  type AnalysisOutcome,
  type CreateLoudnessOptions,
  type EffectiveNormalizeMode,
  type GainInfo,
  type LoudnessService,
  type LoudnessSource,
  type WorkerStats,
  type WorkerStatus,
} from './service.js';
export { registerLoudnessRoutes, type LoudnessController } from './routes.js';
