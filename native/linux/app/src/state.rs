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
pub const ROWS: usize = 9;
pub const ROW_H: f32 = 26.;
/// 20 + 84 + 8 + (8 + 26 + 6 + rows) + 14 = COMPACT_H + QUEUE_H
pub const QUEUE_H: f32 = 276. - 234. + ROWS as f32 * ROW_H;

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
}

impl Mini {
    pub fn new(cfg: Config, dir: PathBuf, net: Net) -> Mini {
        let model = Model::new(&cfg.zone);
        Mini { cfg, dir, model, net, covers: vec![], shown: false, queue_open: false, filter: String::new(), pick: 0, top: 0, notice: None, hover: None, window: None, desktop: None, drag_over: None, tick: None, hide_epoch: 0 }
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
        self.open_window(cx);
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
        self.close_window(cx);
        self.tick = None;
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
        // a layer-shell surface is sized when it is made: the window is made again at the new height (state is here)
        self.close_window(cx);
        self.open_window(cx);
    }

    fn close_window(&mut self, cx: &mut Context<Self>) {
        if let Some(h) = self.window.take() {
            cx.defer(move |cx| {
                let _ = h.update(cx, |_, window, _| window.remove_window());
            });
        }
    }

    fn open_window(&mut self, cx: &mut Context<Self>) {
        let me = cx.entity();
        let h = self.panel_height();
        cx.defer(move |cx: &mut App| {
            let opened = crate::view::open(&me, WIDTH, h, cx);
            me.update(cx, |m, cx| {
                match opened {
                    Some(w) if m.shown => m.window = Some(w),
                    Some(w) => {
                        let _ = w.update(cx, |_, window, _| window.remove_window());
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
