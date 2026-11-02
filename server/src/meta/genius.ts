// Genius: album/song "About" descriptions and artist notes via the official
// API (https://api.genius.com, Authorization: Bearer <cfg.geniusToken>).
//
// We do NOT request genius.com web pages any more: that path returned 403 and is
// outside Genius' sanctioned API. The search endpoint is noisy (it returns
// user-made list pages such as "Rock Albums That Mention Depression by Trigger
// Genius"), so every hit is validated:
//   * primary_artist.name must match the album artist (normalised, so
//     "Alice In Chains" == "Alice in Chains" and "Bob Marley & The Wailers" ==
//     "Bob Marley and the Wailers");
//   * the hit title must map to one of our local tracks by normalised title.
// The album description is then found through the matched song's `album` field,
// and GET /albums/<id>?text_format=plain.
//
// verifiedArtist is deliberately strict. Fields inspected on real responses
// (Nov 2026):
//   song.primary_artist.is_verified / song.album.artist.is_verified — whether the
//     artist account is verified (often false even for famous artists);
//   song.verified_contributors[] = { contributions: ["annotations"], artist:
//     { name, is_verified } } — a verified artist credited on the song who
//     authored annotations;
//   song.verified_annotations_by[] = user objects with
//     role_for_display: "verified_artist";
//   song.description_annotation = { verified?, verified_annotator_ids[],
//     annotations: [{ verified, authors: [{ user: { name, login } }] }] }.
// We report true only when one of those verified artists is a credited artist on
// that song (primary/featured/writer/producer) — or, for a verified description
// annotation, when an annotation author's name matches such a credited artist.
import * as cheerio from 'cheerio';
import type { Sourced } from '@liner/shared';
import type { CachedHttp } from './http.js';
import type { ReviewAlbumRef } from './types.js';
import { cleanText, namesMatch, normalizeTitle, stripQualifiers, titleSimilarity, truncateAtSentence } from './text.js';

export interface TrackRef {
  id: string;
  title: string;
}

export type GeniusNote = Sourced<string> & { verifiedArtist: boolean; trackId?: string };

export interface GeniusOptions {
  maxTracks?: number;
  maxNotes?: number;
  /** From server/config.json (untracked). No token = no Genius requests. */
  token?: string;
}

interface GeniusArtist {
  id?: number;
  name?: string;
  is_verified?: boolean;
  login?: string;
}

interface GeniusAnnotationAuthor {
  user?: { id?: number; name?: string; login?: string };
}

interface GeniusAnnotation {
  verified?: boolean;
  body?: { plain?: string };
  authors?: GeniusAnnotationAuthor[];
}

interface GeniusDescriptionAnnotation {
  verified?: boolean;
  verified_annotator_ids?: number[];
  annotator_login?: string;
  annotations?: GeniusAnnotation[];
}

interface GeniusVerifiedContributor {
  contributions?: string[];
  artist?: GeniusArtist;
}

interface GeniusAlbumRef {
  id?: number;
  name?: string;
  url?: string;
  full_title?: string;
  artist?: GeniusArtist;
  primary_artists?: GeniusArtist[];
}

interface GeniusSong {
  id?: number;
  title?: string;
  url?: string;
  description?: { plain?: string } | string | null;
  description_annotation?: GeniusDescriptionAnnotation | null;
  primary_artist?: GeniusArtist;
  primary_artists?: GeniusArtist[];
  featured_artists?: GeniusArtist[];
  writer_artists?: GeniusArtist[];
  producer_artists?: GeniusArtist[];
  artist_names?: string;
  album?: GeniusAlbumRef | null;
  verified_contributors?: GeniusVerifiedContributor[];
  verified_annotations_by?: GeniusArtist[];
}

interface GeniusAlbum {
  id?: number;
  name?: string;
  url?: string;
  artist?: GeniusArtist;
  primary_artists?: GeniusArtist[];
  description_annotation?: GeniusDescriptionAnnotation | null;
  verified_contributors?: GeniusVerifiedContributor[];
}

interface GeniusSearchHit {
  id?: number;
  title?: string;
  url?: string;
  api_path?: string;
  artist_names?: string;
  primary_artist?: GeniusArtist;
  album?: GeniusAlbumRef;
}

interface GeniusSearchResponse {
  response?: { hits?: { result?: GeniusSearchHit }[] };
}

interface GeniusSongResponse {
  response?: { song?: GeniusSong };
}

interface GeniusAlbumResponse {
  response?: { album?: GeniusAlbum };
}

const GENIUS_API = 'https://api.genius.com';

export function geniusSearchUrl(album: ReviewAlbumRef, trackTitle?: string): string {
  const q = trackTitle ? `${album.artist} ${trackTitle}` : `${album.artist} ${album.title}`;
  return `${GENIUS_API}/search?q=${encodeURIComponent(q)}`;
}

export function geniusSongUrl(songId: number | string): string {
  return `${GENIUS_API}/songs/${encodeURIComponent(String(songId))}?text_format=plain`;
}

export function geniusAlbumUrl(albumId: number | string): string {
  return `${GENIUS_API}/albums/${encodeURIComponent(String(albumId))}?text_format=plain`;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function textValue(value: { plain?: string } | string | null | undefined): string | undefined {
  if (typeof value === 'string') return htmlToText(value);
  if (value && typeof value === 'object' && typeof value.plain === 'string') return cleanText(value.plain);
  return undefined;
}

function htmlToText(html: string): string {
  // text_format=plain should never contain markup, but be defensive.
  if (!/[<>]/.test(html)) return cleanText(html);
  return cleanText(cheerio.load(`<div>${html}</div>`)('div').text());
}

function usableDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = cleanText(value);
  if (!text || text === '?' || text === '…' || text.length < 10) return undefined;
  return truncateAtSentence(text, 2000);
}

/** Description body from a description_annotation object. */
function annotationDescription(annotation: GeniusDescriptionAnnotation | null | undefined): string | undefined {
  const annotations = annotation?.annotations ?? [];
  const ordered = [...annotations].sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));
  for (const entry of ordered) {
    const text = usableDescription(textValue(entry.body));
    if (text) return text;
  }
  return undefined;
}

function songDescription(song: GeniusSong): string | undefined {
  return usableDescription(textValue(song.description)) ?? annotationDescription(song.description_annotation);
}

function creditedArtistNames(...groups: (GeniusArtist[] | undefined)[]): string[] {
  const names: string[] = [];
  for (const group of groups) {
    for (const artist of group ?? []) if (artist?.name) names.push(artist.name);
  }
  return names;
}

function songCreditedArtists(song: GeniusSong): string[] {
  const names = creditedArtistNames(
    song.primary_artists,
    song.featured_artists,
    song.writer_artists,
    song.producer_artists,
  );
  if (song.primary_artist?.name) names.push(song.primary_artist.name);
  return [...new Set(names)];
}

function nameIsCredited(name: string | undefined, credited: string[]): boolean {
  if (!name) return false;
  return credited.some((artist) => namesMatch(artist, name));
}

/**
 * True only when a verified artist credited on this song authored its
 * annotations/description. See the field list at the top of this file.
 */
export function songNoteVerified(song: GeniusSong): boolean {
  const credited = songCreditedArtists(song);

  // 1. Verified contributor with an "annotations" contribution.
  for (const contributor of song.verified_contributors ?? []) {
    if (!contributor.artist?.is_verified) continue;
    if (!(contributor.contributions ?? []).includes('annotations')) continue;
    if (nameIsCredited(contributor.artist.name, credited)) return true;
  }

  // 2. Annotations verified by a user account flagged as a verified artist.
  for (const user of song.verified_annotations_by ?? []) {
    if (user.is_verified === false && user.name && !nameIsCredited(user.name, credited)) continue;
    if (nameIsCredited(user.name, credited) || nameIsCredited(user.login, credited)) return true;
  }

  // 3. A verified description annotation whose author is a credited artist.
  const annotation = song.description_annotation;
  if (annotation) {
    const verifiedAnnotation =
      annotation.verified === true ||
      (annotation.verified_annotator_ids?.length ?? 0) > 0 ||
      (annotation.annotations ?? []).some((entry) => entry.verified === true);
    if (verifiedAnnotation) {
      const authors = (annotation.annotations ?? []).flatMap((entry) =>
        (entry.authors ?? []).map((author) => author.user?.name ?? author.user?.login).filter((n): n is string => Boolean(n)),
      );
      if (authors.some((name) => nameIsCredited(name, credited))) return true;
    }
  }
  return false;
}

/** Album descriptions rarely carry verified authors; apply the same rule. */
function albumNoteVerified(album: GeniusAlbum): boolean {
  const annotation = album.description_annotation;
  if (!annotation) return false;
  const verifiedAnnotation =
    annotation.verified === true || (annotation.verified_annotator_ids?.length ?? 0) > 0;
  if (!verifiedAnnotation) return false;
  const credited = creditedArtistNames(album.primary_artists);
  if (album.artist?.name) credited.push(album.artist.name);
  const authors = (annotation.annotations ?? []).flatMap((entry) =>
    (entry.authors ?? []).map((author) => author.user?.name ?? author.user?.login).filter((n): n is string => Boolean(n)),
  );
  return authors.some((name) => nameIsCredited(name, credited));
}

/** Validate a search hit against the album artist and one of our tracks. */
export function pickGeniusSong(
  response: GeniusSearchResponse,
  albumArtist: string,
  trackTitle: string,
): GeniusSearchHit | null {
  const hits = (response.response?.hits ?? [])
    .map((hit) => hit.result)
    .filter((result): result is GeniusSearchHit => Boolean(result));
  let best: { hit: GeniusSearchHit; score: number } | null = null;
  const wanted = normalizeTitle(stripQualifiers(trackTitle));
  for (const hit of hits) {
    const primary = hit.primary_artist?.name ?? '';
    if (!primary || !namesMatch(albumArtist, primary)) continue;
    const title = normalizeTitle(stripQualifiers(hit.title ?? ''));
    if (!title) continue;
    const exact = title === wanted;
    const sim = titleSimilarity(trackTitle, hit.title ?? '');
    if (!exact && sim < 0.92) continue;
    const artistExact = normalizeTitle(albumArtist) === normalizeTitle(primary);
    const score = (exact ? 3 : sim) + (artistExact ? 1 : 0);
    if (!best || score > best.score) best = { hit, score };
  }
  return best?.hit ?? null;
}

function albumRefFromSong(song: GeniusSong): GeniusAlbumRef | null {
  if (song.album?.id) return song.album;
  return null;
}

function songUrl(song: GeniusSong): string {
  if (song.url) return song.url;
  return song.id ? `https://genius.com/songs/${song.id}` : 'https://genius.com';
}

export async function fetchGenius(
  http: CachedHttp,
  album: ReviewAlbumRef,
  tracks: TrackRef[],
  opts: GeniusOptions = {},
): Promise<GeniusNote[]> {
  const token = opts.token?.trim();
  if (!token) return [];
  const maxTracks = opts.maxTracks ?? 12;
  const maxNotes = opts.maxNotes ?? 20;
  const headers = authHeaders(token);

  const notes: GeniusNote[] = [];
  const usedSongs = new Set<number>();
  let fetched = 0;
  let albumRef: GeniusAlbumRef | null = null;

  for (const track of tracks) {
    if (fetched >= maxTracks || notes.length >= maxNotes) break;

    const search = await http.getJson<GeniusSearchResponse>(geniusSearchUrl(album, track.title), {
      accept: 'application/json',
      headers,
    });
    if (!search) continue;
    const hit = pickGeniusSong(search, album.artist, track.title);
    if (!hit?.id || usedSongs.has(hit.id)) continue;
    usedSongs.add(hit.id);
    fetched++;

    const songData = await http.getJson<GeniusSongResponse>(geniusSongUrl(hit.id), {
      accept: 'application/json',
      headers,
    });
    const song = songData?.response?.song;
    if (!song) continue;
    // The same title can exist on several albums ("Let It Be" is on both Just
    // As I Am and Still Bill). When Genius tells us which album it belongs to,
    // reject a song from a different one.
    if (song.album?.name && titleSimilarity(album.title, song.album.name) < 0.6) continue;
    if (song.album?.id && !albumRef) albumRef = albumRefFromSong(song);

    const description = songDescription(song);
    if (!description) continue;
    if (notes.some((note) => note.value === description)) continue;
    notes.push({
      value: description,
      source: 'Genius',
      url: songUrl(song),
      verifiedArtist: songNoteVerified(song),
      trackId: track.id,
    });
  }

  // Album description: found through a matched song's `album` field.
  if (albumRef?.id && notes.length < maxNotes) {
    const albumData = await http.getJson<GeniusAlbumResponse>(geniusAlbumUrl(albumRef.id), {
      accept: 'application/json',
      headers,
    });
    const geniusAlbum = albumData?.response?.album;
    const description = annotationDescription(geniusAlbum?.description_annotation);
    if (description && !notes.some((note) => note.value === description)) {
      notes.unshift({
        value: description,
        source: 'Genius',
        url: albumRef.url ?? `https://genius.com/albums/${albumRef.id}`,
        verifiedArtist: geniusAlbum ? albumNoteVerified(geniusAlbum) : false,
      });
    }
  }

  return notes.slice(0, maxNotes);
}
