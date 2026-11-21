//! What the pages show, fetched once and kept (the web's TanStack Query cache). A value is `Loading` while its request is
//! out, `Ready` with an `Arc` the page can hold while drawing, or `Err` with the server's own sentence. Entries older than
//! `STALE` are fetched again the next time a page asks; `library-changed` and our own edits drop what they touch.
use rune_mini_core::library::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const STALE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub enum Slot<T> {
    Loading,
    Ready(Arc<T>),
    Err(String),
}

impl<T> Slot<T> {
    pub fn ready(&self) -> Option<&Arc<T>> { if let Slot::Ready(v) = self { Some(v) } else { None } }
}

pub struct Cached<T> {
    pub slot: Slot<T>,
    pub at: Instant,
}

impl<T> Cached<T> {
    pub fn loading() -> Cached<T> { Cached { slot: Slot::Loading, at: Instant::now() } }
    pub fn stale(&self) -> bool { !matches!(self.slot, Slot::Loading) && self.at.elapsed() > STALE }
}

/// One Albums query's pages so far (`useInfiniteQuery`).
#[derive(Default)]
pub struct AlbumList {
    pub items: Vec<AlbumSummary>,
    pub total: usize,
    pub loaded: bool,
    pub fetching: bool,
    pub error: Option<String>,
    pub at: Option<Instant>,
}

/// A card on the Artists page, derived from the album list (the server has no artists list).
#[derive(Clone, Debug, PartialEq)]
pub struct ArtistCard {
    pub id: String,
    pub name: String,
    pub n: usize,
}

/// A paged list of tracks (the Tracks page, one query per key).
#[derive(Default)]
pub struct TrackList {
    pub items: Vec<LibTrack>,
    pub total: usize,
    pub loaded: bool,
    pub fetching: bool,
    pub error: Option<String>,
    pub at: Option<Instant>,
}

#[derive(Default)]
pub struct Data {
    pub genres: Option<Cached<Vec<GenreFacet>>>,
    pub labels: Option<Cached<Vec<LabelFacet>>>,
    pub years: Option<Cached<Vec<YearFacet>>>,
    pub tracks: HashMap<String, TrackList>,
    /// anything the later pages read as plain JSON, by request path
    pub json: HashMap<String, Cached<serde_json::Value>>,
    pub albums: HashMap<String, AlbumList>,
    pub album: HashMap<String, Cached<Album>>,
    pub artist: HashMap<String, Cached<Artist>>,
    pub artist_cards: Option<Cached<Vec<ArtistCard>>>,
    pub playlists: Option<Cached<Vec<PlaylistSummary>>>,
    pub playlist: HashMap<String, Cached<PlaylistDetail>>,
    pub search: HashMap<String, Cached<SearchResults>>,
    /// Spotify heart state per track id (answered from the server's synced Liked Songs).
    pub liked: HashMap<String, bool>,
    pub liked_asked: std::collections::HashSet<String>,
}

impl Data {
    /// A like or a playlist edit happened somewhere: the web invalidates `liked`, `playlist` and `playlists`.
    pub fn library_changed(&mut self) {
        self.liked.clear();
        self.liked_asked.clear();
        self.playlist.clear();
        self.playlists = None;
        self.artist_cards = None;
        self.genres = None;
        // keep what is on screen and ask again in the background: clearing it emptied lists like Discover for a moment,
        // which threw their scroll back to the top after every like or playlist add
        let old = Instant::now().checked_sub(STALE * 2);
        for c in self.json.values_mut() { if let Some(t) = old { c.at = t; } }
        for l in self.tracks.values_mut() { l.at = None; }
    }
}

/// Group an album list into artists: one card per artist id, sorted by name (Artists.tsx).
pub fn artist_cards(albums: &[AlbumSummary]) -> Vec<ArtistCard> {
    let mut map: HashMap<&str, ArtistCard> = HashMap::new();
    for a in albums {
        map.entry(a.artist.id.as_str()).and_modify(|e| e.n += 1).or_insert_with(|| ArtistCard { id: a.artist.id.clone(), name: a.artist.name.clone(), n: 1 });
    }
    let mut v: Vec<ArtistCard> = map.into_values().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    fn al(id: &str, ar: &str, name: &str) -> AlbumSummary {
        AlbumSummary { id: id.into(), artist: rune_mini_core::model::ArtistRef { id: ar.into(), name: name.into() }, ..Default::default() }
    }
    #[::core::prelude::v1::test]
    fn artists_are_grouped_counted_and_sorted() {
        let c = artist_cards(&[al("1", "b", "bravo"), al("2", "a", "Alpha"), al("3", "b", "bravo")]);
        assert_eq!(c.iter().map(|x| (x.name.as_str(), x.n)).collect::<Vec<_>>(), vec![("Alpha", 1), ("bravo", 2)]);
    }
    #[::core::prelude::v1::test]
    fn library_changed_forgets_playlists_and_likes() {
        let mut d = Data::default();
        d.playlists = Some(Cached::loading());
        d.liked.insert("sp:1".into(), true);
        d.library_changed();
        assert!(d.playlists.is_none() && d.liked.is_empty());
    }
}
