//! Artists (web `pages/Artists.tsx`): one card per artist, derived from the album list.
use super::*;
use crate::data::{ArtistCard, Slot};

const MIN: f32 = 150.;
const GAP_X: f32 = 20.;
const GAP_Y: f32 = 30.;
const AVATAR_MAX: f32 = 132.;

/// The round initials avatar (`Avatar` in `album/Credits.tsx`; the photo from `/api/artist-image` is phase 5).
pub fn avatar(id: &str, name: &str, size: f32) -> Div {
    let (a, b) = tile_gradient(id);
    div().size(px(size)).flex_none().rounded_full().overflow_hidden().flex().items_center().justify_center().bg(linear_gradient(135., linear_color_stop(a, 0.), linear_color_stop(b, 1.)))
        .border_1().border_color(wh(0.14)).font_weight(w(600.)).text_color(wh(0.88)).text_size(px(size * 0.36)).child(crate::util::initials(name))
}

impl Rune {
    pub fn artists_page(&mut self, cw: f32, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_artist_cards(cx);
        let slot = self.data.artist_cards.as_ref().map(|c| c.slot.clone());
        let (list, loaded, err): (std::sync::Arc<Vec<ArtistCard>>, bool, bool) = match slot { Some(Slot::Ready(l)) => (l, true, false), Some(Slot::Err(_)) => (Default::default(), false, true), _ => (Default::default(), false, false) };
        let (cols, card_w) = grid_dims(cw, MIN, GAP_X, 1);
        let av = AVATAR_MAX.min(card_w);
        let row_h = av + 64. + GAP_Y;
        let rows = list.len().div_ceil(cols);
        let n = 1 + rows + 1;
        let sub = if loaded { plural(list.len(), "artist") } else { " ".into() };
        let row: RowFn = Box::new(move |this, ix, _w, cx| {
            if ix == 0 { return padded(page_head("Artists", &sub, None)).into_any_element(); }
            if err { return if ix == 1 { padded(empty("Could not load artists", "")).into_any_element() } else { bottom_space() }; }
            if ix > rows { return bottom_space(); }
            let start = (ix - 1) * cols;
            let mut r = h_flex().items_start().gap(px(GAP_X)).h(px(row_h));
            for a in list.iter().skip(start).take(cols) {
                let id = a.id.clone();
                r = r.child(v_flex().id(SharedString::from(format!("ac-{}", a.id))).w(px(card_w)).flex_none().items_center().gap(px(4.)).py(px(10.)).px(px(6.)).rounded(px(14.)).cursor_pointer().hover(|s| s.bg(wh(0.05)))
                    .child(avatar(&a.id, &a.name, av).mb(px(8.)))
                    .child(div().max_w_full().truncate().text_size(px(14.)).font_weight(w(600.)).child(a.name.clone()))
                    .child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(plural(a.n, "album")))
                    .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id.clone()), cx))));
            }
            let _ = this;
            padded(r).into_any_element()
        });
        self.list_page("artists".into(), (cols as u64) << 4, n, row, cx)
    }
}
