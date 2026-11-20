use futures::StreamExt;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::model::Repeat;
use rune_mini_core::mpris_meta::{seek_jump, MprisMeta};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender as TokioTx};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{interface, Connection};

pub const CONTROL_NAME: &str = "org.rune.Desktop";
pub const CONTROL_PATH: &str = "/org/rune/Desktop";
pub const MPRIS_NAME: &str = "org.mpris.MediaPlayer2.rune_desktop";

use super::{OsCtl as DesktopCtl, OsEvent as DesktopEvent, Events};

/// `rune-desktop` started a second time: ask the running one to come to the front. Returns true when one answered.
pub fn raise_running() -> bool {
    let Ok(conn) = zbus::blocking::Connection::session() else { return false };
    conn.call_method(Some(CONTROL_NAME), CONTROL_PATH, Some(CONTROL_NAME), "Raise", &()).is_ok()
}

pub fn spawn(events: Events) -> TokioTx<DesktopCtl> {
    let (tx, rx) = unbounded_channel();
    std::thread::Builder::new()
        .name("rune-dbus".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
            rt.block_on(run(events, rx));
        })
        .ok();
    tx
}

// ------------------------------------------------------------------------------------------------ the shared snapshot

#[derive(Default)]
struct Snap {
    meta: MprisMeta,
    at: Option<std::time::Instant>,
}

type Shared = Arc<Mutex<Snap>>;

impl Snap {
    fn position_us(&self) -> i64 {
        let add = match (self.meta.playback_status, self.at) {
            ("Playing", Some(t)) => t.elapsed().as_micros() as i64,
            _ => 0,
        };
        (self.meta.position_us + add).clamp(0, self.meta.length_us.max(self.meta.position_us))
    }
}

// ------------------------------------------------------------------------------------------------ org.rune.Mini

struct Control(Events);

#[interface(name = "org.rune.Desktop")]
impl Control {
    async fn raise(&self) {
        let _ = self.0.unbounded_send(DesktopEvent::Raise);
    }
}

// ------------------------------------------------------------------------------------------------ MPRIS

struct MprisRoot(Events);

#[interface(name = "org.mpris.MediaPlayer2")]
impl MprisRoot {
    async fn raise(&self) {
        let _ = self.0.unbounded_send(DesktopEvent::Raise);
    }
    async fn quit(&self) {
        let _ = self.0.unbounded_send(DesktopEvent::Quit);
    }
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> String {
        "rune".into()
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> String {
        "rune-desktop".into()
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        vec![]
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        vec![]
    }
}

struct MprisPlayer {
    snap: Shared,
    tx: Events,
}

impl MprisPlayer {
    fn cmd(&self, c: UiCommand) {
        let _ = self.tx.unbounded_send(DesktopEvent::Cmd(c));
    }
    fn meta(&self) -> MprisMeta {
        self.snap.lock().map(|s| s.meta.clone()).unwrap_or_default()
    }
}

fn val<'a>(v: impl Into<Value<'a>>) -> OwnedValue {
    OwnedValue::try_from(v.into()).expect("no file descriptors in metadata")
}

pub fn metadata_map(m: &MprisMeta) -> HashMap<String, OwnedValue> {
    let mut d: HashMap<String, OwnedValue> = HashMap::new();
    if let Ok(p) = ObjectPath::try_from(m.track_id.as_str()) {
        d.insert("mpris:trackid".into(), val(Value::ObjectPath(p)));
    }
    if m.playback_status == "Stopped" && m.title.is_empty() {
        return d;
    }
    d.insert("mpris:length".into(), val(m.length_us));
    d.insert("xesam:title".into(), val(m.title.as_str()));
    d.insert("xesam:artist".into(), val(m.artists.clone()));
    d.insert("xesam:album".into(), val(m.album.as_str()));
    if let Some(u) = &m.art_url {
        d.insert("mpris:artUrl".into(), val(u.as_str()));
    }
    d
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl MprisPlayer {
    async fn next(&self) {
        self.cmd(UiCommand::Next);
    }
    async fn previous(&self) {
        self.cmd(UiCommand::Prev);
    }
    async fn pause(&self) {
        self.cmd(UiCommand::Pause);
    }
    async fn play_pause(&self) {
        self.cmd(UiCommand::PlayPause);
    }
    async fn stop(&self) {
        self.cmd(UiCommand::Pause);
    }
    async fn play(&self) {
        self.cmd(UiCommand::Play);
    }
    async fn seek(&self, offset: i64) {
        self.cmd(UiCommand::SeekBy(offset as f64 / 1000.));
    }
    async fn set_position(&self, _track: ObjectPath<'_>, position: i64) {
        self.cmd(UiCommand::SeekTo(position as f64 / 1000.));
    }
    async fn open_uri(&self, _uri: &str) {}

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.meta().playback_status.into()
    }
    #[zbus(property)]
    fn loop_status(&self) -> String {
        self.meta().loop_status.into()
    }
    #[zbus(property)]
    fn set_loop_status(&self, v: String) {
        self.cmd(UiCommand::SetRepeat(match v.as_str() {
            "Playlist" => Repeat::All,
            "Track" => Repeat::One,
            _ => Repeat::Off,
        }));
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn set_rate(&self, _v: f64) {}
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool {
        self.meta().shuffle
    }
    #[zbus(property)]
    fn set_shuffle(&self, v: bool) {
        self.cmd(UiCommand::SetShuffle(v));
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        metadata_map(&self.meta())
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.meta().volume
    }
    #[zbus(property)]
    fn set_volume(&self, v: f64) {
        self.cmd(UiCommand::Volume((v * 100.).clamp(0., 100.)));
    }
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.snap.lock().map(|s| s.position_us()).unwrap_or(0)
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        self.meta().can_next
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        self.meta().can_prev
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        self.meta().can_play
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        self.meta().can_pause
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        self.meta().can_seek
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}

// ------------------------------------------------------------------------------------------------ tray

struct Sni {
    tx: Events,
}

/// 22x22 ARGB: a 3x2 cluster of dots, the mark of Claude Summon's menu-bar icon.
fn icon_pixels() -> Vec<u8> {
    let n = 22usize;
    let mut px = vec![0u8; n * n * 4];
    let dots: [(f32, f32, f32); 6] = [(6., 7., 2.2), (11., 7., 3.4), (16., 7., 2.2), (6., 14., 3.4), (11., 14., 2.2), (16., 14., 3.4)];
    for y in 0..n {
        for x in 0..n {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let a = dots.iter().map(|&(cx, cy, r)| (r + 0.5 - ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt()).clamp(0., 1.)).fold(0f32, f32::max);
            let i = (y * n + x) * 4;
            px[i..i + 4].copy_from_slice(&[(a * 255.) as u8, 0xD9, 0x90, 0x5F]);
        }
    }
    px
}

#[interface(name = "org.kde.StatusNotifierItem")]
impl Sni {
    async fn activate(&self, _x: i32, _y: i32) {
        let _ = self.tx.unbounded_send(DesktopEvent::Raise);
    }
    async fn secondary_activate(&self, _x: i32, _y: i32) {
        let _ = self.tx.unbounded_send(DesktopEvent::Raise);
    }
    async fn context_menu(&self, _x: i32, _y: i32) {}
    async fn scroll(&self, _delta: i32, _orientation: String) {}

    #[zbus(property)]
    fn category(&self) -> String {
        "ApplicationStatus".into()
    }
    #[zbus(property)]
    fn id(&self) -> String {
        "rune-desktop".into()
    }
    #[zbus(property)]
    fn title(&self) -> String {
        "rune".into()
    }
    #[zbus(property)]
    fn status(&self) -> String {
        "Active".into()
    }
    #[zbus(property)]
    fn window_id(&self) -> u32 {
        0
    }
    #[zbus(property)]
    fn icon_name(&self) -> String {
        String::new()
    }
    #[zbus(property)]
    fn icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
        vec![(22, 22, icon_pixels())]
    }
    #[zbus(property)]
    fn tool_tip(&self) -> (String, Vec<(i32, i32, Vec<u8>)>, String, String) {
        (String::new(), vec![], "rune".into(), "Show rune".into())
    }
    #[zbus(property)]
    fn item_is_menu(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn menu(&self) -> OwnedObjectPath {
        OwnedObjectPath::try_from("/MenuBar").expect("path")
    }
}

#[derive(Clone, Default)]
struct MenuState {
    zones: Vec<(String, String)>,
    current: String,
}

struct DbusMenu {
    tx: Events,
    st: Arc<Mutex<MenuState>>,
}

const ID_TOGGLE: i32 = 1;
const ID_CONFIG: i32 = 4;
const ID_QUIT: i32 = 5;
const ID_ZONE0: i32 = 100;

type Props = HashMap<String, OwnedValue>;

fn props(pairs: &[(&str, Value<'_>)]) -> Props {
    pairs.iter().map(|(k, v)| (k.to_string(), val(v.clone()))).collect()
}

impl DbusMenu {
    /// (id, properties) for every item, in order.
    fn items(&self) -> Vec<(i32, Props)> {
        let st = self.st.lock().map(|s| s.clone()).unwrap_or_default();
        let mut v = vec![(ID_TOGGLE, props(&[("label", "Show rune".into())])), (2, props(&[("type", "separator".into())]))];
        for (i, (id, name)) in st.zones.iter().enumerate() {
            let on = *id == st.current;
            v.push((ID_ZONE0 + i as i32, props(&[("label", format!("{}{}", if on { "\u{25cf} " } else { "    " }, name).into())])));
        }
        v.push((3, props(&[("type", "separator".into())])));
        v.push((ID_CONFIG, props(&[("label", "Open config folder".into())])));
        v.push((ID_QUIT, props(&[("label", "Quit".into())])));
        v
    }
}

#[interface(name = "com.canonical.dbusmenu")]
impl DbusMenu {
    async fn get_layout(&self, parent: i32, _depth: i32, _names: Vec<String>) -> (u32, (i32, Props, Vec<OwnedValue>)) {
        let items = self.items();
        if parent != 0 {
            let p = items.into_iter().find(|(id, _)| *id == parent).map(|(_, p)| p).unwrap_or_default();
            return (1, (parent, p, vec![]));
        }
        let children = items.into_iter().map(|(id, p)| val(Value::from((id, p, Vec::<OwnedValue>::new())))).collect();
        (1, (0, props(&[("children-display", "submenu".into())]), children))
    }
    async fn get_group_properties(&self, ids: Vec<i32>, _names: Vec<String>) -> Vec<(i32, Props)> {
        self.items().into_iter().filter(|(id, _)| ids.is_empty() || ids.contains(id)).collect()
    }
    async fn get_property(&self, id: i32, name: String) -> OwnedValue {
        self.items().into_iter().find(|(i, _)| *i == id).and_then(|(_, p)| p.get(&name).and_then(|v| v.try_clone().ok())).unwrap_or_else(|| val(""))
    }
    async fn event(&self, id: i32, event_id: String, _data: Value<'_>, _ts: u32) {
        if event_id != "clicked" {
            return;
        }
        let ev = match id {
            ID_TOGGLE => DesktopEvent::Raise,
            ID_CONFIG => DesktopEvent::OpenConfig,
            ID_QUIT => DesktopEvent::Quit,
            i if i >= ID_ZONE0 => {
                let z = self.st.lock().ok().and_then(|s| s.zones.get((i - ID_ZONE0) as usize).map(|z| z.0.clone()));
                match z {
                    Some(z) => DesktopEvent::SetZone(z),
                    None => return,
                }
            }
            _ => return,
        };
        let _ = self.tx.unbounded_send(ev);
    }
    async fn about_to_show(&self, _id: i32) -> bool {
        false
    }
    #[zbus(signal)]
    async fn layout_updated(emitter: &SignalEmitter<'_>, revision: u32, parent: i32) -> zbus::Result<()>;
    #[zbus(property)]
    fn version(&self) -> u32 {
        3
    }
    #[zbus(property)]
    fn text_direction(&self) -> String {
        "ltr".into()
    }
    #[zbus(property)]
    fn status(&self) -> String {
        "normal".into()
    }
    #[zbus(property)]
    fn icon_theme_path(&self) -> Vec<String> {
        vec![]
    }
}

// ------------------------------------------------------------------------------------------------ the thread

async fn run(events: Events, mut ctl: UnboundedReceiver<DesktopCtl>) {
    let snap: Shared = Arc::new(Mutex::new(Snap::default()));
    let menu_state = Arc::new(Mutex::new(MenuState::default()));
    let built = zbus::connection::Builder::session()
        .and_then(|b| b.name(CONTROL_NAME))
        .and_then(|b| b.serve_at(CONTROL_PATH, Control(events.clone())))
        .and_then(|b| b.serve_at("/org/mpris/MediaPlayer2", MprisRoot(events.clone())))
        .and_then(|b| b.serve_at("/org/mpris/MediaPlayer2", MprisPlayer { snap: snap.clone(), tx: events.clone() }))
        .and_then(|b| b.serve_at("/StatusNotifierItem", Sni { tx: events.clone() }))
        .and_then(|b| b.serve_at("/MenuBar", DbusMenu { tx: events.clone(), st: menu_state.clone() }));
    let conn = match async { built?.build().await }.await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rune-desktop: no session bus or the name is taken: {e}");
            // keep draining so senders never block
            while ctl.recv().await.is_some() {}
            return;
        }
    };
    // MPRIS: the name is requested without queueing; another "rune" player keeps it
    if conn.request_name_with_flags(MPRIS_NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into()).await.is_err() {
        eprintln!("rune-desktop: {MPRIS_NAME} is taken: no MPRIS");
    }
    register_tray(&conn).await;
    let mut last: Option<(MprisMeta, std::time::Instant)> = None;
    while let Some(msg) = ctl.recv().await {
        match msg {
            DesktopCtl::Zones { zones, current } => {
                if let Ok(mut s) = menu_state.lock() {
                    if s.zones == zones && s.current == current {
                        continue;
                    }
                    s.zones = zones;
                    s.current = current;
                }
                if let Ok(iref) = conn.object_server().interface::<_, DbusMenu>("/MenuBar").await {
                    let _ = DbusMenu::layout_updated(iref.signal_emitter(), 2, 0).await;
                }
            }
            DesktopCtl::Notify { title, body } => {
                let hints: HashMap<&str, Value<'_>> = HashMap::new();
                let _ = conn
                    .call_method(
                        Some("org.freedesktop.Notifications"),
                        "/org/freedesktop/Notifications",
                        Some("org.freedesktop.Notifications"),
                        "Notify",
                        &("rune", 0u32, "rune-desktop", title.as_str(), body.as_str(), Vec::<&str>::new(), hints, 5000i32),
                    )
                    .await;
            }
            DesktopCtl::Meta(meta) => {
                let now = std::time::Instant::now();
                let mut jumped = false;
                let mut changed = true;
                if let Some((old, at)) = &last {
                    jumped = seek_jump(old, &meta, now.duration_since(*at).as_millis() as u64);
                    let (mut a, mut b) = (old.clone(), meta.clone());
                    a.position_us = 0;
                    b.position_us = 0;
                    changed = a != b;
                }
                if let Ok(mut s) = snap.lock() {
                    s.meta = meta.clone();
                    s.at = Some(now);
                }
                last = Some((meta.clone(), now));
                if !changed && !jumped {
                    continue;
                }
                if let Ok(iref) = conn.object_server().interface::<_, MprisPlayer>("/org/mpris/MediaPlayer2").await {
                    let e = iref.signal_emitter();
                    let g = iref.get().await;
                    if changed {
                        let _ = g.playback_status_changed(e).await;
                        let _ = g.loop_status_changed(e).await;
                        let _ = g.shuffle_changed(e).await;
                        let _ = g.volume_changed(e).await;
                        let _ = g.metadata_changed(e).await;
                        let _ = g.can_go_next_changed(e).await;
                        let _ = g.can_go_previous_changed(e).await;
                        let _ = g.can_play_changed(e).await;
                        let _ = g.can_pause_changed(e).await;
                        let _ = g.can_seek_changed(e).await;
                    }
                    if jumped {
                        let _ = MprisPlayer::seeked(e, meta.position_us).await;
                    }
                }
            }
        }
    }
}

async fn register_tray(conn: &Connection) {
    let Some(name) = conn.unique_name().map(|n| n.to_string()) else { return };
    let r = tokio::time::timeout(
        Duration::from_secs(4),
        conn.call_method(Some("org.kde.StatusNotifierWatcher"), "/StatusNotifierWatcher", Some("org.kde.StatusNotifierWatcher"), "RegisterStatusNotifierItem", &(name.as_str(),)),
    )
    .await;
    if !matches!(r, Ok(Ok(_))) {
        eprintln!("rune-desktop: no StatusNotifierWatcher: no tray icon");
    }
}
