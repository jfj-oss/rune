//! A playlist (web `pages/Playlist.tsx`): hero and rows. Phase 1: play, shuffle, queue, pin, delete, remove a row.
//! Drag reorder, multi-select, inline rename, picture, hotkey and m3u8 are phase 4.
use super::*;
use super::playlists::playlist_cover;
use rune_mini_core::library::*;

enum Row { Hero, Head, Track(usize), Empty, Space }
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
        if d.tracks.is_empty() { rows.push(Row::Empty); } else { rows.push(Row::Head); for i in 0..d.tracks.len() { rows.push(Row::Track(i)); } }
        rows.push(Row::Space);
        let body_w = cw.min(BODY_MAX);
        let n = rows.len();
        let key = format!("playlist:{id}");
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            Row::Hero => this.playlist_hero(&d, window, cx),
            Row::Head => body(h_flex().h(px(34.)).px(px(6.)).items_center().border_b_1().border_color(wh(0.07)).text_size(px(11.5)).font_weight(w(600.)).text_color(c(TEXT3))
                .child(div().w(px(44.)).flex_none().text_center().child("#")).child(div().flex_grow(1.).flex_basis(relative(0.6)).child("TITLE")).child(div().flex_grow(1.).flex_basis(relative(0.4)).child("ALBUM")).child(div().w(px(56.)).flex_none().text_right().pr(px(8.)).child("TIME")).child(div().w(px(40.)).flex_none()), body_w),
            Row::Track(i) => { let t = d.tracks[*i].clone(); body(this.playlist_row(&d, &t, *i, window, cx), body_w) }
            Row::Empty => body(div().pt(px(36.)).child(empty(if d.summary.is_smart() { "Nothing matches yet" } else { "This playlist is empty" }, "Add tracks from any album or track list with \u{201c}Add to playlist\u{201d}, or save the queue as a playlist.")), body_w),
            Row::Space => bottom_space(),
        });
        self.list_page(key, (cw as u64) << 8, n, rowfn, cx)
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
            .child(div().font_family(SERIF).text_size(px(49.)).line_height(px(54.)).font_weight(w(600.)).child(s.name.clone()))
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
        h_flex().id(group.clone()).group(group.clone()).h(px(56.)).px(px(6.)).items_center().rounded(px(R)).cursor_pointer()
            .when(playing, |x| x.bg(ca(ACCENT, 0.12))).when(!playing, |x| x.hover(|s| s.bg(wh(0.05))))
            .child(div().w(px(44.)).h_full().flex_none().flex().items_center().justify_center().text_size(px(14.)).text_color(c(TEXT3))
                .child(div().group_hover(group.clone(), |s| s.invisible()).child(if playing { icon("audio-lines", 14., c(ACCENT2)).into_any_element() } else { div().child((i + 1).to_string()).into_any_element() }))
                .child(div().absolute().invisible().group_hover(group.clone(), |s| s.visible()).child(icon("play", 14., c(TEXT)))))
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
            .on_click(cx.listener(move |this, _, _, cx| this.play_playlist(&pid, false, i, cx)))
            .into_any_element()
    }
}

fn body(inner: impl IntoElement, body_w: f32) -> AnyElement {
    div().w_full().pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element()
}
