// Shared inputs for the meta sources. Kept in its own module so the sources do
// not depend on each other (metacritic.ts was removed in round 2).
export interface ReviewAlbumRef {
  id: string;
  title: string;
  artist: string;
  year?: number;
  /** MusicBrainz release-group id (filled by the matcher) — the reliable route
   *  to the English Wikipedia article via URL relationships + Wikidata. */
  mbReleaseGroupId?: string;
}
