//! The pages (web `pages/*`). A page is a list of rows drawn through GPUI's virtual `list`, so only what is on screen is laid
//! out, and the page's scroll position is kept while the app runs.
pub mod album;
pub mod albums;
pub mod artist;
pub mod artists;
pub mod genres;
pub mod home;
pub mod tracks;
pub mod playlist;
pub mod playlists;
pub mod search;
pub mod soon;

use crate::rune::*;
use crate::route::*;
use crate::theme::*;
use crate::util::*;
use crate::widgets::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::library::AlbumSummary;
use std::sync::Arc;

/// The width of the content column of a page: the window minus the sidebar, the page padding and the scrollbar.
pub fn content_w(col_w: f32) -> f32 { (col_w - 2. * PAD - SCROLLBAR).max(200.) }

/// Cards per row and the card width of the web's `auto-fill, minmax(min, 1fr)` grid.
pub fn grid_dims(cw: f32, min: f32, gap: f32, min_cols: usize) -> (usize, f32) {
    let cols = (((cw + gap) / (min + gap)).floor() as usize).max(min_cols);
    (cols, (cw - gap * (cols as f32 - 1.)) / cols as f32)
}

pub type RowFn = Box<dyn Fn(&mut Rune, usize, &mut Window, &mut Context<Rune>) -> AnyElement>;

impl Rune {
    /// The page for the current route, filling the column below the top bar.
    pub fn page(&mut self, col_w: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let route = self.route().clone();
        let cw = content_w(col_w);
        match route {
            Route::Albums(q) => self.albums_page(q, cw, window, cx),
            Route::Album(id) => self.album_page(id, cw, window, cx),
            Route::Artists => self.artists_page(cw, window, cx),
            Route::Artist(id) => self.artist_page(id, cw, window, cx),
            Route::Playlists(q) => self.playlists_page(q, cw, window, cx),
            Route::Playlist(id) => self.playlist_page(id, cw, window, cx),
            Route::Search(q) => self.search_page(q, cw, window, cx),
            Route::Home => self.home_page(cw, window, cx),
            Route::Tracks => self.tracks_page(cw, window, cx),
            Route::Genres => self.genres_page(cw, window, cx),
            Route::Genre(g) => self.genre_page(g, cw, window, cx),
            r => self.soon_page(r, cx),
        }
    }

    /// A virtualised page: `count` rows drawn by `row`. `sig` changes when the rows' layout changes (columns), which
    /// re-measures them; the scroll position is kept per route.
    pub fn list_page(&mut self, key: String, sig: u64, count: usize, row: RowFn, cx: &mut Context<Self>) -> AnyElement {
        let sigkey = format!("{key}#sig");
        let st = match self.lists.get(&key) {
            Some(s) => {
                let old_sig = self.list_sigs.get(&sigkey).copied().unwrap_or(sig);
                if old_sig != sig { s.reset(count); }
                else if s.item_count() != count {
                    let old = s.item_count();
                    if count > old { s.splice(old..old, count - old); } else { s.splice(count..old, 0); }
                }
                s.clone()
            }
            None => { let s = ListState::new(count, ListAlignment::Top, px(600.)); self.lists.insert(key.clone(), s.clone()); s }
        };
        self.list_sigs.insert(sigkey, sig);
        let row = Arc::new(row);
        list(st.clone(), cx.processor(move |this: &mut Rune, ix: usize, window, cx| row(this, ix, window, cx))).size_full().into_any_element()
    }

    /// The row of an album card grid: `cols` cards starting at `start`.
    pub fn album_row(&mut self, items: &[AlbumSummary], start: usize, total: usize, cols: usize, card_w: f32, gap: f32, row_h: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut row = h_flex().items_start().gap(px(gap)).h(px(row_h));
        for c_ix in 0..cols {
            let ix = start + c_ix;
            if ix >= total { break; }
            row = match items.get(ix) { Some(a) => row.child(self.album_card(a, card_w, window, cx)), None => row.child(skeleton_card(card_w)) };
        }
        row.into_any_element()
    }

    pub fn album_card(&mut self, a: &AlbumSummary, w_: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let img = self.cover(&a.id, a.cover_url.as_deref(), w_, window);
        let (id, aid) = (a.id.clone(), a.artist.id.clone());
        let id2 = id.clone();
        let group = SharedString::from(format!("card-{id}"));
        let always = self.badges_always;
        let fmt = if a.source == "spotify" { Some(("Spotify".to_string(), true)) } else { a.format.clone().map(|f| (f, false)) };
        v_flex().w(px(w_)).flex_none().min_w_0()
            .child(div().id(group.clone()).group(group.clone()).relative().w(px(w_)).h(px(w_)).rounded(px(R)).cursor_pointer()
                .shadow(vec![BoxShadow { inset: false, color: bk(0.4), offset: point(px(0.), px(8.)), blur_radius: px(22.), spread_radius: px(0.) }])
                .child(cover_el(img, &a.id, &a.title, w_, R))
                .when_some(fmt, |d, (t, sp)| d.child(div().absolute().left(px(8.)).bottom(px(8.)).opacity(if always { 1. } else { 0. }).group_hover(group.clone(), |s| s.opacity(1.)).child(badge(&t, sp))))
                .when(a.pinned, |d| d.child(div().absolute().top(px(8.)).right(px(8.)).size(px(22.)).rounded_full().bg(ca(0x0c0c10, 0.78)).border_1().border_color(wh(0.14)).flex().items_center().justify_center().child(icon("pin", 11., c(TEXT)))))
                .child(div().id(SharedString::from(format!("play-{id}"))).absolute().right(px(8.)).bottom(px(8.)).size(px(42.)).rounded_full().bg(c(ACCENT)).hover(|s| s.bg(c(ACCENT2))).flex().items_center().justify_center()
                    .opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(icon("play", 18., c(0x12101f)))
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.play_album(&id2, false, 0, cx); })))
                .on_click(cx.listener({ let id = id.clone(); move |this, _, _, cx| this.go(Route::Album(id.clone()), cx) })))
            .child(div().id(SharedString::from(format!("ct-{id}"))).mt(px(11.)).truncate().text_size(px(14.)).font_weight(w(600.)).cursor_pointer().hover(|s| s.underline()).child(a.title.clone())
                .on_click(cx.listener({ let id = id.clone(); move |this, _, _, cx| this.go(Route::Album(id.clone()), cx) })))
            .child(h_flex().mt(px(2.)).text_size(px(13.)).min_w_0().overflow_hidden().whitespace_nowrap()
                .child(div().id(SharedString::from(format!("ca-{id}"))).flex_shrink(1.).min_w_0().truncate().text_color(c(TEXT2)).cursor_pointer().hover(|s| s.text_color(c(TEXT)).underline()).child(a.artist.name.clone())
                    .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(aid.clone()), cx))))
                .when_some(a.year, |d, y| d.child(div().flex_none().text_color(c(TEXT3)).child(format!(" \u{b7} {y}")))))
            .into_any_element()
    }
}

pub fn skeleton_card(w_: f32) -> AnyElement {
    v_flex().w(px(w_)).flex_none().child(div().size(px(w_)).rounded(px(R)).bg(surface()))
        .child(div().mt(px(10.)).h(px(12.)).w_full().rounded(px(6.)).bg(surface()))
        .child(div().mt(px(10.)).h(px(12.)).w(relative(0.6)).rounded(px(6.)).bg(surface())).into_any_element()
}

/// The page padding around a row: left PAD, right PAD plus the scrollbar (the web's `.page` inside a scrolling `main`).
pub fn padded(inner: impl IntoElement) -> Div {
    div().w_full().pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(inner)
}

pub fn page_head(title: &str, sub: &str, actions: Option<AnyElement>) -> Div {
    h_flex().items_end().justify_between().pt(px(28.)).mb(px(20.))
        .child(v_flex().child(page_title(title)).child(div().mt(px(4.)).min_h(px(20.)).text_size(px(14.)).text_color(c(TEXT3)).child(sub.to_string())))
        .children(actions)
}

pub fn bottom_space() -> AnyElement { div().h(px(NPBAR_H + 56.)).into_any_element() }

#[allow(dead_code)]
pub fn count_label(n: usize, what: &str) -> String { plural(n, what) }

/// Albums from a cached JSON `{items,total}` (or a bare list of `{albumId}` is handled by the caller).
pub fn albums_of(slot: &crate::data::Slot<serde_json::Value>) -> Option<rune_mini_core::library::Page<AlbumSummary>> {
    slot.ready().and_then(|v| serde_json::from_value((**v).clone()).ok())
}

impl Rune {
    /// A horizontal scroller (the web's `HScroll`): the track scrolls by wheel or drag, arrows appear on hover.
    pub fn hscroll(&mut self, key: &str, cards: Vec<AnyElement>, cx: &mut Context<Self>) -> AnyElement {
        let handle = self.hscrolls.entry(key.to_string()).or_default().clone();
        let group = SharedString::from(format!("hs-{key}"));
        let (h1, h2) = (handle.clone(), handle.clone());
        let arrow = |id: String, left: bool, h: ScrollHandle, cx: &mut Context<Self>| {
            let mut d = div().id(SharedString::from(id)).absolute().top(px(70.)).size(px(40.)).rounded_full().bg(ca(0x14151c, 0.9)).border_1().border_color(wh(0.14)).flex().items_center().justify_center().cursor_pointer()
                .opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).hover(|s| s.bg(ca(0x23242e, 0.95))).child(icon(if left { "chevron-left" } else { "chevron-right" }, 18., c(TEXT)));
            d = if left { d.left(px(PAD - 14.)) } else { d.right(px(PAD - 14.)) };
            d.on_click(cx.listener(move |_, _, _, cx| {
                let mut o = h.offset();
                let step = f32::from(h.bounds().size.width).max(300.) * 0.8;
                o.x = (o.x + px(if left { step } else { -step })).min(px(0.)).max(-h.max_offset().x);
                h.set_offset(o);
                cx.notify();
            }))
        };
        div().relative().group(group.clone()).w_full().child(
            div().id(SharedString::from(format!("hst-{key}"))).track_scroll(&handle).overflow_x_scroll().w_full().pl(px(PAD)).pr(px(PAD)).pt(px(4.)).pb(px(8.))
                .child(h_flex().gap(px(20.)).children(cards)))
            .child(arrow(format!("hsl-{key}"), true, h1, cx)).child(arrow(format!("hsr-{key}"), false, h2, cx)).into_any_element()
    }
}

/// The web's `.sechead` with an optional "See all" link.
pub fn sec_head(title: &str, see_all: Option<AnyElement>) -> Div {
    h_flex().w_full().justify_between().items_baseline().mb(px(14.)).pb(px(10.)).border_b_1().border_color(wh(0.07)).child(eyebrow(title)).children(see_all)
}
