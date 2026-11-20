//! Which songs a zone can play and which copy of a song it should get: the web's `player/routing.ts` and
//! `player/preferLocal.ts`, with the same rules and tests. Owned songs play from the local file wherever a zone can play
//! local files; a Spotify-only zone gets the Spotify copy; what a zone cannot play is dropped, and when the song that was
//! asked for cannot play there the "Play on" sheet asks where to play it.
use rune_mini_core::library::LibTrack;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source { Local, Spotify, Radio }

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub source: Source,
    pub title: String,
    pub artists: Vec<String>,
    pub duration_ms: f64,
    pub album_id: String,
}

pub fn source_of(id: &str, declared: &str) -> Source {
    match declared { "spotify" => Source::Spotify, "radio" => Source::Radio, "local" => Source::Local, _ => if id.starts_with("sp:") { Source::Spotify } else if id.starts_with("l:") { Source::Local } else { Source::Radio } }
}

impl Item {
    pub fn from_track(t: &LibTrack) -> Item {
        Item { id: t.id.clone(), source: source_of(&t.id, &t.source), title: t.title.clone(), artists: t.artists.iter().map(|a| a.name.clone()).collect(), duration_ms: t.duration_ms, album_id: t.album_id.clone() }
    }
    pub fn local(id: &str) -> Item { Item { id: id.into(), source: source_of(id, ""), title: String::new(), artists: vec![], duration_ms: 0., album_id: String::new() } }
}

/// What a zone can play (`zoneCanPlay`; the desktop app has no Soloist-on-a-phone).
pub fn zone_can_play(kind: &str, source: Source) -> bool {
    match kind {
        // the pc zone hosts every source: local and radio through mpv, Spotify through the Spotify app rune starts
        "pc" => true,
        "browser" => matches!(source, Source::Local | Source::Radio),
        _ => source == Source::Spotify,
    }
}

#[derive(Debug, PartialEq)]
pub enum Routing {
    Ok { items: Vec<Item>, start: usize, dropped: usize },
    /// the song asked for cannot play on this zone: the sheet asks where
    Start { need: Source },
}

pub fn route_items(kind: &str, items: &[Item], start: usize) -> Routing {
    let Some(s) = items.get(start) else { return Routing::Ok { items: vec![], start: 0, dropped: 0 } };
    if !zone_can_play(kind, s.source) { return Routing::Start { need: s.source }; }
    let kept: Vec<Item> = items.iter().filter(|i| zone_can_play(kind, i.source)).cloned().collect();
    let at = kept.iter().position(|k| std::ptr::eq(k, s) || k == s).unwrap_or(0);
    Routing::Ok { dropped: items.len() - kept.len(), items: kept, start: at }
}

/// "Play my own copy": Spotify songs the user owns become the local file (`twins` maps `sp:` id -> the local item).
pub fn prefer_local(items: &[Item], twins: &HashMap<String, Item>) -> Vec<Item> { items.iter().map(|i| twins.get(&i.id).cloned().unwrap_or_else(|| i.clone())).collect() }

/// The reverse: local files that have a Spotify copy become that Spotify song (for Spotify-only zones).
pub fn prefer_spotify(items: &[Item], twins: &HashMap<String, Item>) -> Vec<Item> { prefer_local(items, twins) }

#[derive(Clone, Copy, Debug)]
pub struct Ability { pub local: bool, pub spotify: bool, pub spotify_elsewhere: bool }

pub fn ability(kind: &str, spotify_elsewhere: bool) -> Ability {
    Ability { local: zone_can_play(kind, Source::Local), spotify: zone_can_play(kind, Source::Spotify), spotify_elsewhere }
}

/// Which twin lookups `fit_for_zone` needs: (to_local, to_spotify). A local-only zone with Spotify connected may need both.
pub fn lookups_needed(can: Ability, whole: bool, items: &[Item]) -> (bool, bool) {
    let has_sp = items.iter().any(|i| i.source == Source::Spotify);
    let has_local = items.iter().any(|i| i.source == Source::Local);
    if can.local && can.spotify { return (has_sp, false); }
    if can.spotify { return (false, has_local); }
    if !can.local { return (false, false); }
    (has_sp, whole && can.spotify_elsewhere && has_sp)
}

/// `fitForZone`: the copy of each song this zone can play, so as little as possible is skipped.
pub fn fit_for_zone(items: &[Item], start: usize, can: Ability, whole: bool, to_local: &HashMap<String, Item>, to_spotify: &HashMap<String, Item>) -> Vec<Item> {
    if can.local && can.spotify { return prefer_local(items, to_local); }
    if can.spotify { return prefer_spotify(items, to_spotify); }
    if !can.local { return items.to_vec(); }
    let here = prefer_local(items, to_local);
    let skipped_here = here.iter().filter(|i| i.source == Source::Spotify).count();
    if !whole || skipped_here == 0 || !can.spotify_elsewhere { return here; }
    let there = prefer_spotify(items, to_spotify);
    if there.get(start).map(|i| i.source) != Some(Source::Spotify) { return here; }
    let skipped_there = there.iter().filter(|i| i.source != Source::Spotify).count();
    if skipped_there < skipped_here { there } else { here }
}

/// Zones that could play songs of this source, browser first, then Soloist, then Connect devices (`playableZones`).
pub fn playable_zones(zones: &[(String, String, String)], source: Source) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = zones.iter().filter(|z| zone_can_play(&z.2, source)).cloned().collect();
    let rank = |z: &(String, String, String)| match z.2.as_str() { "browser" => 0, "spotify" => 2, _ => 3 };
    out.sort_by_key(rank);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn it(id: &str) -> Item { Item::local(id) }

    #[::core::prelude::v1::test]
    fn zones_play_what_the_web_says_they_play() {
        assert!(zone_can_play("pc", Source::Spotify) && zone_can_play("pc", Source::Local));
        assert!(zone_can_play("browser", Source::Local) && zone_can_play("browser", Source::Radio) && !zone_can_play("browser", Source::Spotify));
        assert!(zone_can_play("spotify", Source::Spotify) && !zone_can_play("spotify", Source::Local));
    }

    #[::core::prelude::v1::test]
    fn unplayable_songs_are_dropped_and_an_unplayable_start_asks() {
        let list = [it("l:1"), it("sp:2"), it("l:3")];
        match route_items("browser", &list, 2) { Routing::Ok { items, start, dropped } => { assert_eq!((items.len(), start, dropped), (2, 1, 1)); } other => panic!("{other:?}") }
        assert_eq!(route_items("browser", &list, 1), Routing::Start { need: Source::Spotify });
        assert_eq!(route_items("pc", &list, 1), Routing::Ok { items: list.to_vec(), start: 1, dropped: 0 });
        assert_eq!(route_items("pc", &[], 0), Routing::Ok { items: vec![], start: 0, dropped: 0 });
    }

    #[::core::prelude::v1::test]
    fn owned_spotify_songs_play_from_the_local_file_and_the_reverse_for_connect() {
        let mut to_local = HashMap::new();
        to_local.insert("sp:2".to_string(), it("l:9"));
        let list = [it("l:1"), it("sp:2")];
        let pc = fit_for_zone(&list, 0, ability("pc", true), true, &to_local, &HashMap::new());
        assert_eq!(pc.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["l:1", "l:9"]);
        let mut to_sp = HashMap::new();
        to_sp.insert("l:1".to_string(), it("sp:1"));
        let connect = fit_for_zone(&list, 0, ability("spotify", true), true, &HashMap::new(), &to_sp);
        assert_eq!(connect.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["sp:1", "sp:2"]);
    }

    #[::core::prelude::v1::test]
    fn a_local_only_zone_sends_the_whole_list_the_spotify_way_only_when_that_skips_fewer() {
        let list = [it("sp:1"), it("sp:2"), it("l:3")];
        let mut to_sp = HashMap::new();
        to_sp.insert("l:3".to_string(), it("sp:3"));
        // here: 2 Spotify songs would be skipped; there: none
        let r = fit_for_zone(&list, 0, ability("browser", true), true, &HashMap::new(), &to_sp);
        assert!(r.iter().all(|i| i.source == Source::Spotify));
        // adding to the queue (whole = false) keeps the zone as it is
        let r2 = fit_for_zone(&list, 0, ability("browser", true), false, &HashMap::new(), &to_sp);
        assert_eq!(r2, list.to_vec());
        // Spotify not connected: nothing to switch to
        let r3 = fit_for_zone(&list, 0, ability("browser", false), true, &HashMap::new(), &to_sp);
        assert_eq!(r3, list.to_vec());
    }

    #[::core::prelude::v1::test]
    fn the_sheet_lists_browser_first_and_only_zones_that_can_play() {
        let z = |id: &str, k: &str| (id.to_string(), id.to_string(), k.to_string());
        let zones = vec![z("pc", "pc"), z("spotify:x", "spotify"), z("browser:a", "browser")];
        assert_eq!(playable_zones(&zones, Source::Spotify).iter().map(|z| z.0.as_str()).collect::<Vec<_>>(), ["spotify:x", "pc"]);
        assert_eq!(playable_zones(&zones, Source::Local).iter().map(|z| z.0.as_str()).collect::<Vec<_>>(), ["browser:a", "pc"]);
        assert_eq!(lookups_needed(ability("pc", false), true, &[it("sp:1")]), (true, false));
    }
}
