//! rune's own sound (PORT-PLAN phase 9): this app is a browser-style zone (`browser:<id>`) that it sounds itself. The server
//! queue stays the only queue: it publishes a `TabPlan` (which song, a run of songs to follow gaplessly, a seek counter) and
//! this app plays it and reports back what really happened (`TabReport`). `tabplayer` is the web's `TabPlayer` in Rust,
//! `engine` is the sound (symphonia, rubato, cpal), `pipeline` its pure parts, `source` the HTTP byte source.
pub mod engine;
pub mod pipeline;
pub mod source;
pub mod tabplayer;

/// A queue entry the engine can play: the queue id names this instance, the track id names the file.
#[derive(Clone, Debug, PartialEq)]
pub struct TrackRef {
    pub key: String,
    pub id: String,
}

/// What the engine tells the app.
#[derive(Debug, Clone, PartialEq)]
pub enum AudioEvent {
    /// the last frame of this queue entry was played
    Ended(String),
    Failed(String, String),
}

/// What makes the sound (the web's `Engine`).
pub trait Engine {
    fn load(&mut self, track: &TrackRef, start_ms: f64, autoplay: bool, upcoming: &[TrackRef]);
    fn set_upcoming(&mut self, upcoming: &[TrackRef]);
    fn play(&mut self);
    fn pause(&mut self);
    fn seek(&mut self, ms: f64);
    fn set_volume(&mut self, v: f64);
    fn position(&self) -> Option<f64>;
    fn stop(&mut self);
}
