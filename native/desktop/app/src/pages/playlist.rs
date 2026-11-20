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

/// The web's `orderPlaylist`: with "Newest first" the most recently added entries lead (entries added together keep their playlist
/// order, undated ones go last); smart playlists and playlists without dates keep their own order. Returns the shown order as
/// playlist positions, and whether it differs from the playlist's own.
pub fn order_positions(tracks: &[LibTrack], smart: bool, newest_first: bool) -> (Vec<usize>, bool) {
    let ident: Vec<usize> = (0..tracks.len()).collect();
    if !newest_first || smart || tracks.iter().all(|t| t.added_at.is_none()) { return (ident, false); }
    let at = |i: usize| tracks[i].added_at.unwrap_or(f64::NEG_INFINITY);
    let mut o = ident.clone();
    o.sort_by(|&a, &b| at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    let sorted = o != ident;
    (o, sorted)
}

/// Can the order be switched at all (the web's `canSort`)?
pub fn can_sort(tracks: &[LibTrack], smart: bool) -> bool { !smart && tracks.iter().any(|t| t.added_at.is_some()) }

impl Rune {
    pub fn playlist_page(&mut self, id: String, cw: f32, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_playlist(&id, cx);
        let d = match self.data.playlist.get(&id).map(|c| c.slot.clone()) {
            Some(crate::data::Slot::Ready(d)) => d,
            Some(crate::data::Slot::Err(e)) => return div().size_full().pt(px(28.)).px(px(PAD)).child(if unreachable(&e) { fail(cx, "Could not load this playlist", "The rune server did not answer.") } else { empty("Playlist not found", "It may have been deleted, removed from Spotify, or hasn\u{2019}t synced yet.") }).into_any_element(),
            _ => return div().size_full().pt(px(44.)).px(px(PAD)).child(div().size(px(300.)).rounded(px(6.)).bg(surface())).into_any_element(),
        };
        // "Newest first" (the default) or the playlist's own order; rows below act on playlist positions through `pl_orig`
        let (order, sorted) = order_positions(&d.tracks, d.summary.is_smart(), self.pl_newest_first);
        let d = if sorted { Arc::new(PlaylistDetail { summary: d.summary.clone(), description: d.description.clone(), tracks: order.iter().map(|&i| d.tracks[i].clone()).collect() }) } else { d };
        self.pl_orig = order;
        self.pl_sorted = sorted;
        self.pl_view = Some(d.clone());
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
        let cover = playlist_cover(self, s, 300., window, cx);
        let rune = s.is_rune();
        let can_sort = can_sort(&d.tracks, s.is_smart());
        let kind = if s.is_smart() { "Smart playlist" } else if rune { "Playlist" } else { "Spotify playlist" };
        let pin = PopItem { icon: if s.pinned { "pin-off" } else { "pin" }, label: if s.pinned { "Unpin".into() } else { "Pin to Library".into() }, act: MenuAct::PinPlaylist { id: s.id.clone(), pin: !s.pinned }, danger: false, chevron: false, dot: false, sub: false };
        let ids: Vec<String> = d.tracks.iter().map(|t| t.id.clone()).collect();
        let mut items = vec![PopItem { icon: "list-end", label: "Play next".into(), act: MenuAct::PlayNext(ids), danger: false, chevron: false, dot: false, sub: false }, pin];
        if s.is_rune() { items.push(PopItem { icon: "download", label: "Export as .m3u8".into(), act: MenuAct::ExportM3u8 { id: s.id.clone(), name: s.name.clone() }, danger: false, chevron: false, dot: false, sub: false }); }
        let _ = &mut items;
        let (sid, sname) = (s.id.clone(), s.name.clone());
        let dot = || div().mx(px(9.)).text_color(c(TEXT3)).child("\u{b7}");
        let text = v_flex().relative().flex_1().min_w_0().gap(px(12.)).pb(px(4.))
            .child(crate::pages::album::hero_scrim())
            .child(eyebrow(kind).text_color(ca(TEXT, 0.62)))
            .child(self.playlist_title(s, cx))
            .children(d.description.clone().filter(|x| !x.is_empty()).map(|x| div().text_size(px(14.5)).text_color(c(TEXT2)).child(x)))
            .child(h_flex().flex_wrap().items_baseline().text_size(px(15.)).text_color(c(TEXT2))
                .children(s.owner.clone().map(|o| h_flex().child(div().font_weight(w(600.)).text_color(c(TEXT)).child(o)).child(dot())))
                .child(div().child(format!("{}, {}", plural(if s.track_count > 0 { s.track_count } else { d.tracks.len() }, "track"), format_total_length(total_ms)))))
            .child(h_flex().flex_wrap().items_center().gap(px(8.)).child(if rune { badge("rune", false).h(px(28.)).px(px(11.)).text_size(px(12.)).text_color(c(ACCENT2)) } else { badge("From Spotify", true).h(px(28.)).px(px(11.)).text_size(px(12.)) }))
            .child(h_flex().flex_wrap().gap(px(10.)).mt(px(8.))
                .child(div().id("p-play").child(btn("Play", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| { if let Some(v) = this.pl_view.clone() { this.play_tracks(v.tracks.clone(), 0, false, cx); } else { this.play_playlist(&i1, false, 0, cx); } })))
                .child(div().id("p-shuffle").child(btn("Shuffle", Some("shuffle"), false)).on_click(cx.listener(move |this, _, _, cx| { if let Some(v) = this.pl_view.clone() { this.play_tracks(v.tracks.clone(), 0, true, cx); } else { this.play_playlist(&i2, true, 0, cx); } })))
                .child(div().id("p-queue").child(btn("Queue", Some("plus"), false)).on_click(cx.listener(move |this, _, _, cx| this.enqueue_playlist(&i3, cx))))
                .children(can_sort.then(|| {
                    let newest = self.pl_newest_first;
                    div().id("p-order").child(btn(if newest { "Newest first" } else { "Playlist order" }, Some(if newest { "arrow-down-wide-narrow" } else { "list-ordered" }), false))
                        .on_click(cx.listener(|this, _, _, cx| { this.pl_newest_first = !this.pl_newest_first; this.save_state(); cx.notify(); }))
                }))
                .children(rune.then(|| {
                    let (hid, hname) = (s.id.clone(), s.name.clone());
                    let current = self.playlist_key_of(&s.id);
                    let listening = self.hotkey_listen.as_ref().is_some_and(|l| l.0 == s.id);
                    let (hid2, cur2) = (hid.clone(), current.clone());
                    h_flex().gap(px(6.)).child(div().id("p-hotkey").child(btn(&if listening { "Press a key\u{2026}".to_string() } else { match &current { Some(k) => format!("Hotkey  {}", k.to_uppercase()), None => "Hotkey".into() } }, Some("keyboard"), listening))
                        .on_click(cx.listener(move |this, _, _, cx| { this.hotkey_listen = if this.hotkey_listen.is_some() { None } else { Some((hid.clone(), hname.clone())) }; cx.notify(); })))
                        .children(cur2.filter(|_| !listening).map(|_| div().id("p-hotkey-x").role(Role::Button).aria_label("Clear hotkey").child(btn_icon40("x")).on_click(cx.listener(move |this, _, _, cx| { let nm = this.data.playlist.get(&hid2).and_then(|c| c.slot.ready()).map(|d| d.summary.name.clone()).unwrap_or_default(); this.set_playlist_key(&hid2, &nm, "", cx); }))))
                }))
                .child(self.mini_button(&s.id, &s.name, cx))
                .child(div().id("p-more").role(Role::Button).aria_label("More actions").child(btn_icon40("ellipsis")).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                    let p = ev.position();
                    let mut its = items.clone();
                    if rune { its.push(PopItem { icon: "trash", label: "Delete playlist".into(), act: MenuAct::DeletePlaylist { id: sid.clone(), name: sname.clone() }, danger: true, chevron: false, dot: false, sub: false }); }
                    this.open_menu(PopMenu { x: f32::from(p.x) - 20., y: f32::from(p.y) + 24., items: its, add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: false, up: false }, cx);
                }))));
        let bg = self.playlist_hero_bg(d, window, cx);
        let content = div().relative().w_full().pt(px(44.)).pb(px(30.)).pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(
            h_flex().w_full().max_w(px(BODY_MAX)).mx_auto().gap(px(40.)).items_end()
                .child(div().w(px(300.)).flex_none().child(cover.shadow(vec![BoxShadow { inset: false, color: bk(0.6), offset: point(px(0.), px(30.)), blur_radius: px(70.), spread_radius: px(-10.) }])))
                .child(text));
        div().relative().w_full().overflow_hidden().children(bg).child(content).into_any_element()
    }

    /// "Show in rune mini" on a playlist's page: a coloured dot on rune mini that shuffle-plays this playlist (the web's `MiniButton`).
    fn mini_button(&mut self, id: &str, name: &str, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::pages::settings::{MINI_COLORS, MINI_MAX};
        let list: Vec<(String, usize)> = self.ensure_json("/mini/playlists", cx).ready().and_then(|v| v.get("playlists").and_then(|p| p.as_array()).cloned()).unwrap_or_default().iter()
            .filter_map(|p| Some((p.get("id")?.as_str()?.to_string(), p.get("color").and_then(|c| c.as_u64()).unwrap_or(0) as usize))).collect();
        let mine = list.iter().find(|(i, _)| i == id).map(|(_, c)| *c);
        let on = mine.is_some();
        let full = list.len() >= MINI_MAX;
        let pid = id.to_string();
        let _ = name;
        let dot = match mine { Some(col) => icon("circle", 16., c(MINI_COLORS[col % MINI_COLORS.len()])), None => icon("circle", 16., c(TEXT)) };
        h_flex().id("p-mini").role(Role::Button).aria_label(if on { "Remove from rune mini" } else { "Show in rune mini" }).aria_toggled(if on { Toggled::True } else { Toggled::False })
            .h(px(40.)).px(px(16.)).gap(px(8.)).items_center().rounded_full().cursor_pointer().bg(wh(0.08)).hover(|s| s.bg(wh(0.15))).border_1().border_color(wh(0.12)).text_size(px(14.)).font_weight(w(600.))
            .child(dot).child("Show in rune mini")
            .on_click(cx.listener(move |this, _, _, cx| {
                if !on && full { this.say(format!("The rune mini has room for {MINI_MAX} playlists \u{2014} remove one in Settings first"), cx); return; }
                this.spawn_send(cx, if on { "DELETE" } else { "PUT" }, format!("/mini/playlists/{}", rune_mini_core::commands::encode(&pid)), None, move |me, r, cx| {
                    me.forget_json("/mini/playlists");
                    if r.is_err() { me.say(if on { "Could not remove it from the rune mini" } else { "Could not add it to the rune mini" }, cx); } else { me.say(if on { "Removed from rune mini" } else { "Shown in rune mini" }, cx); }
                    cx.notify();
                });
            }))
    }

    /// The header behind a playlist's hero: the ASCII sea for the two wave playlists, two glows for Liked Songs, otherwise the first
    /// song's cover, soft and tinted (see `tint.rs`); under the dark wash in every case.
    fn playlist_hero_bg(&mut self, d: &PlaylistDetail, window: &mut Window, cx: &mut Context<Self>) -> Option<Div> {
        use crate::tint;
        let s = &d.summary;
        if let Some((kind, seed)) = crate::gen::playlist_art(&s.id) {
            if !crate::gen::usable() { return None; }
            let art = self.art("hero", crate::gen::Mode::Ascii, kind, seed, cx);
            return Some(div().absolute().top_0().left_0().size_full().child(art));
        }
        let liked = s.id == LIKED_PLAYLIST_ID;
        let first = d.tracks.first().map(|t| t.album_id.clone());
        let src = if liked { None } else { first.and_then(|a| self.cover(&a, None, 200., window)) };
        if !liked && src.is_none() { return None; }
        let key = (s.id.clone(), src.as_ref().map(|i| Arc::as_ptr(i) as usize).unwrap_or(0));
        if self.hero_tint.as_ref().map(|(k, _)| k) != Some(&key) {
            let vw = f32::from(window.viewport_size().width);
            let box_w = (vw - crate::shell::side_w(self.sidebar_collapsed)).max(400.);
            let box_h = 374.;
            let (ow, oh) = (64usize, ((64. * box_h / box_w).ceil() as usize).max(8));
            let bytes = match &src {
                Some(i) => {
                    let sz = i.size(0);
                    let (w_, h_) = (sz.width.0 as usize, sz.height.0 as usize);
                    i.as_bytes(0).map(|b| tint::render(Some(&tint::Src { bgra: b, w: w_, h: h_ }), false, box_w, box_h, ow, oh))
                }
                None => Some(tint::render(None, true, box_w, box_h, ow, oh)),
            }?;
            let rgba = image::RgbaImage::from_raw(ow as u32, oh as u32, bytes)?;
            let img = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
            if let Some((_, old)) = self.hero_tint.replace((key, img)) { let _ = window.drop_image(old); }
        }
        let img = self.hero_tint.as_ref().map(|(_, i)| i.clone())?;
        Some(div().absolute().top_0().left_0().size_full().child(img_fill(img)))
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
            .child(if n == 0 { div().flex_1().child(if self.pl_sorted { "Newest first \u{b7} switch to \u{201c}Playlist order\u{201d} to drag rows \u{b7} shift or ctrl-click to select" } else { "Drag the grip to reorder \u{b7} click to play \u{b7} shift or ctrl-click to select" }).into_any_element() } else { div().flex_1().font_weight(w(600.)).text_color(c(TEXT)).child(format!("{n} selected")).into_any_element() })
            .when(n > 0, |t| {
                let ids: Vec<String> = self.pl_sel.iter().filter_map(|i| d.tracks.get(*i).map(|x| x.id.clone())).collect();
                let pos: Vec<usize> = self.pl_sel.iter().map(|&i| self.pl_orig.get(i).copied().unwrap_or(i)).collect();
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
        let can_drag = rune_editable && !self.pl_sorted;
        let mut menu = self.track_menu_ids(vec![t.id.clone()], t.title.clone(), Some(album.id.clone()), t.artists.first().map(|a| a.id.clone()), t.source == "spotify", t.id.clone());
        if rune_editable { menu.items.push(PopItem { icon: "trash", label: "Remove from playlist".into(), act: MenuAct::RemoveFromPlaylist { playlist: d.summary.id.clone(), position: self.pl_orig.get(i).copied().unwrap_or(i) }, danger: true, chevron: false, dot: false, sub: false }); }
        let (menu2, pid) = (menu.clone(), d.summary.id.clone());
        let aid = album.id.clone();
        let picked = self.pl_sel.contains(&i);
        let selecting = self.pl_select_mode || !self.pl_sel.is_empty();
        let pid_drop = d.summary.id.clone();
        let (drag_title, pid2) = (t.title.clone(), d.summary.id.clone());
        h_flex().id(group.clone()).group(group.clone()).h(px(56.)).px(px(6.)).items_center().rounded(px(R)).cursor_pointer()
            .when(playing, |x| x.bg(ca(ACCENT, 0.12))).when(!playing && !picked, |x| x.hover(|s| s.bg(wh(0.05)))).when(picked, |x| x.bg(ca(ACCENT, 0.2)))
            .when(rune_editable && !can_drag, |d| d.child(div().w(px(24.)).flex_none()))
            .when(can_drag, |d| d.child(div().id(SharedString::from(format!("pg-{i}"))).w(px(24.)).h_full().flex_none().flex().items_center().justify_center().opacity(0.45).hover(|s| s.opacity(1.)).cursor(CursorStyle::ClosedHand)
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
            .child(div().id(SharedString::from(format!("pm-{i}"))).role(Role::Button).aria_label("More actions").w(px(40.)).flex_none().flex().justify_center().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(btn_icon("ellipsis", 18., c(TEXT2), false))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = menu2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); })))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
            .drag_over::<PlDrag>(|st, _, _, _| st.border_t_2().border_color(c(ACCENT)))
            .on_drop(cx.listener(move |this, dg: &PlDrag, _, cx| this.move_in_playlist(&pid_drop, dg.from, i, cx)))
            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                let m = ev.modifiers();
                if rune_editable && (selecting || m.shift || m.control || m.platform) {
                    let (s, a) = select_row(&this.pl_sel, this.pl_anchor, i, m.shift, m.control || m.platform || this.pl_select_mode || !this.pl_sel.is_empty() && !m.shift);
                    this.pl_sel = s; this.pl_anchor = a; cx.notify();
                } else if let Some(v) = this.pl_view.clone() { this.play_tracks(v.tracks.clone(), i, false, cx); } else { this.play_playlist(&pid, false, i, cx); }
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

fn img_fill(i: Arc<RenderImage>) -> impl IntoElement { img(ImageSource::Render(i)).size_full().object_fit(ObjectFit::Fill) }

#[cfg(test)]
mod order_tests {
    use super::*;

    fn t(added: Option<f64>) -> LibTrack { LibTrack { added_at: added, ..Default::default() } }

    #[::core::prelude::v1::test]
    fn newest_first_like_the_web_and_ties_keep_the_playlists_order() {
        let tr = vec![t(Some(10.)), t(Some(30.)), t(None), t(Some(30.)), t(Some(20.))];
        let (o, sorted) = order_positions(&tr, false, true);
        assert_eq!(o, vec![1, 3, 4, 0, 2], "30, 30 (playlist order), 20, 10, undated last");
        assert!(sorted);
        assert_eq!(order_positions(&tr, false, false), ((0..5).collect(), false), "the playlist's own order");
        assert!(!order_positions(&tr, true, true).1, "smart playlists keep their rule order");
        assert!(!order_positions(&[t(None), t(None)], false, true).1, "nothing dated, nothing to sort");
        assert!(!order_positions(&[t(Some(3.)), t(Some(2.)), t(Some(1.))], false, true).1, "already newest first: not 'sorted', rows stay draggable");
        assert!(can_sort(&tr, false) && !can_sort(&tr, true) && !can_sort(&[t(None)], false));
    }
}
