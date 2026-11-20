//! The artist page (web `pages/Artist.tsx`): hero, biography, albums, appears on, similar artists.
//! The MusicBrainz discography sections, the photo and the blurred cover mosaic are phase 5 / 6.
use super::*;
use super::artists::avatar;
use rune_mini_core::library::*;

enum Row { Hero, Bio, Head(&'static str), Cards(&'static str, usize), Similar, Space }
const BODY_MAX: f32 = 1240.;

impl Rune {
    pub fn artist_page(&mut self, id: String, cw: f32, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_artist(&id, cx);
        let artist = match self.data.artist.get(&id).map(|c| c.slot.clone()) {
            Some(crate::data::Slot::Ready(a)) => a,
            Some(crate::data::Slot::Err(_)) => return div().size_full().pt(px(28.)).px(px(PAD)).child(empty("Artist not found", "")).into_any_element(),
            _ => return div().size_full().pt(px(120.)).px(px(PAD)).child(div().h(px(40.)).w(px(300.)).rounded(px(6.)).bg(surface())).into_any_element(),
        };
        let body_w = cw.min(BODY_MAX);
        let (gap_x, gap_y) = (22., 24.);
        let (cols, card_w) = grid_dims(body_w, 170., gap_x, 2);
        let row_h = card_w + 52.15 + gap_y;
        let mut rows = vec![Row::Hero];
        rows.push(Row::Bio);
        for (name, list) in [("Albums", &artist.albums), ("Appears on", &artist.appears_on)] {
            if list.is_empty() { continue; }
            rows.push(Row::Head(name));
            for r in 0..list.len().div_ceil(cols) { rows.push(Row::Cards(name, r)); }
        }
        if !artist.similar.is_empty() { rows.push(Row::Head("Similar artists")); rows.push(Row::Similar); }
        rows.push(Row::Space);
        let n = rows.len();
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| match rows.get(ix) {
            Some(Row::Hero) => this.artist_hero(&artist, window, cx),
            Some(Row::Bio) if artist.bio.is_none() => abody(div().pt(px(28.)).child(h_flex().gap(px(11.)).py(px(12.)).pl(px(15.)).pr(px(18.)).items_center().rounded(px(R)).border_1().border_color(line()).bg(bk(0.42)).text_size(px(13.5)).text_color(c(TEXT2)).w_auto()
                .child(icon("book-open", 17., c(TEXT3))).child("No biography found for this artist.")), body_w),
            Some(Row::Bio) => {
                let b = artist.bio.clone().unwrap();
                abody(v_flex().pt(px(36.)).child(section_head("Biography")).child(v_flex().max_w(px(760.)).gap(px(8.))
                    .child(div().font_family(SERIF).text_size(px(17.)).line_height(px(27.)).max_h(px(27. * 6.)).overflow_hidden().text_color(c(TEXT2)).child(b.value))
                    .child(div().text_size(px(13.)).text_color(c(TEXT3)).child(format!("From {} \u{203a}", b.source)))), body_w)
            }
            Some(Row::Head(t)) => abody(div().pt(px(36.)).child(section_head(t)), body_w),
            Some(Row::Cards(name, r)) => {
                let list = if *name == "Albums" { &artist.albums } else { &artist.appears_on };
                abody(this.album_row(list, r * cols, list.len(), cols, card_w, gap_x, row_h, window, cx), body_w)
            }
            Some(Row::Similar) => abody(h_flex().flex_wrap().gap(px(10.)).children(artist.similar.iter().map(|s| {
                let sid = s.id.clone();
                h_flex().id(SharedString::from(format!("sim-{}", s.id))).h(px(40.)).pl(px(7.)).pr(px(14.)).gap(px(8.)).items_center().rounded_full().bg(wh(0.08)).cursor_pointer().text_size(px(14.)).hover(|st| st.bg(wh(0.14)))
                    .child(avatar(&s.id, &s.name, 26.)).child(s.name.clone()).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(sid.clone()), cx)))
            })), body_w),
            _ => bottom_space(),
        });
        self.list_page(format!("artist:{id}"), (cols as u64) << 8, n, rowfn, cx)
    }

    fn artist_hero(&mut self, a: &Artist, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let local = a.albums.iter().any(|x| x.source == "local");
        let ids: Vec<String> = a.albums.iter().filter(|x| !local || x.source == "local").map(|x| x.id.clone()).collect();
        let (i1, i2) = (ids.clone(), ids.clone());
        let aid = a.id.clone();
        let meta = format!("{}{}", plural(a.albums.len(), "album"), if a.appears_on.is_empty() { String::new() } else { format!(" \u{b7} appears on {}", a.appears_on.len()) });
        div().w_full().min_h(px(280.)).pt(px(72.)).pb(px(36.)).pl(px(PAD)).pr(px(PAD + SCROLLBAR)).flex().items_end().child(
            h_flex().w_full().items_center().gap(px(28.))
                .child(avatar(&a.id, &a.name, 96.).shadow(vec![BoxShadow { inset: false, color: bk(0.6), offset: point(px(0.), px(30.)), blur_radius: px(70.), spread_radius: px(-10.) }]))
                .child(v_flex().child(eyebrow("Artist"))
                    .child(div().mt(px(6.)).font_family(SERIF).text_size(px(62.)).line_height(px(66.)).font_weight(w(600.)).child(a.name.clone()))
                    .child(div().mt(px(8.)).text_size(px(14.5)).text_color(c(TEXT2)).child(meta))
                    .when(!ids.is_empty(), |d| d.child(h_flex().flex_wrap().gap(px(10.)).mt(px(8.))
                        .child(div().id("ar-play").child(btn("Play", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| this.play_albums(i1.clone(), false, cx))))
                        .child(div().id("ar-shuffle").child(btn("Shuffle", Some("shuffle"), false)).on_click(cx.listener(move |this, _, _, cx| this.play_albums(i2.clone(), true, cx))))
                        .when(local, |d| d.child(div().id("ar-more").child(btn_icon40("ellipsis")).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                            let p = ev.position();
                            this.open_menu(PopMenu { x: f32::from(p.x) - 20., y: f32::from(p.y) + 24., items: vec![PopItem { icon: "waves", label: "Start radio".into(), act: MenuAct::Radio { from: "artist", id: aid.clone() }, danger: false, chevron: false, dot: false, sub: false }], add_ids: vec![], add_label: String::new(), add_open: false, right_aligned: false, up: false }, cx);
                        }))))))
                )).into_any_element()
    }
}

fn abody(inner: impl IntoElement, body_w: f32) -> AnyElement {
    div().w_full().pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element()
}
