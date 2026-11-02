import { describe, expect, it } from 'vitest';
import { decodeCue, framesToMs, parseCue } from '../src/scan/cue.js';

const SINGLE_FILE_CUE = `REM COMMENT "Exact Audio Copy"
PERFORMER "Guns N' Roses"
TITLE "Use Your Illusion I"
REM DATE 1991
REM GENRE "Rock"
REM DISCNUMBER 2
FILE "LP1.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Right Next Door To Hell"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Dust N' Bones"
    INDEX 00 03:00:00
    INDEX 01 03:02:00
  TRACK 03 AUDIO
    TITLE "Live And Let Die"
    INDEX 01 08:00:22
`;

describe('parseCue', () => {
  it('parses album fields and single-file tracks', () => {
    const sheet = parseCue(SINGLE_FILE_CUE);
    expect(sheet.title).toBe('Use Your Illusion I');
    expect(sheet.performer).toBe("Guns N' Roses");
    expect(sheet.date).toBe('1991');
    expect(sheet.genre).toBe('Rock');
    expect(sheet.discNumber).toBe(2);
    expect(sheet.files).toHaveLength(1);
    expect(sheet.files[0]!.name).toBe('LP1.flac');
    expect(sheet.tracks).toHaveLength(3);
    expect(sheet.tracks.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(sheet.tracks[0]!.index01Ms).toBe(0);
    expect(sheet.tracks[1]!.index01Ms).toBe(framesToMs(3, 2, 0));
    expect(sheet.tracks[1]!.index00Ms).toBe(framesToMs(3, 0, 0));
    expect(sheet.tracks[2]!.title).toBe('Live And Let Die');
  });

  it('converts cue frames (1/75 s) to milliseconds', () => {
    expect(framesToMs(0, 0, 0)).toBe(0);
    expect(framesToMs(1, 2, 3)).toBe(62040); // (62*75+3) frames * 1000/75
    expect(framesToMs(0, 1, 37)).toBe(1493);
  });

  it('handles CRLF and a UTF-8 BOM', () => {
    const text = '﻿TITLE "Album"\r\nPERFORMER "Artist"\r\nFILE "a.flac" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE "Song"\r\n    INDEX 01 00:00:00\r\n';
    const sheet = parseCue(text);
    expect(sheet.title).toBe('Album');
    expect(sheet.performer).toBe('Artist');
    expect(sheet.tracks[0]!.title).toBe('Song');
  });

  it('assigns INDEX 01 that appears after the next FILE line', () => {
    // EAC writes the pregap of track N under FILE N-1 and the INDEX 01 under
    // FILE N. Those tracks belong to the new FILE.
    const text = `FILE "01.flac" WAVE
  TRACK 01 AUDIO
    TITLE "One"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Two"
    INDEX 00 03:10:00
FILE "02.flac" WAVE
    INDEX 01 00:00:00
`;
    const sheet = parseCue(text);
    expect(sheet.files).toHaveLength(2);
    expect(sheet.files[0]!.tracks.map((t) => t.number)).toEqual([1]);
    expect(sheet.files[1]!.tracks.map((t) => t.number)).toEqual([2]);
    expect(sheet.tracks[1]!.file).toBe('02.flac');
    expect(sheet.tracks[1]!.index01Ms).toBe(0);
  });

  it('handles unquoted TITLE/PERFORMER values', () => {
    const sheet = parseCue('TITLE Album\nPERFORMER Artist\nFILE a.flac WAVE\nTRACK 01 AUDIO\nTITLE Song\nINDEX 01 00:00:00\n');
    expect(sheet.title).toBe('Album');
    expect(sheet.performer).toBe('Artist');
    expect(sheet.tracks[0]!.title).toBe('Song');
  });
});

describe('decodeCue', () => {
  it('decodes UTF-8 with a BOM', () => {
    const text = '﻿TITLE "Café"\n';
    const buf = Buffer.from(text, 'utf8');
    expect(decodeCue(buf)).toBe('TITLE "Café"\n');
  });

  it('falls back to windows-1252 for invalid UTF-8', () => {
    // 0xE9 is "é" in windows-1252 but invalid on its own in UTF-8.
    const buf = Buffer.from('PERFORMER "Caf\xe9"\n', 'latin1');
    expect(decodeCue(buf)).toBe('PERFORMER "Café"\n');
  });
});
