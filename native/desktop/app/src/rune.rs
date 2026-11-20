//! The one piece of state: what the server last said (core's `Model`), what the pages hold (`Data`), where the user is
//! (`History`), and what the chrome is doing (menus, dialogs, drags). Every view is a method of `Rune` that draws from it;
//! every click is a method that sends a request. The app keeps no queue: the player bar shows the server's.
use crate::covers::{self, Covers};
use crate::data::*;
use crate::route::*;
use futures::StreamExt;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use rune_mini_core::commands::{self, Request, UiCommand};
use rune_mini_core::config::{self, Config};
use rune_mini_core::library::*;
use rune_mini_core::model::{pickable_zones, Conn, Effect, Model, Msg, Status};
use rune_mini_core::net::{Client, Net, NetEvent};
use rune_mini_core::now_ms;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const PAGE: usize = 120;

pub struct Toast {
    pub text: String,
    pub at: Instant,
}

/// What a menu item does (menu.rs draws, actions.rs runs).
#[derive(Clone, Debug)]
pub enum MenuAct {
    PlayNext(Vec<String>),
    AddToQueue(Vec<String>),
    /// open or close the "Add to playlist" list inside the menu
    AddToPlaylistToggle,
    AddToPlaylist { playlist: String, name: String },
    NewPlaylistWith(Vec<String>, String),
    GoAlbum(String),
    GoArtist(String),
    Radio { from: &'static str, id: String },
    Like { id: String, on: bool },
    PinAlbum { id: String, pin: bool },
    PinPlaylist { id: String, pin: bool },
    RemoveFromPlaylist { playlist: String, position: usize },
    RemoveFromQueue(String),
    DeletePlaylist { id: String, name: String },
    SetSort(crate::route::Sort),
    SetView(bool),
    TracksSort(&'static str),
    TracksDir,
    GenreSort(&'static str),
    Facet { kind: &'static str, value: Option<String> },
    Rescan,
    FixMatch(String),
    CopyText(String, String),
    DuplicatesPage,
    SettingsPage,
}

#[derive(Clone, Debug)]
pub struct PopItem {
    pub icon: &'static str,
    pub label: String,
    pub act: MenuAct,
    pub danger: bool,
    pub chevron: bool,
    pub dot: bool,
    /// an indented sub-entry of the open "Add to playlist" list
    pub sub: bool,
}

#[derive(Clone, Debug)]
pub struct PopMenu {
    pub x: f32,
    pub y: f32,
    pub items: Vec<PopItem>,
    /// the track ids the "Add to playlist" list adds (set for track and album menus)
    pub add_ids: Vec<String>,
    pub add_label: String,
    pub add_open: bool,
    /// where to anchor: Some(true) = x is the right edge (dropdowns)
    pub right_aligned: bool,
    /// open upward from y (the bar at the bottom)
    pub up: bool,
}

pub enum Dialog {
    /// Fix match: the album and the candidate release picked so far
    FixMatch { album: String, sel: Option<String> },
    /// New playlist: name box, and the tracks to put in it
    NewPlaylist { name: Entity<InputState>, ids: Vec<String> },
    DeletePlaylist { id: String, name: String },
}

#[derive(Clone, Copy, PartialEq)]
pub enum Drag {
    Seek,
    Volume,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Saved {
    #[serde(default)]
    sidebar_collapsed: bool,
    #[serde(default)]
    view_list: bool,
    /// the id of this install's own zone (`browser:<id>`), made on first run
    #[serde(default)]
    audio_id: String,
    /// the zone last chosen in the player bar
    #[serde(default)]
    zone: Option<String>,
}

pub struct Rune {
    pub cfg: Config,
    pub dir: PathBuf,
    pub net: Net,
    pub client: Client,
    pub model: Model,
    pub data: Data,
    pub covers: Covers,
    pub hist: History,
    pub lists: HashMap<String, ListState>,
    pub list_sigs: HashMap<String, u64>,
    pub hscrolls: HashMap<String, ScrollHandle>,
    pub audio_model: Model,
    pub audio: Option<crate::audio::tabplayer::TabPlayer<crate::audio::engine::RealEngine, crate::audio_zone::ChanReporter>>,
    pub own_zone: String,
    pub zone_pref: Option<String>,
    pub peak_cache: Option<(String, Arc<Vec<f32>>, bool)>,
    pub np_open: bool,
    pub prose_open: std::collections::HashSet<String>,
    pub hscores_open: bool,
    pub preview: Option<crate::preview::Preview>,
    pub pl_sel: std::collections::BTreeSet<usize>,
    pub pl_anchor: Option<usize>,
    pub pl_select_mode: bool,
    pub pl_rename: Option<Entity<InputState>>,
    pub pl_rename_sub: Option<Subscription>,
    pub focus: FocusHandle,

    pub sidebar_collapsed: bool,
    pub view_list: bool,
    pub queue_open: bool,
    pub menu: Option<PopMenu>,
    pub dialog: Option<Dialog>,
    pub toast: Option<Toast>,
    pub drag: Option<Drag>,
    /// the seek bar while dragging: where it is (ms); the server only hears the final value
    pub seek_drag: Option<f64>,
    /// volume the user just chose and until when it is shown instead of the server's (Spotify answers late)
    pub vol_hold: Option<(Instant, f64)>,
    pub vol_sent: Instant,
    pub zone_open: bool,
    pub signal_open: bool,
    pub signal_path: Vec<String>,
    signal_for: String,

    pub search_input: Entity<InputState>,
    pub albums_find: Entity<InputState>,
    pub playlists_find: Entity<InputState>,
    pub tracks_find: Entity<InputState>,
    pub genres_find: Entity<InputState>,
    pub tracks_q: String,
    pub genres_q: String,
    pub tracks_sort: &'static str,
    pub tracks_desc: Option<bool>,
    pub genre_sort: &'static str,
    pub find_timer: Option<Task<()>>,
    pub sort_open: bool,
    pub hovered_row: Option<String>,
    /// keyboard pick in search results (arrows + Enter)
    /// keyboard pick in search results; None until an arrow key is used
    pub search_pick: Option<usize>,
    /// cards show their format badge without hover (the search page)
    pub badges_always: bool,
    pub seek_bounds: std::rc::Rc<std::cell::Cell<Bounds<Pixels>>>,
    pub vol_bounds: std::rc::Rc<std::cell::Cell<Bounds<Pixels>>>,
    pub test: Option<crate::testhook::Hook>,
    pub frame: u64,
    pub bench_times: Vec<f64>,
    pub last_frame: Option<Instant>,
    tick: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

fn state_path(dir: &std::path::Path) -> PathBuf { dir.join("state.json") }

impl Rune {
    pub fn new(cfg: Config, dir: PathBuf, token: String, window: &mut Window, cx: &mut Context<Self>) -> Rune {
        let (net_tx, mut net_rx) = futures::channel::mpsc::unbounded();
        let net_tx = std::sync::Mutex::new(net_tx);
        let net = Net::start(&cfg.url, &token, Arc::new(move |e| { let _ = net_tx.lock().map(|t| t.unbounded_send(e)); }));
        let client = net.client.clone();
        net.set_visible(true);
        cx.spawn(async move |this, cx| {
            while let Some(ev) = net_rx.next().await {
                if this.update(cx, |m, cx| m.on_net(ev, cx)).is_err() { break; }
            }
        }).detach();

        let (cover_tx, mut cover_rx) = futures::channel::mpsc::unbounded();
        let budget = std::env::var("RUNE_DESKTOP_COVER_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(96);
        let covers = Covers::new(client.clone(), cover_tx, budget);
        cx.spawn(async move |this, cx| {
            while let Some(first) = cover_rx.next().await {
                let mut batch = vec![first];
                while let Ok(Some(more)) = cover_rx.try_next() { batch.push(more); }
                if this.update(cx, |m, cx| { for d in batch { m.covers.apply(d); } cx.notify(); }).is_err() { break; }
            }
        }).detach();

        let saved: Saved = std::fs::read_to_string(state_path(&dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search albums, artists, tracks"));
        let albums_find = cx.new(|cx| InputState::new(window, cx).placeholder("Find in albums"));
        let playlists_find = cx.new(|cx| InputState::new(window, cx).placeholder("Find in playlists"));
        let tracks_find = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by title, artist or album"));
        let genres_find = cx.new(|cx| InputState::new(window, cx).placeholder("Filter genres"));
        let mut subs = Vec::new();
        subs.push(cx.subscribe_in(&tracks_find, window, |this: &mut Rune, st, ev: &InputEvent, _w, cx| {
            if let InputEvent::Change = ev {
                let v = st.read(cx).value().trim().to_string();
                this.find_timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(250)).await;
                    let _ = this.update(cx, |m, cx| { if m.tracks_find.read(cx).value().trim() == v && m.tracks_q != v { m.tracks_q = v; cx.notify(); } });
                }));
            }
        }));
        subs.push(cx.subscribe_in(&genres_find, window, |this: &mut Rune, st, ev: &InputEvent, _w, cx| {
            if let InputEvent::Change = ev { this.genres_q = st.read(cx).value().trim().to_string(); cx.notify(); }
        }));
        subs.push(cx.subscribe_in(&search_input, window, |this: &mut Rune, st, ev: &InputEvent, window, cx| this.on_search_input(st, ev, window, cx)));
        subs.push(cx.subscribe_in(&albums_find, window, |this: &mut Rune, st, ev: &InputEvent, _w, cx| {
            if let InputEvent::Change = ev { let v = st.read(cx).value().trim().to_string(); this.find_changed(v, true, cx); }
        }));
        subs.push(cx.subscribe_in(&playlists_find, window, |this: &mut Rune, st, ev: &InputEvent, _w, cx| {
            if let InputEvent::Change = ev { let v = st.read(cx).value().trim().to_string(); this.find_changed(v, false, cx); }
        }));

        let start = match std::env::var("RUNE_DESKTOP_ROUTE").ok().as_deref() {
            Some(r) => parse_route(r),
            None => Route::Home,
        };
        let mut saved = saved;
        if saved.audio_id.is_empty() { saved.audio_id = crate::audio_zone::fresh_id(); let _ = std::fs::create_dir_all(&dir); if let Ok(j) = serde_json::to_string(&saved) { let _ = std::fs::write(state_path(&dir), j); } }
        let own_zone = format!("browser:{}", saved.audio_id);
        // this app sounds its own zone; on a Mac that is the default, since nothing else there plays
        let first_zone = saved.zone.clone().unwrap_or_else(|| if cfg!(target_os = "macos") { own_zone.clone() } else { cfg.zone.clone() });
        let model = Model::new(&first_zone);
        let audio_model = Model::new(&own_zone);
        let (audio_tx, audio_rx) = futures::channel::mpsc::unbounded();
        let audio = crate::audio_zone::start(&client, &own_zone, audio_tx);
        cx.spawn(async move |this, cx| {
            let mut audio_rx = audio_rx;
            while let Some(ev) = audio_rx.next().await { if this.update(cx, |m, cx| m.audio_event(ev, cx)).is_err() { break; } }
        }).detach();
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            if this.update(cx, |m, _| { if let Some(a) = m.audio.as_mut() { a.tick(now_ms()); } }).is_err() { break; }
        }).detach();
        let me = Rune {
            audio_model, audio, own_zone, zone_pref: saved.zone.clone(),
            cfg, dir, net, client, model, data: Data::default(), covers, hist: History::new(start), lists: HashMap::new(), list_sigs: HashMap::new(), hscrolls: HashMap::new(), peak_cache: None, np_open: false, prose_open: Default::default(), hscores_open: false, preview: None, pl_sel: Default::default(), pl_anchor: None, pl_select_mode: false, pl_rename: None, pl_rename_sub: None, focus: cx.focus_handle(),
            sidebar_collapsed: saved.sidebar_collapsed, view_list: saved.view_list, queue_open: false, menu: None, dialog: None, toast: None, drag: None, seek_drag: None,
            vol_hold: None, vol_sent: Instant::now() - Duration::from_secs(5), zone_open: false, signal_open: false, signal_path: vec![], signal_for: String::new(),
            search_input, albums_find, playlists_find, tracks_find, genres_find, tracks_q: String::new(), genres_q: String::new(), tracks_sort: "title", tracks_desc: None, genre_sort: "artist", find_timer: None, sort_open: false, hovered_row: None, search_pick: None, badges_always: false, seek_bounds: Default::default(), vol_bounds: Default::default(), test: crate::testhook::start(), frame: 0, bench_times: vec![], last_frame: None, tick: None, _subs: subs,
        };
        me.net.viewing(vec![me.model.zone.clone()]);
        me
    }

    // ------------------------------------------------------------------ persistence

    pub fn save_state(&self) {
        let s = Saved { sidebar_collapsed: self.sidebar_collapsed, view_list: self.view_list, audio_id: self.own_zone.trim_start_matches("browser:").to_string(), zone: self.zone_pref.clone() };
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(j) = serde_json::to_string(&s) { let _ = std::fs::write(state_path(&self.dir), j); }
    }

    // ------------------------------------------------------------------ the network

    pub fn on_net(&mut self, ev: NetEvent, cx: &mut Context<Self>) {
        let now = now_ms();
        let (msg, msg2) = match ev {
            NetEvent::Conn(c) => {
                if c == Conn::Online {
                    self.net.fetch_zones();
                    self.net.fetch_state(&self.model.zone.clone(), None);
                    if self.model.zone != self.own_zone { self.net.fetch_state(&self.own_zone.clone(), None); }
                    self.net.viewing(vec![self.model.zone.clone()]);
                    // the library may have changed while we were away
                    self.data.library_changed();
                    for l in self.data.albums.values_mut() { l.at = None; }
                }
                (Msg::Conn(c.clone()), Msg::Conn(c))
            }
            NetEvent::Ws(rune_mini_core::model::ServerEvent::LibraryChanged) => {
                self.data.library_changed();
                for l in self.data.albums.values_mut() { l.at = None; }
                cx.notify();
                return;
            }
            NetEvent::Ws(e) => (Msg::Ws(e.clone()), Msg::Ws(e)),
            NetEvent::Fetched { state, rev } => (Msg::Fetched { state: state.clone(), rev: rev.clone() }, Msg::Fetched { state, rev }),
            NetEvent::Zones(z) => (Msg::Zones(z.clone()), Msg::Zones(z)),
            NetEvent::Failed(e) => { self.say(e, cx); return; }
            NetEvent::Cover { .. } => return,
            // rune mini's playlist dots: not used by the desktop app
            NetEvent::Minis(_) | NetEvent::Started { .. } => return,
        };
        // the zone this app sounds is followed whichever zone is on screen
        if self.model.zone != self.own_zone {
            for e in self.audio_model.update(msg2, now) { let Effect::Fetch { zone, rev } = e; self.net.fetch_state(&zone, rev); }
            self.audio_changed(now);
        }
        let fx = self.model.update(msg, now);
        for e in fx {
            let Effect::Fetch { zone, rev } = e;
            self.net.fetch_state(&zone, rev);
        }
        if self.model.zone == self.own_zone { self.audio_state_from_view(now); }
        self.player_changed(cx);
    }

    /// After the server's state changed: the signal path (read when the song changes) and the position tick.
    fn player_changed(&mut self, cx: &mut Context<Self>) {
        let key = self.model.player.as_ref().and_then(|p| p.current().map(|c| format!("{}|{}", self.model.zone, c.queue_id))).unwrap_or_default();
        if key != self.signal_for {
            self.signal_for = key.clone();
            self.signal_path.clear();
            if !key.is_empty() {
                let zone = self.model.zone.clone();
                self.spawn_json::<Value>(cx, format!("/player/{}", commands::encode(&zone)), move |me, r, cx| {
                    if me.signal_for != key { return; }
                    if let Ok(v) = r {
                        me.signal_path = v.get("signalPath").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(|| derive_signal(&v));
                        cx.notify();
                    }
                });
            }
        }
        self.manage_tick(cx);
        cx.notify();
    }

    /// One redraw a second while something is playing (the seek bar's time); the bar itself is drawn from the monotonic clock.
    fn manage_tick(&mut self, cx: &mut Context<Self>) {
        let want = self.model.player.as_ref().is_some_and(|p| p.status == Status::Playing);
        if want && self.tick.is_none() {
            self.tick = Some(cx.spawn(async move |this, cx| loop {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                let go = this.update(cx, |m, cx| {
                    let still = m.model.player.as_ref().is_some_and(|p| p.status == Status::Playing);
                    if still { if m.drag != Some(Drag::Seek) { cx.notify(); } } else { m.tick = None; }
                    still
                }).unwrap_or(false);
                if !go { break; }
            }));
        } else if !want {
            self.tick = None;
        }
    }

    pub fn say(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.toast = Some(Toast { text: text.into(), at: Instant::now() });
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(3200)).await;
            let _ = this.update(cx, |m, cx| {
                if m.toast.as_ref().is_some_and(|t| t.at.elapsed() >= Duration::from_millis(3100)) { m.toast = None; cx.notify(); }
            });
        }).detach();
    }

    // ------------------------------------------------------------------ requests

    pub fn spawn_json<T: DeserializeOwned + Send + 'static>(&self, cx: &mut Context<Self>, path: String, done: impl FnOnce(&mut Rune, Result<T, String>, &mut Context<Rune>) + 'static) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_spawn(async move { client.get_json::<T>(&path) }).await;
            let _ = this.update(cx, move |me, cx| done(me, r, cx));
        }).detach();
    }

    pub fn spawn_send(&self, cx: &mut Context<Self>, method: &'static str, path: String, body: Option<Value>, done: impl FnOnce(&mut Rune, Result<Value, String>, &mut Context<Rune>) + 'static) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_spawn(async move { client.send_json(method, &path, body.as_ref()) }).await;
            let _ = this.update(cx, move |me, cx| done(me, r, cx));
        }).detach();
    }

    /// A player command for the zone being shown.
    pub fn cmd(&mut self, c: UiCommand, cx: &mut Context<Self>) {
        if let Some(r) = commands::map(&self.model, &c, now_ms()) { self.net.send(r); }
        cx.notify();
    }

    /// A raw `PlayerCommand` body (play / enqueue carry track ids the shared command table does not know).
    pub fn player_body(&mut self, body: Value) {
        self.net.send(Request { zone: self.model.zone.clone(), body });
    }

    // ------------------------------------------------------------------ fetch on demand

    pub fn ensure_album(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.data.album.get(id).is_some_and(|c| !c.stale()) { return; }
        match self.data.album.get_mut(id) { Some(c) => c.at = Instant::now(), None => { self.data.album.insert(id.to_string(), Cached::loading()); } }
        let key = id.to_string();
        self.spawn_json::<Album>(cx, format!("/albums/{}", commands::encode(id)), move |me, r, cx| {
            me.data.album.insert(key, Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            cx.notify();
        });
    }

    pub fn ensure_artist(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.data.artist.get(id).is_some_and(|c| !c.stale()) { return; }
        match self.data.artist.get_mut(id) { Some(c) => c.at = Instant::now(), None => { self.data.artist.insert(id.to_string(), Cached::loading()); } }
        let key = id.to_string();
        self.spawn_json::<Artist>(cx, format!("/artists/{}", commands::encode(id)), move |me, r, cx| {
            me.data.artist.insert(key, Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            cx.notify();
        });
    }

    pub fn ensure_playlists(&mut self, cx: &mut Context<Self>) {
        if self.data.playlists.as_ref().is_some_and(|c| !c.stale()) { return; }
        match self.data.playlists.as_mut() { Some(c) => c.at = Instant::now(), None => self.data.playlists = Some(Cached::loading()) }
        self.spawn_json::<Vec<PlaylistSummary>>(cx, "/playlists".into(), |me, r, cx| {
            me.data.playlists = Some(Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            cx.notify();
        });
    }

    pub fn ensure_playlist(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.data.playlist.get(id).is_some_and(|c| !c.stale()) { return; }
        match self.data.playlist.get_mut(id) { Some(c) => c.at = Instant::now(), None => { self.data.playlist.insert(id.to_string(), Cached::loading()); } }
        let key = id.to_string();
        self.spawn_json::<PlaylistDetail>(cx, format!("/playlists/{}", commands::encode(id)), move |me, r, cx| {
            me.data.playlist.insert(key, Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            cx.notify();
        });
    }

    pub fn ensure_search(&mut self, q: &str, cx: &mut Context<Self>) {
        if q.is_empty() || self.data.search.get(q).is_some_and(|c| !c.stale()) { return; }
        match self.data.search.get_mut(q) { Some(c) => c.at = Instant::now(), None => { self.data.search.insert(q.to_string(), Cached::loading()); } }
        let key = q.to_string();
        self.spawn_json::<SearchResults>(cx, format!("/search{}", rune_mini_core::client_ext::qs(&[("q", q.to_string())])), move |me, r, cx| {
            me.data.search.insert(key, Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            me.search_pick = None;
            cx.notify();
        });
    }

    /// Any GET as JSON, kept by its path like a query cache. Returns what is known now; asks again when stale.
    pub fn ensure_json(&mut self, path: &str, cx: &mut Context<Self>) -> Slot<serde_json::Value> {
        if let Some(c) = self.data.json.get(path) {
            if !c.stale() { return c.slot.clone(); }
        }
        let prev = self.data.json.get(path).map(|c| c.slot.clone());
        self.data.json.insert(path.to_string(), Cached { slot: prev.clone().unwrap_or(Slot::Loading), at: Instant::now() });
        let key = path.to_string();
        self.spawn_json::<Value>(cx, path.to_string(), move |me, r, cx| {
            me.data.json.insert(key, Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
            cx.notify();
        });
        prev.unwrap_or(Slot::Loading)
    }

    /// Drop one cached JSON (after we changed it) so the next draw asks again.
    pub fn forget_json(&mut self, prefix: &str) { self.data.json.retain(|k, _| !k.starts_with(prefix)); }

    pub fn ensure_facets(&mut self, cx: &mut Context<Self>) {
        if self.data.genres.as_ref().is_none_or(|c| c.stale()) {
            if self.data.genres.is_none() { self.data.genres = Some(Cached::loading()); } else if let Some(c) = self.data.genres.as_mut() { c.at = Instant::now(); }
            self.spawn_json::<Vec<GenreFacet>>(cx, "/genres".into(), |me, r, cx| { me.data.genres = Some(Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() }); cx.notify(); });
        }
    }

    pub fn ensure_labels_years(&mut self, cx: &mut Context<Self>) {
        if self.data.labels.as_ref().is_none_or(|c| c.stale()) {
            if self.data.labels.is_none() { self.data.labels = Some(Cached::loading()); } else if let Some(c) = self.data.labels.as_mut() { c.at = Instant::now(); }
            self.spawn_json::<Vec<LabelFacet>>(cx, "/labels".into(), |me, r, cx| { me.data.labels = Some(Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() }); cx.notify(); });
        }
        if self.data.years.as_ref().is_none_or(|c| c.stale()) {
            if self.data.years.is_none() { self.data.years = Some(Cached::loading()); } else if let Some(c) = self.data.years.as_mut() { c.at = Instant::now(); }
            self.spawn_json::<Vec<YearFacet>>(cx, "/years".into(), |me, r, cx| { me.data.years = Some(Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() }); cx.notify(); });
        }
    }

    /// The Tracks page's pages (`/tracks?q&sort&dir&offset&limit`), or a genre's albums through `ensure_albums`.
    pub fn ensure_tracks(&mut self, key: &str, query: &str, more: bool, cx: &mut Context<Self>) {
        let l = self.data.tracks.entry(key.to_string()).or_default();
        if l.fetching { return; }
        let offset = if more { if !l.loaded || l.items.len() >= l.total { return; } l.items.len() } else { if l.loaded && l.at.is_some_and(|t| t.elapsed() < STALE) { return; } 0 };
        l.fetching = true;
        let (k, q) = (key.to_string(), query.to_string());
        self.spawn_json::<Page<LibTrack>>(cx, format!("/tracks?{}offset={}&limit=200", if query.is_empty() { String::new() } else { format!("{query}&") }, offset), move |me, r, cx| {
            let l = me.data.tracks.entry(k).or_default();
            l.fetching = false;
            match r {
                Ok(p) => { if offset == 0 { l.items = p.items; } else { l.items.extend(p.items); } l.total = p.total; l.loaded = true; l.error = None; l.at = Some(Instant::now()); }
                Err(e) => l.error = Some(e),
            }
            cx.notify();
        });
    }

    /// The first page of an Albums query, and (when `more`) the next one.
    pub fn ensure_albums(&mut self, q: &AlbumsQ, more: bool, cx: &mut Context<Self>) {
        let key = q.key();
        let l = self.data.albums.entry(key.clone()).or_default();
        if l.fetching { return; }
        let offset = if more {
            if !l.loaded || l.items.len() >= l.total { return; }
            l.items.len()
        } else {
            if l.loaded && l.at.is_some_and(|t| t.elapsed() < STALE) { return; }
            0
        };
        l.fetching = true;
        let q2 = q.clone();
        self.spawn_json::<Page<AlbumSummary>>(cx, format!("/library/albums{}", q2.query(offset, PAGE)), move |me, r, cx| {
            let l = me.data.albums.entry(key).or_default();
            l.fetching = false;
            match r {
                Ok(p) => {
                    if offset == 0 { l.items = p.items; } else { l.items.extend(p.items); }
                    l.total = p.total;
                    l.loaded = true;
                    l.error = None;
                    l.at = Some(Instant::now());
                }
                Err(e) => l.error = Some(e),
            }
            cx.notify();
        });
    }

    /// Every album (for the Artists page): pages of 500 until the total is reached.
    pub fn ensure_artist_cards(&mut self, cx: &mut Context<Self>) {
        if self.data.artist_cards.as_ref().is_some_and(|c| !c.stale()) { return; }
        match self.data.artist_cards.as_mut() { Some(c) => c.at = Instant::now(), None => self.data.artist_cards = Some(Cached::loading()) }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_spawn(async move {
                let mut all: Vec<AlbumSummary> = Vec::new();
                loop {
                    let p: Page<AlbumSummary> = client.get_json(&format!("/library/albums?sort=artist&offset={}&limit=500", all.len()))?;
                    let n = p.items.len();
                    all.extend(p.items);
                    if n == 0 || all.len() >= p.total { break; }
                }
                Ok::<_, String>(artist_cards(&all))
            }).await;
            let _ = this.update(cx, move |me, cx| {
                me.data.artist_cards = Some(Cached { slot: match r { Ok(a) => Slot::Ready(Arc::new(a)), Err(e) => Slot::Err(e) }, at: Instant::now() });
                cx.notify();
            });
        }).detach();
    }

    // ------------------------------------------------------------------ navigation

    /// Test runs only: the time between drawn frames.
    pub fn note_frame(&mut self) {
        if self.test.is_none() { return; }
        let now = Instant::now();
        if let Some(l) = self.last_frame { self.bench_times.push(now.duration_since(l).as_secs_f64() * 1000.); if self.bench_times.len() > 20000 { self.bench_times.drain(..10000); } }
        self.last_frame = Some(now);
    }

    pub fn route(&self) -> &Route { self.hist.current() }

    pub fn go(&mut self, r: Route, cx: &mut Context<Self>) {
        if self.hist.push(r) { self.routed(cx); }
    }
    pub fn back(&mut self, cx: &mut Context<Self>) { if self.hist.back() { self.routed(cx); } }
    pub fn forward(&mut self, cx: &mut Context<Self>) { if self.hist.forward() { self.routed(cx); } }

    fn routed(&mut self, cx: &mut Context<Self>) {
        // the web closes the queue and menus when the path changes (Shell.tsx)
        self.queue_open = false;
        self.np_open = false;
        self.pl_sel.clear();
        self.pl_anchor = None;
        self.pl_select_mode = false;
        self.pl_rename = None;
        self.menu = None;
        self.sort_open = false;
        self.hovered_row = None;
        self.search_pick = None;
        cx.notify();
    }

    /// A page changed its own parameters (typing in a find box): no new history entry.
    pub fn replace_route(&mut self, r: Route, cx: &mut Context<Self>) {
        if self.hist.replace(r) { cx.notify(); }
    }

    // ------------------------------------------------------------------ the typed boxes

    fn on_search_input(&mut self, st: &Entity<InputState>, ev: &InputEvent, _window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            InputEvent::Change => {
                let v = st.read(cx).value().trim().to_string();
                if v.is_empty() { return; }
                // debounced 200 ms like TopBar.tsx; replaces the entry while already on the search page
                let on_search = matches!(self.route(), Route::Search(_));
                self.find_timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(200)).await;
                    let _ = this.update(cx, |m, cx| {
                        let now = m.search_input.read(cx).value().trim().to_string();
                        if now == v {
                            if on_search || matches!(m.route(), Route::Search(_)) { m.replace_route(Route::Search(v), cx); } else { m.go(Route::Search(v), cx); }
                        }
                    });
                }));
            }
            InputEvent::PressEnter { .. } => {
                let v = st.read(cx).value().trim().to_string();
                self.find_timer = None;
                if let Route::Search(q) = self.route().clone() {
                    if q == v { self.activate_search_pick(cx); return; }
                }
                if !v.is_empty() { if matches!(self.route(), Route::Search(_)) { self.replace_route(Route::Search(v), cx); } else { self.go(Route::Search(v), cx); } }
            }
            _ => {}
        }
    }

    /// The Albums / Playlists find boxes: 220 ms after the last key, the route's `q` follows (history entry replaced).
    fn find_changed(&mut self, v: String, albums: bool, cx: &mut Context<Self>) {
        let same = match self.route() { Route::Albums(q) if albums => q.q == v, Route::Playlists(q) if !albums => *q == v, _ => true };
        if same { return; }
        self.find_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(220)).await;
            let _ = this.update(cx, |m, cx| {
                let cur = if albums { m.albums_find.read(cx).value().trim().to_string() } else { m.playlists_find.read(cx).value().trim().to_string() };
                if cur != v { return; }
                match m.route().clone() {
                    Route::Albums(mut q) if albums => { q.q = v; m.replace_route(Route::Albums(q), cx); }
                    Route::Playlists(_) if !albums => m.replace_route(Route::Playlists(v), cx),
                    _ => {}
                }
            });
        }));
    }

    pub fn zone_list(&self) -> Vec<(String, String, String)> {
        let mut z: Vec<(String, String, String)> = pickable_zones(&self.model.zones).into_iter().map(|z| (z.id, z.name, z.kind)).collect();
        if z.is_empty() { z.push(("pc".into(), "Linux PC speakers".into(), "pc".into())); }
        z.push((self.own_zone.clone(), crate::audio_zone::device_name(), "browser".into()));
        z
    }

    pub fn zone_name(&self) -> String {
        if self.model.zone == self.own_zone { return crate::audio_zone::device_name(); }
        self.model.zones.iter().find(|z| z.id == self.model.zone).map(|z| z.name.clone()).unwrap_or_else(|| if self.model.zone == "pc" { "Linux PC speakers".into() } else { self.model.zone.clone() })
    }

    pub fn set_zone(&mut self, id: &str, cx: &mut Context<Self>) {
        self.zone_pref = Some(id.to_string());
        self.save_state();
        if id != self.own_zone && self.model.zone == self.own_zone {
            // our own zone is followed by the second model while another zone is on screen: start it from the server's word
            self.audio_model = Model::new(&self.own_zone);
            self.net.fetch_state(&self.own_zone.clone(), None);
        }
        let fx = self.model.set_zone(id);
        for e in fx { let Effect::Fetch { zone, rev } = e; self.net.fetch_state(&zone, rev); }
        self.net.viewing(vec![id.to_string()]);
        self.zone_open = false;
        self.player_changed(cx);
    }

    /// The scale-aware cover request: the server sizes are 200 and 600 (the web's srcset).
    pub fn cover(&mut self, id: &str, url: Option<&str>, logical_px: f32, window: &Window) -> Option<Arc<RenderImage>> {
        let device = logical_px * window.scale_factor();
        let size: u16 = if device <= 210. { 200 } else { 600 };
        // a 600 that is already decoded is as good as a 200: no second request when the bigger one is held
        if size == 200 && self.covers.has(id, 600) { return self.covers.get(id, url, 600, device.ceil() as u32); }
        self.covers.get(id, url, size, device.ceil() as u32)
    }
}

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_route(s: &str) -> Route {
    let (path, query) = s.split_once('?').unwrap_or((s, ""));
    let param = |k: &str| query.split('&').find_map(|p| p.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| v.to_string()));
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    let dec = |x: &str| pct_decode(x);
    match seg.as_slice() {
        [""] | ["home"] => Route::Home,
        ["albums"] => {
            let mut q = AlbumsQ::default();
            match param("source").as_deref() { Some("local") => q.source = Src::Local, Some("spotify") => q.source = Src::Spotify, _ => {} }
            match param("sort").as_deref() { Some("artist") => q.sort = Sort::Artist, Some("title") => q.sort = Sort::Title, Some("year") => q.sort = Sort::Year, _ => {} }
            q.q = param("q").map(|v| pct_decode(&v.replace('+', " "))).unwrap_or_default();
            q.genre = param("genre").map(|v| pct_decode(&v));
            q.label = param("label").map(|v| pct_decode(&v));
            q.year = param("year").and_then(|v| v.parse().ok());
            Route::Albums(q)
        }
        ["album", id] => Route::Album(dec(id)),
        ["artists"] => Route::Artists,
        ["artist", id] => Route::Artist(dec(id)),
        ["playlists"] => Route::Playlists(param("q").unwrap_or_default()),
        ["playlist", id] => Route::Playlist(dec(id)),
        ["search"] => Route::Search(param("q").unwrap_or_default()),
        ["tracks"] => Route::Tracks,
        ["genres"] => Route::Genres,
        ["genres", g] => Route::Genre(dec(g)),
        ["people", p] => Route::Person(dec(p)),
        ["people"] => Route::People,
        ["discover"] => Route::Discover,
        ["radio"] => Route::Radio,
        ["stats"] => Route::Stats,
        ["settings"] => Route::Settings,
        ["duplicates"] => Route::Duplicates,
        _ => Route::Home,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn routes_parse_like_the_web_urls() {
        assert_eq!(parse_route("/albums?source=spotify"), Route::Albums(AlbumsQ::spotify()));
        assert_eq!(parse_route("/album/la%3Aabc"), Route::Album("la:abc".into()));
        assert_eq!(parse_route("/playlists"), Route::Playlists(String::new()));
        assert_eq!(parse_route("/search?q=glass"), Route::Search("glass".into()));
        assert_eq!(parse_route("/"), Route::Home);
    }
}

/// The web's `useSignalPath` fallback for the PC zone when the server sent no path: derived from the track's file format.
pub fn derive_signal(state: &Value) -> Vec<String> {
    if state.get("zone").and_then(|z| z.as_str()) != Some("pc") { return vec![]; }
    let idx = state.get("index").and_then(|i| i.as_i64()).unwrap_or(-1);
    let Some(t) = state.get("queue").and_then(|q| q.as_array()).and_then(|q| usize::try_from(idx).ok().and_then(|i| q.get(i))).and_then(|q| q.get("track")) else { return vec![] };
    if t.get("source").and_then(|s| s.as_str()) == Some("spotify") { return vec![]; }
    let sr = t.get("sampleRate").and_then(|x| x.as_f64()).unwrap_or(44100.);
    if t.get("format").and_then(|x| x.as_str()) == Some("mp3") {
        return vec![format!("MP3 {}", t.get("bitrateKbps").and_then(|x| x.as_i64()).unwrap_or(320)), "mpv".into(), "PipeWire 48 kHz".into(), "resampled".into()];
    }
    let bd = t.get("bitDepth").and_then(|x| x.as_i64()).unwrap_or(16);
    vec![format!("FLAC {}/{}", bd, sr / 1000.), "mpv".into(), format!("PipeWire {} kHz", (sr / 1000.).round()), "bit-perfect".into()]
}
