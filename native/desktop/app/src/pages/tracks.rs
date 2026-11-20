//! Tracks (web `pages/Tracks.tsx`): a filter box, sort + direction, a sortable header and a virtualised list of every track.
use super::*;
use crate::menu::{item, pop};
use gpui_kit::component::input::Input;
use rune_mini_core::library::LibTrack;

const SORTS: [(&str, &str); 5] = [("title", "Title"), ("artist", "Artist"), ("album", "Album"), ("duration", "Duration"), ("added", "Date added")];
const QUEUE_AHEAD: usize = 300;

/// The `/tracks` query for a sort state (the page's cache key is the same string).
pub fn tracks_query(q: &str, sort: &str, desc: bool) -> String {
    rune_mini_core::client_ext::qs(&[("q", q.to_string()), ("sort", sort.to_string()), ("dir", if desc { "desc".into() } else { "asc".into() })]).trim_start_matches('?').to_string()
}

pub fn head_col(label: &str, active: bool, desc: bool, right: bool) -> Div {
    h_flex().h_full().gap(px(5.)).items_center().when(right, |d| d.justify_end()).text_size(px(12.)).font_weight(w(600.)).text_color(if active { c(TEXT) } else { c(TEXT3) }).cursor_pointer().hover(|s| s.text_color(c(TEXT2)))
        .child(label.to_uppercase()).when(active, |d| d.child(icon(if desc { "arrow-down" } else { "arrow-up" }, 13., c(TEXT))))
}

impl Rune {
    pub fn tracks_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let sort = self.tracks_sort;
        let desc = self.tracks_desc.unwrap_or(sort == "added");
        let q = self.tracks_q.clone();
        let query = tracks_query(&q, sort, desc);
        self.ensure_tracks(&query, &query, false, cx);
        let (items, total, loaded, err) = match self.data.tracks.get(&query) { Some(l) => (std::sync::Arc::new(l.items.clone()), l.total, l.loaded, l.error.clone()), None => (Default::default(), 0, false, None) };
        let _ = window;
        let n = 3 + if loaded { total } else { 0 } + 1;
        let sub = if !loaded { " ".to_string() } else if !q.is_empty() { format!("{} matching \u{201c}{}\u{201d}", plural(total, "track"), q) } else { plural(total, "track") };
        let find = self.tracks_find.clone();
        let key = format!("tracks:{query}");
        let body_w = cw;
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            match ix {
                0 => padded(page_head("Tracks", &sub, None)).into_any_element(),
                1 => {
                    let sort_label = SORTS.iter().find(|s| s.0 == sort).map(|s| s.1).unwrap_or("Title");
                    padded(h_flex().gap(px(10.)).items_center().mb(px(22.))
                        .child(h_flex().h(px(36.)).w(px(360.)).max_w_full().pl(px(14.)).pr(px(8.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3))
                            .child(icon("search", 15., c(TEXT3))).child(div().flex_1().min_w_0().text_size(px(14.)).child(Input::new(&find).appearance(false).cleanable(false))))
                        .child(div().flex_1())
                        .child(h_flex().id("tk-sort").h(px(36.)).pl(px(14.)).pr(px(10.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).cursor_pointer().text_size(px(13.))
                            .child(div().text_color(c(TEXT3)).child("Sort")).child(div().font_weight(w(500.)).text_color(c(TEXT)).child(sort_label)).child(icon("chevron-down", 12., c(TEXT2)))
                            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                                let p = ev.position();
                                let items = SORTS.iter().map(|s| item(if s.0 == sort { "check" } else { "arrow-down-up" }, s.1, MenuAct::TracksSort(s.0))).collect();
                                this.open_menu(pop(f32::from(p.x) - 60., f32::from(p.y) + 22., items), cx);
                            })))
                        .child(div().id("tk-dir").size(px(36.)).flex().items_center().justify_center().rounded_full().bg(surface()).border_1().border_color(line()).cursor_pointer().hover(|s| s.bg(wh(0.12)))
                            .child(icon(if desc { "arrow-down" } else { "arrow-up" }, 17., c(TEXT2))).on_click(cx.listener(|this, _, _, cx| this.run_menu_act(MenuAct::TracksDir, cx))))).into_any_element()
                }
                2 => {
                    if let Some(e) = &err { if !loaded { return padded(fail(cx, "Could not load tracks", &format!("Is the rune server running? ({e})"))).into_any_element(); } }
                    if loaded && total == 0 { return padded(empty("No tracks here", if q.is_empty() { "The library has no tracks yet." } else { "Nothing matches that filter." })).into_any_element(); }
                    let col = |label: &'static str, id: &'static str, right: bool, cx: &mut Context<Rune>| {
                        let on = sort == id;
                        div().id(SharedString::from(format!("th-{id}"))).h_full().child(head_col(label, on, desc, right)).on_click(cx.listener(move |this, _, _, cx| {
                            if this.tracks_sort == id { this.run_menu_act(MenuAct::TracksDir, cx); } else { this.run_menu_act(MenuAct::TracksSort(SORTS.iter().find(|s| s.0 == id).map(|s| s.0).unwrap_or("title")), cx); }
                        }))
                    };
                    padded(h_flex().h(px(38.)).px(px(6.)).gap(px(12.)).items_center().border_b_1().border_color(line()).mb(px(4.))
                        .child(div().w(px(44.)).flex_none())
                        .child(div().flex_grow(2.2).flex_basis(px(0.)).min_w_0().child(col("Title", "title", false, cx)))
                        .child(div().flex_grow(1.4).flex_basis(px(0.)).min_w_0().child(col("Artist", "artist", false, cx)))
                        .child(div().flex_grow(1.4).flex_basis(px(0.)).min_w_0().child(col("Album", "album", false, cx)))
                        .child(div().w(px(64.)).flex_none().child(col("Time", "duration", true, cx)))
                        .child(div().w(px(44.)).flex_none())).into_any_element()
                }
                i if i == n - 1 => bottom_space(),
                i => {
                    let r = i - 3;
                    if !loaded { return padded(div().h(px(56.))).into_any_element(); }
                    if r + 40 >= items.len() { this.ensure_tracks(&query, &query, true, cx); }
                    match items.get(r) { Some(t) => padded(this.flat_track_row(t, &items, r, body_w, window, cx)).into_any_element(), None => padded(div().h(px(56.)).flex().items_center().child(div().ml(px(8.)).size(px(40.)).rounded(px(4.)).bg(surface()))).into_any_element() }
                }
            }
        });
        let nn = if loaded { n } else { 4 };
        self.list_page(key, 0, nn, row, cx)
    }

    fn flat_track_row(&mut self, t: &LibTrack, all: &std::sync::Arc<Vec<LibTrack>>, i: usize, _w: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let cur = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.track.id.clone());
        let playing = cur.as_deref() == Some(t.id.as_str());
        let album = t.album.clone().unwrap_or_default();
        let img = self.cover(&album.id, album.cover_url.as_deref(), 40., window);
        let group = SharedString::from(format!("tk-{i}"));
        let menu = self.track_menu_ids(vec![t.id.clone()], t.title.clone(), Some(album.id.clone()), t.artists.first().map(|a| a.id.clone()), t.source == "spotify", t.id.clone());
        let menu2 = menu.clone();
        let (aid, all2) = (album.id.clone(), all.clone());
        let artist_id = t.artists.first().map(|a| a.id.clone());
        h_flex().id(group.clone()).group(group.clone()).h(px(56.)).px(px(6.)).gap(px(12.)).items_center().rounded(px(R)).cursor_pointer()
            .when(playing, |x| x.bg(ca(ACCENT, 0.12))).when(!playing, |x| x.hover(|s| s.bg(wh(0.05))))
            .child(div().w(px(44.)).flex_none().pl(px(8.)).child(div().relative().size(px(40.)).child(cover_el(img, &album.id, &album.title, 40., R_SM))
                .child(div().absolute().inset_0().rounded(px(R_SM)).bg(bk(0.55)).flex().items_center().justify_center().when(!playing, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)))
                    .child(if playing { icon("audio-lines", 16., c(TEXT)) } else { icon("play", 16., c(TEXT)) }))))
            .child(div().flex_grow(2.2).flex_basis(px(0.)).min_w_0().truncate().text_size(px(14.5)).font_weight(w(500.)).text_color(if playing { c(ACCENT2) } else { c(TEXT) }).child(t.title.clone()))
            .child(div().flex_grow(1.4).flex_basis(px(0.)).min_w_0().flex().child(div().id(SharedString::from(format!("tka-{i}"))).min_w_0().truncate().text_size(px(13.5)).text_color(c(TEXT2)).hover(|s| s.text_color(c(TEXT)).underline()).child(t.artist_line())
                .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); if let Some(a) = &artist_id { this.go(Route::Artist(a.clone()), cx); } }))))
            .child(div().flex_grow(1.4).flex_basis(px(0.)).min_w_0().flex().child(div().id(SharedString::from(format!("tkb-{i}"))).min_w_0().truncate().text_size(px(13.5)).text_color(c(TEXT2)).hover(|s| s.text_color(c(TEXT)).underline()).child(album.title.clone())
                .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.go(Route::Album(aid.clone()), cx); }))))
            .child(div().w(px(64.)).flex_none().text_right().text_size(px(13.)).text_color(c(TEXT3)).child(format_duration(t.duration_ms)))
            .child(div().id(SharedString::from(format!("tkm-{i}"))).role(Role::Button).aria_label("More actions").w(px(44.)).flex_none().flex().justify_center().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(btn_icon("ellipsis", 18., c(TEXT2), false))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = menu2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); })))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
            .on_click(cx.listener(move |this, _, _, cx| {
                let ids: Vec<String> = all2.iter().skip(i).take(QUEUE_AHEAD).map(|t| t.id.clone()).collect();
                this.play_ids(ids, 0, false, cx);
            }))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn the_tracks_query_carries_filter_sort_and_direction() {
        assert_eq!(tracks_query("", "title", false), "sort=title&dir=asc");
        assert_eq!(tracks_query("a b", "added", true), "q=a+b&sort=added&dir=desc");
    }
}
