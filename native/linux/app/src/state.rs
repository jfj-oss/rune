//! The one piece of state: what the server last said (core::Model), what the panel is doing (queue open, filter, pick),
//! and the glue to the network and the desktop thread. The window only draws it.
use crate::desktop::{DesktopCtl, DesktopEvent};
use crate::look;
use gpui_kit::*;
use rune_mini_core::commands::{self, UiCommand};
use rune_mini_core::config::{self, Config};
use rune_mini_core::filter;
use rune_mini_core::keys::{self, Action, Key};
use rune_mini_core::model::{next_zone, pickable_zones, Effect, Model, Msg, ServerEvent, Status};
use rune_mini_core::mpris_meta;
use rune_mini_core::net::{Net, NetEvent};
use rune_mini_core::now_ms;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender as TokioTx;

pub const WIDTH: f32 = 560.;
pub const COMPACT_H: f32 = 124.;
/// How long the closed layout is drawn before a hidden panel is minimized, and how long the warm-up window stays drawn.
const HIDE_DELAY_MS: u64 = 40;
const WARM_MS: u64 = 250;
const ACTIVATE_WAIT_MS: u64 = 400;
pub const ROWS: usize = 9;
pub const ROW_H: f32 = 26.;
/// 20 + 84 + 8 + (8 + 26 + 6 + rows) + 14 = COMPACT_H + QUEUE_H
pub const QUEUE_H: f32 = 276. - 234. + ROWS as f32 * ROW_H;

/// RUNE_MINI_TRACE=1: epoch-clock timestamps of the show path on stderr, to line up with an outside observer.
pub fn trace_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("RUNE_MINI_TRACE").is_some())
}

pub fn trace(what: &str) {
    if trace_on() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.);
        eprintln!("TRACE {t:.6} {what}");
    }
}

pub enum Cover {
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
}

pub struct Mini {
    pub cfg: Config,
    pub dir: PathBuf,
    pub model: Model,
    pub net: Net,
    pub covers: Vec<(String, Cover)>,
    pub shown: bool,
    pub queue_open: bool,
    pub filter: String,
    pub pick: usize,
    pub top: usize,
    pub notice: Option<String>,
    pub hover: Option<String>,
    pub window: Option<AnyWindowHandle>,
    pub desktop: Option<TokioTx<DesktopCtl>>,
    pub drag_over: Option<usize>,
    tick: Option<Task<()>>,
    hide_epoch: u64,
    opening: bool,
    /// RUNE_MINI_LAYER=1: the layer-shell overlay, which is closed and made again instead of minimized and resized.
    layer: bool,
}

impl Mini {
    pub fn new(cfg: Config, dir: PathBuf, net: Net) -> Mini {
        let model = Model::new(&cfg.zone);
        Mini { cfg, dir, model, net, covers: vec![], shown: false, queue_open: false, filter: String::new(), pick: 0, top: 0, notice: None, hover: None, window: None, desktop: None, drag_over: None, tick: None, hide_epoch: 0, opening: false, layer: std::env::var_os("RUNE_MINI_LAYER").is_some() }
    }

    // ---------------------------------------------------------------- what is shown

    pub fn matches(&self) -> Vec<usize> {
        self.model.player.as_ref().map(|p| filter::matches(&p.queue, &self.filter)).unwrap_or_default()
    }

    pub fn panel_height(&self) -> f32 {
        COMPACT_H + if self.queue_open { QUEUE_H } else { 0. }
    }

    pub fn zone_name(&self) -> String {
        self.model.zones.iter().find(|z| z.id == self.model.zone).map(|z| z.name.clone()).unwrap_or_else(|| if self.model.zone == "pc" { "PC".into() } else { self.model.zone.clone() })
    }

    pub fn zone_list(&self) -> Vec<(String, String)> {
        let mut z: Vec<(String, String)> = pickable_zones(&self.model.zones).into_iter().map(|z| (z.id, z.name)).collect();
        if z.is_empty() {
            z.push(("pc".into(), "PC".into()));
        }
        if !z.iter().any(|(id, _)| *id == self.model.zone) {
            z.push((self.model.zone.clone(), self.zone_name()));
        }
        z
    }

    pub fn cover_for(&self, album_id: &str) -> Option<&Cover> {
        self.covers.iter().find(|(k, _)| k == album_id).map(|(_, c)| c)
    }

    // ---------------------------------------------------------------- network

    pub fn on_net(&mut self, ev: NetEvent, cx: &mut Context<Self>) {
        let now = now_ms();
        let msg = match ev {
            NetEvent::Conn(c) => {
                let online = c == rune_mini_core::model::Conn::Online;
                let m = Msg::Conn(c);
                if online {
                    // events may have been missed: read the zone list and the state again
                    self.net.fetch_zones();
                    self.net.fetch_minis();
                    self.net.fetch_state(&self.model.zone.clone(), None);
                    self.net.viewing(vec![self.model.zone.clone()]);
                    self.notice = None;
                }
                m
            }
            NetEvent::Ws(e) => {
                // the playlists on the left edge were changed in big rune: read them again
                if matches!(e, ServerEvent::MiniPlaylists) {
                    self.net.fetch_minis();
                }
                Msg::Ws(e)
            }
            NetEvent::Minis(l) => Msg::Minis(l),
            NetEvent::Started { playlist, state } => Msg::Started { playlist, state },
            NetEvent::Fetched { state, rev } => Msg::Fetched { state, rev },
            NetEvent::Zones(z) => Msg::Zones(z),
            NetEvent::Failed(e) => {
                self.notice = Some(e);
                cx.notify();
                return;
            }
            NetEvent::Cover { key, bytes } => {
                cx.spawn(async move |this, cx| {
                    let img = cx.background_spawn(async move { decode_cover(&bytes) }).await;
                    let _ = this.update(cx, |m, cx| {
                        if let Some(slot) = m.covers.iter_mut().find(|(k, _)| *k == key) {
                            slot.1 = match img {
                                Some(i) => Cover::Ready(i),
                                None => Cover::Failed,
                            };
                        }
                        cx.notify();
                    });
                })
                .detach();
                return;
            }
        };
        let fx = self.model.update(msg, now);
        self.run_effects(fx);
        self.changed(cx);
    }

    fn run_effects(&mut self, fx: Vec<Effect>) {
        for e in fx {
            let Effect::Fetch { zone, rev } = e;
            self.net.fetch_state(&zone, rev);
        }
    }

    /// After anything that changes what is shown or said.
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.ensure_cover();
        let n = self.matches().len();
        if self.pick >= n {
            self.pick = n.saturating_sub(1);
        }
        self.keep_pick_visible();
        if let Some(d) = &self.desktop {
            let _ = d.send(DesktopCtl::Meta(mpris_meta::from_model(&self.model, &self.net.client.base, now_ms())));
            let _ = d.send(DesktopCtl::Zones { zones: self.zone_list(), current: self.model.zone.clone() });
        }
        self.manage_tick(cx);
        cx.notify();
    }

    fn ensure_cover(&mut self) {
        let Some(item) = self.model.player.as_ref().and_then(|p| p.current()) else { return };
        let id = item.album.id.clone();
        if id.is_empty() || self.covers.iter().any(|(k, _)| *k == id) {
            return;
        }
        let path = match item.album.cover_url.as_deref() {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => format!("/api/cover/{}?size=200", commands::encode(&id)),
        };
        self.covers.push((id.clone(), Cover::Loading));
        // only the current cover (and the one before) are kept: memory stays small
        while self.covers.len() > 2 {
            self.covers.remove(0);
        }
        self.net.fetch_cover(id, path);
    }

    // ---------------------------------------------------------------- the 1 Hz tick: only while shown and playing

    fn manage_tick(&mut self, cx: &mut Context<Self>) {
        let want = self.shown && self.model.player.as_ref().is_some_and(|p| p.status == Status::Playing);
        if want && self.tick.is_none() {
            self.tick = Some(cx.spawn(async move |this, cx| loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let go = this
                    .update(cx, |m, cx| {
                        let still = m.shown && m.model.player.as_ref().is_some_and(|p| p.status == Status::Playing);
                        if still {
                            cx.notify();
                        } else {
                            m.tick = None;
                        }
                        still
                    })
                    .unwrap_or(false);
                if !go {
                    break;
                }
            }));
        } else if !want {
            self.tick = None;
        }
    }

    // ---------------------------------------------------------------- commands

    pub fn command(&mut self, c: UiCommand, cx: &mut Context<Self>) {
        let now = now_ms();
        if let Some(r) = commands::map(&self.model, &c, now) {
            self.net.send(r);
        }
        cx.notify();
    }

    /// A playlist dot (or key N): shuffle-play playlist `i` on the zone shown.
    pub fn play_mini(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(p) = self.model.minis.get(i) else { return };
        self.notice = None;
        self.net.shuffle_playlist(&self.model.zone.clone(), &p.id.clone());
        cx.notify();
    }

    /// The zone name in the footer: the next zone, wrapping.
    pub fn cycle_zone(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self.zone_list().into_iter().map(|(id, _)| id).collect();
        if let Some(z) = next_zone(&ids, &self.model.zone) {
            self.set_zone(&z, cx);
        }
    }

    pub fn set_zone(&mut self, zone: &str, cx: &mut Context<Self>) {
        let fx = self.model.set_zone(zone);
        if fx.is_empty() {
            return;
        }
        self.run_effects(fx);
        self.net.viewing(vec![zone.to_string()]);
        self.cfg.zone = zone.to_string();
        let _ = config::save(&self.dir, &self.cfg);
        self.filter.clear();
        self.pick = 0;
        self.top = 0;
        self.changed(cx);
    }

    pub fn on_desktop(&mut self, ev: DesktopEvent, cx: &mut Context<Self>) {
        if trace_on() {
            trace(&format!("desktop event {ev:?}"));
        }
        match ev {
            DesktopEvent::Toggle => self.toggle(cx),
            DesktopEvent::Show => self.show(cx),
            DesktopEvent::Hide => self.hide(cx),
            DesktopEvent::Quit => cx.quit(),
            DesktopEvent::Cmd(c) => self.command(c, cx),
            DesktopEvent::SetZone(z) => self.set_zone(&z, cx),
            DesktopEvent::OpenConfig => {
                let _ = std::process::Command::new("xdg-open").arg(&self.dir).spawn();
            }
            DesktopEvent::Note(n) => {
                eprintln!("rune-mini: {n}");
                self.notice = Some(n);
                cx.notify();
            }
        }
    }

    // ---------------------------------------------------------------- keys

    pub fn key(&mut self, k: &Key, cx: &mut Context<Self>) {
        let Some(a) = keys::map_key(k, self.queue_open, self.filter.is_empty()) else { return };
        self.notice = None;
        match a {
            Action::Hide => self.hide(cx),
            Action::PlayPause => self.command(UiCommand::PlayPause, cx),
            Action::Prev => self.command(UiCommand::Prev, cx),
            Action::Next => self.command(UiCommand::Next, cx),
            Action::SeekBack => self.command(UiCommand::SeekBy(-keys::SEEK_MS), cx),
            Action::SeekForward => self.command(UiCommand::SeekBy(keys::SEEK_MS), cx),
            Action::VolumeUp => self.command(UiCommand::VolumeBy(keys::VOLUME_STEP), cx),
            Action::VolumeDown => self.command(UiCommand::VolumeBy(-keys::VOLUME_STEP), cx),
            Action::ToggleShuffle => self.command(UiCommand::ToggleShuffle, cx),
            Action::ToggleRepeat => self.command(UiCommand::CycleRepeat, cx),
            Action::PrevSong => self.command(UiCommand::PrevSong, cx),
            Action::Restart => self.command(UiCommand::Restart, cx),
            Action::SkipFifth => self.command(UiCommand::SkipFraction(keys::SKIP_FRACTION), cx),
            Action::PlayPlaylist(i) => self.play_mini(i, cx),
            Action::OpenQueue => self.set_queue_open(true, cx),
            Action::CloseQueue => self.set_queue_open(false, cx),
            Action::Type(t) => {
                self.filter.push_str(&t);
                self.pick = 0;
                self.top = 0;
                self.changed(cx);
            }
            Action::Backspace => {
                self.filter.pop();
                self.pick = 0;
                self.top = 0;
                self.changed(cx);
            }
            Action::ClearFilter => {
                self.filter.clear();
                self.pick = 0;
                self.top = 0;
                self.changed(cx);
            }
            Action::PickUp => {
                self.pick = self.pick.saturating_sub(1);
                self.keep_pick_visible();
                cx.notify();
            }
            Action::PickDown => {
                self.pick = (self.pick + 1).min(self.matches().len().saturating_sub(1));
                self.keep_pick_visible();
                cx.notify();
            }
            Action::PlayPicked => {
                if let Some(&i) = self.matches().get(self.pick) {
                    self.command(UiCommand::Jump(i), cx);
                }
            }
            Action::RemovePicked => {
                let m = self.matches();
                if let Some(id) = m.get(self.pick).and_then(|&i| self.model.player.as_ref().and_then(|p| p.queue.get(i))).map(|q| q.queue_id.clone()) {
                    self.command(UiCommand::Remove(id), cx);
                }
            }
        }
    }

    fn keep_pick_visible(&mut self) {
        if self.pick < self.top {
            self.top = self.pick;
        } else if self.pick >= self.top + ROWS {
            self.top = self.pick + 1 - ROWS;
        }
        let n = self.matches().len();
        self.top = self.top.min(n.saturating_sub(ROWS));
    }

    pub fn scroll_list(&mut self, delta_rows: i32, cx: &mut Context<Self>) {
        let n = self.matches().len();
        let max = n.saturating_sub(ROWS) as i32;
        self.top = (self.top as i32 + delta_rows).clamp(0, max) as usize;
        cx.notify();
    }

    // ---------------------------------------------------------------- the window

    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        if self.shown {
            self.hide(cx);
        } else {
            self.show(cx);
        }
    }

    /// Summon the panel. The window is made once and kept: summoning restores it (xdg-activation un-minimizes it) and
    /// hiding minimizes it, so no summon pays for a new wgpu surface, atlas and first frame (about 250 ms the old way).
    pub fn show(&mut self, cx: &mut Context<Self>) {
        if self.shown {
            return;
        }
        self.shown = true;
        self.hide_epoch += 1;
        self.net.set_visible(true);
        // the panel may have been hidden a long time: read the state and the zones fresh
        self.net.fetch_state(&self.model.zone.clone(), None);
        self.net.fetch_zones();
        self.net.fetch_minis();
        match self.window {
            Some(h) => {
                self.window_op(h, cx, |w, _| w.activate_window());
                self.watch_activation(cx);
                cx.notify();
            }
            None => self.open_window(true, cx),
        }
        self.manage_tick(cx);
    }

    pub fn hide(&mut self, cx: &mut Context<Self>) {
        if !self.shown {
            return;
        }
        self.shown = false;
        self.queue_open = false;
        self.filter.clear();
        self.pick = 0;
        self.top = 0;
        self.net.set_visible(false);
        self.tick = None;
        self.hide_epoch += 1;
        let epoch = self.hide_epoch;
        let h = self.panel_height();
        if self.layer {
            // a layer-shell surface cannot be minimized: it is closed and made again
            self.close_window(cx);
        } else if let Some(w) = self.window {
            // the closed state (compact, no filter) is drawn first, so the next summon never shows the queue it left; the
            // window is minimized a frame later. A summon in between cancels it (the epoch moved on).
            self.window_op(w, cx, move |win, _| win.resize(size(px(WIDTH), px(h))));
            cx.notify();
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(HIDE_DELAY_MS)).await;
                let _ = this.update(cx, |m, cx| {
                    if !m.shown && m.hide_epoch == epoch {
                        if let Some(w) = m.window {
                            m.window_op(w, cx, |win, _| win.minimize_window());
                        }
                    }
                });
            })
            .detach();
        }
    }

    pub fn set_queue_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.queue_open == open {
            return;
        }
        self.queue_open = open;
        self.filter.clear();
        self.pick = self.model.player.as_ref().map(|p| p.index.max(0) as usize).unwrap_or(0);
        self.top = 0;
        self.keep_pick_visible();
        // the one window is resized in place (no new window, no new first frame)
        let h = self.panel_height();
        match self.window {
            // a layer-shell surface is sized when it is made: it is made again at the new height
            Some(_) if self.layer => {
                self.close_window(cx);
                self.open_window(true, cx);
            }
            Some(w) => self.window_op(w, cx, move |win, _| win.resize(size(px(WIDTH), px(h)))),
            None => self.open_window(true, cx),
        }
        cx.notify();
    }

    fn close_window(&mut self, cx: &mut Context<Self>) {
        if let Some(h) = self.window.take() {
            self.window_op(h, cx, |win, _| win.remove_window());
        }
    }

    /// If the compositor did not take the activation (the window is not active shortly after a summon), the old way is the
    /// fallback: close the window and make a new one, which is shown and focused when it is made.
    fn watch_activation(&mut self, cx: &mut Context<Self>) {
        let epoch = self.hide_epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(ACTIVATE_WAIT_MS)).await;
            let Ok(Some(h)) = this.update(cx, |m, _| (m.shown && m.hide_epoch == epoch).then_some(m.window).flatten()) else { return };
            let active = h.update(cx, |_, window, _| window.is_window_active()).unwrap_or(true);
            if !active {
                let _ = this.update(cx, |m, cx| {
                    if m.shown && m.hide_epoch == epoch {
                        eprintln!("rune-mini: the window was not activated; making a new one");
                        m.close_window(cx);
                        m.open_window(true, cx);
                    }
                });
            }
        })
        .detach();
    }

    /// Run `f` on the window once the current update is over (a window cannot be touched from inside its own update).
    fn window_op(&self, h: AnyWindowHandle, cx: &mut Context<Self>, f: impl FnOnce(&mut Window, &mut App) + 'static) {
        cx.defer(move |cx| {
            let _ = h.update(cx, |_, window, cx| f(window, cx));
        });
    }

    /// Make the window. `visible` false is the warm-up at start: no focus, minimized once its first frames are drawn.
    pub fn open_window(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.opening || (self.layer && !visible) {
            return;
        }
        self.opening = true;
        let me = cx.entity();
        let h = self.panel_height();
        cx.defer(move |cx: &mut App| {
            trace("open_window start");
            let opened = crate::view::open(&me, WIDTH, h, visible, cx);
            trace("open_window returned");
            me.update(cx, |m, cx| {
                m.opening = false;
                match opened {
                    Some(w) => {
                        m.window = Some(w);
                        if m.shown {
                            // summoned while the warm-up window was being made: it was opened unfocused
                            m.window_op(w, cx, |win, _| win.activate_window());
                        } else {
                            m.hide_epoch += 1;
                            let epoch = m.hide_epoch;
                            cx.spawn(async move |this, cx| {
                                cx.background_executor().timer(Duration::from_millis(WARM_MS)).await;
                                let _ = this.update(cx, |m, cx| {
                                    if !m.shown && m.hide_epoch == epoch {
                                        if let Some(w) = m.window {
                                            m.window_op(w, cx, |win, _| win.minimize_window());
                                        }
                                    }
                                });
                            })
                            .detach();
                        }
                    }
                    None => {
                        m.shown = false;
                        m.notice = Some("could not open a window".into());
                    }
                }
                cx.notify();
            });
        });
    }

    /// The window was closed by the desktop (a close button, alt+F4): the panel is hidden and the next summon makes it again.
    pub fn window_gone(&mut self, cx: &mut Context<Self>) {
        self.window = None;
        if self.shown {
            self.shown = false;
            self.queue_open = false;
            self.net.set_visible(false);
            self.tick = None;
        }
        cx.notify();
    }
}

/// Decode a cover once, at twice its drawn size: BGRA for GPUI, a small texture.
pub fn decode_cover(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let img = image::load_from_memory(bytes).ok()?;
    let sq = img.resize_to_fill(192, 192, image::imageops::FilterType::Triangle);
    let mut rgba = sq.to_rgba8();
    for p in rgba.pixels_mut() {
        p.0.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)])))
}

pub fn status_word(s: &Status) -> &'static str {
    match s {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Loading => "loading",
        Status::Stopped => "stopped",
    }
}

pub fn playlist_dot(key: u8) -> Hsla {
    look::c(look::dot_color(key))
}
