// MusicBrainz release-group -> English Wikipedia article.
//
// The matcher fills albums.mb_release_group_id. Release groups carry URL
// relationships to Wikipedia and Wikidata (type = "wikipedia" / "wikidata");
// when only Wikidata is linked, its enwiki sitelink gives the article title.
// This is far more reliable than search, especially for albums whose English
// article uses a disambiguated title ("Uprising (Bob Marley and the Wailers
// album)") or a name the local tags spell differently.
//
// Requests go through the shared MbClient so meta and the matcher share the
// 1 request/second MusicBrainz budget.
import type { MbClient } from '../match/mb.js';
import type { CachedHttp } from './http.js';

interface UrlRelation {
  type?: string;
  'target-type'?: string;
  url?: { resource?: string };
}

export interface MbReleaseGroupRels {
  id: string;
  title?: string;
  relations?: UrlRelation[];
}

interface WikidataResponse {
  entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } } | undefined>;
}

export function releaseGroupUrlRelationsUrl(releaseGroupId: string): string {
  return `https://musicbrainz.org/ws/2/release-group/${encodeURIComponent(releaseGroupId)}?inc=url-rels&fmt=json`;
}

export function wikidataSitelinksUrl(qid: string): string {
  return `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(
    qid,
  )}&props=sitelinks&sitefilter=enwiki&format=json`;
}

/** Extract the article title from an en.wikipedia.org URL. */
export function wikipediaTitleFromUrl(resource: string | undefined): string | null {
  if (!resource) return null;
  try {
    const url = new URL(resource);
    if (!/(^|\.)en\.wikipedia\.org$/i.test(url.host)) return null;
    const match = /^\/wiki\/(.+)$/.exec(url.pathname);
    if (!match?.[1]) return null;
    return decodeURIComponent(match[1]).replace(/_/g, ' ');
  } catch {
    return null;
  }
}

export function wikidataIdFromUrl(resource: string | undefined): string | null {
  if (!resource) return null;
  try {
    const url = new URL(resource);
    if (!/(^|\.)wikidata\.org$/i.test(url.host)) return null;
    const match = /\/(?:wiki|entity)\/(Q\d+)/i.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Pick the enwiki title from a release-group's URL relationships. */
export function pageTitleFromRelations(relations: UrlRelation[] | undefined): {
  wikipedia?: string;
  wikidata?: string;
} {
  const out: { wikipedia?: string; wikidata?: string } = {};
  for (const relation of relations ?? []) {
    if (relation['target-type'] && relation['target-type'] !== 'url') continue;
    const resource = relation.url?.resource;
    if (!resource) continue;
    if (relation.type === 'wikipedia' && !out.wikipedia) {
      const title = wikipediaTitleFromUrl(resource);
      if (title) out.wikipedia = title;
    }
    if (relation.type === 'wikidata' && !out.wikidata) {
      const qid = wikidataIdFromUrl(resource);
      if (qid) out.wikidata = qid;
    }
  }
  return out;
}

/** Resolve a release group to its English Wikipedia article title, if linked. */
export async function releaseGroupWikipediaTitle(
  http: CachedHttp,
  mb: MbClient,
  releaseGroupId: string,
): Promise<string | null> {
  const group = await mb.getJson<MbReleaseGroupRels>(releaseGroupUrlRelationsUrl(releaseGroupId));
  const links = pageTitleFromRelations(group.relations);
  if (links.wikipedia) return links.wikipedia;
  if (!links.wikidata) return null;

  const data = await http.getJson<WikidataResponse>(wikidataSitelinksUrl(links.wikidata), { accept: 'application/json' });
  return data?.entities?.[links.wikidata]?.sitelinks?.enwiki?.title ?? null;
}
