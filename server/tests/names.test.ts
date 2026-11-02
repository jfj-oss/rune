import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanFolderName, cleanTrackTitle, formatDisplay } from '../src/scan/names.js';

const REAL_FOLDER_NAMES = readFileSync(
  new URL('./real-folder-names.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

describe('cleanFolderName', () => {
  it('never leaves release junk in any real library folder name', () => {
    expect(REAL_FOLDER_NAMES.length).toBeGreaterThan(150);
    for (const name of REAL_FOLDER_NAMES) {
      const cleaned = cleanFolderName(name);
      const text = `${cleaned.artist ?? ''} ${cleaned.album ?? ''}`;
      expect(text, name).not.toMatch(/[\[\]{}]/);
      expect(text, name).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, name).not.toMatch(/\b(?:flac|kbps|pmedia)\b/i);
    }
  });

  const cases: [string, { artist?: string; album?: string; year?: number }][] = [
    [
      'Daft Punk - Discovery (2001) [FLAC] 88',
      { artist: 'Daft Punk', album: 'Discovery', year: 2001 },
    ],
    [
      '(1976) The Stills-Young Band - Long May You Run [FLAC]',
      { artist: 'The Stills-Young Band', album: 'Long May You Run', year: 1976 },
    ],
    [
      'Air - Moon Safari Rarities (25th Anniversary Edition) (2024) [16Bit-44.1kHz] FLAC [PMEDIA] ⭐️',
      {
        artist: 'Air',
        album: 'Moon Safari Rarities (25th Anniversary Edition)',
        year: 2024,
      },
    ],
    [
      'Bob Marley & The Wailers - Survival (1979)',
      { artist: 'Bob Marley & The Wailers', album: 'Survival', year: 1979 },
    ],
    [
      'Bob Marley and the Wailers - Legend The Best Of (2002) FLAC Soup',
      { artist: 'Bob Marley and the Wailers', album: 'Legend The Best Of', year: 2002 },
    ],
    [
      'Andy Gibb - Flowing Rivers - Shadow Dancing - (2007)-[FLAC]-[TFM]',
      { artist: 'Andy Gibb', album: 'Flowing Rivers - Shadow Dancing', year: 2007 },
    ],
    [
      'New Order - Low-Life (Definitive) (2023) [24Bit-48kHz] FLAC [PMEDIA] ⭐️]',
      { artist: 'New Order', album: 'Low-Life (Definitive)', year: 2023 },
    ],
    [
      'Red Hot Chili Peppers - (2003) Greatest Hits',
      { artist: 'Red Hot Chili Peppers', album: 'Greatest Hits', year: 2003 },
    ],
    [
      'XTC - 1979 - Drums And Wires (2001 RM)',
      { artist: 'XTC', album: 'Drums And Wires', year: 1979 },
    ],
    [
      'Elton John – To Be Continued... (1990) (4 CD) [FLAC} [rjk]',
      { artist: 'Elton John', album: 'To Be Continued...', year: 1990 },
    ],
    [
      'Daft Punk - Homework (2022 25th Anniversary Edition) [FLAC] 88',
      { artist: 'Daft Punk', album: 'Homework (2022 25th Anniversary Edition)', year: 2022 },
    ],
    ['Ween - Quebec (Jp - 2003)', { artist: 'Ween', album: 'Quebec', year: 2003 }],
    ['JAY Z-The Black Album', { artist: 'JAY Z', album: 'The Black Album' }],
    [
      'a-ha - Hunting High And Low (2010 Deluxe Edition) FLAC 88',
      { artist: 'a-ha', album: 'Hunting High And Low (2010 Deluxe Edition)', year: 2010 },
    ],
    [
      'Glen Campbell - Southern Nights • His Greatest Hits - [FLAC]-[TFM]',
      { artist: 'Glen Campbell', album: 'Southern Nights - His Greatest Hits' },
    ],
    [
      'The Trammps - Disco Inferno (The Trammps Albums 1975-1980) (8CD Box Set) (2022) Mp3 320kbps [PMEDIA] ⭐️',
      { artist: 'The Trammps', album: 'Disco Inferno', year: 2022 },
    ],
    ['A Rock And Roll Alternative', { album: 'A Rock And Roll Alternative' }],
    ['ABBA - 24Bit Vinyl Pack', { artist: 'ABBA' }],
    [
      'CunninLynguists-A_Piece_of_Strange-2005-CMS',
      { artist: 'CunninLynguists', album: 'A Piece of Strange', year: 2005 },
    ],
    [
      'Pink Floyd - The Wall (1979) [VINYL] [24-192 kHz, UK Harvest SHDW 411, 2 LP]',
      { artist: 'Pink Floyd', album: 'The Wall', year: 1979 },
    ],
    [
      'Snoop Dogg - Neva Left (2017) [Mp3~320kbps]',
      { artist: 'Snoop Dogg', album: 'Neva Left', year: 2017 },
    ],
    [
      '1075 1977 - Gerry Rafferty - City To City (DCC GZS-1075)',
      { artist: 'Gerry Rafferty', album: 'City To City', year: 1977 },
    ],
    [
      '1975, 1976. Poco - Head Over Heels, Rose Of Cimarron (2011 Beat Goes On Records, BGOCD 1003, UK)',
      { artist: 'Poco', album: 'Head Over Heels, Rose Of Cimarron', year: 1975 },
    ],
    [
      'Kino - Это не любовь (1985)',
      { artist: 'Kino', album: 'Это не любовь', year: 1985 },
    ],
  ];

  it.each(cases)('parses %s', (input, expected) => {
    expect(cleanFolderName(input)).toEqual(expected);
  });

  it('keeps "and"/"&" inside artist names (never splits them)', () => {
    expect(cleanFolderName('Crosby, Stills, Nash & Young - Déjà Vu (2014)')).toEqual({
      artist: 'Crosby, Stills, Nash & Young',
      album: 'Déjà Vu',
      year: 2014,
    });
  });
});

describe('cleanTrackTitle', () => {
  it('drops leading track numbers and extensions', () => {
    expect(cleanTrackTitle('01 - Down.flac')).toBe('Down');
    expect(cleanTrackTitle('02. Aerodynamic.flac')).toBe('Aerodynamic');
    expect(cleanTrackTitle('Can U Get Away.mp3')).toBe('Can U Get Away');
  });
});

describe('formatDisplay', () => {
  it('renders the display strings used by the UI', () => {
    expect(formatDisplay({ kind: 'flac', sampleRate: 96000, bitDepth: 24 })).toBe('FLAC 24/96');
    expect(formatDisplay({ kind: 'flac', sampleRate: 44100, bitDepth: 16 })).toBe('FLAC 16/44.1');
    expect(formatDisplay({ kind: 'flac', sampleRate: 88200, bitDepth: 24 })).toBe('FLAC 24/88.2');
    expect(formatDisplay({ kind: 'mp3', bitrateKbps: 320 })).toBe('MP3 320');
    expect(formatDisplay({ kind: 'mp3', bitrateKbps: 175 })).toBe('MP3 VBR');
  });
});
