//! What a key or a button asks for, and the REST request that carries it. The server owns the queue: the panel never
//! edits a queue itself, it sends `POST /api/player/:zone` with one `PlayerCommand` (see shared/src/index.ts).
use crate::model::{Model, Repeat, Status};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum UiCommand {
    PlayPause,
    Play,
    Pause,
    Next,
    Prev,
    /// Absolute position in ms.
    SeekTo(f64),
    /// Relative to the position now, in ms.
    SeekBy(f64),
    /// 0..100
    Volume(f64),
    VolumeBy(f64),
    ToggleShuffle,
    SetShuffle(bool),
    CycleRepeat,
    SetRepeat(Repeat),
    /// Play from this queue position.
    Jump(usize),
    Remove(String),
    Move { queue_id: String, to: usize },
    Clear,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub zone: String,
    pub body: Value,
}

impl Request {
    pub fn path(&self) -> String {
        format!("/api/player/{}", encode(&self.zone))
    }
}

/// The body of "shuffle-play this playlist": what the web's Shuffle button sends (store/player.ts `startOn`): the whole list,
/// shuffle on, the zone mixes it itself (first song included).
pub fn play_playlist_body(track_ids: &[String]) -> Value {
    json!({"type": "play", "trackIds": track_ids, "startIndex": 0, "shuffle": true})
}

/// Percent-encode a path segment (zone ids contain ':' and Spotify device ids may contain more).
pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The request for `cmd` given what is shown now, or `None` when there is nothing sensible to send.
pub fn map(model: &Model, cmd: &UiCommand, now: u64) -> Option<Request> {
    let zone = model.zone.clone();
    let p = model.player.as_ref();
    let body = match cmd {
        UiCommand::PlayPause => match p.map(|p| &p.status) {
            Some(Status::Playing) | Some(Status::Loading) => json!({"type": "pause"}),
            Some(Status::Paused) => json!({"type": "resume"}),
            // stopped (the queue ended): start the queue again from the cursor, or the top
            Some(Status::Stopped) => {
                let p = p?;
                if p.queue.is_empty() {
                    return None;
                }
                json!({"type": "jump", "index": p.index.max(0)})
            }
            None => return None,
        },
        UiCommand::Play => json!({"type": "resume"}),
        UiCommand::Pause => json!({"type": "pause"}),
        UiCommand::Next => json!({"type": "next"}),
        UiCommand::Prev => json!({"type": "prev"}),
        UiCommand::SeekTo(ms) => json!({"type": "seek", "positionMs": ms.max(0.).round()}),
        UiCommand::SeekBy(d) => {
            let p = p?;
            let dur = p.current()?.track.duration_ms;
            let mut to = (p.position(now) + d).max(0.);
            if dur > 0. {
                to = to.min((dur - 500.).max(0.));
            }
            json!({"type": "seek", "positionMs": to.round()})
        }
        UiCommand::Volume(v) => json!({"type": "volume", "volume": v.clamp(0., 100.).round()}),
        UiCommand::VolumeBy(d) => json!({"type": "volume", "volume": (p?.volume + d).clamp(0., 100.).round()}),
        UiCommand::ToggleShuffle => json!({"type": "shuffle", "on": !p?.shuffle}),
        UiCommand::SetShuffle(on) => json!({"type": "shuffle", "on": on}),
        UiCommand::CycleRepeat => json!({"type": "repeat", "mode": p?.repeat.next().as_str()}),
        UiCommand::SetRepeat(r) => json!({"type": "repeat", "mode": r.as_str()}),
        UiCommand::Jump(i) => json!({"type": "jump", "index": i}),
        UiCommand::Remove(id) => json!({"type": "remove", "queueId": id}),
        UiCommand::Move { queue_id, to } => json!({"type": "move", "queueId": queue_id, "toIndex": to}),
        UiCommand::Clear => json!({"type": "clear"}),
    };
    Some(Request { zone, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn model(status: Status, vol: f64, shuffle: bool, repeat: Repeat) -> Model {
        let mut m = Model::new("pc");
        let st = WireState {
            zone: "pc".into(),
            status,
            queue: Some(vec![
                QueueItem { queue_id: "q1".into(), track: Track { title: "A".into(), duration_ms: 200_000., ..Default::default() }, album: Default::default() },
                QueueItem { queue_id: "q2".into(), track: Track { title: "B".into(), duration_ms: 100_000., ..Default::default() }, album: Default::default() },
            ]),
            index: 0,
            position_ms: 10_000.,
            volume: vol,
            shuffle,
            repeat,
            elsewhere: false,
        };
        m.update(Msg::Fetched { state: st, rev: None }, 1000);
        m
    }

    #[test]
    fn play_pause_follows_the_status() {
        assert_eq!(map(&model(Status::Playing, 50., false, Repeat::Off), &UiCommand::PlayPause, 0).unwrap().body, json!({"type": "pause"}));
        assert_eq!(map(&model(Status::Paused, 50., false, Repeat::Off), &UiCommand::PlayPause, 0).unwrap().body, json!({"type": "resume"}));
        assert_eq!(map(&model(Status::Stopped, 50., false, Repeat::Off), &UiCommand::PlayPause, 0).unwrap().body, json!({"type": "jump", "index": 0}));
        assert!(map(&Model::new("pc"), &UiCommand::PlayPause, 0).is_none(), "nothing known: nothing sent");
    }

    #[test]
    fn transport_and_toggles() {
        let m = model(Status::Playing, 50., true, Repeat::All);
        assert_eq!(map(&m, &UiCommand::Next, 0).unwrap().body, json!({"type": "next"}));
        assert_eq!(map(&m, &UiCommand::Prev, 0).unwrap().body, json!({"type": "prev"}));
        assert_eq!(map(&m, &UiCommand::ToggleShuffle, 0).unwrap().body, json!({"type": "shuffle", "on": false}));
        assert_eq!(map(&m, &UiCommand::CycleRepeat, 0).unwrap().body, json!({"type": "repeat", "mode": "one"}));
        let off = model(Status::Playing, 50., false, Repeat::One);
        assert_eq!(map(&off, &UiCommand::CycleRepeat, 0).unwrap().body, json!({"type": "repeat", "mode": "off"}));
    }

    #[test]
    fn volume_is_clamped_and_whole() {
        let m = model(Status::Playing, 98., false, Repeat::Off);
        assert_eq!(map(&m, &UiCommand::VolumeBy(5.), 0).unwrap().body, json!({"type": "volume", "volume": 100.0}));
        assert_eq!(map(&m, &UiCommand::Volume(-4.), 0).unwrap().body, json!({"type": "volume", "volume": 0.0}));
    }

    #[test]
    fn seek_by_adds_the_extrapolated_position_and_stays_inside_the_song() {
        let m = model(Status::Playing, 50., false, Repeat::Off);
        // reported 10 s at t=1000 ms; at t=3000 ms it is 12 s; +10 s = 22 s
        assert_eq!(map(&m, &UiCommand::SeekBy(10_000.), 3000).unwrap().body, json!({"type": "seek", "positionMs": 22000.0}));
        assert_eq!(map(&m, &UiCommand::SeekBy(-60_000.), 3000).unwrap().body, json!({"type": "seek", "positionMs": 0.0}));
        assert_eq!(map(&m, &UiCommand::SeekBy(1e9), 3000).unwrap().body, json!({"type": "seek", "positionMs": 199500.0}));
        let paused = model(Status::Paused, 50., false, Repeat::Off);
        assert_eq!(map(&paused, &UiCommand::SeekBy(5000.), 9000).unwrap().body, json!({"type": "seek", "positionMs": 15000.0}), "a paused song does not advance");
    }

    #[test]
    fn queue_edits_use_the_servers_names() {
        let m = model(Status::Playing, 50., false, Repeat::Off);
        assert_eq!(map(&m, &UiCommand::Jump(3), 0).unwrap().body, json!({"type": "jump", "index": 3}));
        assert_eq!(map(&m, &UiCommand::Remove("q2".into()), 0).unwrap().body, json!({"type": "remove", "queueId": "q2"}));
        assert_eq!(map(&m, &UiCommand::Move { queue_id: "q2".into(), to: 0 }, 0).unwrap().body, json!({"type": "move", "queueId": "q2", "toIndex": 0}));
    }

    #[test]
    fn a_playlist_dot_sends_the_shuffle_play_the_web_sends() {
        let ids = vec!["a".to_string(), "b".to_string()];
        assert_eq!(play_playlist_body(&ids), json!({"type": "play", "trackIds": ["a", "b"], "startIndex": 0, "shuffle": true}));
        assert_eq!(encode("pl:rune:1b2-c"), "pl%3Arune%3A1b2-c");
    }

    #[test]
    fn the_path_encodes_the_zone() {
        let r = map(&model(Status::Playing, 1., false, Repeat::Off), &UiCommand::Next, 0).unwrap();
        assert_eq!(r.path(), "/api/player/pc");
        assert_eq!(Request { zone: "spotify:ab/c d".into(), body: json!({}) }.path(), "/api/player/spotify%3Aab%2Fc%20d");
    }
}
