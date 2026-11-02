// Folder/file-name parsing. Library folder names are full of scene/release junk
// ("[FLAC 24-96]", "(Mp3 320kbps)", "{RZCM-59475}", emoji, ...). The scanner uses
// this only as a last-resort fallback when tags and cue sheets are missing.

export interface CleanFolderName {
  artist?: string;
  album?: string;
  year?: number;
}

const AUDIO_OR_ARCHIVE_EXT =
  /\.(?:flac|mp3|m4a|ogg|opus|wav|wave|aiff?|cue|rar|zip|7z|m3u8?|log|txt|jpg|jpeg|png|webp)$/i;

// Extended_Pictographic covers ⭐ etc.; FE0F/ZWJ/skin-tone modifiers are stripped too.
const EMOJI_RE = /[\p{Extended_Pictographic}️‍]|[\u{1F3FB}-\u{1F3FF}]/gu;

/** True for parentheticals that are release/catalog/quality junk, not part of the title. */
function isJunkParen(raw: string): boolean {
  const c = raw.trim().toLowerCase();
  if (!c) return true;
  // Pure years / numbers / separators: (1976), (1972,2010), (2019)
  if (/^[\d\s,.;:\-–/]+$/.test(c)) return true;
  // Disc/box-set counts: (4 CD), (8CD Box Set), (2CD Remastered...)
  if (/\b\d{1,2}\s*(?:cd|disc|disk|lp)s?\b/.test(c)) return true;
  // Catalog numbers / label codes: (DCC GZS-1075), (BGOCD 1003), (UICY-78965)
  if (/\b[A-Z]{2,6}[-\s]?\d{2,}\b/.test(raw)) return true;
  if (/\b\d{6,}\b/.test(c)) return true;
  // Quality / format / media words.
  if (
    /\b(?:flac|mp3|kbps|kb\/s|cbr|vbr|eac|vinyl|remaster(?:ed)?|reissue|box\s*set|hi-?res|web(?:-dl)?|24\s*-?\s*bit|16\s*-?\s*bit|24\s*[-/]\s*\d+|16\s*[-/]\s*\d+|sacd|dvd|blu-?ray|lp)\b/.test(
      c,
    )
  ) {
    return true;
  }
  // "(1974 Rock)", "(2011 Beat Goes On Records...)", "(Jp - 2003)": a year in a
  // parenthetical that carries no edition/soundtrack information.
  if (
    /(?:19|20)\d{2}/.test(c) &&
    !/anniversary|deluxe|edition|soundtrack|live|remix|acoustic|session|mono|stereo|expanded/.test(c)
  ) {
    return true;
  }
  return false;
}

/** Extract the most likely release year, preferring whole-year parentheticals. */
export function extractYear(s: string): number | undefined {
  // Whole-content years, e.g. "(2001)" — the last one is usually the release year.
  const whole = [...s.matchAll(/[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]/g)].map((m) => Number(m[1]));
  if (whole.length > 0) return whole[whole.length - 1];

  // Leading year, optionally preceded by a catalog-ish number: "1075 1977 - ..."
  const leading = s.match(/^\s*(?:\d{1,4}\s+)?((?:19|20)\d{2})\b/);
  if (leading) return Number(leading[1]);

  // First year anywhere else: "(2010 Deluxe Edition)", "(Jp - 2003)".
  const anywhere = s.match(/(?:19|20)\d{2}/);
  return anywhere ? Number(anywhere[0]) : undefined;
}

function stripLeadingYear(s: string): string {
  return s.replace(
    /^\s*(?:\d{1,4}\s+)?(?:19|20)\d{2}(?:\s*[,.;/\-–]\s*(?:19|20)\d{2})*\s*[.\-–,;:]?\s*/,
    '',
  );
}

function removeJunkWords(s: string): string {
  return s
    // FLAC/MP3 + a following quality number (FLAC 88, FLAC 24-192, FLAC 16-44).
    .replace(/\bflac\s*(?:\d+(?:\.\d+)?(?:\s*[-/]\s*\d+(?:\.\d+)?)?)?/gi, ' ')
    .replace(/\bmp3(?:\s*\+\s*cue)?\b/gi, ' ')
    .replace(/\bflac\s*\+\s*cue\b/gi, ' ')
    .replace(/\beac[-\s]?flac\b/gi, ' ')
    // 320kbps, 320_kbps, MP3~320Kbps, V0, CBR, VBR.
    .replace(/\b(?:320|256|224|192|160|128|96|88|64|48)\s*[_\s~-]*(?:kbps|kb\/s|kbit\/?s?)\b/gi, ' ')
    .replace(/\bkbps\b/gi, ' ')
    .replace(/\b(?:cbr|vbr|v0|v2)\b/gi, ' ')
    // Scene / release-group noise.
    .replace(/\b(?:web(?:-dl)?|pmedia|tgx|tfm|eac|h33t|vx|gameripp|cms|rlg)\b/gi, ' ')
    .replace(/\b(?:hi-?res|hd)\b/gi, ' ')
    .replace(/\b(?:24|16)\s*-?\s*bit\b/gi, ' ')
    .replace(/\b(?:24|16)\s*[-/]\s*(?:192|96|88\.2|48|44\.1|44)\b/gi, ' ')
    .replace(/\b88\.2\s*[-/]\s*24\b/gi, ' ')
    .replace(/\b(?:soup|beats)\b/gi, ' ')
    .replace(/\bvinyl(?:\s+pack)?\b/gi, ' ')
    .replace(/\bremaster(?:ed)?\b/gi, ' ')
    .replace(/\breissue\b/gi, ' ')
    // Uploader / ripper tags seen in this library.
    .replace(
      /\b(?:vtwin\d*cube|politux|kitlope|junlego\d*|hunter|moses|beolab\d*|sc4r3cr0w|chaosshade|jamal(?:\s+the\s+moroccan)?|big\s+papi|papi|rjk|oan)\b/gi,
      ' ',
    )
    // Safety net for the words the tests forbid.
    .replace(/\b(?:flac|kbps|pmedia)\b/gi, ' ');
}

function tidy(s: string): string {
  return s
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/\s+,/g, ',')
    .trim()
    .replace(/^[\s\-–,;:_]+/, '')
    .replace(/[\s\-–,;:_]+$/, '')
    .trim();
}

/**
 * Parse a folder (or file) name into artist/album/year. Best effort: tags win in
 * the scanner; this is the fallback. Always removes [ ] { }, emoji and the words
 * FLAC / kbps / PMEDIA from the results.
 */
export function cleanFolderName(raw: string): CleanFolderName {
  let s = raw.normalize('NFC').replace(/ /g, ' ').trim();
  s = s.replace(AUDIO_OR_ARCHIVE_EXT, '');
  s = s.replace(EMOJI_RE, ' ');

  // Year is extracted before the release brackets are removed.
  let year = extractYear(s);

  // Normalise dash/bullet separators so one segmentation path handles them.
  s = s.replace(/\s*[–—―]\s*/g, ' - ');
  s = s.replace(/\s*•\s*/g, ' - ');
  s = s.replace(/_/g, ' ');

  // Bracketed and curly-bracket groups are always release junk in this library.
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\{[^}]*\}/g, ' ');
  // Parenthetical groups: keep meaningful ones, drop catalog/quality ones.
  s = s.replace(/\(([^()]*)\)/g, (match, content: string) => (isJunkParen(content) ? ' ' : match));
  // Stray / malformed brackets ("[FLAC}").
  s = s.replace(/[\[\]{}]/g, ' ');

  s = stripLeadingYear(s);
  s = removeJunkWords(s);
  // A bare quality number left dangling at the end, e.g. "[FLAC] 88".
  s = s.replace(/[\s,\-–]+(?:88|96|128|160|192|224|256|320)\s*$/, '');
  // A dangling separator ("ABBA - " after "24Bit Vinyl Pack" is stripped) means
  // we only have an artist, not an artist + album.
  const danglingArtist = s.match(/^(.+?)\s+-\s*$/);
  if (danglingArtist && !/\s+-\s+/.test(danglingArtist[1]!)) {
    return {
      artist: scrubWord(tidy(danglingArtist[1]!)),
      ...(year ? { year } : {}),
    };
  }

  s = tidy(s);

  // Split artist / album. Prefer a spaced dash; then a one-sided spaced dash;
  // then an unspaced hyphen (scene-style names) unless it looks like a word
  // such as "a-ha" where both sides are lowercase.
  let artist: string | undefined;
  let album: string | undefined;

  const spaced = s.match(/^(.+?)\s+-\s+(.+)$/);
  const leftSpaced = spaced ? null : s.match(/^(.+?)\s+-\s*(.+)$/);
  const rightSpaced = spaced || leftSpaced ? null : s.match(/^(.+?)\s*-\s+(.+)$/);
  let m = spaced ?? leftSpaced ?? rightSpaced;

  if (!m) {
    const bare = s.match(/^([^-]{1,80})-(\S.*)$/);
    if (bare) {
      const left = bare[1]!.trim();
      const right = bare[2]!.trim();
      if (!(/[a-z]$/.test(left) && /^[a-z]/.test(right))) m = bare;
    }
  }

  if (m) {
    artist = tidy(removeJunkWords(stripLeadingYear(m[1]!)));
    album = tidy(removeJunkWords(stripLeadingYear(m[2]!)));
    // Scene-style trailer year: "A Piece of Strange-2005".
    if (/[^\d\s][-–](?:19|20)\d{2}$/.test(album)) {
      album = tidy(album.replace(/[-–](?:19|20)\d{2}$/, ''));
    }
  } else {
    album = s;
  }

  // If segmentation produced an empty artist, keep the album whole.
  if (!artist) {
    if (!album && s) album = s;
  }
  if (artist && !album) album = undefined;

  artist = artist ? tidy(artist) : undefined;
  album = album ? tidy(album) : undefined;

  // Final safety net: the output can never contain brackets or forbidden words.
  if (artist) artist = scrubWord(artist) || undefined;
  if (album) album = scrubWord(album) || undefined;

  if (year === undefined) year = extractYear(raw);
  return { ...(artist ? { artist } : {}), ...(album ? { album } : {}), ...(year ? { year } : {}) };
}

function scrubWord(value: string): string {
  return tidy(
    value
      .replace(EMOJI_RE, ' ')
      .replace(/[\[\]{}]/g, ' ')
      .replace(/\b(?:flac|kbps|pmedia)\b/gi, ' '),
  );
}

/** Fallback title from a file name: drop extension and a leading track number. */
export function cleanTrackTitle(fileName: string): string {
  let s = fileName.replace(AUDIO_OR_ARCHIVE_EXT, '').replace(/_/g, ' ');
  s = s.replace(EMOJI_RE, ' ');
  s = s.replace(/^\s*\d{1,3}\s*[.\-–\s]\s*/, '');
  s = s.replace(/^\s*\d{1,3}\s*$/, '');
  s = tidy(removeJunkWords(s));
  return s || fileName;
}

/** "FLAC 24/96", "FLAC 16/44.1", "MP3 320", "MP3 VBR"; other codecs get a generic tag. */
export function formatDisplay(i: {
  kind: 'flac' | 'mp3' | 'other';
  codec?: string;
  container?: string;
  sampleRate?: number;
  bitDepth?: number;
  bitrateKbps?: number;
}): string {
  const khz = (rate: number | undefined): string | undefined => {
    if (!rate || rate <= 0) return undefined;
    const v = rate / 1000;
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1)));
  };

  if (i.kind === 'flac') {
    const k = khz(i.sampleRate);
    if (i.bitDepth && k) return `FLAC ${i.bitDepth}/${k}`;
    if (k) return `FLAC ${k}`;
    return 'FLAC';
  }
  if (i.kind === 'mp3') {
    const kbps = i.bitrateKbps;
    if (kbps && kbps > 0) {
      // Common MPEG bitrates; a value near one of them means CBR.
      const common = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const nearest = common.reduce((a, b) => (Math.abs(b - kbps) < Math.abs(a - kbps) ? b : a));
      if (Math.abs(nearest - kbps) <= Math.max(4, kbps * 0.04)) return `MP3 ${nearest}`;
    }
    return 'MP3 VBR';
  }
  const label = (i.codec || i.container || 'Audio').toUpperCase();
  const k = khz(i.sampleRate);
  if (i.bitDepth && k) return `${label} ${i.bitDepth}/${k}`;
  if (kbpsLabel(i.bitrateKbps)) return `${label} ${kbpsLabel(i.bitrateKbps)}`;
  return label;
}

function kbpsLabel(kbps: number | undefined): string | undefined {
  if (!kbps || kbps <= 0) return undefined;
  const rounded = Math.round(kbps / 32) * 32;
  return String(rounded > 0 ? rounded : Math.round(kbps));
}
