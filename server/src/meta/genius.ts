// Genius: album/song "About" descriptions and artist notes. Genius sits behind
// Cloudflare on some networks; failures are swallowed so the rest of the album
// details still render. Parsers are exported for offline fixture tests.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Sourced } from '@liner/shared';
import type { CachedHttp } from './http.js';
import { cleanText, geniusSlug, namesMatch, normalizeTitle, titleSimilarity, truncateAtSentence } from './text.js';
import type { ReviewAlbumRef } from './metacritic.js';

export interface TrackRef {
  id: string;
  title: string;
}

export type GeniusNote = Sourced<string> & { verifiedArtist: boolean; trackId?: string };

export interface GeniusAlbumParse {
  description?: string;
  verified: boolean;
  tracks: { title: string; href: string }[];
}

export interface GeniusSongParse {
  description?: string;
  verified: boolean;
}

interface GeniusSearch {
  response?: {
    sections?: {
      hits?: {
        result?: {
          type?: string;
          title?: string;
          url?: string;
          artist_names?: string;
          primary_artist_names?: string;
        };
      }[];
    }[];
  };
}

const GENIUS = 'https://genius.com';

export function geniusSearchUrl(album: ReviewAlbumRef): string {
  return `${GENIUS}/api/search/multi?q=${encodeURIComponent(`${album.artist} ${album.title}`)}`;
}

export function geniusAlbumUrl(album: ReviewAlbumRef): string {
  return `${GENIUS}/albums/${geniusSlug(album.artist)}/${geniusSlug(album.title)}`;
}

const DESCRIPTION_SELECTORS = [
  '[class*="AlbumDescription" i]',
  '[class*="album_description" i]',
  '[class*="SongDescription" i]',
  '[class*="song_description" i]',
  '[class*="description" i]',
  'meta[name="description"]',
];

const LYRICS_SELECTORS = '.lyrics, [class*="Lyrics" i], [class*="lyrics" i], .song_body-lyrics';

function textFromNode($: CheerioAPI, node: unknown): string {
  const $n = $(node as never).clone();
  $n.find(`button, script, style, ${LYRICS_SELECTORS}`).remove();
  $n.find('[class*="ReadMore" i], [class*="read-more" i]').remove();
  const paragraphs = $n
    .find('p')
    .toArray()
    .map((p) => cleanText($(p).text()))
    .filter((t) => t.length >= 30);
  const text = paragraphs.length ? paragraphs.join('\n\n') : cleanText($n.text());
  return text;
}

function descriptionFrom($: CheerioAPI): string | undefined {
  for (const selector of DESCRIPTION_SELECTORS) {
    for (const node of $(selector).toArray()) {
      if ($(node).is('meta')) {
        const content = $(node).attr('content');
        if (content && content.length >= 60) return truncateAtSentence(content, 2000);
        continue;
      }
      const text = textFromNode($, node);
      if (text.length >= 60) return truncateAtSentence(text, 2000);
    }
  }
  return undefined;
}

function verifiedIn(html: string, $: CheerioAPI): boolean {
  if ($('[class*="verified" i], [data-verified="true"], svg[title*="Verified" i], [aria-label*="Verified" i]').length > 0) {
    return true;
  }
  return /\bverified (artist|annotation)\b/i.test(html);
}

function absoluteGeniusUrl(href: string): string {
  if (href.startsWith('http')) return href;
  return `${GENIUS}${href.startsWith('/') ? '' : '/'}${href}`;
}

function titleFromSongHref(href: string): string {
  const slug = href.split('/').pop() ?? '';
  return slug.replace(/-lyrics$/, '').replace(/-/g, ' ');
}

/** Parse a Genius album page. Exported for fixture tests. */
export function parseGeniusAlbumPage(html: string, url: string): GeniusAlbumParse {
  const $ = cheerio.load(html);
  const tracks: { title: string; href: string }[] = [];
  const seen = new Set<string>();
  $('a[href*="-lyrics"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const abs = absoluteGeniusUrl(href);
    if (seen.has(abs)) return;
    seen.add(abs);
    const title = cleanText($(a).text()) || titleFromSongHref(href);
    if (title) tracks.push({ title, href: abs });
  });
  return { description: descriptionFrom($), verified: verifiedIn(html, $), tracks };
}

/** Parse a Genius song page. Exported for fixture tests. */
export function parseGeniusSongPage(html: string): GeniusSongParse {
  const $ = cheerio.load(html);
  return { description: descriptionFrom($), verified: verifiedIn(html, $) };
}

export function pickGeniusAlbum(result: GeniusSearch, album: ReviewAlbumRef): { title: string; url: string } | null {
  const hits = (result.response?.sections ?? [])
    .flatMap((s) => s.hits ?? [])
    .map((h) => h.result)
    .filter((r): r is NonNullable<typeof r> => r !== undefined && r.type === 'album');
  let best: { title: string; url: string; score: number } | null = null;
  for (const hit of hits) {
    const title = hit.title ?? '';
    const url = hit.url ?? '';
    if (!title || !url) continue;
    const sim = titleSimilarity(album.title, title);
    if (sim < 0.7) continue;
    const artist = hit.artist_names ?? hit.primary_artist_names ?? '';
    const artistScore = artist && namesMatch(album.artist, artist) ? 2 : 0;
    const score = sim * 3 + artistScore;
    if (!best || score > best.score) best = { title, url: url.startsWith('http') ? url : absoluteGeniusUrl(url), score };
  }
  return best ? { title: best.title, url: best.url } : null;
}

export interface GeniusOptions {
  maxTracks?: number;
  maxNotes?: number;
}

export async function fetchGenius(
  http: CachedHttp,
  album: ReviewAlbumRef,
  tracks: TrackRef[],
  opts: GeniusOptions = {},
): Promise<GeniusNote[]> {
  const maxTracks = opts.maxTracks ?? 12;
  const maxNotes = opts.maxNotes ?? 20;

  let albumUrl: string | undefined;
  const search = await http.getJson<GeniusSearch>(geniusSearchUrl(album), { accept: 'application/json' });
  const picked = search ? pickGeniusAlbum(search, album) : null;
  albumUrl = picked?.url ?? geniusAlbumUrl(album);

  const page = await http.get(albumUrl);
  if (!page || page.status !== 200) return [];
  const parsed = parseGeniusAlbumPage(page.body, albumUrl);

  const notes: GeniusNote[] = [];
  if (parsed.description) {
    notes.push({ value: parsed.description, source: 'Genius', url: albumUrl, verifiedArtist: parsed.verified });
  }

  const byTitle = new Map<string, TrackRef>();
  for (const t of tracks) byTitle.set(normalizeTitle(t.title), t);

  let fetched = 0;
  for (const link of parsed.tracks) {
    if (fetched >= maxTracks || notes.length >= maxNotes) break;
    const track =
      byTitle.get(normalizeTitle(link.title)) ??
      byTitle.get(normalizeTitle(titleFromSongHref(link.href))) ??
      tracks.find((t) => titleSimilarity(t.title, link.title) >= 0.85);
    if (!track) continue;
    fetched++;
    const song = await http.get(link.href);
    if (!song || song.status !== 200) continue;
    const songParse = parseGeniusSongPage(song.body);
    if (!songParse.description) continue;
    if (notes.some((n) => n.value === songParse.description)) continue;
    notes.push({
      value: songParse.description,
      source: 'Genius',
      url: link.href,
      verifiedArtist: songParse.verified,
      trackId: track.id,
    });
  }
  return notes.slice(0, maxNotes);
}
