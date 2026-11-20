//! Tests only: a line-JSON control port (RUNE_DESKTOP_TEST_PORT=<port>, 127.0.0.1) so the e2e can ask the real window to do
//! what a click does, and read back what it shows. One JSON object per line in, one per line out. Closed unless the variable is set.
//!   {"cmd":"state"}                              route, queue, status, zone, toast, covers held, frame counters
//!   {"cmd":"go","route":"/album/la%3A.."}        navigate (same parser as RUNE_DESKTOP_ROUTE)
//!   {"cmd":"play_album","id","shuffle","start"}  {"cmd":"enqueue_album","id","next"}  {"cmd":"play_playlist","id","shuffle"}
//!   {"cmd":"player","name":"next|prev|pause|resume|shuffle|repeat|clear","n":..}   {"cmd":"seek","ms"} {"cmd":"volume","v"}
//!   {"cmd":"jump","index"} {"cmd":"remove","index"} {"cmd":"move","index","to"}   queue edits by queue position
//!   {"cmd":"add_to_playlist","playlist","name","ids":[..]} {"cmd":"new_playlist","name","ids":[..]} {"cmd":"pin","id","on"}
//!   {"cmd":"queue","open":true}  {"cmd":"scroll","dy":px}  {"cmd":"bench","steps":N,"dy":px,"ms":16}   (frame intervals while scrolling)
use crate::rune::*;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

pub struct Hook {
    rx: Mutex<Receiver<(Value, Sender<Value>)>>,
}

pub fn start() -> Option<Hook> {
    let port: u16 = std::env::var("RUNE_DESKTOP_TEST_PORT").ok()?.parse().ok()?;
    let (tx, rx) = channel::<(Value, Sender<Value>)>();
    let l = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| eprintln!("test port: {e}")).ok()?;
    std::thread::Builder::new().name("rune-test".into()).spawn(move || {
        for sock in l.incoming().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let Ok(mut w) = sock.try_clone() else { return };
                for line in BufReader::new(sock).lines().map_while(Result::ok) {
                    let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    let (rtx, rrx) = channel();
                    if tx.send((v, rtx)).is_err() { return; }
                    let r = rrx.recv_timeout(Duration::from_secs(60)).unwrap_or(json!({"error": "timeout"}));
                    let _ = writeln!(w, "{r}");
                }
            });
        }
    }).ok()?;
    Some(Hook { rx: Mutex::new(rx) })
}

impl Rune {
    /// Poll the control port every 40 ms (only exists in a test run).
    pub fn start_hook_loop(&mut self, cx: &mut Context<Self>) {
        if self.test.is_none() { return; }
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(40)).await;
            let alive = this.update(cx, |m, cx| {
                let jobs: Vec<(Value, Sender<Value>)> = m.test.as_ref().map(|h| h.rx.lock().unwrap().try_iter().collect()).unwrap_or_default();
                for (v, reply) in jobs { m.hook_cmd(v, reply, cx); }
            }).is_ok();
            if !alive { break; }
        }).detach();
    }

    fn hook_cmd(&mut self, v: Value, reply: Sender<Value>, cx: &mut Context<Self>) {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let n = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.);
        let b = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
        let ids = || -> Vec<String> { v.get("ids").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
        let qid = |i: usize| self.model.player.as_ref().and_then(|p| p.queue.get(i).map(|q| q.queue_id.clone()));
        let out = match s("cmd").as_str() {
            "state" => {
                let p = self.model.player.as_ref();
                let (held, bytes) = self.covers.held();
                json!({
                    "route": self.route().key(), "online": self.model.online(), "zone": self.model.zone,
                    "status": p.map(|p| format!("{:?}", p.status).to_lowercase()), "index": p.map(|p| p.index), "shuffle": p.map(|p| p.shuffle), "volume": p.map(|p| p.volume),
                    "queue": p.map(|p| p.queue.iter().map(|q| q.track.title.clone()).collect::<Vec<_>>()),
                    "toast": self.toast.as_ref().map(|t| t.text.clone()), "queue_open": self.queue_open, "menu": self.menu.is_some(), "dialog": self.dialog.is_some(),
                    "covers_held": held, "covers_bytes": bytes, "covers_requested": self.covers.requested, "covers_fetched": self.covers.fetched, "frames": self.frame,
                    "own_zone": self.own_zone, "audio": self.audio.as_ref().map(|a| json!({"loaded": a.loaded(), "sounding": a.is_sounding(), "position": crate::audio::Engine::position(&a.engine)})),
                    "albums_loaded": self.data.albums.values().map(|l| l.items.len()).max(),
                })
            }
            "go" => { let r = crate::rune::parse_route(&s("route")); self.go(r, cx); json!({"ok": true}) }
            "play_album" => { self.play_album(&s("id"), b("shuffle"), n("start") as usize, cx); json!({"ok": true}) }
            "enqueue_album" => { self.enqueue_album(&s("id"), b("next"), cx); json!({"ok": true}) }
            "play_playlist" => { self.play_playlist(&s("id"), b("shuffle"), 0, cx); json!({"ok": true}) }
            "player" => {
                let c = match s("name").as_str() { "next" => UiCommand::Next, "prev" => UiCommand::Prev, "pause" => UiCommand::Pause, "resume" => UiCommand::Play, "shuffle" => UiCommand::ToggleShuffle, "repeat" => UiCommand::CycleRepeat, "clear" => UiCommand::Clear, "toggle" => UiCommand::PlayPause, _ => { let _ = reply.send(json!({"error": "unknown player command"})); return; } };
                self.cmd(c, cx); json!({"ok": true})
            }
            "seek" => { self.cmd(UiCommand::SeekTo(n("ms")), cx); json!({"ok": true}) }
            "volume" => { self.cmd(UiCommand::Volume(n("v")), cx); json!({"ok": true}) }
            "jump" => { self.cmd(UiCommand::Jump(n("index") as usize), cx); json!({"ok": true}) }
            "remove" => match qid(n("index") as usize) { Some(id) => { self.cmd(UiCommand::Remove(id), cx); json!({"ok": true}) } None => json!({"error": "no such row"}) },
            "move" => match qid(n("index") as usize) { Some(id) => { self.cmd(UiCommand::Move { queue_id: id, to: n("to") as usize }, cx); json!({"ok": true}) } None => json!({"error": "no such row"}) },
            "add_to_playlist" => { self.add_to_playlist(&s("playlist"), &s("name"), ids(), cx); json!({"ok": true}) }
            "new_playlist" => { self.create_playlist(s("name"), ids(), cx); json!({"ok": true}) }
            "rename_playlist" => { self.rename_playlist(&s("id"), s("name"), cx); json!({"ok": true}) }
            "playlist_move" => { self.move_in_playlist(&s("id"), n("from") as usize, n("to") as usize, cx); json!({"ok": true}) }
            "playlist_remove" => { let pos: Vec<usize> = v.get("positions").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|x| x as usize)).collect()).unwrap_or_default(); self.remove_positions(&s("id"), pos, cx); json!({"ok": true}) }
            "np" => { self.np_open = b("open"); cx.notify(); json!({"ok": true}) }
            "tracks_sort" => { self.tracks_sort = match s("sort").as_str() { "artist" => "artist", "album" => "album", "duration" => "duration", "added" => "added", _ => "title" }; self.tracks_desc = v.get("desc").and_then(|x| x.as_bool()); cx.notify(); json!({"ok": true}) }
            "zone" => { let z = if s("id") == "own" { self.own_zone.clone() } else { s("id") }; self.set_zone(&z, cx); json!({"ok": true})}
            "pin" => { self.set_pin(&s("id"), b("on"), false, cx); json!({"ok": true}) }
            "queue" => { self.queue_open = b("open"); cx.notify(); json!({"ok": true}) }
            "scroll" => { if let Some(l) = self.lists.get(&self.route().key()) { l.scroll_by(px(n("dy") as f32)); } cx.notify(); json!({"ok": true}) }
            "bench" => {
                let (steps, dy, ms) = (n("steps") as usize, n("dy") as f32, n("ms").max(1.) as u64);
                self.bench_times.clear(); self.last_frame = None;
                let key = self.route().key();
                cx.spawn(async move |this, cx| {
                    for _ in 0..steps {
                        cx.background_executor().timer(Duration::from_millis(ms)).await;
                        let _ = this.update(cx, |m, cx| { if let Some(l) = m.lists.get(&key) { l.scroll_by(px(dy)); } cx.notify(); });
                    }
                    cx.background_executor().timer(Duration::from_millis(300)).await;
                    let _ = this.update(cx, |m, _| {
                        let mut t = m.bench_times.clone();
                        t.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        let q = |p: f64| t.get(((t.len() as f64 - 1.) * p) as usize).copied().unwrap_or(0.);
                        let over = t.iter().filter(|x| **x > 20.).count();
                        let _ = reply.send(json!({"frames": t.len(), "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": t.last().copied().unwrap_or(0.), "over20ms": over}));
                    });
                }).detach();
                return;
            }
            other => json!({"error": format!("unknown command {other}")}),
        };
        let _ = reply.send(out);
    }
}
