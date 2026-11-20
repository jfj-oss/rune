//! Genres (web `pages/Genres.tsx`): a grid of mosaic tiles, and one genre's albums.
use super::*;
use crate::data::Slot;
use crate::menu::{item, pop};
use gpui_kit::component::input::Input;
use rune_mini_core::library::GenreFacet;

const MIN: f32 = 190.;
const GAP_X: f32 = 22.;
const GAP_Y: f32 = 28.;
const GSORTS: [(&str, &str); 4] = [("artist", "Artist"), ("title", "Title"), ("year", "Year"), ("added", "Date added")];

impl Rune {
    fn genre_tile(&mut self, g: &GenreFacet, w_: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let ids: Vec<String> = g.cover_album_ids.iter().take(4).cloned().collect();
        let single = ids.len() == 1;
        let cs = if single { w_ } else { ((w_ - 2.) / 2.).floor() };
        let mut cellel = |this: &mut Rune, i: usize, window: &mut Window| -> Div {
            match ids.get(i) {
                Some(id) => { let im = this.cover(id, None, cs, window); match im { Some(i) => div().size(px(cs)).flex_none().child(img(ImageSource::Render(i)).size(px(cs)).object_fit(ObjectFit::Cover)), None => div().size(px(cs)).flex_none().bg(surface2()) } }
                None => { let (a, b) = tile_gradient(&format!("{}{i}", g.genre)); div().size(px(cs)).flex_none().opacity(0.45).bg(linear_gradient(135., linear_color_stop(a, 0.), linear_color_stop(b, 1.))) }
            }
        };
        let mosaic_base = v_flex().relative().size(px(w_)).gap(px(if single { 0. } else { 2. })).rounded(px(10.)).overflow_hidden().bg(surface2())
            .shadow(vec![BoxShadow { inset: false, color: bk(0.4), offset: point(px(0.), px(10.)), blur_radius: px(28.), spread_radius: px(0.) }]);
        let mosaic = if single { mosaic_base.child(cellel(self, 0, window)) } else {
            mosaic_base.child(h_flex().gap(px(2.)).child(cellel(self, 0, window)).child(cellel(self, 1, window))).child(h_flex().gap(px(2.)).child(cellel(self, 2, window)).child(cellel(self, 3, window)))
        };
        let name = g.genre.clone();
        v_flex().id(SharedString::from(format!("gt-{}", g.genre))).w(px(w_)).flex_none().gap(px(3.)).cursor_pointer()
            .child(mosaic)
            .child(div().mt(px(10.)).truncate().text_size(px(15.)).font_weight(w(600.)).child(g.genre.clone()))
            .child(div().text_size(px(13.)).text_color(c(TEXT3)).child(plural(g.album_count, "album")))
            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Genre(name.clone()), cx)))
            .into_any_element()
    }

    pub fn genres_page(&mut self, cw: f32, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_facets(cx);
        let slot = self.data.genres.as_ref().map(|c| c.slot.clone());
        let (all, loaded, err): (std::sync::Arc<Vec<GenreFacet>>, bool, bool) = match slot { Some(Slot::Ready(l)) => (l, true, false), Some(Slot::Err(_)) => (Default::default(), false, true), _ => (Default::default(), false, false) };
        let needle = fold(&self.genres_q);
        let list: Vec<GenreFacet> = all.iter().filter(|g| needle.is_empty() || fold(&g.genre).contains(&needle)).cloned().collect();
        let (cols, tile_w) = grid_dims(cw, MIN, GAP_X, 2);
        let rows = list.len().div_ceil(cols);
        let n = 2 + rows.max(usize::from(loaded && list.is_empty())) + 1;
        let sub = if loaded { plural(all.len(), "genre") } else { " ".into() };
        let find = self.genres_find.clone();
        let q = self.genres_q.clone();
        let qkey = !q.is_empty();
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            if ix == 0 { return padded(page_head("Genres", &sub, None)).into_any_element(); }
            if ix == 1 {
                return padded(h_flex().mb(px(22.)).child(h_flex().h(px(36.)).w(px(360.)).pl(px(14.)).pr(px(8.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3))
                    .child(icon("search", 15., c(TEXT3))).child(div().flex_1().min_w_0().text_size(px(14.)).child(Input::new(&find).appearance(false).cleanable(false))))).into_any_element();
            }
            if ix == n - 1 { return bottom_space(); }
            if err { return padded(empty("Could not load genres", "Is the rune server running?")).into_any_element(); }
            if !loaded { return padded(div().h(px(tile_w + 70.))).into_any_element(); }
            if list.is_empty() { return padded(empty("No genres here", if q.is_empty() { "Genres appear once albums have been tagged or matched." } else { "Nothing matches that filter." })).into_any_element(); }
            let start = (ix - 2) * cols;
            let mut r = h_flex().items_start().gap(px(GAP_X)).h(px(tile_w + 56. + GAP_Y));
            for g in list.iter().skip(start).take(cols) { r = r.child(this.genre_tile(g, tile_w, window, cx)); }
            padded(r).into_any_element()
        });
        self.list_page("genres".into(), ((cols as u64) << 4) | u64::from(qkey), n, row, cx)
    }

    pub fn genre_page(&mut self, genre: String, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let sort = match self.genre_sort { "title" => Sort::Title, "year" => Sort::Year, "added" => Sort::Added, _ => Sort::Artist };
        let q = AlbumsQ { genre: Some(genre.clone()), sort, ..Default::default() };
        self.ensure_albums(&q, false, cx);
        let key = q.key();
        let (items, total, loaded, err) = match self.data.albums.get(&key) { Some(l) => (l.items.clone(), l.total, l.loaded, l.error.clone()), None => (vec![], 0, false, None) };
        let (cols, card_w) = grid_dims(cw, 170., 22., 2);
        let rows = if loaded { total.div_ceil(cols) } else { 3 };
        let n = 2 + rows + 1;
        let cur = self.genre_sort;
        let sub = if loaded { plural(total, "album") } else { " ".into() };
        let gkey = format!("genre:{genre}:{cur}");
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            if ix == 0 {
                return padded(v_flex().pt(px(22.))
                    .child(h_flex().id("gp-back").gap(px(2.)).items_center().mb(px(14.)).ml(px(-4.)).text_size(px(13.5)).font_weight(w(600.)).text_color(c(TEXT2)).cursor_pointer().hover(|s| s.text_color(c(TEXT)))
                        .child(icon("chevron-left", 15., c(TEXT2))).child("Genres").on_click(cx.listener(|this, _, _, cx| this.go(Route::Genres, cx))))
                    .child(eyebrow("Genre"))
                    .child(div().font_family(SERIF).text_size(px(37.)).line_height(px(41.)).font_weight(w(600.)).child(genre.clone()))
                    .child(div().mt(px(4.)).mb(px(20.)).min_h(px(20.)).text_size(px(14.)).text_color(c(TEXT3)).child(sub.clone()))).into_any_element();
            }
            if ix == 1 {
                let label = GSORTS.iter().find(|s| s.0 == cur).map(|s| s.1).unwrap_or("Artist");
                return padded(h_flex().mb(px(22.)).child(div().flex_1()).child(h_flex().id("gp-sort").h(px(36.)).pl(px(14.)).pr(px(10.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).cursor_pointer().text_size(px(13.))
                    .child(div().text_color(c(TEXT3)).child("Sort")).child(div().font_weight(w(500.)).text_color(c(TEXT)).child(label)).child(icon("chevron-down", 12., c(TEXT2)))
                    .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                        let p = ev.position();
                        let items = GSORTS.iter().map(|s| item(if s.0 == cur { "check" } else { "arrow-down-up" }, s.1, MenuAct::GenreSort(s.0))).collect();
                        this.open_menu(pop(f32::from(p.x) - 60., f32::from(p.y) + 22., items), cx);
                    })))).into_any_element();
            }
            if ix == n - 1 { return bottom_space(); }
            if let Some(e) = &err { if !loaded { return padded(empty("Could not load this genre", e)).into_any_element(); } }
            if loaded && total == 0 { return padded(empty("No albums in this genre", "")).into_any_element(); }
            if !loaded { return padded(h_flex().gap(px(22.)).h(px(card_w + 86.)).children((0..cols).map(|_| skeleton_card(card_w)))).into_any_element(); }
            let r = ix - 2;
            if (r + 3) * cols >= items.len() { this.ensure_albums(&q, true, cx); }
            padded(this.album_row(&items, r * cols, total, cols, card_w, 22., card_w + 86., window, cx)).into_any_element()
        });
        self.list_page(gkey, (cols as u64) << 2, n, row, cx)
    }
}
