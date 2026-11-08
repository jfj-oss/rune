/**
 * What this browser's <audio> element can really play, in the vocabulary the server's stream route understands.
 *
 * The server normally sends the stored file untouched. A phone's browser does not play everything a PC's does
 * (iOS Safari has no Opus, some browsers no FLAC), so the player tells the server which source kinds it can play
 * and the stream route transcodes to AAC when the file is not one of them (server/src/play/stream.ts).
 */
export type SourceKind = 'flac' | 'mp3' | 'aac' | 'm4a' | 'wav' | 'aiff' | 'vorbis' | 'opus' | 'wma';

/** A `?accept=` list: what the server may send as-is. */
export function acceptedParam(kinds: readonly SourceKind[]): string {
  return kinds.join(',');
}

/**
 * Probe a media element (`el.canPlayType`) for each source kind. AAC is included whenever an AAC/MP4 container is
 * claimed: it is the server's transcode output, so a browser that cannot take it would get nothing usable at all.
 */
export function playableFormats(canPlayType: (mime: string) => string): SourceKind[] {
  const can = (mime: string): boolean => {
    try {
      return !!canPlayType(mime);
    } catch {
      return false;
    }
  };
  const mp3 = can('audio/mpeg');
  const mp4 = can('audio/mp4') || can('audio/mp4; codecs="alac"');
  const aac = can('audio/aac') || mp4;
  const out: SourceKind[] = [];
  if (mp3) out.push('mp3');
  if (aac) out.push('aac');
  if (mp4) out.push('m4a');
  if (can('audio/flac')) out.push('flac');
  if (can('audio/wav') || can('audio/wave') || can('audio/x-wav')) out.push('wav');
  if (can('audio/aiff') || can('audio/x-aiff')) out.push('aiff');
  if (can('audio/ogg; codecs="vorbis"') || can('audio/ogg')) out.push('vorbis');
  if (can('audio/ogg; codecs="opus"') || can('audio/opus')) out.push('opus');
  if (can('audio/x-ms-wma')) out.push('wma');
  // No answer at all (a very old/limited element): assume the universally supported basics rather than the original.
  return out.length ? out : ['mp3', 'aac', 'm4a'];
}

/** The accepted-source list for this page; null when there is no DOM to probe (tests, SSR). */
export function browserAcceptedFormats(): string | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  try {
    const el = document.createElement('audio');
    return acceptedParam(playableFormats((mime) => el.canPlayType(mime)));
  } catch {
    return null;
  }
}
