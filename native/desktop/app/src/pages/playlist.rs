//! A playlist (web `pages/Playlist.tsx`): hero and rows. Phase 1: play, shuffle, queue, pin, delete, remove a row.
//! Drag reorder, multi-select, inline rename, picture, hotkey and m3u8 are phase 4.
use super::*;
use super::playlists::playlist_cover;
use rune_mini_core::library::*;

enum Row { Hero, Tools, Head, Track(usize), Empty, Space }

/// Dragging a playlist row by its grip: where it is now.
#[derive(Clone)]
pub struct PlDrag { pub from: usize, pub title: String }

/// The web's `selectRow`: a plain click picks one; ctrl/cmd toggles one; shift extends from the anchor.
pub fn select_row(sel: &std::collections::BTreeSet<usize>, anchor: Option<usize>, i: usize, shift: bool, toggle: bool) -> (std::collections::BTreeSet<usize>, Option<usize>) {
    let mut s = sel.clone();
    if shift {
        if let Some(a) = anchor { let (lo, hi) = (a.min(i), a.max(i)); if !toggle { s.clear(); } for k in lo..=hi { s.insert(k); } return (s, Some(a)); }
    }
    if toggle { if !s.remove(&i) { s.insert(i); } return (s, Some(i)); }
    s.clear(); s.insert(i);
    (s, Some(i))
}
const BODY_MAX: f32 = 1240.;

impl Rune {
    pub fn playlist_page(&mut self, id: String, cw: f32, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_playlist(&id, cx);
        let d = match self.data.playlist.get(&id).map(|c| c.slot.clone()) {
            Some(crate::data::Slot::Ready(d)) => d,
            Some(crate::data::Slot::Err(_)) => return div().size_full().pt(px(28.)).px(px(PAD)).child(empty("Playlist not found", "It may have been deleted, removed from Spotify, or hasn\u{2019}t synced yet.")).into_any_element(),
            _ => return div().size_full().pt(px(44.)).px(px(PAD)).child(div().size(px(300.)).rounded(px(6.)).bg(surface())).into_any_element(),
        };
        let mut rows = vec![Row::Hero];
        if d.summary.is_editable() && !d.tracks.is_empty() { rows.push(Row::Tools); }
        if d.tracks.is_empty() { rows.push(Row::Empty); } else { rows.push(Row::Head); for i in 0..d.tracks.len() { rows.push(Row::Track(i)); } }
        rows.push(Row::Space);
        let body_w = cw.min(BODY_MAX);
        let n = rows.len();
        let key = format!("playlist:{id}");
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            Row::Hero => this.playlist_hero(&d, window, cx),
            Row::Tools => body(this.playlist_tools(&d, cx), body_w),
            Row::Head => body(h_flex().h(px(34.)).px(px(6.)).items_center().border_b_1().border_color(wh(0.07)).text_size(px(11.5)).font_weight(w(600.)).text_color(c(TEXT3))
                .child(div().w(px(44.)).flex_none().text_center().child("#")).child(div().flex_grow(1.).flex_basis(relative(0.6)).child("TITLE")).child(div().flex_grow(1.).flex_basis(relative(0.4)).child("ALBUM")).child(div().w(px(56.)).flex_none().text_right().pr(px(8.)).child("TIME")).child(div().w(px(40.)).flex_none()), body_w),
            Row::Track(i) => { let t = d.tracks[*i].clone(); body(this.playlist_row(&d, &t, *i, window, cx), body_w) }
            Row::Empty => body(div().pt(px(36.)).child(empty(if d.summary.is_smart() { "Nothing matches yet" } else { "This playlist is empty" }, "Add tracks from any album or track list with \u{201c}Add to playlist\u{201d}, or save the queue as a playlist.")), body_w),
            Row::Space => bottom_space(),
        });
        let sig = ((cw as u64) << 8) | (self.pl_sel.len() as u64 & 0xff) | (u64::from(self.pl_select_mode) << 7);
        self.list_page(key, sig, n, rowfn, cx)
    }

    fn playlist_hero(&mut self, d: &PlaylistDetail, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let s = &d.summary;
        let total_ms: f64 = d.tracks.iter().map(|t| t.duration_ms).sum();
        let (i1, i2, i3) = (s.id.clone(), s.id.clone(), s.id.clone());
        let cover = playlist_cover(self, s, 300., window);
        let rune = s.is_rune();
        let kind = if s.is_smart() { "Smart playlist" } else if rune { "Playlist" } else { "Spotify playlist" };
        let pin = PopItem { icon: if s.pinned { "pin-off" } else { "pin" }, label: if s.pinned { "Unpin".into() } else { "Pin to Library".into() }, act: MenuAct::PinPlaylist { id: s.id.clone(), pin: !s.pinned }, danger: false, chevron: false, dot: false, sub: false };
        let ids: Vec<String> = d.tracks.iter().map(|t| t.id.clone()).collect();
        let mut items = vec![PopItem { icon: "list-end", label: "Play next".into(), act: MenuAct::PlayNext(ids), danger: false, chevron: false, dot: false, sub: false }, pin];
        let _ = &mut items;
        let (sid, sname) = (s.id.clone(), s.name.clone());
        let dot = || div().mx(px(9.)).text_color(c(TEXT3)).child("\u{b7}");
        let text = v_flex().flex_1().min_w_0().gap(px(12.)).pb(px(4.))
            .child(eyebrow(kind).text_color(ca(TEXT, 0.62)))
            .child(self.playlist_title(s, cx))
            .children(d.description.clone().filter(|x| !x.is_empty()).map(|x| div().text_size(px(14.5)).text_color(c(TEXT2)).child(x)))
            .child(h_flex().flex_wrap().items_baseline().text_size(px(15.)).text_color(c(TEXT2))
                .children(s.owner.clone().map(|o| h_flex().child(div().font_weight(w(600.)).text_color(c(TEXT)).child(o)).child(dot())))
                .child(div().child(format!("{}, {}", plural(if s.track_count > 0 { s.track_count } else { d.tracks.len() }, "track"), format_total_length(total_ms)))))
            .child(h_flex().flex_wrap().items_center().gap(px(8.)).child(if rune { badge("rune", false).h(px(28.)).px(px(11.)).text_size(px(12.)).text_color(c(ACCENT2)) } else { badge("From Spotify", true).h(px(28.)).px(px(11.)).text_size(px(12.)) }))
            .child(h_flex().flex_wrap().gap(px(10.)).mt(px(8.))
                .child(div().id("p-play").child(btn("Play", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| this.play_playlist(&i1, false, 0, cx))))
                .child(div().id("p-shuffle").child(btn("Shuffle", Some("shuffle"), false)).on_click(cx.listener(move |this, _, _, cx| this.play_playlist(&i2, true, 0, cx))))
                .child(div().id("p-queue").child(btn("Queue", Some("plus"), false)).on_click(cx.listener(move |this, _, _, cx| this.enqueue_playlist(&i3, cx))))
                .child(div().id("p-more").child(btn_icon40("ellipsis")).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                    let p = ev.position();
                    let mut its = items.clone();
                    if rune { its.push(PopItem { icon: "trash", label: "Delete playlist".into(), act: MenuAct::DeletePlaylist { id: sid.clone(), name: sname.clone() }, danger: true, chevron: false, dot: false, sub: false }); }
                    this.open_menu(PopMenu { x: f32::from(p.x) - 20., y: f32::from(p.y) + 24., items: its, add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: false, up: false }, cx);
                }))));
        div().w_full().pt(px(44.)).pb(px(30.)).pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(
            h_flex().w_full().max_w(px(BODY_MAX)).mx_auto().gap(px(40.)).items_end()
                .child(div().w(px(300.)).flex_none().child(cover.shadow(vec![BoxShadow { inset: false, color: bk(0.6), offset: point(px(0.), px(30.)), blur_radius: px(70.), spread_radius: px(-10.) }])))
                .child(text)).into_any_element()
    }

    /// The playlist's name: plain text, or for rune's own playlists a click makes it an input (Enter or leaving it saves, Esc cancels).
    fn playlist_title(&mut self, s: &PlaylistSummary, cx: &mut Context<Self>) -> AnyElement {
        let big = |d: Div| d.font_family(SERIF).text_size(px(49.)).line_height(px(54.)).font_weight(w(600.));
        if !s.is_rune() { return big(div()).child(s.name.clone()).into_any_element(); }
        if let Some(inp) = self.pl_rename.clone() {
            return big(div().h(px(60.)).px(px(10.)).ml(px(-10.)).flex().items_center().rounded(px(8.)).bg(surface()).border_1().border_color(ca(ACCENT, 0.6)).child(div().flex_1().child(gpui_kit::component::input::Input::new(&inp).appearance(false).cleanable(false)))).into_any_element();
        }
        let (id, name) = (s.id.clone(), s.name.clone());
        div().id("pl-title").font_family(SERIF).text_size(px(49.)).line_height(px(54.)).font_weight(w(600.)).cursor_text().rounded(px(8.)).px(px(10.)).ml(px(-10.)).hover(|d| d.bg(wh(0.05))).child(s.name.clone())
            .on_click(cx.listener(move |this, _, window, cx| this.begin_rename(&id, &name, window, cx))).into_any_element()
    }

    fn begin_rename(&mut self, id: &str, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        use gpui_kit::component::input::{InputEvent, InputState};
        let st = cx.new(|cx| InputState::new(window, cx));
        let n = name.to_string();
        st.update(cx, |s, cx| s.set_value(n, window, cx));
        let f = st.read(cx).focus_handle(cx);
        window.focus(&f, cx);
        let (pid, old) = (id.to_string(), name.to_string());
        self.pl_rename_sub = Some(cx.subscribe_in(&st, window, move |this: &mut Rune, state, ev: &InputEvent, _w, cx| {
            match ev {
                InputEvent::PressEnter { .. } | InputEvent::Blur => {
                    if this.pl_rename.is_none() { return; }
                    let v = state.read(cx).value().trim().to_string();
                    this.pl_rename = None;
                    this.pl_rename_sub = None;
                    if !v.is_empty() && v != old { this.rename_playlist(&pid, v, cx); }
                    cx.notify();
                }
                _ => {}
            }
        }));
        self.pl_rename = Some(st);
        cx.notify();
    }

    fn playlist_tools(&mut self, d: &PlaylistDetail, cx: &mut Context<Self>) -> Div {
        let n = self.pl_sel.len();
        let pid = d.summary.id.clone();
        let sbtn = |id: &'static str, label: &str, ic: &'static str, on: bool| h_flex().id(id).h(px(32.)).px(px(12.)).gap(px(6.)).items_center().rounded_full().cursor_pointer().text_size(px(13.)).font_weight(w(600.))
            .bg(if on { ca(ACCENT, 0.2) } else { wh(0.08) }).text_color(c(TEXT)).hover(|s| s.bg(wh(0.15))).child(icon(ic, 14., c(TEXT))).child(label.to_string());
        h_flex().h(px(48.)).items_center().gap(px(12.)).pb(px(6.)).text_size(px(13.)).text_color(c(TEXT3))
            .when(n == 0, |t| t.child(sbtn("pt-select", "Select", "check", self.pl_select_mode).on_click(cx.listener(|this, _, _, cx| { this.pl_select_mode = !this.pl_select_mode; cx.notify(); }))))
            .child(if n == 0 { div().flex_1().child("Drag the grip to reorder \u{b7} click to play \u{b7} shift or ctrl-click to select").into_any_element() } else { div().flex_1().font_weight(w(600.)).text_color(c(TEXT)).child(format!("{n} selected")).into_any_element() })
            .when(n > 0, |t| {
                let ids: Vec<String> = self.pl_sel.iter().filter_map(|i| d.tracks.get(*i).map(|x| x.id.clone())).collect();
                let pos: Vec<usize> = self.pl_sel.iter().copied().collect();
                let what = format!("{} tracks", n);
                t.child(sbtn("pt-add", "Add to playlist", "list-plus", false).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                    let p = ev.position();
                    let mut m = crate::menu::pop(f32::from(p.x) - 60., f32::from(p.y) + 22., vec![crate::menu::item("list-plus", "Add to playlist", MenuAct::AddToPlaylistToggle)]);
                    m.items[0].chevron = true; m.add_open = true; m.add_ids = ids.clone(); m.add_label = what.clone();
                    this.open_menu(m, cx);
                })))
                .child(sbtn("pt-remove", "Remove", "trash", false).text_color(c(BAD)).on_click(cx.listener(move |this, _, _, cx| this.remove_positions(&pid, pos.clone(), cx))))
                .child(sbtn("pt-clear", "Clear", "x", false).on_click(cx.listener(|this, _, _, cx| { this.pl_sel.clear(); this.pl_anchor = None; this.pl_select_mode = false; cx.notify(); })))
            })
    }

    fn playlist_row(&mut self, d: &PlaylistDetail, t: &LibTrack, i: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let cur = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.track.id.clone());
        let playing = cur.as_deref() == Some(t.id.as_str());
        let album = t.album.clone().unwrap_or_default();
        let img = self.cover(&album.id, album.cover_url.as_deref(), 40., window);
        let group = SharedString::from(format!("pr-{i}-{}", t.id));
        let rune_editable = d.summary.is_editable();
        let mut menu = self.track_menu_ids(vec![t.id.clone()], t.title.clone(), Some(album.id.clone()), t.artists.first().map(|a| a.id.clone()), t.source == "spotify", t.id.clone());
        if rune_editable { menu.items.push(PopItem { icon: "trash", label: "Remove from playlist".into(), act: MenuAct::RemoveFromPlaylist { playlist: d.summary.id.clone(), position: i }, danger: true, chevron: false, dot: false, sub: false }); }
        let (menu2, pid) = (menu.clone(), d.summary.id.clone());
        let aid = album.id.clone();
        let picked = self.pl_sel.contains(&i);
        let selecting = self.pl_select_mode || !self.pl_sel.is_empty();
        let pid_drop = d.summary.id.clone();
        let (drag_title, pid2) = (t.title.clone(), d.summary.id.clone());
        h_flex().id(group.clone()).group(group.clone()).h(px(56.)).px(px(6.)).items_center().rounded(px(R)).cursor_pointer()
            .when(playing, |x| x.bg(ca(ACCENT, 0.12))).when(!playing && !picked, |x| x.hover(|s| s.bg(wh(0.05)))).when(picked, |x| x.bg(ca(ACCENT, 0.2)))
            .when(rune_editable, |d| d.child(div().id(SharedString::from(format!("pg-{i}"))).w(px(24.)).h_full().flex_none().flex().items_center().justify_center().opacity(0.45).hover(|s| s.opacity(1.)).cursor(CursorStyle::ClosedHand)
                .child(icon("grip-vertical", 15., c(TEXT3)))
                .on_drag(PlDrag { from: i, title: drag_title }, |dg, _o, _w, cx| { let t = dg.title.clone(); cx.new(|_| crate::queue::DragGhost(t)) })))
            .child(div().w(px(44.)).h_full().flex_none().flex().items_center().justify_center().text_size(px(14.)).text_color(c(TEXT3))
                .when(selecting && rune_editable, |d| d.child(div().size(px(18.)).rounded(px(4.)).border_1().border_color(if picked { c(ACCENT) } else { wh(0.3) }).when(picked, |d| d.bg(c(ACCENT))).flex().items_center().justify_center().child(if picked { icon("check", 12., c(0x12101f)).into_any_element() } else { div().into_any_element() })))
                .when(!(selecting && rune_editable), |d| d.child(div().group_hover(group.clone(), |s| s.invisible()).child(if playing { icon("audio-lines", 14., c(ACCENT2)).into_any_element() } else { div().child((i + 1).to_string()).into_any_element() }))
                .child(div().absolute().invisible().group_hover(group.clone(), |s| s.visible()).child(icon("play", 14., c(TEXT))))))
            .child(h_flex().flex_grow(1.).flex_basis(relative(0.6)).min_w_0().gap(px(12.)).items_center()
                .child(cover_el(img, &album.id, &album.title, 40., R_SM))
                .child(v_flex().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(500.)).text_color(if playing { c(ACCENT2) } else { c(TEXT) }).child(t.title.clone()))
                    .child(div().truncate().text_size(px(13.)).text_color(c(TEXT2)).child(t.artist_line()))))
            .child(div().flex_grow(1.).flex_basis(relative(0.4)).min_w_0().flex().child(div().id(SharedString::from(format!("pa-{i}"))).min_w_0().truncate().text_size(px(13.)).text_color(c(TEXT2)).hover(|s| s.text_color(c(TEXT)).underline()).child(album.title.clone())
                .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.go(Route::Album(aid.clone()), cx); }))))
            .child(div().w(px(56.)).flex_none().text_right().pr(px(8.)).text_size(px(13.)).text_color(c(TEXT3)).child(format_duration(t.duration_ms)))
            .child(div().id(SharedString::from(format!("pm-{i}"))).w(px(40.)).flex_none().flex().justify_center().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(btn_icon("ellipsis", 18., c(TEXT2), false))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = menu2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); })))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
            .drag_over::<PlDrag>(|st, _, _, _| st.border_t_2().border_color(c(ACCENT)))
            .on_drop(cx.listener(move |this, dg: &PlDrag, _, cx| this.move_in_playlist(&pid_drop, dg.from, i, cx)))
            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                let m = ev.modifiers();
                if rune_editable && (selecting || m.shift || m.control || m.platform) {
                    let (s, a) = select_row(&this.pl_sel, this.pl_anchor, i, m.shift, m.control || m.platform || this.pl_select_mode || !this.pl_sel.is_empty() && !m.shift);
                    this.pl_sel = s; this.pl_anchor = a; cx.notify();
                } else { this.play_playlist(&pid, false, i, cx); }
            }))
            .into_any_element()
    }
}

fn body(inner: impl IntoElement, body_w: f32) -> AnyElement {
    div().w_full().pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[::core::prelude::v1::test]
    fn selection_follows_the_webs_select_row() {
        let none = BTreeSet::new();
        let (s, a) = select_row(&none, None, 3, false, false);
        assert_eq!((s.iter().copied().collect::<Vec<_>>(), a), (vec![3], Some(3)));
        let (s, a) = select_row(&s, a, 6, true, false);
        assert_eq!(s.iter().copied().collect::<Vec<_>>(), vec![3, 4, 5, 6]);
        let (s, _) = select_row(&s, a, 5, false, true);
        assert_eq!(s.iter().copied().collect::<Vec<_>>(), vec![3, 4, 6]);
    }
}
