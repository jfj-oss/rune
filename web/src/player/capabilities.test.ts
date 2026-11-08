import { describe, expect, it } from 'vitest';
import { acceptedParam, playableFormats } from './capabilities';

/** A canPlayType probe that answers like a given browser: the mimes in `plays` get 'probably'. */
function probe(plays: string[]): (mime: string) => string {
  const can = (mime: string) => plays.some((p) => mime === p || mime.startsWith(`${p};`));
  return (mime) => (can(mime) ? 'probably' : '');
}

describe('playableFormats', () => {
  it('lists what a desktop browser plays (FLAC and Opus included)', () => {
    const kinds = playableFormats(
      probe(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/wav', 'audio/ogg']),
    );
    expect(kinds).toEqual(['mp3', 'aac', 'm4a', 'flac', 'wav', 'vorbis', 'opus']);
  });

  it('lists what iOS Safari plays: no FLAC, Opus or WMA', () => {
    const kinds = playableFormats(
      probe(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/aiff']),
    );
    expect(kinds).toEqual(['mp3', 'aac', 'm4a', 'wav', 'aiff']);
    expect(kinds).not.toContain('flac');
    expect(kinds).not.toContain('opus');
    expect(kinds).not.toContain('wma');
  });

  it('treats MP4 support as AAC and M4A support, since AAC is what the server transcodes to', () => {
    expect(playableFormats(probe(['audio/mp4']))).toEqual(['aac', 'm4a']);
  });

  it('falls back to the universally supported basics when the element answers nothing', () => {
    expect(playableFormats(() => '')).toEqual(['mp3', 'aac', 'm4a']);
  });

  it('survives a probe that throws', () => {
    expect(playableFormats(() => { throw new Error('no media'); })).toEqual(['mp3', 'aac', 'm4a']);
  });
});

describe('acceptedParam', () => {
  it('joins the kinds into the server’s accept= value', () => {
    expect(acceptedParam(['flac', 'mp3', 'aac'])).toBe('flac,mp3,aac');
  });
});
