//! The library as the server sends it (`shared/src/index.ts`, `shared/src/playlists.ts`): albums, artists, search,
//! playlists. Field names follow the wire (camelCase). Every field that may be missing has a default, so a newer server
//! never breaks an older client. Used by rune desktop; the other clients keep to `model.rs`.
use crate::model::ArtistRef;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Page<T> {
    #[serde(default = "Vec::new")]
    pub items: Vec<T>,
    #[serde(default)]
    pub total: usize,
}

/// One track as the library routes send it (the queue's lean `model::Track` has no disc, number or format).
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibTrack {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub album_id: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artists: Vec<ArtistRef>,
    #[serde(default)]
    pub disc: u32,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub duration_ms: f64,
    #[serde(default)]
    pub format: Option<String>,
    // playlist rows (PlaylistTrack): the album bits and the entry id
    #[serde(default)]
    pub album: Option<TrackAlbum>,
    #[serde(default)]
    pub entry_id: Option<String>,
    #[serde(default)]
    pub entry_source: Option<String>,
    #[serde(default)]
    pub added_at: Option<f64>,
}

impl LibTrack {
    pub fn artist_line(&self) -> String {
        self.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
    }
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackAlbum {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
    pub id: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: ArtistRef,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub added_at: f64,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    #[serde(flatten)]
    pub summary: AlbumSummary,
    #[serde(default)]
    pub tracks: Vec<LibTrack>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub match_confidence: Option<f64>,
    #[serde(default)]
    pub credits: Vec<Credit>,
    #[serde(default)]
    pub folder_path: Option<String>,
}

/// One credit of an album (`Credit` in shared/src/index.ts): a person, a role, and the tracks it was on (none = the whole album).
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credit {
    pub artist: ArtistRef,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub track_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Sourced {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub bio: Option<Sourced>,
    #[serde(default)]
    pub albums: Vec<AlbumSummary>,
    #[serde(default)]
    pub appears_on: Vec<AlbumSummary>,
    #[serde(default)]
    pub similar: Vec<ArtistRef>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SearchResults {
    #[serde(default)]
    pub albums: Vec<AlbumSummary>,
    #[serde(default)]
    pub artists: Vec<ArtistRef>,
    #[serde(default)]
    pub tracks: Vec<LibTrack>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub track_count: usize,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub can_edit: Option<bool>,
    #[serde(default)]
    pub pinned: bool,
    /// "static" | "smart" (rune playlists)
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub cover_album_ids: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    #[serde(flatten)]
    pub summary: PlaylistSummary,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tracks: Vec<LibTrack>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenreFacet {
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub album_count: usize,
    #[serde(default)]
    pub cover_album_ids: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelFacet {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub album_count: usize,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YearFacet {
    #[serde(default)]
    pub year: i32,
    #[serde(default)]
    pub album_count: usize,
    #[serde(default)]
    pub decade: i32,
}

/// One row of `/history/recent` or `/history/rediscover`.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAlbum {
    #[serde(default)]
    pub album_id: String,
}

pub const LIKED_PLAYLIST_ID: &str = "pl:sp:liked";

impl PlaylistSummary {
    /// rune's own playlists are `pl:rune:<uuid>`; everything else is synced from Spotify (lib/playlists.ts).
    pub fn is_rune(&self) -> bool { self.id.starts_with("pl:rune:") }
    pub fn is_smart(&self) -> bool { self.is_rune() && self.kind.as_deref() == Some("smart") }
    pub fn is_editable(&self) -> bool { self.is_rune() && !self.is_smart() }
    /// Can a local track be added (rune's own, or the overlay of a synced Spotify playlist)?
    pub fn can_add_to(&self) -> bool { self.is_editable() || (!self.is_rune() && self.id != LIKED_PLAYLIST_ID) }
}

/// `/api/cover/:id?size=` for an album (or a playlist mosaic cell), as the web's `coverSrc`. A cover URL that is already
/// absolute (Spotify's CDN) is used as given.
pub fn cover_path(album_id: &str, cover_url: Option<&str>, size: &str) -> String {
    if let Some(u) = cover_url {
        if u.starts_with("http://") || u.starts_with("https://") {
            return u.to_string();
        }
        // a station's logo is served by its own route, not the cover route
        if u.starts_with("/api/") && !u.starts_with("/api/cover/") {
            return u.to_string();
        }
    }
    format!("/api/cover/{}?size={}", crate::commands::encode(album_id), size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_album_page_parses_with_the_wire_names() {
        let j = r#"{"items":[{"id":"la:1","source":"local","title":"Lost Garden","artist":{"id":"ar:n:1","name":"The Understudies"},"year":1996,"coverUrl":"/api/cover/la%3A1?size=600","format":"FLAC 16/44.1","addedAt":1795146795035,"pinned":true}],"total":60}"#;
        let p: Page<AlbumSummary> = serde_json::from_str(j).unwrap();
        assert_eq!(p.total, 60);
        let a = &p.items[0];
        assert_eq!((a.title.as_str(), a.year, a.pinned), ("Lost Garden", Some(1996), true));
        assert_eq!(a.artist.name, "The Understudies");
    }

    #[test]
    fn a_full_album_flattens_the_summary_and_keeps_disc_and_number() {
        let j = r#"{"id":"la:1","source":"local","title":"T","artist":{"id":"a","name":"A"},"addedAt":1,"tracks":[{"id":"l:1","albumId":"la:1","source":"local","title":"One","artists":[{"id":"a","name":"A"}],"disc":2,"number":3,"durationMs":1500.0,"format":"flac"}],"genres":["Rock"],"label":"L","credits":[]}"#;
        let a: Album = serde_json::from_str(j).unwrap();
        assert_eq!(a.summary.title, "T");
        assert_eq!((a.tracks[0].disc, a.tracks[0].number), (2, 3));
        assert_eq!(a.genres, vec!["Rock".to_string()]);
    }

    #[test]
    fn playlists_know_who_owns_them() {
        let j = r#"[{"id":"pl:rune:x","name":"Road trip","trackCount":18,"source":"local","kind":"static","coverAlbumIds":["la:1"]},{"id":"pl:sp:liked","name":"Liked Songs","trackCount":3,"source":"spotify","canEdit":true}]"#;
        let l: Vec<PlaylistSummary> = serde_json::from_str(j).unwrap();
        assert!(l[0].is_editable() && l[0].can_add_to());
        assert!(!l[1].is_rune() && !l[1].can_add_to());
    }

    #[test]
    fn covers_use_the_server_route_unless_the_url_is_absolute() {
        assert_eq!(cover_path("la:1", None, "200"), "/api/cover/la%3A1?size=200");
        assert_eq!(cover_path("sp:1", Some("https://i.scdn.co/x"), "200"), "https://i.scdn.co/x");
        assert_eq!(cover_path("la:1", Some("/api/cover/la%3A1?size=600"), "200"), "/api/cover/la%3A1?size=200");
    }
}
