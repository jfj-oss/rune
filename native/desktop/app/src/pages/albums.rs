//! Albums (web `pages/Albums.tsx`): header, toolbar (source, find, sort, view), a virtualised grid or list.
use super::*;
use gpui_kit::component::input::Input;
use crate::menu::{item, pop};
use rune_mini_core::library::AlbumSummary;

const MIN_CARD: f32 = 170.;
const GAP: f32 = 22.;

fn seg_button(id: &'static str, label: &str, on: bool) -> Stateful<Div> {
    div().id(id).h(px(30.)).px(px(14.)).flex().items_center().justify_center().rounded_full().cursor_pointer().text_size(px(13.)).font_weight(w(500.))
        .text_color(if on { c(TEXT) } else { c(TEXT2) }).when(on, |d| d.bg(surface3())).hover(|s| s.text_color(c(TEXT))).child(label.to_string())
}

impl Rune {
    pub fn find_box(&self, input: &Entity<gpui_kit::component::input::InputState>) -> Div {
        h_flex().h(px(36.)).w(px(210.)).pl(px(12.)).pr(px(8.)).gap(px(6.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3))
            .child(icon("search", 15., c(TEXT3))).child(div().flex_1().min_w_0().text_size(px(13.5)).child(Input::new(input).appearance(false).cleanable(false)))
    }

    pub fn albums_page(&mut self, q: AlbumsQ, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_albums(&q, false, cx);
        self.ensure_labels_years(cx);
        let focused = self.albums_find.read(cx).focus_handle(cx).is_focused(window);
        if !focused && self.albums_find.read(cx).value().trim() != q.q { let v = q.q.clone(); self.albums_find.update(cx, |s, cx| s.set_value(v, window, cx)); }
        let key = q.key();
        let (items, total, loaded, err) = match self.data.albums.get(&key) { Some(l) => (l.items.clone(), l.total, l.loaded, l.error.clone()), None => (vec![], 0, false, None) };
        let list_view = self.view_list;
        let gap = if cw < 520. { 14. } else { GAP };
        let (cols, card_w) = if list_view { (1, cw) } else { grid_dims(cw, MIN_CARD, gap, 2) };
        let rows = if !loaded { if err.is_some() { 0 } else { 3 } } else { total.div_ceil(cols) };
        let n = 1 + rows + 1 + usize::from(loaded && total == 0) + usize::from(err.is_some() && !loaded);
        let title = q.genre.clone().or(q.label.clone()).or(q.year.map(|y| y.to_string())).unwrap_or_else(|| if q.source == Src::Spotify { "Spotify".into() } else { "Albums".into() });
        let sub = if !loaded { " ".to_string() } else if !q.q.is_empty() { format!("{} matching \u{201c}{}\u{201d}", plural(total, "album"), q.q) } else { plural(total, "album") };
        let find = self.albums_find.clone();
        let q2 = q.clone();
        let items2 = items.clone();
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            if ix == 0 {
                return padded(v_flex()
                    .child(page_head(&title, &sub, None))
                    .child(this.albums_toolbar(&q2, &find, list_view, cx)).pb(px(22.))).into_any_element();
            }
            if loaded && total == 0 {
                if ix == 1 { return padded(if q2.source == Src::Spotify { empty("No saved Spotify albums", "Save an album from its page (or search Spotify) and it shows up here.") } else { empty("No albums here", &if q2.q.is_empty() { "Nothing matches these filters.".to_string() } else { format!("No album, artist or song matches \u{201c}{}\u{201d}.", q2.q) }) }).into_any_element(); }
                return bottom_space();
            }
            if !loaded {
                if let Some(e) = &err { if ix == 1 { return padded(empty("Could not load the library", &format!("Is the rune server running? ({e})"))).into_any_element(); } return bottom_space(); }
                if ix <= 3 { let (cols, cw_) = (cols, card_w); return padded(h_flex().gap(px(gap)).h(px(cw_ + 64. + gap)).children((0..cols).map(|_| skeleton_card(cw_)))).into_any_element(); }
                return bottom_space();
            }
            let r = ix - 1;
            if r >= total.div_ceil(cols) { return bottom_space(); }
            if (r + 3) * cols >= items2.len() { this.ensure_albums(&q2, true, cx); }
            if list_view {
                return padded(match items2.get(r) { Some(a) => this.album_list_row(a, window, cx), None => div().id("lr-empty").h(px(56.)) }).into_any_element();
            }
            padded(this.album_row(&items2, r * cols, total, cols, card_w, gap, card_w + 64. + gap, window, cx)).into_any_element()
        });
        self.list_page(format!("albums:{key}"), (cols as u64) << 1 | u64::from(list_view), n, row, cx)
    }

    fn albums_toolbar(&mut self, q: &AlbumsQ, find: &Entity<gpui_kit::component::input::InputState>, list_view: bool, cx: &mut Context<Self>) -> Div {
        let src = |id: &'static str, label: &'static str, s: Src, cur: Src, q: &AlbumsQ, cx: &mut Context<Self>| {
            let mut nq = q.clone(); nq.source = s;
            seg_button(id, label, cur == s).on_click(cx.listener(move |this, _, _, cx| this.replace_route(Route::Albums(nq.clone()), cx)))
        };
        let sort = q.sort;
        h_flex().gap(px(10.)).flex_wrap().items_center()
            .child(h_flex().p(px(3.)).rounded_full().bg(surface()).border_1().border_color(line())
                .child(src("src-all", "All", Src::All, q.source, q, cx)).child(src("src-local", "Local", Src::Local, q.source, q, cx)).child(src("src-spotify", "Spotify", Src::Spotify, q.source, q, cx)))
            .child(self.find_box(find))
            .child(self.facet_chip("fc-label", "Label", q.label.is_some(), "label", cx))
            .child(self.facet_chip("fc-year", "Year", q.year.is_some(), "year", cx))
            .children([("label", q.label.clone()), ("year", q.year.map(|y| y.to_string()))].into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).map(|(k, v)| {
                h_flex().id(SharedString::from(format!("rm-{k}"))).h(px(30.)).pl(px(12.)).pr(px(8.)).gap(px(6.)).items_center().rounded_full().bg(wh(0.08)).text_size(px(12.5)).text_color(c(TEXT2)).cursor_pointer().hover(|s| s.bg(wh(0.14)))
                    .child(format!("{k}: {v}")).child(icon("x", 12., c(TEXT2)))
                    .on_click(cx.listener(move |this, _, _, cx| this.run_menu_act(MenuAct::Facet { kind: k, value: None }, cx)))
            }))
            .child(div().flex_1())
            .child(h_flex().id("sort").h(px(36.)).pl(px(14.)).pr(px(10.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).cursor_pointer().text_size(px(13.))
                .child(div().text_color(c(TEXT3)).child("Sort")).child(div().font_weight(w(500.)).text_color(c(TEXT)).child(sort.label())).child(icon("chevron-down", 12., c(TEXT2)))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                    let p = ev.position();
                    let items = Sort::ALL.iter().map(|s| PopItem { icon: if *s == sort { "check" } else { "disc-3" }, label: s.label().into(), act: MenuAct::SetSort(*s), danger: false, chevron: false, dot: false, sub: false }).collect();
                    this.open_menu(PopMenu { x: f32::from(p.x) - 40., y: f32::from(p.y) + 22., items, add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: false, up: false }, cx);
                })))
            .child(h_flex().p(px(3.)).rounded_full().bg(surface()).border_1().border_color(line())
                .child(div().id("v-grid").w(px(34.)).h(px(30.)).flex().items_center().justify_center().rounded_full().cursor_pointer().when(!list_view, |d| d.bg(surface3())).child(icon("layout-grid", 16., c(if list_view { TEXT2 } else { TEXT })))
                    .on_click(cx.listener(|this, _, _, cx| this.run_menu_act(MenuAct::SetView(false), cx))))
                .child(div().id("v-list").w(px(34.)).h(px(30.)).flex().items_center().justify_center().rounded_full().cursor_pointer().when(list_view, |d| d.bg(surface3())).child(icon("list", 16., c(if list_view { TEXT } else { TEXT2 })))
                    .on_click(cx.listener(|this, _, _, cx| this.run_menu_act(MenuAct::SetView(true), cx)))))
            .child(div().id("lib-more").child(btn_icon40("ellipsis")).on_click(cx.listener(|this, ev: &ClickEvent, window, cx| this.open_top_menu(ev, window, cx))))
    }

    /// A "Label" / "Year" chip: opens a scrolling list of the server's facets (`/labels`, `/years`).
    fn facet_chip(&mut self, id: &'static str, label: &'static str, set: bool, kind: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        h_flex().id(id).h(px(30.)).px(px(12.)).gap(px(5.)).items_center().rounded_full().cursor_pointer().text_size(px(12.5)).font_weight(w(500.))
            .bg(if set { ca(ACCENT, 0.18) } else { wh(0.08) }).text_color(if set { c(ACCENT2) } else { c(TEXT2) }).hover(|s| s.bg(wh(0.14)))
            .child(label).child(icon("chevron-down", 13., c(TEXT2)))
            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                let p = ev.position();
                let cur = match this.route() { Route::Albums(q) => (q.label.clone(), q.year), _ => (None, None) };
                let mut items: Vec<PopItem> = vec![];
                if kind == "label" {
                    match this.data.labels.as_ref().and_then(|c| c.slot.ready()) {
                        Some(l) if !l.is_empty() => for x in l.iter() { let on = cur.0.as_deref() == Some(x.label.as_str()); items.push(item(if on { "check" } else { "tag" }, format!("{}  \u{b7}  {}", x.label, x.album_count), MenuAct::Facet { kind: "label", value: if on { None } else { Some(x.label.clone()) } })); },
                        Some(_) => items.push(item("info", "No labels found", MenuAct::Facet { kind: "label", value: None })),
                        None => items.push(item("loader", "Loading\u{2026}", MenuAct::Facet { kind: "label", value: None })),
                    }
                } else {
                    match this.data.years.as_ref().and_then(|c| c.slot.ready()) {
                        Some(l) if !l.is_empty() => for x in l.iter() { let on = cur.1 == Some(x.year); items.push(item(if on { "check" } else { "calendar" }, format!("{}  \u{b7}  {}", x.year, plural(x.album_count, "album")), MenuAct::Facet { kind: "year", value: if on { None } else { Some(x.year.to_string()) } })); },
                        Some(_) => items.push(item("info", "No years found", MenuAct::Facet { kind: "year", value: None })),
                        None => items.push(item("loader", "Loading\u{2026}", MenuAct::Facet { kind: "year", value: None })),
                    }
                }
                this.open_menu(pop(f32::from(p.x) - 20., f32::from(p.y) + 22., items), cx);
            }))
    }

    pub fn album_list_row(&mut self, a: &AlbumSummary, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let img = self.cover(&a.id, a.cover_url.as_deref(), 44., window);
        let (id, aid) = (a.id.clone(), a.artist.id.clone());
        let fmt = if a.source == "spotify" { Some(("Spotify".to_string(), true)) } else { a.format.clone().map(|f| (f, false)) };
        h_flex().id(SharedString::from(format!("lr-{id}"))).h(px(56.)).px(px(10.)).gap(px(16.)).items_center().rounded(px(R)).hover(|s| s.bg(surface())).cursor_pointer()
            .child(cover_el(img, &a.id, &a.title, 44., R))
            .child(v_flex().flex_1().min_w_0()
                .child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).child(a.title.clone()))
                .child(div().id(SharedString::from(format!("lra-{id}"))).truncate().text_size(px(13.)).text_color(c(TEXT2)).hover(|s| s.text_color(c(TEXT)).underline()).child(a.artist.name.clone())
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.go(Route::Artist(aid.clone()), cx); }))))
            .child(div().w(px(64.)).text_right().text_size(px(13.)).text_color(c(TEXT2)).child(a.year.map(|y| y.to_string()).unwrap_or_default()))
            .children(fmt.map(|(t, sp)| badge(&t, sp)))
            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(id.clone()), cx)))
    }
}
