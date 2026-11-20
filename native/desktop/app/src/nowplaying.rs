//! Now Playing, full screen (web `components/player/NowPlaying.tsx`, `.np` in shell.css): the cover large on the left; title,
//! artists, waveform, transport, volume, signal path and "Up next" on the right. Esc or the chevron closes it.
use crate::rune::*;
use crate::route::*;
use crate::theme::*;
use crate::util::*;
use crate::widgets::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::model::{Repeat, Status};
use rune_mini_core::now_ms;

const UP_NEXT_MAX: usize = 100;

impl Rune {
    pub fn now_playing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let vw = f32::from(window.viewport_size().width);
        let vh = f32::from(window.viewport_size().height);
        let player = self.model.player.clone();
        let cur = player.as_ref().and_then(|p| p.current()).cloned();
        let index = player.as_ref().map(|p| p.index).unwrap_or(-1);
        let status = player.as_ref().map(|p| p.status.clone()).unwrap_or(Status::Stopped);
        let playing = matches!(status, Status::Playing | Status::Loading);
        let (shuffle, repeat) = player.as_ref().map(|p| (p.shuffle, p.repeat)).unwrap_or((false, Repeat::Off));
        let now = now_ms();
        let dur = cur.as_ref().map(|q| q.track.duration_ms).unwrap_or(0.);
        let pos = self.seek_drag.unwrap_or_else(|| player.as_ref().map(|p| p.position(now)).unwrap_or(0.));
        let volume = match self.vol_hold { Some((t, v)) if t.elapsed().as_millis() < 4000 => v, _ => player.as_ref().map(|p| p.volume).unwrap_or(0.) };
        let frac = if dur > 0. { (pos / dur) as f32 } else { 0. };
        let panel_w = ((vw - 144. - 64.) * 0.42).clamp(380., 540.);
        let art = (vh * 0.6).min(vw * 0.5).min(vw - 144. - 64. - panel_w).max(200.);
        let wide = vw >= 1000.;

        // ---- top bar
        let top = h_flex().flex_none().h(px(64.)).px(px(20.)).pt(px(10.)).items_center().justify_between()
            .child(div().w(px(160.)).child(div().id("np-close").child(btn_icon("chevron-down", 26., c(TEXT), false)).on_click(cx.listener(|this, _, _, cx| { this.np_open = false; cx.notify(); }))))
            .child(v_flex().items_center().min_w_0().max_w(px(vw * 0.5)).child(eyebrow("Now playing")).children(cur.as_ref().map(|q| {
                let aid = q.album.id.clone();
                div().id("np-top-album").truncate().text_size(px(13.5)).font_weight(w(600.)).cursor_pointer().hover(|s| s.underline()).child(q.album.title.clone())
                    .on_click(cx.listener(move |this, _, _, cx| { this.np_open = false; this.go(Route::Album(aid.clone()), cx); }))
            })))
            .child(h_flex().w(px(160.)).justify_end().gap(px(4.))
                .children(cur.as_ref().map(|q| {
                    let m = self.track_menu_ids(vec![q.track.id.clone()], q.track.title.clone(), Some(q.album.id.clone()), q.track.artists.first().map(|a| a.id.clone()), q.track.id.starts_with("sp:"), q.track.id.clone());
                    div().id("np-addpl").child(btn_icon("list-plus", 22., c(TEXT), false)).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                        let p = ev.position();
                        let mut mm = m.clone(); mm.x = f32::from(p.x) - 200.; mm.y = f32::from(p.y) + 20.; mm.add_open = true;
                        this.open_menu(mm, cx);
                    }))
                }))
                .child(h_flex().id("np-zone").h(px(36.)).px(px(12.)).gap(px(8.)).items_center().max_w(px(150.)).rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.08))).text_size(px(13.)).text_color(c(TEXT2))
                    .child(icon("speaker", 16., c(TEXT2))).child(div().min_w_0().truncate().child(self.zone_name()))
                    .on_click(cx.listener(|this, _, _, cx| { this.zone_open = !this.zone_open; this.signal_open = false; cx.notify(); }))));

        // ---- cover
        let cover = match &cur {
            Some(q) => { let img = self.cover(&q.album.id, q.album.cover_url.as_deref(), art, window); cover_el(img, &q.album.id, &q.album.title, art, 10.) }
            None => div().size(px(art)).rounded(px(10.)).bg(surface2()),
        }.shadow(vec![BoxShadow { inset: false, color: bk(0.6), offset: point(px(0.), px(30.)), blur_radius: px(70.), spread_radius: px(-10.) }]);

        // ---- panel
        let title = cur.as_ref().map(|q| q.track.title.clone()).unwrap_or_else(|| "Nothing playing".into());
        let sub: Vec<AnyElement> = match &cur {
            Some(q) => {
                let mut v: Vec<AnyElement> = vec![];
                for (i, a) in q.track.artists.iter().enumerate() {
                    if i > 0 { v.push(div().child(", ").into_any_element()); }
                    let id = a.id.clone();
                    v.push(div().id(SharedString::from(format!("np-ar-{i}"))).font_weight(w(600.)).text_color(c(TEXT)).cursor_pointer().hover(|s| s.underline()).child(a.name.clone())
                        .on_click(cx.listener(move |this, _, _, cx| { this.np_open = false; this.go(Route::Artist(id.clone()), cx); })).into_any_element());
                }
                let aid = q.album.id.clone();
                v.push(div().text_color(c(TEXT3)).child(" \u{b7} ").into_any_element());
                v.push(div().id("np-album").cursor_pointer().hover(|s| s.underline()).child(q.album.title.clone()).on_click(cx.listener(move |this, _, _, cx| { this.np_open = false; this.go(Route::Album(aid.clone()), cx); })).into_any_element());
                v
            }
            None => vec![],
        };
        let peaks = match cur.as_ref() { Some(q) => self.peaks_for(&q.track.id, q.track.duration_ms, cx), None => None };
        let seek = h_flex().w_full().mt(px(10.)).gap(px(12.)).items_center()
            .child(div().min_w(px(34.)).text_size(px(11.5)).text_color(c(TEXT3)).child(format_duration(pos)))
            .child(div().flex_1().min_w_0().child(match peaks { Some((p, approx)) => self.waveform("np-seek", p, approx, frac, 54., cx).into_any_element(), None => self.slider("np-seek", frac, 4., 12., false, self.seek_bounds.clone(), Drag::Seek, cx).into_any_element() }))
            .child(div().min_w(px(34.)).text_right().text_size(px(11.5)).text_color(c(TEXT3)).child(format_duration(dur)));
        let has_queue = player.as_ref().is_some_and(|p| !p.queue.is_empty());
        let tb = |id: &'static str, name: &'static str, on: bool, cx: &mut Context<Self>, cmd: UiCommand| div().id(id).child(btn_icon(name, 18., c(TEXT2), on)).on_click(cx.listener(move |this, _, _, cx| this.cmd(cmd.clone(), cx)));
        let transport = h_flex().justify_center().items_center().gap(px(18.)).pt(px(6.))
            .child(tb("np-sh", "shuffle", shuffle, cx, UiCommand::ToggleShuffle))
            .child(div().id("np-prev").size(px(44.)).flex().items_center().justify_center().rounded_full().hover(|s| s.bg(wh(0.08))).cursor_pointer().when(!has_queue, |d| d.opacity(0.4)).child(glyph(G::Prev, 22., c(TEXT))).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::Prev, cx))))
            .child(div().id("np-pp").size(px(60.)).flex_none().rounded_full().bg(c(TEXT)).flex().items_center().justify_center().cursor_pointer().when(!has_queue, |d| d.opacity(0.4)).child(glyph(if playing { G::Pause } else { G::Play }, 26., c(0x101014))).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::PlayPause, cx))))
            .child(div().id("np-next").size(px(44.)).flex().items_center().justify_center().rounded_full().hover(|s| s.bg(wh(0.08))).cursor_pointer().when(!has_queue, |d| d.opacity(0.4)).child(glyph(G::Next, 22., c(TEXT))).on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::Next, cx))))
            .child(tb("np-rp", if repeat == Repeat::One { "repeat-1" } else { "repeat" }, repeat != Repeat::Off, cx, UiCommand::CycleRepeat));
        let vol_icon = if volume <= 0. { "volume-x" } else if volume < 40. { "volume-1" } else { "volume-2" };
        let vol = h_flex().w_full().pt(px(4.)).gap(px(4.)).items_center()
            .child(div().id("np-mute").child(btn_icon(vol_icon, 18., c(TEXT2), false)).on_click(cx.listener(move |this, _, _, cx| { let to = if volume > 0. { 0. } else { 60. }; this.vol_hold = Some((std::time::Instant::now(), to)); this.cmd(UiCommand::Volume(to), cx); })))
            .child(div().flex_1().child(self.slider("np-vol", (volume / 100.) as f32, 6., 18., false, self.vol_bounds.clone(), Drag::Volume, cx)));
        let tone = crate::shell::signal_tone(&self.signal_path);
        let signal = h_flex().flex_wrap().items_center().gap(px(10.)).text_size(px(12.5)).text_color(c(TEXT3))
            .child(div().size(px(10.)).rounded_full().bg(match tone { 2 => c(OK), 1 => c(WARN), _ => c(TEXT3) }))
            .when(!self.signal_path.is_empty(), |d| d.child(div().text_color(match tone { 2 => c(OK), 1 => c(WARN), _ => c(TEXT3) }).child(self.signal_path.join(" \u{2192} "))));

        let up: Vec<(usize, rune_mini_core::model::QueueItem)> = player.as_ref().map(|p| p.queue.iter().enumerate().skip((index + 1).max(0) as usize).take(UP_NEXT_MAX).map(|(i, q)| (i, q.clone())).collect()).unwrap_or_default();
        let remaining = player.as_ref().map(|p| p.queue.len() as i64 - index - 1).unwrap_or(0);
        let mut next_list = v_flex().id("np-next-list").max_h(px(52. * 4.5)).overflow_y_scroll().pb(px(24.));
        for (i, q) in up {
            let img = self.cover(&q.album.id, q.album.cover_url.as_deref(), 40., window);
            next_list = next_list.child(h_flex().id(SharedString::from(format!("npn-{i}"))).h(px(52.)).px(px(8.)).gap(px(12.)).items_center().rounded(px(R)).cursor_pointer().hover(|s| s.bg(wh(0.07)))
                .child(cover_el(img, &q.album.id, &q.album.title, 40., R_SM))
                .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(500.)).child(q.track.title.clone())).child(div().truncate().text_size(px(12.5)).text_color(c(TEXT3)).child(q.artist_line())))
                .child(div().text_size(px(12.)).text_color(c(TEXT3)).child(format_duration(q.track.duration_ms)))
                .on_click(cx.listener(move |this, _, _, cx| this.cmd(UiCommand::Jump(i), cx))));
        }
        let panel = v_flex().w(px(panel_w)).flex_none().gap(px(16.)).min_w_0()
            .child(div().text_center().font_family(SERIF).text_size(px(34.)).line_height(px(39.)).font_weight(w(600.)).child(title))
            .child(h_flex().justify_center().flex_wrap().mt(px(-6.)).text_size(px(16.)).text_color(c(TEXT2)).children(sub))
            .child(seek).child(transport).child(vol).child(signal)
            .when(remaining > 0, |d| d.child(v_flex().mt(px(12.)).gap(px(10.)).child(h_flex().child(eyebrow("Up next")).when(remaining > 3, |d| d.child(div().text_size(px(13.)).text_color(c(TEXT3)).child(format!(" \u{b7} {remaining}"))))).child(next_list)));

        let main = if wide { h_flex().size_full().items_center().justify_center().gap(px(64.)).px(px(72.)).pb(px(32.)).child(cover).child(panel).into_any_element() }
            else { v_flex().size_full().items_center().gap(px(22.)).px(px(24.)).pb(px(28.)).child(cover).child(panel).into_any_element() };

        div().absolute().top_0().left_0().size_full().bg(c(0x000000)).occlude().flex().flex_col()
            .child(div().absolute().inset_0().bg(linear_gradient(180., linear_color_stop(ca(0x000000, 0.0), 0.), linear_color_stop(ca(0x0f1013, 0.55), 1.))))
            .child(top)
            .child(div().id("np-body").flex_1().min_h_0().overflow_y_scroll().child(div().w_full().h(px(vh - 64.)).child(main)))
    }
}
