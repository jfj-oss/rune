//! What the operating system gives the app, behind one small interface: the media keys and the "now playing" surface, a tray
//! icon (Linux), a notification when the song changes, and "a second launch brings the first to the front".
//!
//!  * Linux (`linux.rs`): one D-Bus connection on its own thread. MPRIS player `org.mpris.MediaPlayer2.rune_desktop` (the
//!    keyboard's media keys, KDE's media widget, playerctl), a StatusNotifierItem tray with a small dbusmenu, `org.rune.Desktop`
//!    (the single-instance hook), and `org.freedesktop.Notifications` for the track-change note. rune mini (`org.mpris.MediaPlayer2.rune`)
//!    yields its MPRIS name while this one is on the bus, so the media keys always reach the one that is running the zone.
//!  * macOS (`mac.rs`): `MPRemoteCommandCenter` (media keys, headphones, Control Centre) and `MPNowPlayingInfoCenter`.
//!  * anything else: nothing (the app just has no integration).
//!
//! Tests (and any run with `RUNE_DESKTOP_OS=off`, which the e2e sets) never touch the session's bus names.
use futures::channel::mpsc::UnboundedSender;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::mpris_meta::MprisMeta;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;

/// What the system asks of the app.
#[derive(Debug)]
pub enum OsEvent {
    /// Bring the window to the front (tray click, a second launch, MPRIS `Raise`).
    Raise,
    Quit,
    /// A media key or an MPRIS call, for the zone on screen.
    Cmd(UiCommand),
    SetZone(String),
    OpenConfig,
}

/// What the app tells the system.
pub enum OsCtl {
    Meta(MprisMeta),
    Zones { zones: Vec<(String, String)>, current: String },
    Notify { title: String, body: String },
}

pub type Events = UnboundedSender<OsEvent>;

/// The handle the app keeps. Silent when the integration is off or the platform has none.
pub struct Os {
    #[cfg(target_os = "linux")]
    tx: Option<tokio::sync::mpsc::UnboundedSender<OsCtl>>,
    #[cfg(target_os = "macos")]
    mac: Option<mac::Now>,
    last_meta: Option<MprisMeta>,
}

/// Is the integration wanted? Off for tests (`RUNE_DESKTOP_OS=off`) and for the test control port.
pub fn enabled() -> bool {
    std::env::var("RUNE_DESKTOP_OS").map(|v| v != "off").unwrap_or(true)
}

/// Second launch: tell the running app to come forward. True when one answered (then this process should exit).
pub fn hand_over_to_running() -> bool {
    if !enabled() { return false; }
    #[cfg(target_os = "linux")]
    { return linux::raise_running(); }
    #[cfg(not(target_os = "linux"))]
    false
}

pub fn start(events: Events) -> Os {
    #[cfg(target_os = "linux")]
    { return Os { tx: enabled().then(|| linux::spawn(events)), last_meta: None }; }
    #[cfg(target_os = "macos")]
    { return Os { mac: enabled().then(|| mac::start(&events)), last_meta: None }; }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    { let _ = events; Os { last_meta: None } }
}

impl Os {
    fn send(&self, m: OsCtl) {
        #[cfg(target_os = "linux")]
        if let Some(tx) = &self.tx { let _ = tx.send(m); }
        #[cfg(target_os = "macos")]
        if let Some(mac) = &self.mac {
            match &m { OsCtl::Meta(x) => mac.meta(x), OsCtl::Notify { title, body } => mac::notify(title, body), OsCtl::Zones { .. } => {} }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let _ = m;
    }

    /// The player state, after every change (the platform side works out what really changed).
    pub fn meta(&mut self, m: MprisMeta) {
        if self.last_meta.as_ref() == Some(&m) { return; }
        self.last_meta = Some(m.clone());
        self.send(OsCtl::Meta(m));
    }

    pub fn zones(&self, zones: Vec<(String, String)>, current: String) { self.send(OsCtl::Zones { zones, current }); }

    pub fn notify(&self, title: String, body: String) { self.send(OsCtl::Notify { title, body }); }
}
