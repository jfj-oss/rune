//! What the buttons do: every one is one request to the server (the app keeps no queue). Mirrors `hooks/usePlay.ts`,
//! `usePlaylistEdit.ts`, `Pin.tsx`, `Liked.tsx` and `lib/radio.ts`.
use crate::rune::*;
use crate::route::*;
use crate::util::plural;
use crate::playroute::*;
use std::collections::HashMap;
use gpui_kit::*;
use rune_mini_core::commands;
use rune_mini_core::library::*;
use serde_json::{json, Value};
use std::sync::Arc;

/// An album's track ids in play order (disc, then number): `albumItems` in usePlay.ts.
pub fn album_track_ids(a: &Album) -> Vec<String> {
    let mut t: Vec<&LibTrack> = a.tracks.iter().collect();
    t.sort_by_key(|x| (x.disc, x.number));
    t.into_iter().map(|x| x.id.clone()).collect()
}

/// The body of a `play` command (shared/src/index.ts `PlayerCommand`).
pub fn play_body(ids: &[String], start: usize, shuffle: bool) -> Value {
    let mut b = json!({"type": "play", "trackIds": ids, "startIndex": start});
    if shuffle { b["shuffle"] = json!(true); }
    b
}

impl Rune {
    /// Play a list of song ids on the zone on screen (ids only: no Spotify routing, for lists the server made of local files).
    pub fn play_ids(&mut self, ids: Vec<String>, start: usize, shuffle: bool, cx: &mut Context<Self>) {
        if ids.is_empty() { return; }
        self.player_body(play_body(&ids, start, shuffle));
        cx.notify();
    }

    /// The kind of a zone ("pc", "browser", "spotify"), by id.
    pub fn zone_kind(&self, id: &str) -> String {
        if id == self.own_zone { return "browser".into(); }
        self.model.zones.iter().find(|z| z.id == id).map(|z| z.kind.clone()).unwrap_or_else(|| if id.starts_with("spotify:") { "spotify".into() } else { "pc".into() })
    }

    pub fn play_tracks(&mut self, tracks: Vec<LibTrack>, start: usize, shuffle: bool, cx: &mut Context<Self>) {
        self.play_items(tracks.iter().map(Item::from_track).collect(), start, shuffle, None, cx);
    }

    /// `usePlayer.playItems`: pick the copy each song has on this zone (own file first), drop what it cannot play, and when the
    /// song asked for cannot play here ask where ("Play on"). Lists with nothing but local songs go straight through.
    pub fn play_items(&mut self, items: Vec<Item>, start: usize, shuffle: bool, zone: Option<String>, cx: &mut Context<Self>) {
        if items.is_empty() { return; }
        let zone = zone.unwrap_or_else(|| self.model.zone.clone());
        let kind = self.zone_kind(&zone);
        if items.iter().all(|i| zone_can_play(&kind, i.source) && i.source != Source::Spotify) {
            if zone != self.model.zone { self.set_zone(&zone, cx); }
            self.play_ids(items.iter().map(|i| i.id.clone()).collect(), start, shuffle, cx);
            return;
        }
        let connected = self.spotify_connected(cx);
        let can = ability(&kind, connected);
        let (need_local, need_sp) = lookups_needed(can, true, &items);
        let client = self.client.clone();
        let items2 = items.clone();
        cx.spawn(async move |this, cx| {
            let (to_local, to_sp) = cx.background_spawn(async move {
                let twins = |path: &str, body: Value| -> HashMap<String, Item> {
                    let Ok(v) = client.send_json("POST", path, Some(&body)) else { return HashMap::new() };
                    v.get("twins").and_then(|t| t.as_object()).map(|m| m.iter().filter_map(|(k, p)| {
                        let t = p.get("track")?;
                        Some((k.clone(), Item { id: t.get("id")?.as_str()?.to_string(), source: source_of(t.get("id")?.as_str()?, t.get("source").and_then(|s| s.as_str()).unwrap_or("")), title: t.get("title").and_then(|x| x.as_str()).unwrap_or("").into(), artists: t.get("artists").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from)).collect()).unwrap_or_default(), duration_ms: t.get("durationMs").and_then(|d| d.as_f64()).unwrap_or(0.), album_id: t.get("albumId").and_then(|x| x.as_str()).unwrap_or("").into() }))
                    }).collect()).unwrap_or_default()
                };
                let sp: Vec<&Item> = items2.iter().filter(|i| i.source == Source::Spotify).collect();
                let loc: Vec<&Item> = items2.iter().filter(|i| i.source == Source::Local).collect();
                let a = if need_local && !sp.is_empty() { twins("/local-twins", json!({"tracks": sp.iter().map(|i| json!({"id": i.id, "title": i.title, "artists": i.artists, "durationMs": i.duration_ms})).collect::<Vec<_>>()})) } else { HashMap::new() };
                let b = if need_sp && !loc.is_empty() { twins("/spotify-twins", json!({"ids": loc.iter().map(|i| i.id.clone()).collect::<Vec<_>>()})) } else { HashMap::new() };
                (a, b)
            }).await;
            let _ = this.update(cx, move |me, cx| me.play_routed(items, start, shuffle, zone, kind, can, (to_local, to_sp), cx));
        }).detach();
    }

    fn play_routed(&mut self, items: Vec<Item>, start: usize, shuffle: bool, zone: String, kind: String, can: Ability, twins: (HashMap<String, Item>, HashMap<String, Item>), cx: &mut Context<Self>) {
        let list = fit_for_zone(&items, start, can, true, &twins.0, &twins.1);
        match route_items(&kind, &list, start) {
            Routing::Start { need } => {
                self.dialog = Some(Dialog::PlayOn { items: list, start, shuffle, need });
                cx.notify();
            }
            Routing::Ok { items: kept, start, dropped } => {
                if dropped > 0 { let zn = if zone == self.model.zone { self.zone_name() } else { zone.clone() }; self.say(format!("{} skipped \u{2014} {} can't play them", plural(dropped, "track"), zn), cx); }
                if zone != self.model.zone { self.set_zone(&zone, cx); }
                self.play_ids(kept.iter().map(|i| i.id.clone()).collect(), start, shuffle, cx);
            }
        }
    }

    /// Chosen on the "Play on" sheet: that zone, the copies it can play.
    pub fn play_on(&mut self, zone: &str, items: Vec<Item>, start: usize, shuffle: bool, cx: &mut Context<Self>) {
        self.dialog = None;
        self.play_items(items, start, shuffle, Some(zone.to_string()), cx);
    }

    /// Is Spotify connected (the server's own status; no Spotify call)?
    pub fn spotify_connected(&mut self, cx: &mut Context<Self>) -> bool {
        self.ensure_json("/spotify/status", cx).ready().and_then(|v| v.get("connected").and_then(|c| c.as_bool())).unwrap_or(false)
    }

    pub fn enqueue_ids(&mut self, ids: Vec<String>, next: bool, cx: &mut Context<Self>) {
        if ids.is_empty() { return; }
        let n = ids.len();
        self.player_body(json!({"type": "enqueue", "trackIds": ids, "next": next}));
        self.say(if next { "Playing next".to_string() } else { format!("Added to queue \u{2014} {} {}", n, if n == 1 { "track" } else { "tracks" }) }, cx);
    }

    /// Run `f` with the album, from the cache or after fetching it.
    pub fn with_album(&mut self, id: &str, cx: &mut Context<Self>, f: impl FnOnce(&mut Rune, Arc<Album>, &mut Context<Self>) + 'static) {
        if let Some(a) = self.data.album.get(id).and_then(|c| c.slot.ready()).cloned() { f(self, a, cx); return; }
        self.spawn_json::<Album>(cx, format!("/albums/{}", commands::encode(id)), move |me, r, cx| match r {
            Ok(a) => f(me, Arc::new(a), cx),
            Err(_) => me.say("Could not load that album", cx),
        });
    }

    pub fn play_album(&mut self, id: &str, shuffle: bool, start: usize, cx: &mut Context<Self>) {
        self.with_album(id, cx, move |me, a, cx| { let mut t = a.tracks.clone(); t.sort_by_key(|x| (x.disc, x.number)); me.play_tracks(t, start, shuffle, cx) });
    }

    pub fn enqueue_album(&mut self, id: &str, next: bool, cx: &mut Context<Self>) {
        self.with_album(id, cx, move |me, a, cx| me.enqueue_ids(album_track_ids(&a), next, cx));
    }

    /// Several albums, in order, as one queue (the artist page's Play): at most 12, like `playAlbums`.
    pub fn play_albums(&mut self, ids: Vec<String>, shuffle: bool, cx: &mut Context<Self>) {
        let ids: Vec<String> = ids.into_iter().take(12).collect();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_spawn(async move {
                let mut all = Vec::new();
                for id in ids { let a: Album = client.get_json(&format!("/albums/{}", commands::encode(&id)))?; all.extend(album_track_ids(&a)); }
                Ok::<_, String>(all)
            }).await;
            let _ = this.update(cx, move |me, cx| match r { Ok(t) => me.play_ids(t, 0, shuffle, cx), Err(_) => me.say("Could not load those albums", cx) });
        }).detach();
    }

    pub fn play_playlist(&mut self, id: &str, shuffle: bool, start: usize, cx: &mut Context<Self>) {
        if let Some(d) = self.data.playlist.get(id).and_then(|c| c.slot.ready()).cloned() { self.play_tracks(d.tracks.clone(), start, shuffle, cx); return; }
        self.spawn_json::<PlaylistDetail>(cx, format!("/playlists/{}", commands::encode(id)), move |me, r, cx| match r {
            Ok(d) => me.play_tracks(d.tracks.clone(), start, shuffle, cx),
            Err(_) => me.say("Could not load that playlist", cx),
        });
    }

    pub fn enqueue_playlist(&mut self, id: &str, cx: &mut Context<Self>) {
        self.spawn_json::<PlaylistDetail>(cx, format!("/playlists/{}", commands::encode(id)), move |me, r, cx| match r {
            Ok(d) => me.enqueue_ids(d.tracks.iter().map(|t| t.id.clone()).collect(), false, cx),
            Err(_) => me.say("Could not load that playlist", cx),
        });
    }

    // ------------------------------------------------------------------ playlists

    pub fn add_to_playlist(&mut self, playlist: &str, name: &str, ids: Vec<String>, cx: &mut Context<Self>) {
        if ids.is_empty() { return; }
        let (n, name) = (ids.len(), name.to_string());
        self.spawn_send(cx, "POST", format!("/playlists/{}/tracks", commands::encode(playlist)), Some(json!({"trackIds": ids})), move |me, r, cx| {
            match r {
                Ok(_) => { me.data.playlists = None; me.data.playlist.clear(); me.say(format!("Added {} to \u{201c}{}\u{201d}", plural(n, "track"), name), cx); }
                Err(e) => me.say(format!("Could not add to \u{201c}{name}\u{201d}: {e}"), cx),
            }
        });
    }

    pub fn create_playlist(&mut self, name: String, ids: Vec<String>, cx: &mut Context<Self>) { self.create_playlist_with(name, String::new(), ids, cx); }

    pub fn create_playlist_with(&mut self, name: String, desc: String, ids: Vec<String>, cx: &mut Context<Self>) {
        let mut body = json!({"name": name});
        if !desc.is_empty() { body["description"] = json!(desc); }
        let go_there = ids.is_empty();
        self.spawn_send(cx, "POST", "/playlists".into(), Some(body), move |me, r, cx| match r {
            Ok(v) => {
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                let nm = v.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                me.data.playlists = None;
                if ids.is_empty() { me.say(format!("Created \u{201c}{nm}\u{201d}"), cx); if go_there && !id.is_empty() { me.go(Route::Playlist(id.clone()), cx); } } else { me.add_to_playlist(&id, &nm, ids, cx); }
            }
            Err(_) => me.say("Could not create the playlist \u{2014} is the rune server reachable?", cx),
        });
    }

    pub fn delete_playlist(&mut self, id: &str, name: &str, cx: &mut Context<Self>) {
        let name = name.to_string();
        self.spawn_send(cx, "DELETE", format!("/playlists/{}", commands::encode(id)), None, move |me, r, cx| match r {
            Ok(_) => { me.data.playlists = None; me.data.playlist.clear(); me.say(format!("Deleted \u{201c}{name}\u{201d}"), cx); me.go(Route::Playlists(String::new()), cx); }
            Err(_) => me.say("Could not delete the playlist \u{2014} nothing was changed", cx),
        });
    }

    pub fn remove_from_playlist(&mut self, playlist: &str, position: usize, cx: &mut Context<Self>) {
        self.spawn_send(cx, "DELETE", format!("/playlists/{}/tracks", commands::encode(playlist)), Some(json!({"positions": [position]})), move |me, r, cx| match r {
            Ok(_) => { me.data.playlists = None; me.data.playlist.clear(); me.say("Removed 1 track", cx); }
            Err(e) => me.say(format!("Could not remove the tracks: {e}"), cx),
        });
    }

    pub fn rename_playlist(&mut self, id: &str, name: String, cx: &mut Context<Self>) {
        let name = name.trim().to_string();
        if name.is_empty() { return; }
        self.spawn_send(cx, "PATCH", format!("/playlists/{}", commands::encode(id)), Some(json!({"name": name})), move |me, r, cx| match r {
            Ok(_) => { me.data.playlists = None; me.data.playlist.clear(); cx.notify(); }
            Err(e) => me.say(format!("Could not rename the playlist: {e}"), cx),
        });
    }

    /// Drag a row of a rune playlist from one position to another (`POST /playlists/:id/move`).
    pub fn move_in_playlist(&mut self, id: &str, from: usize, to: usize, cx: &mut Context<Self>) {
        if from == to { return; }
        self.spawn_send(cx, "POST", format!("/playlists/{}/move", commands::encode(id)), Some(json!({"from": from, "to": to})), move |me, r, cx| match r {
            Ok(_) => { me.data.playlist.clear(); me.data.playlists = None; me.pl_sel.clear(); cx.notify(); }
            Err(e) => me.say(format!("Could not move that track: {e}"), cx),
        });
    }

    pub fn remove_positions(&mut self, playlist: &str, positions: Vec<usize>, cx: &mut Context<Self>) {
        if positions.is_empty() { return; }
        let n = positions.len();
        self.spawn_send(cx, "DELETE", format!("/playlists/{}/tracks", commands::encode(playlist)), Some(json!({"positions": positions})), move |me, r, cx| match r {
            Ok(_) => { me.data.playlists = None; me.data.playlist.clear(); me.pl_sel.clear(); me.pl_anchor = None; me.pl_select_mode = false; me.say(format!("Removed {}", plural(n, "track")), cx); }
            Err(e) => me.say(format!("Could not remove the tracks: {e}"), cx),
        });
    }

    pub fn apply_match(&mut self, album: &str, mb: &str, cx: &mut Context<Self>) {
        let a = album.to_string();
        self.spawn_send(cx, "POST", format!("/albums/{}/match", commands::encode(album)), Some(json!({"musicbrainzReleaseId": mb})), move |me, r, cx| match r {
            Ok(_) => {
                me.data.album.remove(&a);
                me.forget_json(&format!("/albums/{}", commands::encode(&a)));
                for l in me.data.albums.values_mut() { l.at = None; }
                me.say("Match updated", cx);
            }
            Err(_) => me.say("Could not apply that match", cx),
        });
    }

    // ------------------------------------------------------------------ m3u8

    /// Export a playlist as an .m3u8 file: asks where to save it, or writes it to `path` (tests).
    pub fn export_m3u8(&mut self, id: &str, name: &str, path: Option<std::path::PathBuf>, cx: &mut Context<Self>) {
        let (client, pid) = (self.client.clone(), id.to_string());
        let file = format!("{}.m3u8", name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect::<String>().trim());
        let file = if file == ".m3u8" { "playlist.m3u8".to_string() } else { file };
        cx.spawn(async move |this, cx| {
            let dest = match path {
                Some(p) => Some(p),
                None => {
                    let dir = std::env::var("HOME").map(|h| std::path::PathBuf::from(h).join("Downloads")).unwrap_or_else(|_| std::path::PathBuf::from("."));
                    let rx = cx.update(|app| app.prompt_for_new_path(&dir, Some(&file)));
                    rx.await.ok().and_then(|r| r.ok()).flatten()
                }
            };
            let Some(dest) = dest else { return };
            let r = cx.background_spawn(async move {
                let mut reply = client.open_stream(&format!("/api/playlists/{}/export.m3u8", rune_mini_core::commands::encode(&pid)), 0)?;
                let mut text = String::new();
                std::io::Read::read_to_string(&mut reply.reader, &mut text).map_err(|e| e.to_string())?;
                std::fs::write(&dest, text).map_err(|e| e.to_string())?;
                Ok::<_, String>(dest)
            }).await;
            let _ = this.update(cx, |me, cx| match r { Ok(p) => me.say(format!("Saved {}", p.file_name().and_then(|f| f.to_str()).unwrap_or("the playlist")), cx), Err(e) => me.say(format!("Could not export: {e}"), cx) });
        }).detach();
    }

    /// Import an .m3u8: asks for the file, or reads `path` (tests); the playlist is made from the tracks rune finds.
    pub fn import_m3u8(&mut self, path: Option<std::path::PathBuf>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let src = match path {
                Some(p) => Some(p),
                None => {
                    let rx = cx.update(|app| app.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Import a playlist".into()) }));
                    rx.await.ok().and_then(|r| r.ok()).flatten().and_then(|v| v.into_iter().next())
                }
            };
            let Some(src) = src else { return };
            let name = src.file_stem().and_then(|s| s.to_str()).unwrap_or("Imported playlist").to_string();
            let text = cx.background_spawn(async move { std::fs::read_to_string(&src) }).await;
            let _ = this.update(cx, move |me, cx| match text {
                Err(e) => me.say(format!("Could not read that file: {e}"), cx),
                Ok(content) => me.spawn_send(cx, "POST", "/playlists/import".into(), Some(json!({"content": content, "name": name})), |me, r, cx| match r {
                    Ok(v) => {
                        me.data.playlists = None;
                        let (n, sk) = (v.get("imported").and_then(|x| x.as_u64()).unwrap_or(0) as usize, v.get("skipped").and_then(|x| x.as_u64()).unwrap_or(0) as usize);
                        me.say(format!("Imported {}{}", plural(n, "track"), if sk > 0 { format!(", {sk} not found") } else { String::new() }), cx);
                        if let Some(id) = v.get("id").and_then(|x| x.as_str()) { me.go(Route::Playlist(id.to_string()), cx); }
                    }
                    Err(e) => me.say(format!("Could not import: {e}"), cx),
                }),
            });
        }).detach();
    }

    // ------------------------------------------------------------------ pins, likes, radio, scan

    pub fn set_pin(&mut self, id: &str, pin: bool, playlist: bool, cx: &mut Context<Self>) {
        let id2 = id.to_string();
        self.spawn_send(cx, if pin { "PUT" } else { "DELETE" }, format!("/pins/{}", commands::encode(id)), None, move |me, r, cx| match r {
            Ok(_) => {
                me.data.album.remove(&id2);
                me.data.playlist.remove(&id2);
                if playlist { me.data.playlists = None; } else { for l in me.data.albums.values_mut() { l.at = None; } }
                me.say(if pin { if playlist { "Pinned to the top of Playlists" } else { "Pinned to the top of Albums" } } else { "Unpinned" }, cx);
            }
            Err(_) => me.say(if pin { "Could not pin it \u{2014} is the rune server reachable?" } else { "Could not unpin it" }, cx),
        });
    }

    pub fn set_liked(&mut self, id: &str, on: bool, cx: &mut Context<Self>) {
        let id2 = id.to_string();
        self.data.liked.insert(id.to_string(), on);
        cx.notify();
        self.spawn_send(cx, if on { "POST" } else { "DELETE" }, "/tracks/liked".into(), Some(json!({"ids": [id]})), move |me, r, cx| {
            if r.is_err() { me.data.liked.insert(id2, !on); me.say("Could not update Liked Songs \u{2014} changes undone", cx); }
            else { me.data.playlist.remove(LIKED_PLAYLIST_ID); me.data.playlists = None; }
        });
    }

    /// Ask the server's synced mirror once whether a Spotify track is liked (no Spotify call).
    pub fn ensure_liked(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.data.liked.contains_key(id) || !self.data.liked_asked.insert(id.to_string()) { return; }
        let id2 = id.to_string();
        self.spawn_json::<Value>(cx, format!("/tracks/liked?ids={}", commands::encode(id)), move |me, r, cx| {
            if let Ok(v) = r { let on = v.get("liked").and_then(|l| l.get(&id2)).and_then(|x| x.as_bool()).unwrap_or(false); me.data.liked.insert(id2, on); cx.notify(); }
        });
    }

    /// `startRadio`: the server picks track ids, the zone plays them.
    pub fn start_radio(&mut self, from: &'static str, id: &str, cx: &mut Context<Self>) {
        self.spawn_send(cx, "POST", "/radio/start".into(), Some(json!({"from": from, "id": id})), move |me, r, cx| match r {
            Ok(v) => {
                let ids: Vec<String> = v.get("trackIds").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                if ids.is_empty() { me.say("Nothing in the library to start radio from", cx); } else { me.play_ids(ids, 0, false, cx); }
            }
            Err(_) => me.say("Could not start radio \u{2014} is the server reachable?", cx),
        });
    }

    pub fn rescan(&mut self, cx: &mut Context<Self>) {
        self.spawn_send(cx, "POST", "/scan".into(), None, |me, r, cx| me.say(if r.is_ok() { "Library rescan started" } else { "Could not reach the server" }, cx));
    }

    pub fn run_menu_act(&mut self, act: MenuAct, cx: &mut Context<Self>) {
        match act {
            MenuAct::PlayNext(ids) => self.enqueue_ids(ids, true, cx),
            MenuAct::AddToQueue(ids) => self.enqueue_ids(ids, false, cx),
            MenuAct::AddToPlaylistToggle => {}
            MenuAct::AddToPlaylist { playlist, name } => { let ids = self.menu.as_ref().map(|m| m.add_ids.clone()).unwrap_or_default(); self.menu = None; self.add_to_playlist(&playlist, &name, ids, cx); }
            MenuAct::NewPlaylistWith(ids, _) => { self.menu = None; self.dialog_new_playlist(ids, cx); }
            MenuAct::GoAlbum(id) => self.go(Route::Album(id), cx),
            MenuAct::GoArtist(id) => self.go(Route::Artist(id), cx),
            MenuAct::Radio { from, id } => self.start_radio(from, &id, cx),
            MenuAct::SongRadio { id, title, artist } => { self.menu = None; self.song_radio = Some((id, title, artist)); cx.notify(); }
            MenuAct::Like { id, on } => self.set_liked(&id, on, cx),
            MenuAct::PinAlbum { id, pin } => self.set_pin(&id, pin, false, cx),
            MenuAct::PinPlaylist { id, pin } => self.set_pin(&id, pin, true, cx),
            MenuAct::RemoveFromPlaylist { playlist, position } => self.remove_from_playlist(&playlist, position, cx),
            MenuAct::RemoveFromQueue(id) => self.cmd(rune_mini_core::commands::UiCommand::Remove(id), cx),
            MenuAct::DeletePlaylist { id, name } => { self.menu = None; self.dialog = Some(Dialog::DeletePlaylist { id, name }); cx.notify(); }
            MenuAct::SetSort(s) => { if let Route::Albums(mut q) = self.route().clone() { q.sort = s; self.replace_route(Route::Albums(q), cx); } }
            MenuAct::SetView(list) => { self.view_list = list; self.save_state(); cx.notify(); }
            MenuAct::TracksSort(k) => { self.tracks_sort = k; self.tracks_desc = None; cx.notify(); }
            MenuAct::TracksDir => { let d = self.tracks_desc.unwrap_or(self.tracks_sort == "added"); self.tracks_desc = Some(!d); cx.notify(); }
            MenuAct::GenreSort(k) => { self.genre_sort = k; cx.notify(); }
            MenuAct::Facet { kind, value } => {
                if let Route::Albums(mut q) = self.route().clone() {
                    match kind { "label" => q.label = value, _ => q.year = value.and_then(|v| v.parse().ok()) }
                    self.replace_route(Route::Albums(q), cx);
                }
            }
            MenuAct::ExportM3u8 { id, name } => { self.menu = None; self.export_m3u8(&id, &name, None, cx); }
            MenuAct::ImportM3u8 => { self.menu = None; self.import_m3u8(None, cx); }
            MenuAct::Rescan => self.rescan(cx),
            MenuAct::Smart(act) => { self.menu = None; self.pending_smart = Some(act); cx.notify(); }
            MenuAct::FixMatch(id) => { self.menu = None; self.dialog = Some(Dialog::FixMatch { album: id, sel: None }); cx.notify(); }
            MenuAct::CopyText(t, what) => { cx.write_to_clipboard(ClipboardItem::new_string(t)); self.say(what, cx); }
            MenuAct::DuplicatesPage => self.go(Route::Duplicates, cx),
            MenuAct::SettingsPage => self.go(Route::Settings, cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn an_albums_tracks_play_in_disc_then_number_order() {
        let t = |id: &str, d, n| LibTrack { id: id.into(), disc: d, number: n, ..Default::default() };
        let a = Album { tracks: vec![t("c", 2, 1), t("b", 1, 2), t("a", 1, 1)], ..Default::default() };
        assert_eq!(album_track_ids(&a), vec!["a", "b", "c"]);
    }
    #[::core::prelude::v1::test]
    fn play_commands_carry_the_shuffle_flag_only_when_asked() {
        let ids = vec!["l:1".to_string()];
        assert_eq!(play_body(&ids, 0, false), json!({"type":"play","trackIds":["l:1"],"startIndex":0}));
        assert_eq!(play_body(&ids, 2, true)["shuffle"], json!(true));
    }
}
