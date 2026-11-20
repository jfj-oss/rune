//! The menus (the web's `Popover`, `TrackMenu.tsx`, the top bar's settings menu), the dialogs and the heart.
use crate::rune::*;
use crate::theme::*;
use crate::widgets::*;
use gpui_kit::component::input::Input;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::library::*;

pub fn item(icon: &'static str, label: impl Into<String>, act: MenuAct) -> PopItem {
    PopItem { icon, label: label.into(), act, danger: false, chevron: false, dot: false, sub: false }
}

pub fn pop(x: f32, y: f32, items: Vec<PopItem>) -> PopMenu {
    PopMenu { x, y, items, add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: false, up: false }
}

impl Rune {
    pub fn open_menu(&mut self, m: PopMenu, cx: &mut Context<Self>) {
        self.menu = Some(m);
        self.zone_open = false;
        self.signal_open = false;
        cx.notify();
    }

    /// The shared track menu (TrackMenu.tsx): radio, play next, add to queue, add to playlist, like, go to album / artist.
    pub fn track_menu_ids(&self, ids: Vec<String>, what: String, album: Option<String>, artist: Option<String>, spotify: bool, liked_id: String) -> PopMenu {
        let mut items = vec![];
        if !spotify { items.push(item("waves", "Start radio from your library", MenuAct::Radio { from: "track", id: liked_id.clone() })); }
        items.push(item("list-start", "Play next", MenuAct::PlayNext(ids.clone())));
        items.push(item("list-end", "Add to queue", MenuAct::AddToQueue(ids.clone())));
        items.push(PopItem { chevron: true, ..item("list-plus", "Add to playlist", MenuAct::AddToPlaylistToggle) });
        if spotify {
            let on = self.data.liked.get(&liked_id).copied().unwrap_or(false);
            items.push(item("heart", if on { "Remove from Liked Songs" } else { "Save to Liked Songs" }, MenuAct::Like { id: liked_id, on: !on }));
        }
        if let Some(a) = album { items.push(item("disc-3", "Go to album", MenuAct::GoAlbum(a))); }
        if let Some(a) = artist { items.push(item("user", "Go to artist", MenuAct::GoArtist(a))); }
        PopMenu { x: 0., y: 0., items, add_ids: ids, add_label: what, add_open: false, right_aligned: false, up: false }
    }

    pub fn album_menu(&self, a: &Album, ids: Vec<String>) -> PopMenu {
        let s = &a.summary;
        let mut items = vec![item("list-end", "Play next", MenuAct::PlayNext(ids.clone()))];
        items.push(item(if s.pinned { "pin-off" } else { "pin" }, if s.pinned { "Unpin" } else { "Pin to Library" }, MenuAct::PinAlbum { id: s.id.clone(), pin: !s.pinned }));
        items.push(PopItem { chevron: true, ..item("list-plus", "Add to playlist", MenuAct::AddToPlaylistToggle) });
        if s.source == "local" { items.push(item("waves", "Start radio", MenuAct::Radio { from: "album", id: s.id.clone() })); }
        PopMenu { x: 0., y: 0., items, add_ids: ids, add_label: s.title.clone(), add_open: false, right_aligned: false, up: false }
    }

    pub fn open_top_menu(&mut self, ev: &ClickEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let p = ev.position();
        let items = vec![
            item("refresh-cw", "Rescan library", MenuAct::Rescan),
            item("copy", "Duplicates\u{2026}", MenuAct::DuplicatesPage),
            item("activity", "Server status\u{2026}", MenuAct::SettingsPage),
        ];
        self.open_menu(PopMenu { x: f32::from(p.x), y: f32::from(p.y) + 20., items, add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: true, up: false }, cx);
    }

    pub fn menu_overlay(&mut self, window: &mut Window, vw: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let m = self.menu.clone().unwrap();
        if m.add_open { self.ensure_playlists(cx); }
        let vh = f32::from(window.viewport_size().height);
        let mut items: Vec<(PopItem, bool)> = vec![];
        for it in &m.items {
            items.push((it.clone(), false));
            if it.chevron && m.add_open {
                items.push((PopItem { icon: "plus", label: "New playlist\u{2026}".into(), act: MenuAct::NewPlaylistWith(m.add_ids.clone(), m.add_label.clone()), danger: false, chevron: false, dot: false, sub: true }, true));
                if let Some(list) = self.data.playlists.as_ref().and_then(|c| c.slot.ready()) {
                    for p in list.iter().filter(|p| p.can_add_to()).take(8) {
                        items.push((PopItem { icon: "list-music", label: p.name.clone(), act: MenuAct::AddToPlaylist { playlist: p.id.clone(), name: p.name.clone() }, danger: false, chevron: false, dot: !p.is_rune(), sub: true }, true));
                    }
                } else {
                    items.push((PopItem { icon: "list-music", label: "Loading\u{2026}".into(), act: MenuAct::AddToPlaylistToggle, danger: false, chevron: false, dot: false, sub: true }, true));
                }
            }
        }
        let est_h = (12. + items.len() as f32 * 40.).min(380.);
        let mut x = if m.right_aligned { m.x - 240. } else { m.x };
        x = x.clamp(8., (vw - 248.).max(8.));
        let mut y = m.y;
        let limit = vh - NPBAR_H - 8.;
        if !m.up && y + est_h > limit { y = (limit - est_h).max(8.); }
        let mut panel = v_flex().id("menu-panel").absolute().left(px(x)).w(px(240.)).p(px(6.)).max_h(px(380.)).overflow_y_scroll().bg(panel_solid()).border_1().border_color(wh(0.14)).rounded(px(12.)).occlude()
            .shadow(vec![BoxShadow { inset: false, color: bk(0.55), offset: point(px(0.), px(18.)), blur_radius: px(48.), spread_radius: px(0.) }]);
        panel = if m.up { panel.bottom(px((vh - y).max(0.))) } else { panel.top(px(y)) };
        for (i, (it, sub)) in items.into_iter().enumerate() {
            let act = it.act.clone();
            let toggle = matches!(act, MenuAct::AddToPlaylistToggle) && it.chevron;
            panel = panel.child(h_flex().id(SharedString::from(format!("mi-{i}"))).h(px(40.)).px(px(12.)).gap(px(12.)).items_center().rounded(px(8.)).cursor_pointer().text_size(px(14.)).whitespace_nowrap()
                .text_color(if it.danger { c(BAD) } else { c(TEXT) }).hover(|s| s.bg(wh(0.07)))
                .when(sub, |d| d.pl(px(24.)))
                .child(icon(it.icon, 16., if it.danger { c(BAD) } else { c(TEXT) }))
                .child(div().flex_1().min_w_0().truncate().child(it.label.clone()))
                .when(it.dot, |d| d.child(div().size(px(7.)).rounded_full().bg(c(SPOTIFY))))
                .when(it.chevron, |d| d.child(icon("chevron-right", 15., c(TEXT3))))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if toggle { if let Some(m) = this.menu.as_mut() { m.add_open = !m.add_open; } cx.notify(); return; }
                    if matches!(act, MenuAct::AddToPlaylistToggle) { return; }
                    let a = act.clone();
                    let keep = matches!(a, MenuAct::AddToPlaylist { .. });
                    if !keep { this.menu = None; }
                    this.run_menu_act(a, cx);
                    this.menu = None;
                    cx.notify();
                })));
        }
        // a transparent sheet behind it: a click anywhere else closes it (and does nothing else)
        div().absolute().size_full().top_0().left_0().child(div().id("menu-away").absolute().size_full().occlude().on_click(cx.listener(|this, _, _, cx| { this.menu = None; cx.notify(); }))).child(panel)
    }

    // ------------------------------------------------------------------ dialogs

    pub fn open_new_playlist(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| gpui_kit::component::input::InputState::new(window, cx).placeholder("Playlist name"));
        let f = name.read(cx).focus_handle(cx);
        window.focus(&f, cx);
        self.dialog = Some(Dialog::NewPlaylist { name, ids });
        cx.notify();
    }

    /// Opened from a menu action, which has no window at hand: ask the window on the next turn.
    pub fn dialog_new_playlist(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let _ = this.update(cx, |_, _| {});
            let _ = cx.update(|app| {
                if let Some(w) = app.active_window() {
                    let _ = w.update(app, |root, window, cx| {
                        if let Ok(me) = root.downcast::<Rune>() { me.update(cx, |m, cx| m.open_new_playlist(ids, window, cx)); }
                    });
                }
            });
        }).detach();
    }

    pub fn dialog_overlay(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let scrim = div().absolute().size_full().top_0().left_0().bg(ca(0x06060a, 0.62)).flex().items_center().justify_center().occlude();
        match self.dialog.as_ref().unwrap() {
            Dialog::NewPlaylist { name, ids } => {
                let ids2 = ids.clone();
                let name2 = name.clone();
                let n = ids.len();
                scrim.child(v_flex().w(px(420.)).p(px(24.)).gap(px(16.)).bg(panel_solid()).border_1().border_color(wh(0.14)).rounded(px(16.)).on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(20.)).font_weight(w(700.)).child("New playlist"))
                    .when(n > 0, |d| d.child(div().text_size(px(13.)).text_color(c(TEXT2)).child(format!("{n} {} will be added", if n == 1 { "track" } else { "tracks" }))))
                    .child(div().h(px(40.)).px(px(14.)).flex().items_center().rounded_full().bg(surface()).border_1().border_color(line()).child(div().flex_1().child(Input::new(name).appearance(false).cleanable(false))))
                    .child(h_flex().gap(px(10.)).justify_end()
                        .child(div().id("dlg-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.dialog = None; cx.notify(); })))
                        .child(div().id("dlg-ok").child(btn("Create", Some("plus"), true)).on_click(cx.listener(move |this, _, _, cx| {
                            let v = name2.read(cx).value().trim().to_string();
                            if v.is_empty() { return; }
                            this.dialog = None;
                            this.create_playlist(v, ids2.clone(), cx);
                            cx.notify();
                        })))))
            }
            Dialog::FixMatch { album, sel } => {
                let (album, sel) = (album.clone(), sel.clone());
                let cands = match self.ensure_json(&format!("/albums/{}/candidates", rune_mini_core::commands::encode(&album)), cx) { crate::data::Slot::Ready(v) => v.as_array().cloned(), _ => None };
                let mut list = v_flex().id("fm-list").gap(px(8.)).max_h(px(380.)).overflow_y_scroll();
                match cands {
                    None => { for _ in 0..3 { list = list.child(div().h(px(58.)).rounded(px(12.)).bg(surface())); } }
                    Some(l) if l.is_empty() => list = list.child(div().text_color(c(TEXT2)).child("No candidate releases were found.")),
                    Some(l) => for (i, cd) in l.iter().enumerate() {
                        let s = |k: &str| cd.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
                        let (mb, title) = (s("musicbrainzReleaseId"), s("title"));
                        let on = sel.as_deref() == Some(mb.as_str());
                        let tracks = cd.get("trackCount").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                        let sub = format!("{}{} \u{b7} {}{}", s("artist"), cd.get("year").and_then(|y| y.as_i64()).map(|y| format!(" \u{b7} {y}")).unwrap_or_default(), crate::util::plural(tracks, "track"), if s("country").is_empty() { String::new() } else { format!(" \u{b7} {}", s("country")) });
                        let pct = (cd.get("score").and_then(|x| x.as_f64()).unwrap_or(0.) * 100.).round() as i64;
                        let (a2, mb2) = (album.clone(), mb.clone());
                        list = list.child(h_flex().id(SharedString::from(format!("cand-{i}"))).gap(px(14.)).px(px(14.)).py(px(12.)).items_center().rounded(px(12.)).cursor_pointer().border_1()
                            .border_color(if on { c(ACCENT) } else { line() }).bg(if on { ca(ACCENT, 0.12) } else { surface() }).hover(|s| s.border_color(ca(ACCENT, 0.5)))
                            .child(div().size(px(18.)).flex_none().rounded_full().border_1().border_color(if on { c(ACCENT) } else { wh(0.35) }).flex().items_center().justify_center().child(div().when(on, |d| d.size(px(10.)).rounded_full().bg(c(ACCENT)))))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(700.)).child(title)).child(div().truncate().text_size(px(12.5)).text_color(c(TEXT2)).child(sub)))
                            .child(div().text_size(px(13.)).font_weight(w(700.)).text_color(c(TEXT2)).child(format!("{pct}%")))
                            .on_click(cx.listener(move |this, _, _, cx| { this.dialog = Some(Dialog::FixMatch { album: a2.clone(), sel: Some(mb2.clone()) }); cx.notify(); })));
                    }
                }
                let (a3, sel3) = (album.clone(), sel.clone());
                scrim.child(v_flex().w(px(520.)).p(px(24.)).gap(px(16.)).bg(panel_solid()).border_1().border_color(wh(0.14)).rounded(px(16.)).on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(20.)).font_weight(w(700.)).child("Fix match"))
                    .child(div().text_size(px(13.5)).text_color(c(TEXT2)).child("Pick the release that matches your files. rune will re-fetch credits, cover art and reviews for it."))
                    .child(list)
                    .child(h_flex().gap(px(10.)).justify_end()
                        .child(div().id("dlg-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.dialog = None; cx.notify(); })))
                        .child(div().id("dlg-apply").child(btn("Apply", None, true)).when(sel.is_none(), |d| d.opacity(0.4)).on_click(cx.listener(move |this, _, _, cx| { if let Some(mb) = sel3.clone() { this.dialog = None; this.apply_match(&a3, &mb, cx); } })))))
            }
            Dialog::PlayOn { items, start, shuffle, need } => {
                let (items, start, shuffle, need) = (items.clone(), *start, *shuffle, *need);
                let cur = self.zone_name();
                let opts = crate::playroute::playable_zones(&self.zone_list(), need);
                let first = items.get(start).map(|i| i.title.clone()).unwrap_or_default();
                let what = if items.len() > 1 { format!("{} tracks", items.len()) } else { first };
                let mut list = v_flex().gap(px(6.));
                for (i, (id, name, kind)) in opts.into_iter().enumerate() {
                    let ic = match kind.as_str() { "browser" => "globe", "spotify" => "smartphone", _ => "speaker" };
                    let hint = match kind.as_str() { "pc" => if need == crate::playroute::Source::Spotify { "Local files, and Spotify (rune starts the app)" } else { "Local files, bit-perfect" }, "browser" => "On this computer", _ => "Spotify Connect" };
                    let on = id == self.model.zone;
                    let (items2, id2) = (items.clone(), id.clone());
                    list = list.child(h_flex().id(SharedString::from(format!("po-{i}"))).gap(px(14.)).px(px(14.)).py(px(12.)).items_center().rounded(px(12.)).cursor_pointer().hover(|s| s.bg(wh(0.07)))
                        .child(icon(ic, 20., c(TEXT)))
                        .child(v_flex().flex_1().min_w_0().child(div().text_size(px(14.5)).font_weight(w(700.)).child(name)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(hint)))
                        .when(on, |d| d.child(icon("check", 16., c(ACCENT2))))
                        .on_click(cx.listener(move |this, _, _, cx| this.play_on(&id2, items2.clone(), start, shuffle, cx))));
                }
                scrim.child(v_flex().w(px(460.)).p(px(24.)).gap(px(14.)).bg(panel_solid()).border_1().border_color(wh(0.14)).rounded(px(16.)).on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(20.)).font_weight(w(700.)).child("Play on\u{2026}"))
                    .child(div().text_size(px(13.5)).text_color(c(TEXT2)).child(format!("{} can\u{2019}t play {}. Pick where to hear {}.", cur, if need == crate::playroute::Source::Spotify { "Spotify tracks" } else { "local files" }, what)))
                    .child(list)
                    .child(div().text_size(px(12.)).text_color(c(TEXT3)).child("Your choice is remembered for this session."))
                    .child(h_flex().justify_end().child(div().id("dlg-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.dialog = None; cx.notify(); })))))
            }
            Dialog::DeletePlaylist { id, name } => {
                let (id, name) = (id.clone(), name.clone());
                let n2 = name.clone();
                scrim.child(v_flex().w(px(380.)).p(px(24.)).gap(px(16.)).bg(panel_solid()).border_1().border_color(wh(0.14)).rounded(px(16.)).on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(20.)).font_weight(w(700.)).child("Delete playlist?"))
                    .child(div().text_color(c(TEXT2)).child(format!("\u{201c}{n2}\u{201d} will be deleted. The tracks themselves stay in your library.")))
                    .child(h_flex().gap(px(10.)).justify_end()
                        .child(div().id("dlg-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.dialog = None; cx.notify(); })))
                        .child(div().id("dlg-del").child(btn("Delete", Some("trash"), false)).on_click(cx.listener(move |this, _, _, cx| { this.dialog = None; this.delete_playlist(&id, &name, cx); })))))
            }
        }
    }

    /// The heart next to a Spotify track's title (Liked.tsx): quiet until liked.
    pub fn heart_button(&mut self, track_id: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        self.ensure_liked(track_id, cx);
        let on = self.data.liked.get(track_id).copied().unwrap_or(false);
        let id = track_id.to_string();
        div().id("np-heart").flex_none().size(px(28.)).flex().items_center().justify_center().rounded_full().cursor_pointer().hover(|s| s.bg(wh(0.08)))
            .child(icon("heart", 16., if on { c(ON) } else { c(TEXT3_GLASS) }))
            .on_click(cx.listener(move |this, _, _, cx| { let now = this.data.liked.get(&id).copied().unwrap_or(false); this.set_liked(&id, !now, cx); }))
    }
}

pub fn panel_solid() -> Hsla { c(0x1b1c24) }
