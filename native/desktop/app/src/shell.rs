//! The frame around every page: sidebar, top bar, the page, the player bar, the queue drawer, menus, dialogs, toast.
//! Measurements are the web's (`shell.css`): sidebar 184 / 64, top bar 56, player bar 88, queue drawer 380.
use crate::rune::*;
use crate::route::*;
use crate::theme::*;
use crate::widgets::*;
use gpui_kit::component::input::Input;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::model::{Repeat, Status};
use rune_mini_core::now_ms;
use std::cell::Cell;
use std::rc::Rc;

pub fn side_w(collapsed: bool) -> f32 { if collapsed { SIDE_W_COLLAPSED } else { SIDE_W } }

/// The player bar's volume slider width: `clamp(240px, 22vw, 340px)`.
pub fn vol_w(window_w: f32) -> f32 { (window_w * 0.22).clamp(240., 340.) }

impl Render for Rune {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.frame += 1;
        if self.frame == 1 { self.start_hook_loop(cx); }
        self.note_frame();
        self.covers.begin_frame();
        self.covers.evict(window);
        let vw = f32::from(window.viewport_size().width);
        let collapsed = self.sidebar_collapsed;
        let sw = side_w(collapsed);
        let page = self.page(vw - sw, window, cx);

        div().relative().size_full().bg(c(BG)).text_color(c(TEXT)).font_family(SANS).text_size(px(15.)).line_height(px(21.75))
            .track_focus(&self.focus)
            .key_context("Rune")
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| this.on_key(ev, window, cx)))
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _w, cx| this.on_drag_move(ev, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, ev: &MouseUpEvent, _w, cx| this.on_drag_up(ev, cx)))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                // a click on bare page gives the keyboard back to the shortcuts (and leaves the search box)
                if !this.search_input.read(cx).focus_handle(cx).is_focused(window) { window.focus(&this.focus.clone(), cx); }
                if this.menu.is_some() || this.zone_open || this.signal_open || this.sort_open { this.menu = None; this.zone_open = false; this.signal_open = false; this.sort_open = false; cx.notify(); }
            }))
            // the page column: top bar, then the page under the glass player bar
            .child(div().absolute().top_0().bottom_0().left(px(sw)).right_0().flex().flex_col()
                .child(self.topbar(window, cx))
                .child(div().flex_1().min_h_0().relative().child(page)))
            .child(self.sidebar(window, cx))
            .child(self.playerbar(window, cx))
            .children(self.queue_open.then(|| self.queue_drawer(window, cx)))
            .children(self.np_open.then(|| self.now_playing(window, cx)))
            .children(self.preview.is_some().then(|| self.preview_overlay(window, cx)))
            .children(self.zone_open.then(|| self.zone_menu(vw, cx)))
            .children(self.signal_open.then(|| self.signal_menu(vw, cx)))
            .children(self.menu.is_some().then(|| self.menu_overlay(window, vw, cx)))
            .children(self.dialog.is_some().then(|| self.dialog_overlay(cx)))
            .children(self.toast.as_ref().map(|t| {
                div().absolute().left_0().right_0().bottom(px(NPBAR_H + 18.)).flex().justify_center().child(
                    div().px(px(18.)).py(px(10.)).rounded_full().bg(panel()).border_1().border_color(wh(0.14)).text_size(px(13.5)).child(t.text.clone()))
            }))
    }
}

impl Rune {
    // ------------------------------------------------------------------ sidebar

    fn nav_item(&self, id: &'static str, label: &'static str, icon_name: &'static str, active: bool, to: Route, cx: &mut Context<Self>) -> Stateful<Div> {
        let collapsed = self.sidebar_collapsed;
        h_flex().id(id).h(px(40.)).px(px(if collapsed { 0. } else { 12. })).gap(px(14.)).items_center().when(collapsed, |d| d.justify_center()).rounded(px(R)).cursor_pointer()
            .text_size(px(14.5)).font_weight(w(500.)).whitespace_nowrap()
            .text_color(if active { c(TEXT) } else { c(TEXT2_GLASS) })
            .when(active, |d| d.bg(ca(ACCENT, 0.18))).when(!active, |d| d.hover(|s| s.bg(wh(0.05)).text_color(c(TEXT))))
            .child(icon(icon_name, 18., if active { c(ACCENT2) } else if false { c(TEXT) } else { c(TEXT2_GLASS) }))
            .when(!collapsed, |d| d.child(label))
            .on_click(cx.listener(move |this, _, _, cx| this.go(to.clone(), cx)))
    }

    fn sidebar(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let collapsed = self.sidebar_collapsed;
        let r = self.route().clone();
        let spotify_view = matches!(&r, Route::Albums(q) if q.source == Src::Spotify);
        let it = |s: &Self, id, label, ic, active, to, cx: &mut Context<Self>| s.nav_item(id, label, ic, active, to, cx);
        v_flex().absolute().left_0().top_0().bottom(px(NPBAR_H)).w(px(side_w(collapsed))).px(px(if collapsed { 10. } else { 12. })).pt(px(20.)).pb(px(12.)).gap(px(4.)).overflow_hidden()
            .bg(ca(0x020208, 0.52)).border_r_1().border_color(wh(0.16))
            .child(h_flex().h(px(44.)).px(px(if collapsed { 0. } else { 10. })).pb(px(18.)).gap(px(10.)).items_center().when(collapsed, |d| d.justify_center())
                .child(crate::logo::logo(36.))
                .when(!collapsed, |d| d.child(div().font_weight(w(600.)).text_size(px(22.)).text_color(c(TEXT)).child("rune"))))
            .child(v_flex().gap(px(2.))
                .child(it(self, "n-home", "Home", "house", r == Route::Home, Route::Home, cx))
                .child(it(self, "n-albums", "Albums", "disc-3", matches!(r, Route::Albums(_)), Route::Albums(AlbumsQ::default()), cx))
                .child(it(self, "n-artists", "Artists", "mic-vocal", r == Route::Artists, Route::Artists, cx))
                .child(it(self, "n-people", "People", "users", r == Route::People, Route::People, cx))
                .child(it(self, "n-tracks", "Tracks", "audio-lines", r == Route::Tracks, Route::Tracks, cx))
                .child(it(self, "n-genres", "Genres", "tags", matches!(r, Route::Genres | Route::Genre(_)), Route::Genres, cx))
                .child(it(self, "n-discover", "Discover", "compass", r == Route::Discover, Route::Discover, cx))
                .child(it(self, "n-radio", "Radio", "radio", r == Route::Radio, Route::Radio, cx))
                .child(it(self, "n-stats", "Stats", "chart-column", r == Route::Stats, Route::Stats, cx)))
            .child(div().h(px(1.)).mx(px(8.)).my(px(10.)).bg(line()))
            .child(v_flex().gap(px(2.))
                .child({
                    let mut d = h_flex().id("n-spotify").h(px(40.)).px(px(if collapsed { 0. } else { 12. })).gap(px(14.)).items_center().when(collapsed, |d| d.justify_center()).rounded(px(R)).cursor_pointer()
                        .text_size(px(14.5)).font_weight(w(500.)).text_color(if spotify_view { c(TEXT) } else { c(TEXT2_GLASS) });
                    if spotify_view { d = d.bg(ca(ACCENT, 0.18)); } else { d = d.hover(|s| s.bg(wh(0.05)).text_color(c(TEXT))); }
                    d.child(div().size(px(18.)).flex().items_center().justify_center().child(div().size(px(10.)).rounded_full().bg(c(SPOTIFY))))
                        .when(!collapsed, |d| d.child("Spotify"))
                        .on_click(cx.listener(|this, _, _, cx| this.go(Route::Albums(AlbumsQ::spotify()), cx)))
                })
                .child(it(self, "n-playlists", "Playlists", "list-music", matches!(r, Route::Playlists(_)), Route::Playlists(String::new()), cx))
                .child(h_flex().id("n-newpl").h(px(40.)).px(px(if collapsed { 0. } else { 12. })).gap(px(14.)).items_center().when(collapsed, |d| d.justify_center()).rounded(px(R)).cursor_pointer()
                    .text_size(px(14.5)).font_weight(w(500.)).text_color(c(TEXT2_GLASS)).hover(|s| s.bg(wh(0.05)).text_color(c(TEXT)))
                    .child(icon("plus", 18., c(TEXT2_GLASS))).when(!collapsed, |d| d.child("New playlist"))
                    .on_click(cx.listener(|this, _, window, cx| this.open_new_playlist(vec![], window, cx)))))
            .child(div().flex_1())
            .child(div().id("collapse").ml(px(if collapsed { 0. } else { 4. })).when(collapsed, |d| d.self_center()).child(btn_icon(if collapsed { "panel-left-open" } else { "panel-left-close" }, 18., c(TEXT2_GLASS), false))
                .on_click(cx.listener(|this, _, _, cx| { this.sidebar_collapsed = !this.sidebar_collapsed; this.save_state(); cx.notify(); })))
    }

    // ------------------------------------------------------------------ top bar

    fn topbar(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (cb, cf) = (self.hist.can_back(), self.hist.can_forward());
        let nav = |id: &'static str, name: &'static str, on: bool| {
            div().id(id).when(!on, |d| d.opacity(0.35)).child(btn_icon(name, 20., c(TEXT2), false)).when(on, |d| d.cursor_pointer())
        };
        let has_text = !self.search_input.read(cx).value().is_empty();
        h_flex().flex_none().h(px(TOPBAR_H)).px(px(20.)).gap(px(12.)).items_center().border_b_1().border_color(wh(0.06))
            .child(h_flex().gap(px(2.))
                .child(nav("back", "chevron-left", cb).on_click(cx.listener(|this, _, _, cx| this.back(cx))))
                .child(nav("fwd", "chevron-right", cf).on_click(cx.listener(|this, _, _, cx| this.forward(cx)))))
            .child(h_flex().w(px(520.)).flex_shrink(1.).h(px(38.)).px(px(14.)).gap(px(10.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3))
                .child(icon("search", 16., c(TEXT3)))
                .child(div().flex_1().min_w_0().text_size(px(14.)).child(Input::new(&self.search_input).appearance(false).cleanable(false)))
                .child(if has_text {
                    div().id("search-clear").size(px(22.)).flex().items_center().justify_center().rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.10))).child(icon("x", 14., c(TEXT2)))
                        .on_click(cx.listener(|this, _, window, cx| { this.search_input.update(cx, |s, cx| s.set_value("", window, cx)); }))
                        .into_any_element()
                } else {
                    div().px(px(6.)).py(px(1.)).rounded(px(4.)).border_1().border_color(line()).text_size(px(11.)).font_weight(w(500.)).text_color(c(TEXT3)).child("/").into_any_element()
                }))
            .child(div().flex_1())
            .child(div().id("settings").child(btn_icon("settings", 19., c(TEXT2), false))
                .on_click(cx.listener(|this, ev: &ClickEvent, window, cx| this.open_top_menu(ev, window, cx))))
    }

    // ------------------------------------------------------------------ player bar

    pub fn slider(&self, id: &'static str, frac: f32, track_h: f32, thumb: f32, hover_fill: bool, bounds: Rc<Cell<Bounds<Pixels>>>, which: Drag, cx: &mut Context<Self>) -> Stateful<Div> {
        let b = bounds.clone();
        let active = self.drag == Some(which);
        let fill = if active || hover_fill { c(ACCENT2) } else { c(TEXT2) };
        h_flex().id(id).group(id).relative().w_full().h(px(if which == Drag::Volume { 28. } else { 18. })).items_center().cursor_pointer()
            .child(div().relative().w_full().h(px(track_h)).rounded(px(track_h / 2.)).bg(wh(0.16))
                .child(div().absolute().left_0().top_0().h_full().w(relative(frac.clamp(0.0005, 1.))).rounded(px(track_h / 2.)).bg(fill)))
            .child(div().absolute().top(px(0.)).left(relative(frac.clamp(0., 1.))).ml(px(-thumb / 2.)).h_full().w(px(thumb)).flex().items_center()
                .child(div().size(px(thumb)).rounded_full().bg(c(0xffffff)).opacity(0.).group_hover(id, |s| s.opacity(1.)).when(active, |d| d.opacity(1.))))
            .child(canvas(move |bb, _, _| b.set(bb), |_, _, _, _| ()).absolute().size_full())
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
                this.drag = Some(which);
                this.drag_to(f32::from(ev.position.x), cx);
            }))
    }

    fn playerbar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = now_ms();
        let vw = f32::from(window.viewport_size().width);
        let player = self.model.player.clone();
        let cur = player.as_ref().and_then(|p| p.current()).cloned();
        let status = player.as_ref().map(|p| p.status.clone()).unwrap_or(Status::Stopped);
        let playing = matches!(status, Status::Playing | Status::Loading);
        let has_queue = player.as_ref().is_some_and(|p| !p.queue.is_empty());
        let (shuffle, repeat) = player.as_ref().map(|p| (p.shuffle, p.repeat)).unwrap_or((false, Repeat::Off));
        let dur = cur.as_ref().map(|q| q.track.duration_ms).unwrap_or(0.);
        let pos = self.seek_drag.unwrap_or_else(|| player.as_ref().map(|p| p.position(now)).unwrap_or(0.));
        let volume = match self.vol_hold { Some((t, v)) if t.elapsed().as_millis() < 4000 => v, _ => player.as_ref().map(|p| p.volume).unwrap_or(0.) };
        let vw_slider = vol_w(vw);
        let peaks = match cur.as_ref() { Some(q) => self.peaks_for(&q.track.id, q.track.duration_ms, cx), None => None };

        // ---- left: art, title row, artists + album
        let left: AnyElement = match cur {
            Some(q) => {
                let img = self.cover(&q.album.id, q.album.cover_url.as_deref(), 56., window);
                let (tid, aid) = (q.track.id.clone(), q.album.id.clone());
                let _ = tid;
                let artists: Vec<(String, String)> = q.track.artists.iter().map(|a| (a.id.clone(), a.name.clone())).collect();
                let item = self.track_menu_ids(vec![q.track.id.clone()], q.track.title.clone(), Some(q.album.id.clone()), artists.first().map(|a| a.0.clone()), q.track.id.starts_with("sp:"), q.track.id.clone());
                h_flex().flex_grow(1.).flex_shrink(1.).flex_basis(px(0.)).min_w(px(180.)).gap(px(14.)).items_center()
                    .child(div().id("np-art").cursor_pointer().child(cover_el(img, &q.album.id, &q.album.title, 56., R).shadow(vec![BoxShadow { inset: false, color: bk(0.45), offset: point(px(0.), px(6.)), blur_radius: px(18.), spread_radius: px(0.) }]))
                        .on_click(cx.listener(|this, _, _, cx| { this.np_open = true; cx.notify(); })))
                    .child(v_flex().flex_1().min_w_0()
                        .child(h_flex().items_center().gap(px(2.)).min_w_0()
                            .child(div().id("np-title").flex_1().min_w_0().truncate().font_weight(w(600.)).text_size(px(14.5)).cursor_pointer().hover(|s| s.underline()).child(q.track.title.clone())
                                .on_click({ let aid = aid.clone(); cx.listener(move |this, _, _, cx| this.go(Route::Album(aid.clone()), cx)) }))
                            .when(q.track.id.starts_with("sp:"), |d| d.child(self.heart_button(&q.track.id, cx)))
                            .child(div().id("np-more").flex_none().size(px(28.)).flex().items_center().justify_center().rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.08)))
                                .child(icon("ellipsis", 18., c(TEXT3_GLASS)))
                                .on_click(cx.listener(move |this, ev: &ClickEvent, _w, cx| { let mut m = item.clone(); let p = ev.position(); m.x = f32::from(p.x); m.y = f32::from(p.y) - 8.; m.up = true; this.open_menu(m, cx); }))))
                        .child(h_flex().mt(px(2.)).gap(px(0.)).min_w_0().overflow_hidden().whitespace_nowrap().text_size(px(13.)).text_color(c(TEXT2_GLASS))
                            .children(artists.iter().enumerate().flat_map(|(i, (id, name))| {
                                let id = id.clone();
                                let mut v: Vec<AnyElement> = vec![];
                                if i > 0 { v.push(div().child(", ").into_any_element()); }
                                v.push(div().id(SharedString::from(format!("np-ar-{i}"))).cursor_pointer().hover(|s| s.text_color(c(TEXT)).underline()).child(name.clone())
                                    .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id.clone()), cx))).into_any_element());
                                v
                            }))
                            .child(div().text_color(c(TEXT3_GLASS)).child(" \u{b7} "))
                            .child(div().id("np-album").cursor_pointer().hover(|s| s.text_color(c(TEXT)).underline()).child(q.album.title.clone())
                                .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(aid.clone()), cx))))))
                    .into_any_element()
            }
            None => div().flex_grow(1.).flex_shrink(1.).flex_basis(px(0.)).min_w(px(180.)).pl(px(4.)).text_size(px(14.)).text_color(c(TEXT3_GLASS)).child(if self.model.online() { "Nothing playing" } else { "Offline \u{2014} reconnecting\u{2026}" }).into_any_element(),
        };

        // ---- centre: transport + seek
        let tbtn = |id: &'static str, name: &'static str, size: f32, on: bool, enabled: bool| {
            let inner = match name {
                "skip-back" => h_flex().size(px(36.)).items_center().justify_center().rounded_full().hover(|s| s.bg(wh(0.08))).child(glyph(G::Prev, size, c(TEXT2_GLASS))).into_any_element(),
                "skip-forward" => h_flex().size(px(36.)).items_center().justify_center().rounded_full().hover(|s| s.bg(wh(0.08))).child(glyph(G::Next, size, c(TEXT2_GLASS))).into_any_element(),
                _ => btn_icon(name, size, c(TEXT2_GLASS), on).into_any_element(),
            };
            div().id(id).cursor_pointer().when(!enabled, |d| d.opacity(0.35)).child(inner)
        };
        let transport = h_flex().gap(px(12.)).items_center()
            .child(tbtn("sh", "shuffle", 16., shuffle, true).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::ToggleShuffle, cx))))
            .child(tbtn("prev", "skip-back", 20., false, has_queue).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::Prev, cx))))
            .child(div().id("pp").size(px(40.)).flex_none().rounded_full().bg(c(TEXT)).flex().items_center().justify_center().cursor_pointer().when(!has_queue, |d| d.opacity(0.4))
                .child(glyph(if playing { G::Pause } else { G::Play }, 18., c(0x101014)))
                .on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::PlayPause, cx))))
            .child(tbtn("next", "skip-forward", 20., false, has_queue).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::Next, cx))))
            .child(tbtn("rp", if repeat == Repeat::One { "repeat-1" } else { "repeat" }, 16., repeat != Repeat::Off, true).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::CycleRepeat, cx))));
        let frac = if dur > 0. { (pos / dur) as f32 } else { 0. };
        let seek = h_flex().w_full().max_w(px(640.)).gap(px(12.)).items_center()
            .child(div().min_w(px(34.)).text_size(px(11.5)).text_color(c(TEXT3_GLASS)).child(crate::util::format_duration(pos)))
            .child(div().flex_1().min_w_0().child(match peaks { Some((p, approx)) => self.waveform("seek", p, approx, frac, 30., cx).into_any_element(), None => self.slider("seek", frac, 4., 12., false, self.seek_bounds.clone(), Drag::Seek, cx).into_any_element() }))
            .child(div().min_w(px(34.)).text_right().text_size(px(11.5)).text_color(c(TEXT3_GLASS)).child(crate::util::format_duration(dur)));
        let centre = v_flex().flex_grow(1.5).flex_shrink(1.).flex_basis(px(0.)).min_w(px(340.)).items_center().gap(px(2.)).child(transport).child(seek);

        // ---- right: signal dot, zone, volume, queue
        let tone = signal_tone(&self.signal_path);
        let vol_icon = if volume <= 0. { "volume-x" } else if volume < 40. { "volume-1" } else { "volume-2" };
        let right = h_flex().flex_none().gap(px(6.)).items_center().justify_end()
            .child(div().id("signal").h(px(36.)).px(px(10.)).flex().items_center().rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.08)))
                .child(div().size(px(10.)).rounded_full().bg(match tone { 2 => c(OK), 1 => c(WARN), _ => c(TEXT3_GLASS) }).when(tone == 2, |d| d.shadow(vec![BoxShadow { inset: false, color: ca(OK, 0.7), offset: point(px(0.), px(0.)), blur_radius: px(10.), spread_radius: px(0.) }])))
                .on_click(cx.listener(|this, _, _, cx| { this.signal_open = !this.signal_open; this.zone_open = false; cx.notify(); })))
            .child(h_flex().id("zone").h(px(36.)).px(px(12.)).gap(px(8.)).items_center().max_w(px(170.)).rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.08)).text_color(c(TEXT)))
                .text_size(px(13.)).text_color(c(TEXT2_GLASS))
                .child(icon("speaker", 16., c(TEXT2_GLASS)))
                .child(div().min_w_0().truncate().child(self.zone_name()))
                .on_click(cx.listener(|this, _, _, cx| { this.zone_open = !this.zone_open; this.signal_open = false; cx.notify(); })))
            .child(h_flex().w(px(vw_slider)).flex_none().gap(px(4.)).items_center()
                .child(div().id("mute").child(btn_icon(vol_icon, 18., c(TEXT2_GLASS), false)).on_click(cx.listener(move |this, _, _, cx| {
                    let to = if volume > 0. { 0. } else { 60. };
                    this.vol_hold = Some((std::time::Instant::now(), to)); this.cmd(UiCommand::Volume(to), cx);
                })))
                .child(div().flex_1().child(self.slider("vol", (volume / 100.) as f32, 6., 18., false, self.vol_bounds.clone(), Drag::Volume, cx))))
            .child(div().id("queue-btn").child(btn_icon("list-music", 20., c(TEXT2_GLASS), self.queue_open)).on_click(cx.listener(|this, _, _, cx| { this.queue_open = !this.queue_open; cx.notify(); })));

        h_flex().absolute().left_0().right_0().bottom_0().h(px(NPBAR_H)).px(px(20.)).gap(px(20.)).items_center()
            .bg(ca(0x020208, 0.97)).border_t_1().border_color(wh(0.16))
            .child(left).child(centre).child(right)
    }

    // ------------------------------------------------------------------ drag handling (seek, volume)

    pub fn start_seek_drag(&mut self, x: f32, cx: &mut Context<Self>) {
        self.drag = Some(Drag::Seek);
        self.drag_to(x, cx);
    }

    fn drag_to(&mut self, x: f32, cx: &mut Context<Self>) {
        match self.drag {
            Some(Drag::Seek) => {
                let b = self.seek_bounds.get();
                let dur = self.model.player.as_ref().and_then(|p| p.current().map(|c| c.track.duration_ms)).unwrap_or(0.);
                if dur > 0. { let f = ((x - f32::from(b.origin.x)) / f32::from(b.size.width).max(1.)).clamp(0., 1.); self.seek_drag = Some(f as f64 * dur); }
            }
            Some(Drag::Volume) => {
                let b = self.vol_bounds.get();
                let f = ((x - f32::from(b.origin.x)) / f32::from(b.size.width).max(1.)).clamp(0., 1.);
                let v = (f * 100.).round() as f64;
                self.vol_hold = Some((std::time::Instant::now(), v));
                // at most ~6 volume commands a second while dragging (Spotify rate limits), the last one on release
                if self.vol_sent.elapsed().as_millis() >= 160 { self.vol_sent = std::time::Instant::now(); self.cmd(UiCommand::Volume(v), cx); }
            }
            None => {}
        }
        cx.notify();
    }

    fn on_drag_move(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        if self.drag.is_some() { self.drag_to(f32::from(ev.position.x), cx); }
    }

    fn on_drag_up(&mut self, ev: &MouseUpEvent, cx: &mut Context<Self>) {
        match self.drag.take() {
            Some(Drag::Seek) => {
                self.drag = Some(Drag::Seek);
                self.drag_to(f32::from(ev.position.x), cx);
                self.drag = None;
                if let Some(ms) = self.seek_drag.take() { self.cmd(UiCommand::SeekTo(ms), cx); }
            }
            Some(Drag::Volume) => {
                self.drag = Some(Drag::Volume);
                let b = self.vol_bounds.get();
                let f = ((f32::from(ev.position.x) - f32::from(b.origin.x)) / f32::from(b.size.width).max(1.)).clamp(0., 1.);
                self.drag = None;
                let v = (f * 100.).round() as f64;
                self.vol_hold = Some((std::time::Instant::now(), v));
                self.cmd(UiCommand::Volume(v), cx);
            }
            None => {}
        }
    }

    // ------------------------------------------------------------------ popovers of the bar

    fn popover_box(&self) -> Div {
        v_flex().absolute().p(px(6.)).bg(panel()).border_1().border_color(wh(0.14)).rounded(px(12.)).shadow(vec![BoxShadow { inset: false, color: bk(0.55), offset: point(px(0.), px(18.)), blur_radius: px(48.), spread_radius: px(0.) }]).occlude()
    }

    pub fn zone_menu(&mut self, vw: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let cur = self.model.zone.clone();
        let mut list = self.popover_box().right(px(vw - vw_right_edge(vw))).bottom(px(NPBAR_H + 12.)).min_w(px(260.));
        list = list.child(div().px(px(12.)).py(px(8.)).text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT3)).child("Play on"));
        for (id, name, kind) in self.zone_list() {
            let on = id == cur;
            let ic = match kind.as_str() { "browser" => "globe", "spotify" => "smartphone", _ => "speaker" };
            let id2 = id.clone();
            list = list.child(h_flex().id(SharedString::from(format!("zone-{id}"))).h(px(40.)).px(px(12.)).gap(px(12.)).items_center().rounded(px(8.)).cursor_pointer().text_size(px(14.)).hover(|s| s.bg(wh(0.07)))
                .when(on, |d| d.bg(ca(ACCENT, 0.14)))
                .child(icon(ic, 16., c(TEXT)))
                .child(div().flex_1().child(name))
                .when(on, |d| d.child(icon("check", 16., c(ACCENT2))))
                .on_click(cx.listener(move |this, _, _, cx| this.set_zone(&id2, cx))));
        }
        list
    }

    pub fn signal_menu(&mut self, vw: f32, _cx: &mut Context<Self>) -> impl IntoElement {
        let steps = self.signal_path.clone();
        let mut b = self.popover_box().right(px(vw - vw_right_edge(vw) + 40.)).bottom(px(NPBAR_H + 12.)).min_w(px(240.)).pb(px(8.));
        b = b.child(div().px(px(12.)).py(px(8.)).text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT3)).child("Signal path"));
        if steps.is_empty() { return b.child(div().px(px(12.)).py(px(4.)).text_size(px(13.)).text_color(c(TEXT3)).child("Nothing is playing.")); }
        for (i, s) in steps.iter().enumerate() {
            let ok = s.to_lowercase().contains("bit-perfect");
            if i > 0 { b = b.child(div().ml(px(24.)).child(icon("arrow-right", 12., c(TEXT3)))); }
            b = b.child(div().mx(px(12.)).child(div().px(px(10.)).py(px(4.)).rounded(px(6.)).text_size(px(13.5)).when(ok, |d| d.bg(ca(OK, 0.2)).text_color(c(OK)).font_weight(w(600.))).when(!ok, |d| d.bg(wh(0.06))).child(s.clone())));
        }
        b
    }
}

fn vw_right_edge(vw: f32) -> f32 { vw - 20. }

/// 2 = bit-perfect (green), 1 = some path (amber), 0 = idle/grey (useSignalPath).
pub fn signal_tone(steps: &[String]) -> u8 {
    if steps.is_empty() { 0 } else if steps.iter().any(|s| s.to_lowercase().contains("bit-perfect")) { 2 } else { 1 }
}
