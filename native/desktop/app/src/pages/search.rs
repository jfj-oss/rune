//! Search results (web `pages/Search.tsx`): top result, albums, artists, tracks, with arrows + Enter from the top bar's box.
use super::*;
use super::artists::avatar;
use crate::data::Slot;
use rune_mini_core::library::*;
use rune_mini_core::model::ArtistRef;

#[derive(Clone, Debug, PartialEq)]
pub enum Nav { Top, Album(String), Artist(String), Track(String, String) }

#[derive(Clone)]
enum Top { Artist(ArtistRef), Album(AlbumSummary) }

fn top_of(q: &str, r: &SearchResults) -> Option<Top> {
    let lq = q.to_lowercase();
    if let Some(a) = r.artists.iter().find(|a| a.name.to_lowercase().starts_with(&lq)) { return Some(Top::Artist(a.clone())); }
    if let Some(a) = r.albums.first() { return Some(Top::Album(a.clone())); }
    r.artists.first().map(|a| Top::Artist(a.clone()))
}

/// Local tracks first (8), then Spotify catalogue ones (6): the server appends those.
fn tracks_of(r: &SearchResults) -> Vec<LibTrack> {
    r.tracks.iter().filter(|t| t.source != "spotify").take(8).chain(r.tracks.iter().filter(|t| t.source == "spotify").take(6)).cloned().collect()
}

/// The keyboard order: top result, albums, artists, tracks.
pub fn nav_items(q: &str, r: &SearchResults) -> Vec<Nav> {
    let mut v = vec![];
    if let Some(t) = top_of(q, r) { v.push(Nav::Top); let _ = t; }
    v.extend(r.albums.iter().map(|a| Nav::Album(a.id.clone())));
    v.extend(r.artists.iter().map(|a| Nav::Artist(a.id.clone())));
    v.extend(tracks_of(r).iter().map(|t| Nav::Track(t.album_id.clone(), t.id.clone())));
    v
}

pub fn activate(this: &mut Rune, cx: &mut Context<Rune>) {
    let Route::Search(q) = this.route().clone() else { return };
    let Some(r) = this.data.search.get(&q).and_then(|c| c.slot.ready()).cloned() else { return };
    let items = nav_items(&q, &r);
    let Some(it) = items.get(this.search_pick.unwrap_or(0).min(items.len().saturating_sub(1))).cloned() else { return };
    let it = if it == Nav::Top { match top_of(&q, &r) { Some(Top::Artist(a)) => Nav::Artist(a.id), Some(Top::Album(a)) => Nav::Album(a.id), None => return } } else { it };
    match it {
        Nav::Album(id) => this.go(Route::Album(id), cx),
        Nav::Artist(id) => this.go(Route::Artist(id), cx),
        Nav::Track(album, track) => play_track(this, &album, &track, cx),
        Nav::Top => {}
    }
}

fn play_track(this: &mut Rune, album: &str, track: &str, cx: &mut Context<Rune>) {
    let track = track.to_string();
    let a2 = album.to_string();
    this.with_album(album, cx, move |me, a, cx| {
        let mut t = a.tracks.clone();
        t.sort_by_key(|x| (x.disc, x.number));
        let idx = t.iter().position(|x| x.id == track).unwrap_or(0);
        me.play_tracks(t, idx, false, cx);
        let _ = a2;
    });
}

fn outline<E: IntoElement + 'static>(on: bool) -> impl Fn(E) -> Div {
    move |d| { let w = div().rounded(px(12.)); if on { w.border_2().border_color(c(ACCENT)).child(d) } else { w.child(d) } }
}

enum Row { Empty(String, String), Top, Albums, Artists, Tracks, Space }

impl Rune {
    pub fn search_page(&mut self, q: String, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let _ = cw;
        let q = q.trim().to_string();
        if !self.search_input.read(cx).focus_handle(cx).is_focused(window) && self.search_input.read(cx).value().trim() != q { let v = q.clone(); self.search_input.update(cx, |s, cx| s.set_value(v, window, cx)); }
        self.ensure_search(&q, cx);
        let res = match self.data.search.get(&q).map(|c| c.slot.clone()) { Some(Slot::Ready(r)) => Some(r), _ => None };
        let mut rows = vec![];
        match (&res, q.is_empty()) {
            (_, true) => rows.push(Row::Empty("Search your library".into(), "Albums, artists and tracks \u{2014} local and Spotify together.".into())),
            (None, _) if matches!(self.data.search.get(&q).map(|c| &c.slot), Some(Slot::Err(_))) => rows.push(Row::Empty("Search failed".into(), "The rune server did not answer. Check that it is running, then search again.".into())),
            (None, _) => {}
            (Some(r), _) if r.albums.is_empty() && r.artists.is_empty() && r.tracks.is_empty() => rows.push(Row::Empty(format!("No results for \u{201c}{q}\u{201d}"), "Try a different spelling or fewer words.".into())),
            (Some(r), _) => {
                if top_of(&q, r).is_some() { rows.push(Row::Top); }
                if !r.albums.is_empty() { rows.push(Row::Albums); }
                if !r.artists.is_empty() { rows.push(Row::Artists); }
                if !tracks_of(r).is_empty() { rows.push(Row::Tracks); }
            }
        }
        rows.push(Row::Space);
        let n = rows.len();
        let pick = self.search_pick.unwrap_or(0);
        let picked = self.search_pick.is_some();
        let nav = res.as_ref().map(|r| nav_items(&q, r)).unwrap_or_default();
        let pick = pick.min(nav.len().saturating_sub(1));
        let active = if picked { nav.get(pick).cloned() } else { None };
        let key = format!("search:{q}");
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| {
            match &rows[ix] {
                Row::Empty(t, b) => padded(div().pt(px(28.)).child(empty(t, b))).into_any_element(),
                Row::Top => {
                    let r = res.clone().unwrap();
                    let top = top_of(&q, &r).unwrap();
                    let on = active == Some(Nav::Top);
                    let card = match top {
                        Top::Artist(a) => { let id = a.id.clone(); h_flex().id("top").items_center().gap(px(22.)).cursor_pointer().child(avatar(&a.id, &a.name, 112.))
                            .child(v_flex().flex_1().gap(px(4.)).child(eyebrow("Artist")).child(div().text_size(px(26.)).font_weight(w(700.)).line_height(px(30.)).child(a.name.clone())))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id.clone()), cx))).into_any_element() }
                        Top::Album(a) => {
                            let img = this.cover(&a.id, a.cover_url.as_deref(), 112., window);
                            let (id, pid) = (a.id.clone(), a.id.clone());
                            let fmt = if a.source == "spotify" { Some(("Spotify".to_string(), true)) } else { a.format.clone().map(|f| (f, false)) };
                            h_flex().id("top").items_center().gap(px(22.)).cursor_pointer().child(cover_el(img, &a.id, &a.title, 112., R))
                                .child(v_flex().flex_1().gap(px(4.)).child(eyebrow("Album")).child(div().text_size(px(26.)).font_weight(w(700.)).line_height(px(30.)).child(a.title.clone()))
                                    .child(h_flex().gap(px(6.)).items_center().text_size(px(14.)).text_color(c(TEXT2)).child(a.artist.name.clone()).children(a.year.map(|y| format!(" \u{b7} {y}"))).children(fmt.map(|(t, sp)| badge(&t, sp)))))
                                .child(div().id("top-play").child(btn("Play", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.play_album(&pid, false, 0, cx); })))
                                .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(id.clone()), cx))).into_any_element()
                        }
                    };
                    padded(div().pt(px(28.)).mb(px(44.)).child(section_head("Top result")).child(outline(on)(div().max_w(px(640.)).p(px(18.)).rounded(px(16.)).bg(surface()).border_1().border_color(line()).child(card)))).into_any_element()
                }
                Row::Albums => {
                    let r = res.clone().unwrap();
                    let mut row = h_flex().gap(px(20.)).items_start().h(px(170. + 64.));
                    for a in r.albums.iter() {
                        let on = active == Some(Nav::Album(a.id.clone()));
                        this.badges_always = true;
                        let card = this.album_card(a, 170., window, cx);
                        this.badges_always = false;
                        row = row.child(outline(on)(div().rounded(px(12.)).child(card)));
                    }
                    padded(div().mb(px(44.)).child(section_head("Albums")).child(div().w_full().overflow_hidden().child(row))).into_any_element()
                }
                Row::Artists => {
                    let r = res.clone().unwrap();
                    let mut row = h_flex().flex_wrap().gap(px(10.));
                    for a in r.artists.iter() {
                        let id = a.id.clone();
                        let on = active == Some(Nav::Artist(a.id.clone()));
                        row = row.child(outline(on)(v_flex().id(SharedString::from(format!("sar-{}", a.id))).w(px(120.)).flex_none().items_center().gap(px(4.)).py(px(10.)).px(px(6.)).rounded(px(14.)).cursor_pointer().hover(|s| s.bg(wh(0.05)))
                            .child(avatar(&a.id, &a.name, 96.).mb(px(8.))).child(div().max_w_full().truncate().text_size(px(14.)).font_weight(w(600.)).child(a.name.clone()))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id.clone()), cx)))));
                    }
                    padded(div().mb(px(44.)).child(section_head("Artists")).child(row)).into_any_element()
                }
                Row::Tracks => {
                    let r = res.clone().unwrap();
                    let mut list = v_flex().max_w(px(860.));
                    for (i, t) in tracks_of(&r).into_iter().enumerate() {
                        let title = r.albums.iter().find(|a| a.id == t.album_id).map(|a| a.title.clone()).unwrap_or_default();
                        let img = this.cover(&t.album_id, None, 44., window);
                        let on = active == Some(Nav::Track(t.album_id.clone(), t.id.clone()));
                        let (alb, tid) = (t.album_id.clone(), t.id.clone());
                        let menu = this.track_menu_ids(vec![t.id.clone()], t.title.clone(), Some(t.album_id.clone()), t.artists.first().map(|a| a.id.clone()), t.source == "spotify", t.id.clone());
                        let menu2 = menu.clone();
                        let group = SharedString::from(format!("sr-{i}"));
                        let fmt = if t.source == "spotify" { Some(("Spotify".to_string(), true)) } else { t.format.as_deref().map(|f| (f.to_uppercase(), false)) };
                        list = list.child(outline(on)(h_flex().id(group.clone()).group(group.clone()).h(px(60.)).px(px(8.)).gap(px(14.)).items_center().rounded(px(R)).cursor_pointer().hover(|s| s.bg(surface()))
                            .child(div().relative().child(cover_el(img, &t.album_id, &title, 44., R)).child(div().absolute().inset_0().rounded(px(R)).bg(bk(0.55)).flex().items_center().justify_center().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(icon("play", 16., c(TEXT)))))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(500.)).child(t.title.clone())).child(div().truncate().text_size(px(13.)).text_color(c(TEXT2)).child(t.artist_line())))
                            .children(fmt.map(|(x, sp)| badge(&x, sp)))
                            .child(div().w(px(52.)).text_right().text_size(px(13.)).text_color(c(TEXT3)).child(format_duration(t.duration_ms)))
                            .child(div().id(SharedString::from(format!("srm-{i}"))).role(Role::Button).aria_label("More actions").child(btn_icon("ellipsis", 18., c(TEXT2), false)).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = menu2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); })))
                            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
                            .on_click(cx.listener(move |this, _, _, cx| play_track(this, &alb, &tid, cx)))));
                    }
                    padded(div().mb(px(44.)).child(section_head("Tracks")).child(list)).into_any_element()
                }
                Row::Space => bottom_space(),
            }
        });
        self.list_page(key, 0, n, rowfn, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alb(id: &str) -> AlbumSummary { AlbumSummary { id: id.into(), ..Default::default() } }
    #[::core::prelude::v1::test]
    fn the_top_result_is_an_artist_that_starts_with_the_query_else_the_first_album() {
        let r = SearchResults { albums: vec![alb("a1")], artists: vec![ArtistRef { id: "x".into(), name: "Glass Animals".into() }], tracks: vec![] };
        assert!(matches!(top_of("glass", &r), Some(Top::Artist(_))));
        assert!(matches!(top_of("zzz", &r), Some(Top::Album(_))), "no artist starts with it: the first album");
    }
    #[::core::prelude::v1::test]
    fn keyboard_order_is_top_albums_artists_tracks() {
        let t = LibTrack { id: "t".into(), album_id: "a1".into(), source: "local".into(), ..Default::default() };
        let r = SearchResults { albums: vec![alb("a1")], artists: vec![ArtistRef { id: "x".into(), name: "X".into() }], tracks: vec![t] };
        assert_eq!(nav_items("q", &r), vec![Nav::Top, Nav::Album("a1".into()), Nav::Artist("x".into()), Nav::Track("a1".into(), "t".into())]);
    }
    #[::core::prelude::v1::test]
    fn local_tracks_come_before_spotify_ones_and_are_capped() {
        let mk = |i: usize, s: &str| LibTrack { id: format!("{s}{i}"), source: s.into(), ..Default::default() };
        let r = SearchResults { tracks: (0..10).map(|i| mk(i, "spotify")).chain((0..10).map(|i| mk(i, "local"))).collect(), ..Default::default() };
        let t = tracks_of(&r);
        assert_eq!(t.len(), 14);
        assert_eq!(t[0].source, "local");
        assert_eq!(t[8].source, "spotify");
    }
}
