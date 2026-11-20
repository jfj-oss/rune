//! rune mini, the part with no window: the protocol types, state reduction (websocket message -> view model), the
//! mapping from a key or a button to a server command, the reconnect policy, settings, and the network threads.
//! Both the GPUI app (../app) and the headless probe (src/bin/probe.rs, used by the e2e test) are built on it.
//! The wire contract is native/PROTOCOL.md; the Swift app in native/mac implements the same one.
pub mod client_ext;
pub mod commands;
pub mod config;
pub mod filter;
pub mod keys;
pub mod library;
pub mod model;
pub mod mpris_meta;
pub mod net;
pub mod reconnect;

use std::sync::OnceLock;
use std::time::Instant;

/// Milliseconds on a monotonic clock, from the first call. Positions are extrapolated against this, never against the
/// server's wall clock (which may differ from ours).
pub fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}
