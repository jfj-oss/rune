//! Wiring of the own-audio zone into the app (PORT-PLAN phase 9): the id this install keeps, the worker that posts the reports
//! in order, the forwarding of engine events to the UI thread, and the two places that feed the server's state to the TabPlayer.
use crate::audio::engine::RealEngine;
use crate::audio::tabplayer::{Reporter, TabPlayer};
use crate::audio::AudioEvent;
use crate::rune::*;
use gpui_kit::*;
use rune_mini_core::now_ms;
use rune_mini_core::net::Client;
use serde_json::Value;
use std::sync::mpsc::{channel, Sender};

/// Reports go to a worker so they reach the server in the order they were made.
pub struct ChanReporter(Sender<Value>);
impl Reporter for ChanReporter {
    fn report(&mut self, body: Value) { let _ = self.0.send(body); }
}

/// 22 letters and digits, the shape the server accepts for `browser:<id>`.
pub fn fresh_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    let st = std::collections::hash_map::RandomState::new();
    while out.len() < 22 {
        let mut h = st.build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_usize(out.len());
        let mut v = h.finish();
        for _ in 0..6 { out.push(char::from_digit((v % 36) as u32, 36).unwrap_or('a')); v /= 36; }
    }
    out.truncate(22);
    out
}

/// What this computer is called in the zone picker.
pub fn device_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        let host = std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .or_else(|| std::process::Command::new("scutil").args(["--get", "ComputerName"]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
            .or_else(|| std::env::var("HOSTNAME").ok());
        match host { Some(h) => format!("This computer ({h})"), None => "This computer".into() }
    }).clone()
}

/// The TabPlayer with the real engine, or None when the sound is switched off (RUNE_DESKTOP_AUDIO=off).
pub fn start(client: &Client, zone: &str, to_ui: futures::channel::mpsc::UnboundedSender<AudioEvent>) -> Option<TabPlayer<RealEngine, ChanReporter>> {
    let mode = std::env::var("RUNE_DESKTOP_AUDIO").unwrap_or_default();
    if mode == "off" { return None; }
    let (etx, erx) = channel::<AudioEvent>();
    std::thread::Builder::new().name("rune-audio-events".into()).spawn(move || { for e in erx { if to_ui.unbounded_send(e).is_err() { break; } } }).ok();
    let engine = RealEngine::start(client.clone(), etx, mode == "null");
    let (rtx, rrx) = channel::<Value>();
    let (c, path) = (client.clone(), format!("/player/{}/report", rune_mini_core::commands::encode(zone)));
    std::thread::Builder::new().name("rune-audio-reports".into()).spawn(move || {
        for body in rrx { let _ = c.send_json("POST", &path, Some(&body)); }
    }).ok();
    Some(TabPlayer::new(engine, ChanReporter(rtx)))
}

impl Rune {
    /// The server's state of the own zone changed while another zone is on screen.
    pub fn audio_changed(&mut self, now: u64) {
        if let (Some(p), Some(a)) = (self.audio_model.player.clone(), self.audio.as_mut()) { a.apply(&p, now); }
    }

    /// The own zone is the one on screen: its state is the main model's.
    pub fn audio_state_from_view(&mut self, now: u64) {
        if let (Some(p), Some(a)) = (self.model.player.clone(), self.audio.as_mut()) { a.apply(&p, now); }
    }

    pub fn audio_event(&mut self, ev: AudioEvent, cx: &mut Context<Self>) {
        let now = now_ms();
        if let Some(a) = self.audio.as_mut() {
            match ev {
                AudioEvent::Ended(k) => a.ended(&k, now),
                AudioEvent::Failed(k, m) => a.failed(&k, &m),
            }
            let notes: Vec<String> = a.notices.drain(..).collect();
            for n in notes { self.say(n, cx); }
        }
    }
}
