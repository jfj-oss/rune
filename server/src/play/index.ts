// Worker C: PC playback zone (mpv) + HTTP streaming/transcoding.
export { createPcZone, type CreatePcZone, type PcZone } from './zone.js';
export {
  registerStreamRoutes,
  activeFfmpegPids,
  activeFfmpegCount,
  parseRangeHeader,
  type ByteRange,
  type ParsedRange,
  type StreamFormat,
} from './stream.js';
export * from './queue.js';
export * from './rows.js';
export { buildFileOptions, type FileOptionInput } from './file-options.js';
export { levelingLabel } from './signal-path.js';
export {
  createPcSpotify,
  registerPcSpotifyRoutes,
  type CommandRunner,
  type CommandResult,
  type PcSpotify,
  type PcSpotifyOptions,
} from './pcSpotify.js';
