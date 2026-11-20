//! Protocol types and the state reduction. Pure: no I/O, the clock is passed in.
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ArtistRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub album_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artists: Vec<ArtistRef>,
    #[serde(default)]
    pub duration_ms: f64,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub queue_id: String,
    #[serde(default)]
    pub track: Track,
    #[serde(default)]
    pub album: AlbumRef,
}

impl QueueItem {
    pub fn artist_line(&self) -> String {
        self.track.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
    }
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Stopped,
    Playing,
    Paused,
    Loading,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

impl Repeat {
    pub fn next(self) -> Repeat {
        match self {
            Repeat::Off => Repeat::All,
            Repeat::All => Repeat::One,
            Repeat::One => Repeat::Off,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::Off => "off",
            Repeat::All => "all",
            Repeat::One => "one",
        }
    }
}

/// `PlayerState` as the server sends it. With `?slim=1` the queue is left out of an event whose queue did not change.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WireState {
    #[serde(default)]
    pub zone: String,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub queue: Option<Vec<QueueItem>>,
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub position_ms: f64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default)]
    pub shuffle: bool,
    #[serde(default)]
    pub repeat: Repeat,
    #[serde(default)]
    pub elsewhere: bool,
}

/// A zone as GET /zones lists it.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoneInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub soloist: Option<bool>,
    #[serde(default)]
    pub spotify_device_id: Option<String>,
    #[serde(default)]
    pub spotify_zone: Option<String>,
}

/// A playlist chosen for the mini (GET /api/mini/playlists): a coloured dot that shuffle-plays it.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiniPlaylist {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Dot colour index into the panel's eight-colour palette; the server keeps it stable and distinct.
    #[serde(default)]
    pub color: u8,
}

/// The most dots (and number keys) there are.
pub const MINI_MAX: usize = 8;

/// websocket /api/ws, server -> client. Anything else (scan progress, library-changed) is `Other`.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerEvent {
    Hello {
        #[serde(default)]
        build: Option<String>,
    },
    Player {
        state: WireState,
        #[serde(default, rename = "queueRev")]
        queue_rev: Option<String>,
    },
    /// The chosen playlists changed: read GET /api/mini/playlists again (handled by the caller, not the reducer).
    MiniPlaylists,
    #[serde(other)]
    Other,
}

/// The zone after `current` in `ids` (wrapping); the first one when `current` is not in the list.
pub fn next_zone(ids: &[String], current: &str) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    let at = ids.iter().position(|i| i == current);
    Some(ids[at.map(|i| (i + 1) % ids.len()).unwrap_or(0)].clone())
}

/// The zones the picker offers: what the web offers (browser zones are not listed by the server; the PC's own Spotify
/// device and Soloist-as-the-PC's-engine are folded into the pc zone, as web/src/player/routing.ts `withoutPcDevice`).
pub fn pickable_zones(all: &[ZoneInfo]) -> Vec<ZoneInfo> {
    let mut hidden: Vec<String> = Vec::new();
    for z in all.iter().filter(|z| z.kind == "pc") {
        if let Some(d) = &z.spotify_device_id {
            hidden.push(format!("spotify:{d}"));
        }
        if let Some(s) = &z.spotify_zone {
            hidden.push(s.clone());
        }
    }
    let mut out: Vec<ZoneInfo> = all.iter().filter(|z| z.kind != "browser" && !(z.kind == "spotify" && hidden.contains(&z.id))).cloned().collect();
    // pc first, then Soloist, then Spotify Connect devices (the web's order)
    let rank = |z: &ZoneInfo| if z.kind == "pc" { 0 } else if z.soloist == Some(true) { 1 } else { 2 };
    out.sort_by_key(rank);
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Conn {
    Connecting,
    Online,
    /// Failed `attempt` times in a row.
    Offline { attempt: u32 },
}

/// What the panel shows of one zone.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Player {
    pub status: Status,
    pub queue: Vec<QueueItem>,
    pub index: i64,
    pub position_ms: f64,
    /// Local monotonic time (`now_ms`) when `position_ms` was current.
    pub at_ms: u64,
    pub volume: f64,
    pub shuffle: bool,
    pub repeat: Repeat,
    pub elsewhere: bool,
}

impl Player {
    pub fn current(&self) -> Option<&QueueItem> {
        usize::try_from(self.index).ok().and_then(|i| self.queue.get(i))
    }
    /// The position now: the reported one plus the time since, while playing, held to the song's length.
    pub fn position(&self, now: u64) -> f64 {
        let base = self.position_ms + if self.status == Status::Playing { now.saturating_sub(self.at_ms) as f64 } else { 0. };
        let max = self.current().map(|c| c.track.duration_ms).filter(|d| *d > 0.).unwrap_or(base);
        base.clamp(0., max.max(0.))
    }
}

pub enum Msg {
    Ws(ServerEvent),
    /// A full state we asked for (or a command's answer). `rev` names the queue fingerprint it answers, if known.
    Fetched { state: WireState, rev: Option<String> },
    Conn(Conn),
    Zones(Vec<ZoneInfo>),
    /// The chosen playlists, in order.
    Minis(Vec<MiniPlaylist>),
    /// The answer to "shuffle-play this playlist": the new state of the zone, and which playlist made the queue.
    Started { playlist: String, state: WireState },
}

/// Things the reducer wants done; the caller does them.
#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    /// GET /player/:zone, and report it back as `Fetched` with this rev.
    Fetch { zone: String, rev: Option<String> },
}

#[derive(Debug, Default)]
pub struct Model {
    pub zone: String,
    pub zones: Vec<ZoneInfo>,
    pub conn_state: Option<Conn>,
    pub player: Option<Player>,
    /// Last full queue per zone and its fingerprint, to fill in slim events.
    queues: HashMap<String, (String, Vec<QueueItem>)>,
    /// A fetch is out for this zone: do not ask twice.
    fetching: Option<String>,
    /// The playlists on the left edge, in order (at most `MINI_MAX`).
    pub minis: Vec<MiniPlaylist>,
    /// The queue a playlist dot made: (zone, playlist id, first queue id, length). It stops matching as soon as the queue
    /// is replaced or edited, so the ring on a dot means "this queue came from it", not "it was clicked once".
    origin: Option<(String, String, String, usize)>,
}

impl Model {
    pub fn new(zone: &str) -> Model {
        Model { zone: zone.to_string(), conn_state: Some(Conn::Connecting), ..Default::default() }
    }

    pub fn conn(&self) -> Conn {
        self.conn_state.clone().unwrap_or(Conn::Connecting)
    }

    pub fn online(&self) -> bool {
        self.conn() == Conn::Online
    }

    /// The playlist whose shuffled play made the queue now shown, if the queue is still that one.
    pub fn playing_playlist(&self) -> Option<&str> {
        let (zone, id, first, len) = self.origin.as_ref()?;
        let p = self.player.as_ref()?;
        (*zone == self.zone && p.queue.len() == *len && p.queue.first().map(|q| &q.queue_id) == Some(first)).then_some(id.as_str())
    }

    /// Show another zone: its state is unknown until read.
    pub fn set_zone(&mut self, zone: &str) -> Vec<Effect> {
        if self.zone == zone {
            return vec![];
        }
        self.zone = zone.to_string();
        self.player = None;
        self.fetching = Some(zone.to_string());
        vec![Effect::Fetch { zone: zone.to_string(), rev: None }]
    }

    fn apply(&mut self, w: WireState, queue: Vec<QueueItem>, now: u64) {
        self.player = Some(Player {
            status: w.status,
            queue,
            index: w.index,
            position_ms: w.position_ms,
            at_ms: now,
            volume: w.volume,
            shuffle: w.shuffle,
            repeat: w.repeat,
            elsewhere: w.elsewhere,
        });
    }

    pub fn update(&mut self, msg: Msg, now: u64) -> Vec<Effect> {
        match msg {
            Msg::Conn(c) => {
                if matches!(c, Conn::Offline { .. } | Conn::Connecting) {
                    // events were missed: the next one for each zone must carry or fetch its queue
                    self.queues.clear();
                    self.fetching = None;
                }
                self.conn_state = Some(c);
                vec![]
            }
            Msg::Zones(z) => {
                self.zones = z;
                vec![]
            }
            Msg::Minis(mut l) => {
                l.truncate(MINI_MAX);
                self.minis = l;
                vec![]
            }
            Msg::Started { playlist, state } => {
                if state.zone != self.zone {
                    return vec![];
                }
                let q = state.queue.clone().unwrap_or_default();
                self.origin = q.first().map(|f| (state.zone.clone(), playlist, f.queue_id.clone(), q.len()));
                self.fetching = None;
                self.apply(state, q, now);
                vec![]
            }
            Msg::Ws(ServerEvent::Player { state, queue_rev }) => {
                if state.zone != self.zone {
                    return vec![];
                }
                if let Some(q) = state.queue.clone() {
                    if let Some(r) = &queue_rev {
                        self.queues.insert(state.zone.clone(), (r.clone(), q.clone()));
                    }
                    self.apply(state, q, now);
                    return vec![];
                }
                match (self.queues.get(&state.zone), &queue_rev) {
                    (Some((have, q)), Some(r)) if have == r => {
                        let q = q.clone();
                        self.apply(state, q, now);
                        vec![]
                    }
                    _ => {
                        // a queue we never saw (joined mid-way or missed an event): read the full state once
                        if self.fetching.as_deref() == Some(&self.zone) {
                            return vec![];
                        }
                        self.fetching = Some(self.zone.clone());
                        vec![Effect::Fetch { zone: self.zone.clone(), rev: queue_rev }]
                    }
                }
            }
            Msg::Ws(_) => vec![],
            Msg::Fetched { state, rev } => {
                if state.zone != self.zone {
                    return vec![];
                }
                self.fetching = None;
                let q = state.queue.clone().unwrap_or_default();
                if let Some(r) = rev {
                    self.queues.insert(state.zone.clone(), (r, q.clone()));
                }
                self.apply(state, q, now);
                vec![]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, title: &str) -> QueueItem {
        QueueItem { queue_id: id.into(), track: Track { title: title.into(), duration_ms: 100_000., ..Default::default() }, album: Default::default() }
    }
    fn ev(json: &str) -> Msg {
        Msg::Ws(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn a_full_event_becomes_the_view() {
        let mut m = Model::new("pc");
        let fx = m.update(ev(r#"{"type":"player","queueRev":"r1","state":{"zone":"pc","status":"playing","queue":[{"queueId":"a","track":{"id":"t","title":"One","durationMs":1000},"album":{"id":"x","title":"X"}}],"index":0,"positionMs":250,"volume":30,"shuffle":true,"repeat":"all","updatedAt":1}}"#), 500);
        assert!(fx.is_empty());
        let p = m.player.as_ref().unwrap();
        assert_eq!((p.status.clone(), p.index, p.volume, p.shuffle, p.repeat), (Status::Playing, 0, 30., true, Repeat::All));
        assert_eq!(p.current().unwrap().track.title, "One");
        assert_eq!(p.position(700), 450., "extrapolated 200 ms while playing");
        assert_eq!(p.position(1_000_000), 1000., "held to the song's length");
    }

    #[test]
    fn a_slim_event_reuses_the_queue_or_asks_once() {
        let mut m = Model::new("pc");
        let slim = r#"{"type":"player","queueRev":"r1","state":{"zone":"pc","status":"paused","index":0,"positionMs":0,"volume":1,"shuffle":false,"repeat":"off"}}"#;
        // never saw the queue: fetch once, not again while it is out
        assert_eq!(m.update(ev(slim), 0), vec![Effect::Fetch { zone: "pc".into(), rev: Some("r1".into()) }]);
        assert!(m.update(ev(slim), 0).is_empty());
        let full = WireState { zone: "pc".into(), queue: Some(vec![item("a", "One")]), ..Default::default() };
        m.update(Msg::Fetched { state: full, rev: Some("r1".into()) }, 0);
        assert_eq!(m.player.as_ref().unwrap().queue.len(), 1);
        // the same rev now fills in from the cache
        assert!(m.update(ev(slim), 5).is_empty());
        assert_eq!(m.player.as_ref().unwrap().queue[0].track.title, "One");
        assert_eq!(m.player.as_ref().unwrap().status, Status::Paused);
        // a new rev: fetch again
        let other = slim.replace("r1", "r2");
        assert_eq!(m.update(ev(&other), 5).len(), 1);
    }

    #[test]
    fn other_zones_and_unknown_events_are_ignored() {
        let mut m = Model::new("pc");
        m.update(ev(r#"{"type":"player","state":{"zone":"spotify:x","status":"playing","queue":[]}}"#), 0);
        assert!(m.player.is_none());
        m.update(ev(r#"{"type":"scan","progress":{}}"#), 0);
        m.update(ev(r#"{"type":"library-changed"}"#), 0);
        m.update(ev(r#"{"type":"hello","build":"abc"}"#), 0);
        assert!(m.player.is_none());
    }

    #[test]
    fn going_offline_forgets_cached_queues_and_switching_zones_refetches() {
        let mut m = Model::new("pc");
        m.update(Msg::Conn(Conn::Online), 0);
        assert!(m.online());
        m.update(Msg::Fetched { state: WireState { zone: "pc".into(), queue: Some(vec![]), ..Default::default() }, rev: Some("r".into()) }, 0);
        m.update(Msg::Conn(Conn::Offline { attempt: 1 }), 0);
        assert!(!m.online());
        let slim = r#"{"type":"player","queueRev":"r","state":{"zone":"pc"}}"#;
        assert_eq!(m.update(ev(slim), 0).len(), 1, "after a reconnect the cache cannot be trusted");
        assert_eq!(m.set_zone("spotify:d"), vec![Effect::Fetch { zone: "spotify:d".into(), rev: None }]);
        assert!(m.player.is_none());
        assert!(m.set_zone("spotify:d").is_empty());
    }

    #[test]
    fn the_zone_list_matches_the_web() {
        let z = |id: &str, kind: &str| ZoneInfo { id: id.into(), kind: kind.into(), name: id.into(), ..Default::default() };
        let mut pc = z("pc", "pc");
        pc.spotify_device_id = Some("dev".into());
        let mut soloist = z("soloist", "spotify");
        soloist.soloist = Some(true);
        let list = vec![z("spotify:phone", "spotify"), z("spotify:dev", "spotify"), z("browser:x", "browser"), soloist, pc];
        let ids: Vec<String> = pickable_zones(&list).into_iter().map(|z| z.id).collect();
        assert_eq!(ids, vec!["pc", "soloist", "spotify:phone"], "browser zones and the PC's own Spotify device are left out");
    }

    fn started(zone: &str, ids: &[&str]) -> WireState {
        WireState { zone: zone.into(), status: Status::Playing, queue: Some(ids.iter().map(|i| item(i, i)).collect()), shuffle: true, ..Default::default() }
    }

    #[test]
    fn the_chosen_playlists_come_from_the_server_and_are_capped() {
        let mut m = Model::new("pc");
        let l: Vec<MiniPlaylist> = serde_json::from_str(r#"[{"id":"pl:a","name":"Alpha","color":3},{"id":"pl:b","name":"Beta","color":0}]"#).unwrap();
        assert_eq!(l[0], MiniPlaylist { id: "pl:a".into(), name: "Alpha".into(), color: 3 });
        m.update(Msg::Minis(l), 0);
        assert_eq!(m.minis.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Alpha", "Beta"]);
        let many = (0..12).map(|i| MiniPlaylist { id: format!("pl:{i}"), ..Default::default() }).collect();
        m.update(Msg::Minis(many), 0);
        assert_eq!(m.minis.len(), MINI_MAX);
    }

    #[test]
    fn the_server_push_is_recognised_and_needs_no_reducer_work() {
        let mut m = Model::new("pc");
        let e: ServerEvent = serde_json::from_str(r#"{"type":"mini-playlists"}"#).unwrap();
        assert!(matches!(e, ServerEvent::MiniPlaylists));
        assert!(m.update(Msg::Ws(e), 0).is_empty());
        assert!(matches!(serde_json::from_str::<ServerEvent>(r#"{"type":"library-changed"}"#).unwrap(), ServerEvent::Other));
    }

    #[test]
    fn a_dot_rings_only_while_the_queue_it_made_is_unchanged() {
        let mut m = Model::new("pc");
        assert_eq!(m.playing_playlist(), None);
        m.update(Msg::Started { playlist: "pl:a".into(), state: started("pc", &["q1", "q2", "q3"]) }, 0);
        assert_eq!(m.playing_playlist(), Some("pl:a"));
        assert_eq!(m.player.as_ref().unwrap().queue.len(), 3, "the answer is shown at once");
        // the same queue again (a position update, a slim event): still ringed
        m.update(Msg::Fetched { state: started("pc", &["q1", "q2", "q3"]), rev: None }, 5);
        assert_eq!(m.playing_playlist(), Some("pl:a"));
        // a song removed: it is no longer the playlist's queue
        m.update(Msg::Fetched { state: started("pc", &["q1", "q3"]), rev: None }, 6);
        assert_eq!(m.playing_playlist(), None);
        // another queue entirely
        m.update(Msg::Started { playlist: "pl:b".into(), state: started("pc", &["z1", "z2"]) }, 7);
        assert_eq!(m.playing_playlist(), Some("pl:b"));
        m.update(Msg::Fetched { state: started("pc", &["y1", "y2"]), rev: None }, 8);
        assert_eq!(m.playing_playlist(), None);
        // another zone shows nothing ringed, and a Started for a zone not shown is ignored
        let mut n = Model::new("pc");
        n.update(Msg::Started { playlist: "pl:a".into(), state: started("pc", &["q1"]) }, 0);
        n.set_zone("spotify:x");
        assert_eq!(n.playing_playlist(), None);
        n.update(Msg::Started { playlist: "pl:a".into(), state: started("pc", &["q1"]) }, 1);
        assert_eq!(n.playing_playlist(), None);
    }

    #[test]
    fn the_zone_name_cycles_through_the_zones_and_wraps() {
        let ids: Vec<String> = ["pc", "soloist", "spotify:x"].iter().map(|s| s.to_string()).collect();
        assert_eq!(next_zone(&ids, "pc").as_deref(), Some("soloist"));
        assert_eq!(next_zone(&ids, "spotify:x").as_deref(), Some("pc"));
        assert_eq!(next_zone(&ids, "gone").as_deref(), Some("pc"));
        assert_eq!(next_zone(&[], "pc"), None);
        assert_eq!(next_zone(&ids[..1], "pc").as_deref(), Some("pc"));
    }
}
