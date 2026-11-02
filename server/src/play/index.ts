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
