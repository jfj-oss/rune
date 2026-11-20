//! Where the user is (the web's React Router routes) and the back/forward history (`window.history`).
use rune_mini_core::client_ext::qs;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Src { #[default] All, Local, Spotify }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Sort { #[default] Added, Artist, Title, Year }

impl Sort {
    pub const ALL: [Sort; 4] = [Sort::Added, Sort::Artist, Sort::Title, Sort::Year];
    pub fn label(self) -> &'static str { match self { Sort::Added => "Date added", Sort::Artist => "Artist", Sort::Title => "Title", Sort::Year => "Year" } }
    pub fn param(self) -> &'static str { match self { Sort::Added => "added", Sort::Artist => "artist", Sort::Title => "title", Sort::Year => "year" } }
}

/// The Albums page's URL parameters (`?sort&source&q&genre&label&year`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AlbumsQ {
    pub source: Src,
    pub sort: Sort,
    pub q: String,
    pub genre: Option<String>,
    pub label: Option<String>,
    pub year: Option<i32>,
}

impl AlbumsQ {
    pub fn spotify() -> AlbumsQ { AlbumsQ { source: Src::Spotify, ..Default::default() } }
    /// `GET /api/library/albums` query, as `api.albums` builds it.
    pub fn query(&self, offset: usize, limit: usize) -> String {
        qs(&[
            ("q", self.q.clone()),
            ("source", match self.source { Src::All => String::new(), Src::Local => "local".into(), Src::Spotify => "spotify".into() }),
            ("sort", self.sort.param().to_string()),
            ("genre", self.genre.clone().unwrap_or_default()),
            ("label", self.label.clone().unwrap_or_default()),
            ("year", self.year.map(|y| y.to_string()).unwrap_or_default()),
            ("offset", offset.to_string()),
            ("limit", limit.to_string()),
        ])
    }
    pub fn key(&self) -> String { format!("{:?}|{:?}|{}|{:?}|{:?}|{:?}", self.source, self.sort, self.q, self.genre, self.label, self.year) }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Home,
    Albums(AlbumsQ),
    Album(String),
    Artists,
    Artist(String),
    Playlists(String),
    Playlist(String),
    Search(String),
    Tracks,
    Genres,
    People,
    Discover,
    Radio,
    Stats,
    Settings,
    Duplicates,
}

impl Route {
    /// One scroll position (one `ListState`) per key, kept while the app runs (the web's `scrollPos` per history entry).
    pub fn key(&self) -> String {
        match self {
            Route::Home => "home".into(),
            Route::Albums(q) => format!("albums:{}", q.key()),
            Route::Album(id) => format!("album:{id}"),
            Route::Artists => "artists".into(),
            Route::Artist(id) => format!("artist:{id}"),
            Route::Playlists(q) => format!("playlists:{q}"),
            Route::Playlist(id) => format!("playlist:{id}"),
            Route::Search(q) => format!("search:{q}"),
            Route::Tracks => "tracks".into(),
            Route::Genres => "genres".into(),
            Route::People => "people".into(),
            Route::Discover => "discover".into(),
            Route::Radio => "radio".into(),
            Route::Stats => "stats".into(),
            Route::Settings => "settings".into(),
            Route::Duplicates => "duplicates".into(),
        }
    }
    pub fn title(&self) -> &'static str {
        match self {
            Route::Home => "Home", Route::Albums(_) => "Albums", Route::Album(_) => "Album", Route::Artists => "Artists", Route::Artist(_) => "Artist",
            Route::Playlists(_) => "Playlists", Route::Playlist(_) => "Playlist", Route::Search(_) => "Search", Route::Tracks => "Tracks", Route::Genres => "Genres",
            Route::People => "People", Route::Discover => "Discover", Route::Radio => "Radio", Route::Stats => "Stats", Route::Settings => "Settings", Route::Duplicates => "Duplicates",
        }
    }
}

#[derive(Debug)]
pub struct History {
    stack: Vec<Route>,
    idx: usize,
}

impl History {
    pub fn new(start: Route) -> History { History { stack: vec![start], idx: 0 } }
    pub fn current(&self) -> &Route { &self.stack[self.idx] }
    pub fn can_back(&self) -> bool { self.idx > 0 }
    pub fn can_forward(&self) -> bool { self.idx + 1 < self.stack.len() }
    /// Go somewhere new: forward entries are dropped (a link click). Same place = nothing.
    pub fn push(&mut self, r: Route) -> bool {
        if *self.current() == r { return false; }
        self.stack.truncate(self.idx + 1);
        self.stack.push(r);
        self.idx += 1;
        true
    }
    /// Replace the current entry (`replace: true`, e.g. typing in a find box).
    pub fn replace(&mut self, r: Route) -> bool {
        if *self.current() == r { return false; }
        self.stack[self.idx] = r;
        true
    }
    pub fn back(&mut self) -> bool { if self.can_back() { self.idx -= 1; true } else { false } }
    pub fn forward(&mut self) -> bool { if self.can_forward() { self.idx += 1; true } else { false } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_behaves_like_the_browsers() {
        let mut h = History::new(Route::Home);
        assert!(h.push(Route::Artists));
        assert!(h.push(Route::Album("a".into())));
        assert!(!h.push(Route::Album("a".into())), "same place twice is one entry");
        assert!(h.back() && h.back() && !h.back());
        assert!(h.can_forward());
        assert!(h.push(Route::Tracks), "a new link drops the forward entries");
        assert!(!h.can_forward());
        assert_eq!(*h.current(), Route::Tracks);
    }
    #[test]
    fn the_albums_query_matches_the_web_api_call() {
        let q = AlbumsQ { source: Src::Local, sort: Sort::Title, q: "a b".into(), ..Default::default() };
        assert_eq!(q.query(120, 120), "?q=a+b&source=local&sort=title&offset=120&limit=120");
        assert_eq!(AlbumsQ::default().query(0, 120), "?sort=added&offset=0&limit=120");
    }
}
