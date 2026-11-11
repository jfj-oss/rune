// Fictional fixture library for mock mode. All artists, albums and quotes are invented.
import type { Album, AlbumDetails, AlbumSummary, Artist, ArtistRef, Credit, Source, Track } from '@liner/shared';
import { hashString } from '../lib/color';
import type { MatchCandidate } from '../lib/types';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hex16 = (s: string) => (hashString(s).toString(16).padStart(8, '0') + hashString(s + '#').toString(16).padStart(8, '0')).slice(0, 16);
const wikiSearch = (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`;
const DAY = 86_400_000;
const NOW = Date.now();

// ---------- artists ----------
const ARTIST_NAMES = [
  'Aster Vale', 'The Marlowe Tides', 'Juniper Kane', 'Okonkwo & The Lantern Orchestra',
  'Velvet Static', 'Hollis Brandt', 'Mira Solenne', 'Dust Cartel', 'Nadia Orlova Quartet',
  'Paper Satellites', 'Cobalt Meridian', 'Rue Delacroix', 'The Ferrous Choir', 'Tomás Ibarra',
  'Lena Wirth', 'Barrow & Finch',
] as const;

export const artistRefs: ArtistRef[] = ARTIST_NAMES.map((name) => ({ id: 'ar:n:' + hex16(name), name }));
const A = (i: number): ArtistRef => artistRefs[i] as ArtistRef;

const BIOS: Record<number, string> = {
  0: 'Aster Vale emerged from the harbour towns of the north in the mid-1970s, a songwriter whose long, patient melodies and weather-worn baritone made her the quiet centre of a loose circle of session players. Her records were assembled slowly, often live to tape, and favour lyrics about distance, work and returning home. After a long silence in the 1980s she resumed recording in a converted lighthouse studio, and the late albums are among her most adventurous.',
  1: 'The Marlowe Tides formed in 1973 as a four-piece rooted in close harmonies and shimmering twelve-string guitars. Over six albums they moved from pastoral folk-rock toward a lusher, string-laden sound, and their live shows became known for unhurried extended arrangements of the studio material.',
  2: 'Juniper Kane writes spare, fingerpicked folk songs about migration, orchards and small-town grudges. Self-produced and recorded mostly in barns and church halls, her albums have the room tone of the places they were made.',
  3: 'A rotating eleven-piece band led by the composer and saxophonist Ade Okonkwo, the Lantern Orchestra blends big-band writing with West African highlife rhythms and long modal improvisations.',
  4: 'Velvet Static make taut, melancholy synth-pop built on drum machines and a battered analogue polysynth. Their 1984 debut was a minor club hit, and their reputation has grown steadily since.',
  6: 'Mira Solenne is a pianist and composer known for patient, resonant interpretations of twentieth-century repertoire as well as her own minimalist miniatures.',
  8: 'The Nadia Orlova Quartet came together in a Prague cellar club in 1992. Orlova\'s dark-toned piano and the quartet\'s unhurried interplay anchor a catalogue of originals and radically slowed standards.',
  10: 'Paper Satellites are a four-piece indie band whose bright, jangling guitars sit on top of unexpectedly dense arrangements. Their records are home-recorded and meticulously layered.',
};

const SIMILAR: Record<number, number[]> = {
  0: [1, 5, 2], 1: [0, 2, 12], 2: [0, 5, 15], 3: [8, 13], 4: [14, 10, 11], 5: [0, 2, 15],
  6: [8, 10], 7: [14, 4], 8: [3, 6], 9: [4, 10, 12], 10: [9, 12, 4], 11: [6, 13],
  12: [10, 9, 1], 13: [3, 11], 14: [4, 10, 7], 15: [2, 5, 0],
};

// ---------- albums ----------
type Fmt = 'FLAC 24/96' | 'FLAC 16/44.1' | 'FLAC 24/192' | 'MP3 320' | 'FLAC 24/48';
interface Seed {
  artist: number; title: string; year: number; genres: string[]; label: string;
  fmt?: Fmt; source?: Source; /** Spotify catalogue album the user has NOT saved */ catalog?: boolean; tracks?: number; discs?: number; special?: 'full' | 'multi' | 'lowconf'; addedDaysAgo?: number;
}
const SEEDS: Seed[] = [
  { artist: 0, title: 'Glass Harbour', year: 1977, genres: ['Rock', 'Soft Rock'], label: 'Northlight Records', fmt: 'FLAC 24/96', tracks: 10, special: 'full', addedDaysAgo: 2 },
  { artist: 0, title: 'Tidewater', year: 1975, genres: ['Folk Rock'], label: 'Northlight Records', fmt: 'FLAC 16/44.1', tracks: 9, addedDaysAgo: 60 },
  { artist: 0, title: 'The Lighthouse Sessions', year: 1991, genres: ['Singer-Songwriter'], label: 'Keeper Sound', fmt: 'FLAC 24/96', tracks: 11, addedDaysAgo: 41 },
  { artist: 1, title: 'Long Division', year: 1974, genres: ['Folk Rock', 'Psychedelic'], label: 'Meridian Gramophone', fmt: 'FLAC 24/96', special: 'multi', discs: 2, tracks: 12, addedDaysAgo: 4 },
  { artist: 1, title: 'Salt and Silver', year: 1972, genres: ['Folk Rock'], label: 'Meridian Gramophone', fmt: 'FLAC 16/44.1', tracks: 10, addedDaysAgo: 120 },
  { artist: 1, title: 'Sundial Weather', year: 1978, genres: ['Folk Rock', 'Pop'], label: 'Meridian Gramophone', fmt: 'MP3 320', tracks: 9, addedDaysAgo: 18 },
  { artist: 2, title: 'Orchard Hymn', year: 2016, genres: ['Folk'], label: 'Barnyard Tapes', fmt: 'FLAC 24/48', tracks: 12, addedDaysAgo: 9 },
  { artist: 2, title: 'What the Ferry Knows', year: 2019, genres: ['Folk', 'Americana'], label: 'Barnyard Tapes', fmt: 'FLAC 24/96', tracks: 10, addedDaysAgo: 30 },
  { artist: 3, title: 'Lantern Suite', year: 1996, genres: ['Jazz', 'Highlife'], label: 'Harmattan', fmt: 'FLAC 16/44.1', tracks: 8, addedDaysAgo: 75 },
  { artist: 3, title: 'Night Market', year: 2003, genres: ['Jazz', 'Afrobeat'], label: 'Harmattan', fmt: 'FLAC 24/96', tracks: 9, addedDaysAgo: 140 },
  { artist: 4, title: 'Static Bloom', year: 1984, genres: ['Synth-pop', 'New Wave'], label: 'Cold Wire', fmt: 'FLAC 16/44.1', tracks: 9, addedDaysAgo: 14 },
  { artist: 4, title: 'Neon Lullabies', year: 1986, genres: ['Synth-pop'], label: 'Cold Wire', fmt: 'FLAC 16/44.1', tracks: 10, addedDaysAgo: 22 },
  { artist: 4, title: 'Remote Control Heart', year: 1988, genres: ['Synth-pop', 'Electronic'], label: 'Cold Wire', fmt: 'MP3 320', tracks: 9, addedDaysAgo: 51 },
  { artist: 5, title: 'Rooms I Left', year: 2008, genres: ['Singer-Songwriter'], label: 'Small Hours', fmt: 'FLAC 24/96', tracks: 11, addedDaysAgo: 6 },
  { artist: 5, title: 'Low Sun, High Water', year: 2012, genres: ['Singer-Songwriter', 'Folk'], label: 'Small Hours', fmt: 'FLAC 24/96', tracks: 10, addedDaysAgo: 70 },
  { artist: 6, title: 'Resonance Studies', year: 2014, genres: ['Classical', 'Minimalism'], label: 'Sostenuto', fmt: 'FLAC 24/192', tracks: 14, addedDaysAgo: 11 },
  { artist: 6, title: 'Nocturnes for a Quiet House', year: 2021, genres: ['Classical'], label: 'Sostenuto', fmt: 'FLAC 24/192', tracks: 12, addedDaysAgo: 33 },
  { artist: 7, title: 'Concrete Orchard', year: 2018, genres: ['Hip-Hop'], label: 'Underpass', fmt: 'FLAC 16/44.1', tracks: 14, addedDaysAgo: 3 },
  { artist: 7, title: 'Bus Fare', year: 2020, genres: ['Hip-Hop', 'Soul'], label: 'Underpass', fmt: 'MP3 320', tracks: 13, addedDaysAgo: 80 },
  { artist: 8, title: 'Slow Standards', year: 1998, genres: ['Jazz'], label: 'Cellar Door', fmt: 'FLAC 24/96', tracks: 8, addedDaysAgo: 100 },
  { artist: 8, title: 'Prague Midnight', year: 2005, genres: ['Jazz'], label: 'Cellar Door', fmt: 'FLAC 24/96', tracks: 9, addedDaysAgo: 5 },
  { artist: 9, title: 'Orbit Decay Is Fine', year: 2011, genres: ['Indie Rock'], label: 'Cardboard Moon', fmt: 'FLAC 16/44.1', tracks: 11, addedDaysAgo: 12 },
  { artist: 9, title: 'Everyone Is a Weather Station', year: 2015, genres: ['Indie Rock', 'Dream Pop'], label: 'Cardboard Moon', fmt: 'FLAC 24/48', tracks: 12, addedDaysAgo: 26 },
  { artist: 9, title: 'Lo-Fi Constellations', year: 2022, genres: ['Indie Rock'], label: 'Cardboard Moon', fmt: 'FLAC 24/48', tracks: 10, addedDaysAgo: 1 },
  { artist: 10, title: 'Fathom', year: 2017, genres: ['Ambient'], label: 'Slow Light', fmt: 'FLAC 24/96', tracks: 7, addedDaysAgo: 8 },
  { artist: 10, title: 'Deep Time Index', year: 2020, genres: ['Ambient', 'Drone'], label: 'Slow Light', fmt: 'FLAC 24/96', tracks: 6, addedDaysAgo: 45 },
  { artist: 11, title: 'Boulevard des Ombres', year: 1969, genres: ['Chanson'], label: 'Disques Lumière', fmt: 'FLAC 16/44.1', tracks: 12, addedDaysAgo: 160 },
  { artist: 11, title: 'Café, Encore', year: 1971, genres: ['Chanson', 'Pop'], label: 'Disques Lumière', fmt: 'FLAC 16/44.1', tracks: 11, addedDaysAgo: 150 },
  { artist: 12, title: 'We Were Always Building Something', year: 2009, genres: ['Post-Rock'], label: 'Furnace Audio', fmt: 'FLAC 24/96', tracks: 6, addedDaysAgo: 19 },
  { artist: 12, title: 'Foundry Hymns', year: 2013, genres: ['Post-Rock'], label: 'Furnace Audio', fmt: 'FLAC 24/96', tracks: 7, addedDaysAgo: 55 },
  { artist: 13, title: 'Sol de Medianoche', year: 2001, genres: ['Latin', 'Bolero'], label: 'Cascada', fmt: 'FLAC 16/44.1', tracks: 11, addedDaysAgo: 90 },
  { artist: 14, title: 'Pattern Recognition', year: 2019, genres: ['Electronic', 'IDM'], label: 'Grid Lines', fmt: 'FLAC 24/48', tracks: 10, addedDaysAgo: 7 },
  { artist: 14, title: 'Signals from the Basement', year: 2023, genres: ['Electronic'], label: 'Grid Lines', fmt: 'FLAC 24/48', tracks: 9, addedDaysAgo: 2 },
  { artist: 15, title: 'Dust on the Dashboard', year: 1982, genres: ['Country'], label: 'Prairie Wire', fmt: 'FLAC 16/44.1', tracks: 10, addedDaysAgo: 130 },
  { artist: 5, title: 'Unlabelled Rip (Disc 1)', year: 2010, genres: ['Singer-Songwriter'], label: 'Small Hours', fmt: 'MP3 320', tracks: 9, special: 'lowconf', addedDaysAgo: 0 },
  // Spotify
  { artist: 0, title: 'Glass Harbour (Live at Dunmore)', year: 2019, genres: ['Rock'], label: 'Northlight Records', source: 'spotify', tracks: 11, addedDaysAgo: 20 },
  { artist: 14, title: 'Ghost Frequencies', year: 2024, genres: ['Electronic'], label: 'Grid Lines', source: 'spotify', tracks: 10, addedDaysAgo: 3 },
  { artist: 9, title: 'Glow in the Garage', year: 2024, genres: ['Indie Rock'], label: 'Cardboard Moon', source: 'spotify', tracks: 11, addedDaysAgo: 10 },
  { artist: 2, title: 'Three Winters', year: 2024, genres: ['Folk'], label: 'Barnyard Tapes', source: 'spotify', tracks: 9, addedDaysAgo: 15 },
  { artist: 7, title: 'Terminal Velocity', year: 2024, genres: ['Hip-Hop'], label: 'Underpass', source: 'spotify', tracks: 12, addedDaysAgo: 40 },
  { artist: 12, title: 'Embers of the Long Night', year: 2025, genres: ['Post-Rock'], label: 'Furnace Audio', source: 'spotify', tracks: 6, addedDaysAgo: 5 },
  // Spotify catalogue (appears in search, not saved)
  { artist: 0, title: 'Glass Harbour (Deluxe Edition)', year: 2022, genres: ['Rock'], label: 'Northlight Records', source: 'spotify', catalog: true, tracks: 14, addedDaysAgo: 0 },
  { artist: 0, title: 'Northern Cross EP', year: 2023, genres: ['Folk Rock'], label: 'Northlight Records', source: 'spotify', catalog: true, tracks: 5, addedDaysAgo: 0 },
  { artist: 14, title: 'Ghost Frequencies Remixed', year: 2025, genres: ['Electronic'], label: 'Grid Lines', source: 'spotify', catalog: true, tracks: 8, addedDaysAgo: 0 },
  { artist: 9, title: 'Glow in the Garage (Live Sessions)', year: 2025, genres: ['Indie Rock'], label: 'Cardboard Moon', source: 'spotify', catalog: true, tracks: 9, addedDaysAgo: 0 },
];
const CATALOG_TITLES = new Set(SEEDS.filter((x) => x.catalog).map((x) => x.title));

export const WORD_A = ['Paper', 'Winter', 'Velvet', 'Copper', 'Slow', 'Hollow', 'Midnight', 'Salt', 'Glass', 'Quiet', 'Burning', 'Distant', 'Amber', 'Paper', 'Second', 'Iron', 'Soft', 'Last', 'Blue', 'Open'];
export const WORD_B = ['Radio', 'Harbour', 'Garden', 'Signal', 'Letters', 'Weather', 'Window', 'Parade', 'Orchard', 'Hours', 'Machine', 'Season', 'Road', 'Lights', 'Rooms', 'Mirror', 'Fever', 'Tide', 'Kite', 'Theory'];

const GLASS_HARBOUR_TRACKS: [string, number][] = [
  ['Low Tide at Dunmore', 258_000], ['Signal Fires', 241_000], ['Glass Harbour', 312_000], ['Letters Never Sent', 223_000],
  ['Salt in the Wiring', 267_000], ['Northern Cross', 289_000], ['The Fisherman\'s Daughter', 204_000], ['Weather for Leaving', 236_000],
  ['Foghorn Lullaby', 188_000], ['Last Boat Home', 331_000],
];

function makeTracks(albumId: string, seed: Seed, artist: ArtistRef): Track[] {
  const r = rng(hashString(albumId));
  const n = seed.tracks ?? 10;
  const discs = seed.discs ?? 1;
  const perDisc = Math.ceil(n / discs);
  const out: Track[] = [];
  const titles = new Set<string>();
  for (let i = 0; i < n; i++) {
    let title: string;
    if (seed.special === 'full') title = (GLASS_HARBOUR_TRACKS[i] as [string, number])[0];
    else do { title = `${WORD_A[Math.floor(r() * WORD_A.length)]} ${WORD_B[Math.floor(r() * WORD_B.length)]}`; } while (titles.has(title));
    titles.add(title);
    const disc = Math.floor(i / perDisc) + 1;
    const duration = seed.special === 'full' ? (GLASS_HARBOUR_TRACKS[i] as [string, number])[1] : Math.round((140 + r() * 260) * 1000);
    const local = seed.source !== 'spotify';
    const t: Track = {
      id: (local ? 'l:' : 'sp:') + hex16(albumId + '/' + i),
      albumId, source: local ? 'local' : 'spotify', title, artists: [artist], disc, number: (i % perDisc) + 1, durationMs: duration,
    };
    if (local) {
      const f = seed.fmt ?? 'FLAC 16/44.1';
      if (f.startsWith('MP3')) { t.format = 'mp3'; t.bitrateKbps = 320; t.sampleRate = 44100; }
      else {
        t.format = 'flac';
        const [bd, sr] = f.replace('FLAC ', '').split('/');
        t.bitDepth = Number(bd);
        t.sampleRate = Math.round(Number(sr) * 1000);
      }
    } else t.spotifyUri = 'spotify:track:' + hex16(albumId + i);
    out.push(t);
  }
  // a couple of features on tracks for "Artist if differs"
  if (seed.special === 'full') {
    out[4] = { ...(out[4] as Track), artists: [artist, A(5)] };
    out[6] = { ...(out[6] as Track), artists: [A(2)] };
  }
  return out;
}

export const FULL_ALBUM_ID = 'la:' + hex16('glass-harbour');
export const MULTI_ALBUM_ID = 'la:' + hex16('long-division');
export const LOWCONF_ALBUM_ID = 'la:' + hex16('unlabelled-rip');

const albumsFull: Album[] = SEEDS.map((s, idx) => {
  const artist = A(s.artist);
  const source: Source = s.source ?? 'local';
  const id = s.special === 'full' ? FULL_ALBUM_ID : s.special === 'multi' ? MULTI_ALBUM_ID : s.special === 'lowconf' ? LOWCONF_ALBUM_ID
    : (source === 'spotify' ? 'sp:' + hex16(s.title + idx) : 'la:' + hex16(s.title + artist.name));
  const tracks = makeTracks(id, s, artist);
  const r = rng(hashString(id + 'c'));
  const fmt = source === 'spotify' ? 'Spotify' : (s.fmt ?? 'FLAC 16/44.1');
  const credits: Credit[] = [];
  if (s.special !== 'full') {
    const pool = [8, 13, 15, 3, 9, 14, 6, 12].map((i) => A(i % artistRefs.length));
    credits.push({ artist: pool[Math.floor(r() * pool.length)] as ArtistRef, role: 'Producer' });
    credits.push({ artist: artist, role: 'Lead Vocals' });
    credits.push({ artist: pool[Math.floor(r() * pool.length)] as ArtistRef, role: 'Mixing Engineer' });
    credits.push({ artist: artist, role: 'Composer' });
  }
  const releaseYear = s.year;
  const a: Album = {
    id, source, title: s.title, artist, year: releaseYear, format: fmt,
    addedAt: NOW - (s.addedDaysAgo ?? idx) * DAY - (idx % 7) * 3_600_000,
    tracks, genres: s.genres, label: s.label,
    releaseDate: `${releaseYear}-${String(1 + (hashString(id) % 12)).padStart(2, '0')}`,
    credits, matchConfidence: source === 'spotify' ? undefined : s.special === 'lowconf' ? 0.42 : 0.82 + (hashString(id) % 18) / 100,
    folderPath: source === 'local' ? `/music/library/${artist.name}/${s.title}` : undefined,
  };
  if (s.special === 'full') {
    const t = (n: number) => (tracks[n - 1] as Track).id;
    const person = (name: string): ArtistRef => ({ id: 'ar:n:' + hex16(name), name });
    a.credits = [
      { artist: artist, role: 'Lead Vocals' }, { artist: artist, role: 'Acoustic Guitar' },
      { artist: person('Ronan Teague'), role: 'Electric Guitar' }, { artist: person('Ronan Teague'), role: 'Slide Guitar', trackIds: [t(3), t(6)] },
      { artist: person('Marguerite Osei'), role: 'Bass' }, { artist: person('Davin Holloway'), role: 'Drums' },
      { artist: person('Davin Holloway'), role: 'Percussion', trackIds: [t(2), t(5), t(8)] },
      { artist: person('Ilse Brandvold'), role: 'Piano' }, { artist: person('Ilse Brandvold'), role: 'Rhodes', trackIds: [t(4), t(9)] },
      { artist: person('Tobias Quill'), role: 'Violin', trackIds: [t(3), t(10)] }, { artist: person('Tobias Quill'), role: 'String Arrangement', trackIds: [t(3), t(10)] },
      { artist: A(5), role: 'Backing Vocals', trackIds: [t(5)] }, { artist: person('Odette Marchetti'), role: 'Harmony Vocals', trackIds: [t(2), t(8)] },
      { artist: person('Wilhelmina Cray'), role: 'Producer' }, { artist: artist, role: 'Producer' },
      { artist: person('Joaquin Ferreira'), role: 'Recording Engineer' }, { artist: person('Joaquin Ferreira'), role: 'Mixing Engineer' },
      { artist: person('Priya Lindqvist'), role: 'Mastering Engineer' }, { artist: person('Cass Ellory'), role: 'Assistant Engineer' },
      { artist: artist, role: 'Composer' }, { artist: artist, role: 'Lyricist' },
      { artist: person('Ronan Teague'), role: 'Composer', trackIds: [t(6)] }, { artist: person('Ilse Brandvold'), role: 'Composer', trackIds: [t(9)] },
    ];
  }
  if (s.special === 'multi') a.credits = a.credits.concat([{ artist: A(8), role: 'Piano', trackIds: [(tracks[5] as Track).id] }]);
  return a;
});

export const ALBUMS: Album[] = albumsFull;
/** Mock "Spotify catalogue" albums: reachable via search, not in the user's library until saved. */
export const CATALOG_IDS = new Set(ALBUMS.filter((a) => CATALOG_TITLES.has(a.title) && a.source === 'spotify').map((a) => a.id));

export function toSummary(a: Album): AlbumSummary {
  return { id: a.id, source: a.source, title: a.title, artist: a.artist, year: a.year, coverUrl: a.coverUrl, format: a.format, addedAt: a.addedAt };
}
export const SUMMARIES: AlbumSummary[] = ALBUMS.map(toSummary);

// ---------- details ----------
export const DETAILS: Record<string, AlbumDetails> = {
  [FULL_ALBUM_ID]: {
    albumId: FULL_ALBUM_ID,
    reception: {
      value:
        'Glass Harbour was widely praised on release for its unhurried arrangements and the clarity of Vale\'s writing. Contemporary critics singled out the title track and "Last Boat Home" as high points, with several noting how the sparse string writing left space for the lyrics. Writing in The Harbour Review, M. Calloway called it "patient, plain-spoken, and quietly devastating in the last third", while Wireless Weekly praised the way the strings arrive and leave without overstaying. Tone Quarterly was more reserved, finding the record "occasionally too polite for its own good" but conceding that "Last Boat Home" alone justified the price of admission.\n\nSome reviewers found the second side too restrained, and a minority felt the production sat closer to the soft rock of the period than the rougher sound of her debut. Retrospective assessments have been more generous: in later reappraisals the album was frequently placed among the best records of its year, and its patient pacing is now cited as an influence on a generation of singer-songwriters. At Metacritic, which assigns a weighted average score out of 100 to reviews from mainstream critics, the album holds a score of 84 based on 12 reviews, indicating "universal acclaim". Album of the Year lists an aggregate user and critic score of 79, and Pitchfork gave a retrospective 8.1 out of 10 on the occasion of the remaster.\n\nThe album reached the national top twenty and was certified silver within a year, and a remastered edition issued in 2012 drew a fresh round of positive notices. Its reputation has only grown since, with critics returning to the way the arrangements breathe, the quiet authority of the vocal performances, and the unusual cohesion of a record assembled over many months of intermittent sessions. Later writers have pointed to the liner notes, in which Vale describes recording most of the vocals alone at night, as a key to its hushed, intimate atmosphere.\n\nIn a 2019 retrospective, The Long Player described it as "the sound of a songwriter fully in command of a very small palette", and the album has since appeared on several lists of the finest albums of the decade. Its two singles, "Glass Harbour" and "Last Boat Home", were both reissued as a double A-side on 7-inch vinyl.',
      source: 'Wikipedia', url: wikiSearch('Glass Harbour Aster Vale album'),
    },
    scores: [
      { outlet: 'Metacritic', score: 84, scale: 100, url: 'https://www.metacritic.com/search/glass%20harbour/', reviewCount: 12 },
      { outlet: 'Album of the Year', score: 79, scale: 100, url: 'https://www.albumoftheyear.org/search/?q=glass+harbour', reviewCount: 340 },
      { outlet: 'Pitchfork', score: 8.1, scale: 10, url: 'https://pitchfork.com/search/?query=glass%20harbour' },
      // a long tail of outlets, like a real well-reviewed album (also exercises the compact score summary)
      ...([['AllMusic', 4, 5], ['Rolling Stone', 4, 5], ['Chicago Tribune', 3, 4], ['Daily News', 4, 5], ['Entertainment Weekly', 3.8, 5], ['Houston Chronicle', 3.5, 5], ['Los Angeles Times', 2, 4], ['NME', 9, 10], ['Spin', 6, 10], ['Mojo', 3, 5], ['Q', 2, 5], ['Uncut', 8, 10], ['The Guardian', 4, 5], ['PopMatters', 5, 10], ['Slant Magazine', 3, 5], ['Paste', 7.4, 10]] as [string, number, number][]).map(([outlet, score, scale]): AlbumDetails['scores'][number] => ({ outlet, score, scale, url: `https://example.org/scores/${encodeURIComponent(outlet)}` })),
    ],
    quotes: [
      // the same sentence the reception text already prints: the page must not show it twice
      { outlet: 'Tone Quarterly', url: 'https://example.org/reviews/glass-harbour-5', quote: 'Contemporary critics singled out the title track and "Last Boat Home" as high points' },
      { outlet: 'The Harbour Review', author: 'M. Calloway', url: 'https://example.org/reviews/glass-harbour-1', quote: 'A record that sounds like it was written while looking out at the water — patient, plain-spoken, and quietly devastating in the last third.' },
      { outlet: 'Wireless Weekly', author: 'D. Okafor', url: 'https://example.org/reviews/glass-harbour-2', quote: 'Vale never raises her voice and never needs to. The strings arrive exactly when you want them and leave before they overstay.' },
      { outlet: 'Tone Quarterly', author: 'S. Lindgren', url: 'https://example.org/reviews/glass-harbour-3', quote: 'Occasionally too polite for its own good, but "Last Boat Home" alone would justify the price of admission.' },
      { outlet: 'The Long Player', url: 'https://example.org/reviews/glass-harbour-4', quote: 'The sound of a songwriter fully in command of a very small palette.' },
    ],
    background: {
      value:
        'Glass Harbour was recorded over eleven weeks in the winter of 1976–77 at a converted net loft above the quay in Dunmore, chosen because Vale wanted "a room that remembered boats". Most of the album was cut live with the band in a single room, with vocals redone alone late at night once the others had gone home. The string parts were written by Tobias Quill on the train up from the city and rehearsed in the loft the day before they were recorded. The cover photograph was taken from the studio window on the last morning of the sessions.',
      source: 'Wikipedia', url: wikiSearch('Glass Harbour Aster Vale recording'),
    },
    artistNotes: [
      { value: 'I wanted every song on this record to sound like it could be sung to one person in a quiet room. If you can hear the room, that is the point. The loft had a sag in the floor near the window and I stood on the high side for every vocal, which I think you can hear in the way the phrases lean.', source: 'Genius', url: 'https://genius.com/albums/Aster-vale/Glass-harbour', verifiedArtist: true },
      { value: '"Last Boat Home" is about my father\'s last winter on the water. He never said goodbye to the boat, he just stopped going down to the quay one morning. The song is only the walk he did not take.', source: 'Genius', url: 'https://genius.com/Aster-vale-last-boat-home-lyrics', verifiedArtist: true, trackId: (ALBUMS[0]?.tracks[9] as Track).id },
      { value: 'The title track started as a joke about the harbour master\'s windows, which were always spotless. By the third verse it was not a joke any more. Ronan found the slide part in one take and we never touched it.', source: 'Genius', url: 'https://genius.com/Aster-vale-glass-harbour-lyrics', verifiedArtist: false, trackId: (ALBUMS[0]?.tracks[2] as Track).id },
    ],
    fetchedAt: NOW - 3 * DAY,
  },
  [MULTI_ALBUM_ID]: {
    albumId: MULTI_ALBUM_ID,
    reception: {
      value: 'Long Division was the Marlowe Tides\' most ambitious release, a double album that stretched their harmonies over side-long suites. Critics at the time were divided: some admired the scale, others found the second disc indulgent. It has since been reassessed as the band\'s peak.',
      source: 'Wikipedia', url: wikiSearch('Long Division Marlowe Tides album'),
    },
    scores: [{ outlet: 'Album of the Year', score: 72, scale: 100, url: 'https://www.albumoftheyear.org/search/?q=long+division', reviewCount: 58 }],
    quotes: [], artistNotes: [], fetchedAt: NOW - 20 * DAY,
  },
};

export const CANDIDATES: MatchCandidate[] = [
  { musicbrainzReleaseId: '3f7b2c1e-5a31-4c1f-9a7e-0d1e5a9c2b11', title: 'Rooms I Left', artist: 'Hollis Brandt', year: 2008, trackCount: 11, country: 'US', score: 0.64 },
  { musicbrainzReleaseId: '9c11d2a4-7e55-41b4-b0c3-6a2d7f1e8841', title: 'Rooms I Left (Deluxe Edition)', artist: 'Hollis Brandt', year: 2009, trackCount: 15, country: 'GB', score: 0.58 },
  { musicbrainzReleaseId: 'a24e80f3-d1c9-4e3b-8b52-93fa7a51c7de', title: 'Low Sun, High Water', artist: 'Hollis Brandt', year: 2012, trackCount: 10, country: 'US', score: 0.41 },
  { musicbrainzReleaseId: '11b9c3d7-4a0d-4e6e-95af-2f4c1bb7e3a0', title: 'Unlabelled', artist: 'Various Artists', year: 2010, trackCount: 9, country: 'XW', score: 0.33 },
];

// ---------- artists ----------
export function buildArtist(id: string): Artist | undefined {
  const idx = artistRefs.findIndex((a) => a.id === id);
  // also resolve credit-only people
  const ref = idx >= 0 ? A(idx) : undefined;
  if (!ref) {
    for (const al of ALBUMS) for (const c of al.credits) if (c.artist.id === id) {
      const appears = ALBUMS.filter((x) => x.credits.some((cc) => cc.artist.id === id)).map(toSummary);
      return { id, name: c.artist.name, albums: [], appearsOn: appears, similar: [] };
    }
    return undefined;
  }
  const bio = BIOS[idx];
  return {
    id, name: ref.name,
    bio: bio ? { value: bio, source: 'Wikipedia', url: wikiSearch(ref.name) } : undefined,
    albums: ALBUMS.filter((a) => a.artist.id === id).map(toSummary).sort((x, y) => (y.year ?? 0) - (x.year ?? 0)),
    appearsOn: ALBUMS.filter((a) => a.artist.id !== id && (a.credits.some((c) => c.artist.id === id) || a.tracks.some((t) => t.artists.some((x) => x.id === id)))).map(toSummary),
    similar: (SIMILAR[idx] ?? []).map((i) => A(i)),
  };
}
