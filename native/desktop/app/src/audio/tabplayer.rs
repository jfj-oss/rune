//! The web's `TabPlayer` (web/src/player/tabPlayer.ts) in Rust: it holds NO queue. The server's state says which song plays,
//! whether it should sound and where (`Player` + `tab`); this makes the engine do that, then reports what the engine did. One
//! thing it decides by itself: when a song ends it goes on to the next one of the server's `run` at once (gapless, no round
//! trip), and says so. This app is the only thing that sounds its own zone, so it is always "hosting".
use super::{Engine, TrackRef};
use rune_mini_core::model::{Player, QueueItem, Status};
use serde_json::{json, Value};

/// How often the sounding player tells the server where it is (the server pauses a zone whose tab fell silent).
pub const HEARTBEAT_MS: u64 = 8_000;

/// Where reports go (a worker that POSTs them in order; a list in tests).
pub trait Reporter {
    fn report(&mut self, body: Value);
}

#[derive(Clone, PartialEq, Debug)]
struct Applied {
    token: u64,
    load_v: u64,
    seek_v: u64,
}

pub struct TabPlayer<E: Engine, R: Reporter> {
    pub engine: E,
    reporter: R,
    state: Option<Player>,
    applied: Option<Applied>,
    /// the queue entry the engine holds
    loaded: Option<String>,
    sounding: bool,
    volume: f64,
    run_key: String,
    last_beat: u64,
    /// one-line problems for the app to show (a song that would not play)
    pub notices: Vec<String>,
}

fn tref(q: &QueueItem) -> TrackRef { TrackRef { key: q.queue_id.clone(), id: q.track.id.clone() } }

impl<E: Engine, R: Reporter> TabPlayer<E, R> {
    pub fn new(engine: E, reporter: R) -> Self {
        TabPlayer { engine, reporter, state: None, applied: None, loaded: None, sounding: false, volume: -1., run_key: String::new(), last_beat: 0, notices: vec![] }
    }

    pub fn loaded(&self) -> Option<&str> { self.loaded.as_deref() }
    pub fn is_sounding(&self) -> bool { self.sounding }

    /// The server's state for this zone.
    pub fn apply(&mut self, s: &Player, now: u64) {
        self.state = Some(s.clone());
        self.reconcile(s, now);
    }

    fn reconcile(&mut self, s: &Player, now: u64) {
        let cur = s.current().cloned();
        let plan = s.tab.clone();
        if (s.volume - self.volume).abs() > f64::EPSILON {
            self.volume = s.volume;
            self.engine.set_volume(s.volume);
        }
        let (Some(cur), Some(plan)) = (cur, plan) else { return self.silence() };
        if s.status == Status::Stopped { return self.silence(); }
        let wants_sound = matches!(s.status, Status::Playing | Status::Loading);
        let fresh = self.applied.as_ref().is_none_or(|a| a.token != plan.token || a.load_v != plan.load_v);
        // the server is still starting a song (its new instruction follows): nothing to do yet
        if s.status == Status::Loading && !fresh { return; }
        if fresh || (self.loaded.as_deref() != Some(cur.queue_id.as_str()) && wants_sound) {
            self.applied = Some(Applied { token: plan.token, load_v: plan.load_v, seek_v: plan.seek_v });
            if !wants_sound { return self.silence(); }
            let pos = if s.status == Status::Playing { s.position(now) } else { s.position_ms };
            self.load(&cur, pos, s, now);
            return;
        }
        if self.loaded.as_deref() != Some(cur.queue_id.as_str()) {
            // paused on a song this engine does not hold: nothing to hold until Play
            return self.silence();
        }
        if let Some(a) = self.applied.as_mut() {
            if a.seek_v != plan.seek_v {
                a.seek_v = plan.seek_v;
                self.engine.seek(s.position_ms);
            }
        }
        let key = plan.run.join(",");
        if key != self.run_key {
            self.run_key = key;
            let up = self.after(s, &cur.queue_id);
            self.engine.set_upcoming(&up);
        }
        if wants_sound && !self.sounding {
            self.sounding = true;
            self.engine.play();
        } else if s.status == Status::Paused && self.sounding {
            self.sounding = false;
            self.engine.pause();
        }
    }

    /// The songs after `queue_id` in the server's run (what the engine may open ahead).
    fn after(&self, s: &Player, queue_id: &str) -> Vec<TrackRef> {
        let run = s.tab.as_ref().map(|t| t.run.as_slice()).unwrap_or(&[]);
        let Some(at) = run.iter().position(|r| r == queue_id) else { return vec![] };
        run.iter().skip(at + 1).take(20).filter_map(|id| s.queue.iter().find(|q| &q.queue_id == id)).map(tref).collect()
    }

    fn load(&mut self, cur: &QueueItem, pos: f64, s: &Player, now: u64) {
        self.loaded = Some(cur.queue_id.clone());
        self.sounding = true;
        self.run_key = s.tab.as_ref().map(|t| t.run.join(",")).unwrap_or_default();
        let up = self.after(s, &cur.queue_id);
        self.engine.load(&tref(cur), pos, true, &up);
        self.last_beat = now;
        self.send("started", Some(&cur.queue_id), json!({"positionMs": pos.round() as i64}));
    }

    fn silence(&mut self) {
        if self.loaded.is_some() || self.sounding { self.engine.stop(); }
        self.loaded = None;
        self.sounding = false;
        self.applied = None;
        self.run_key.clear();
    }

    // ------------------------------------------------------------------ the engine tells

    /// The engine played the last frame of `key`.
    pub fn ended(&mut self, key: &str, now: u64) {
        let Some(s) = self.state.clone() else { return };
        if self.loaded.as_deref() != Some(key) { return; }
        self.send("ended", Some(key), json!({}));
        let run = s.tab.as_ref().map(|t| t.run.clone()).unwrap_or_default();
        let next_id = run.iter().position(|r| r == key).and_then(|i| run.get(i + 1)).cloned();
        let next = next_id.and_then(|id| s.queue.iter().find(|q| q.queue_id == id).cloned());
        match next {
            // the last song of the run: the server decides what comes next and starts it with a new instruction
            None => { self.loaded = None; self.sounding = false; }
            Some(n) => self.load(&n, 0., &s, now),
        }
    }

    pub fn failed(&mut self, key: &str, message: &str) {
        if self.loaded.as_deref() != Some(key) {
            // a song after the loaded one failed to open while the loaded one still plays: the server finds out when it is its turn
            return;
        }
        self.sounding = false;
        self.notices.push(message.to_string());
        self.send("failed", Some(key), json!({"message": message}));
    }

    /// Once a second: the heartbeat.
    pub fn tick(&mut self, now: u64) {
        if now.saturating_sub(self.last_beat) < HEARTBEAT_MS { return; }
        let (Some(q), true, Some(s)) = (self.loaded.clone(), self.sounding, self.state.clone()) else { return };
        self.last_beat = now;
        let pos = self.engine.position().unwrap_or_else(|| s.position(now));
        self.send("position", Some(&q), json!({"positionMs": pos.round() as i64}));
    }

    fn send(&mut self, kind: &str, queue_id: Option<&str>, extra: Value) {
        let Some(plan) = self.state.as_ref().and_then(|s| s.tab.clone()) else { return };
        let mut body = json!({"type": kind, "token": plan.token, "queueId": queue_id.unwrap_or_default(), "visible": true});
        if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) { for (k, v) in e { b.insert(k.clone(), v.clone()); } }
        self.reporter.report(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune_mini_core::model::{AlbumRef, TabPlan, Track};
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Default)]
    struct Log(Rc<RefCell<Vec<String>>>);
    struct Mock(Rc<RefCell<Vec<String>>>);
    impl Engine for Mock {
        fn load(&mut self, t: &TrackRef, start: f64, auto: bool, up: &[TrackRef]) { self.0.borrow_mut().push(format!("load {} @{} auto={} up={}", t.key, start, auto, up.iter().map(|u| u.key.as_str()).collect::<Vec<_>>().join(","))); }
        fn set_upcoming(&mut self, up: &[TrackRef]) { self.0.borrow_mut().push(format!("upcoming {}", up.iter().map(|u| u.key.as_str()).collect::<Vec<_>>().join(","))); }
        fn play(&mut self) { self.0.borrow_mut().push("play".into()); }
        fn pause(&mut self) { self.0.borrow_mut().push("pause".into()); }
        fn seek(&mut self, ms: f64) { self.0.borrow_mut().push(format!("seek {ms}")); }
        fn set_volume(&mut self, v: f64) { self.0.borrow_mut().push(format!("volume {v}")); }
        fn position(&self) -> Option<f64> { Some(1234.) }
        fn stop(&mut self) { self.0.borrow_mut().push("stop".into()); }
    }
    struct Rep(Rc<RefCell<Vec<Value>>>);
    impl Reporter for Rep { fn report(&mut self, b: Value) { self.0.borrow_mut().push(b); } }

    fn item(q: &str) -> QueueItem { QueueItem { queue_id: q.into(), track: Track { id: format!("l:{q}"), duration_ms: 100_000., ..Default::default() }, album: AlbumRef::default() } }
    fn state(status: Status, index: i64, token: u64, load_v: u64, seek_v: u64, run: &[&str]) -> Player {
        Player { status, queue: vec![item("a"), item("b"), item("c")], index, position_ms: 0., at_ms: 0, volume: 50., tab: Some(TabPlan { token, load_v, seek_v, run: run.iter().map(|s| s.to_string()).collect() }), ..Default::default() }
    }
    fn rig() -> (TabPlayer<Mock, Rep>, Rc<RefCell<Vec<String>>>, Rc<RefCell<Vec<Value>>>) {
        let calls = Rc::new(RefCell::new(vec![]));
        let reps = Rc::new(RefCell::new(vec![]));
        let _ = Log::default();
        (TabPlayer::new(Mock(calls.clone()), Rep(reps.clone())), calls, reps)
    }

    #[::core::prelude::v1::test]
    fn a_new_instruction_loads_the_song_and_says_started() {
        let (mut p, calls, reps) = rig();
        p.apply(&state(Status::Playing, 0, 7, 1, 0, &["a", "b", "c"]), 0);
        assert_eq!(calls.borrow().as_slice(), ["volume 50", "load a @0 auto=true up=b,c"]);
        assert_eq!(reps.borrow()[0]["type"], "started");
        assert_eq!(reps.borrow()[0]["token"], 7);
        assert_eq!(reps.borrow()[0]["queueId"], "a");
    }

    #[::core::prelude::v1::test]
    fn the_same_instruction_again_does_nothing() {
        let (mut p, calls, _) = rig();
        let s = state(Status::Playing, 0, 7, 1, 0, &["a", "b"]);
        p.apply(&s, 0);
        let n = calls.borrow().len();
        p.apply(&s, 10);
        assert_eq!(calls.borrow().len(), n);
    }

    #[::core::prelude::v1::test]
    fn pause_resume_and_seek_follow_the_server() {
        let (mut p, calls, _) = rig();
        p.apply(&state(Status::Playing, 0, 1, 1, 0, &["a", "b"]), 0);
        calls.borrow_mut().clear();
        p.apply(&state(Status::Paused, 0, 1, 1, 0, &["a", "b"]), 5);
        assert_eq!(calls.borrow().as_slice(), ["pause"]);
        p.apply(&state(Status::Playing, 0, 1, 1, 0, &["a", "b"]), 6);
        assert_eq!(calls.borrow().as_slice(), ["pause", "play"]);
        let mut s = state(Status::Playing, 0, 1, 1, 1, &["a", "b"]);
        s.position_ms = 42_000.;
        p.apply(&s, 7);
        assert_eq!(calls.borrow().last().unwrap(), "seek 42000");
    }

    #[::core::prelude::v1::test]
    fn a_song_end_goes_on_down_the_run_without_asking_the_server() {
        let (mut p, calls, reps) = rig();
        let s = state(Status::Playing, 0, 3, 1, 0, &["a", "b", "c"]);
        p.apply(&s, 0);
        calls.borrow_mut().clear();
        p.ended("a", 100);
        assert_eq!(calls.borrow().as_slice(), ["load b @0 auto=true up=c"]);
        let types: Vec<String> = reps.borrow().iter().map(|r| r["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types, ["started", "ended", "started"]);
        assert_eq!(p.loaded(), Some("b"));
        p.ended("b", 200);
        p.ended("c", 300);
        assert_eq!(p.loaded(), None);
        assert_eq!(reps.borrow().last().unwrap()["type"], "ended");
    }

    #[::core::prelude::v1::test]
    fn a_new_token_loads_again_and_stopped_silences() {
        let (mut p, calls, _) = rig();
        p.apply(&state(Status::Playing, 0, 1, 1, 0, &["a"]), 0);
        calls.borrow_mut().clear();
        p.apply(&state(Status::Playing, 1, 2, 2, 0, &["b", "c"]), 10);
        assert_eq!(calls.borrow().as_slice(), ["load b @10 auto=true up=c"]);
        calls.borrow_mut().clear();
        p.apply(&Player { status: Status::Stopped, ..state(Status::Stopped, 1, 2, 2, 0, &["b"]) }, 20);
        assert_eq!(calls.borrow().as_slice(), ["stop"]);
    }

    #[::core::prelude::v1::test]
    fn a_failure_is_reported_and_noticed_and_the_heartbeat_sends_the_position() {
        let (mut p, _, reps) = rig();
        p.apply(&state(Status::Playing, 0, 4, 1, 0, &["a", "b"]), 0);
        p.tick(HEARTBEAT_MS + 1);
        assert_eq!(reps.borrow().last().unwrap()["type"], "position");
        assert_eq!(reps.borrow().last().unwrap()["positionMs"], 1234);
        p.failed("a", "Could not play this track");
        assert_eq!(reps.borrow().last().unwrap()["type"], "failed");
        assert_eq!(p.notices, vec!["Could not play this track".to_string()]);
        assert!(!p.is_sounding());
    }
}
