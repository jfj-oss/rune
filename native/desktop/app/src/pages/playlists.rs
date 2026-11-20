//! Playlists (web `pages/Playlists.tsx`): rune's own, then the ones synced from Spotify.
use super::*;
use crate::data::Slot;
use rune_mini_core::library::*;

pub fn playlist_cover(this: &mut Rune, p: &PlaylistSummary, size: f32, window: &mut Window, cx: &mut Context<Rune>) -> Div {
    let base = div().relative().size(px(size)).flex_none().rounded(px(R)).overflow_hidden();
    // the two wave playlists wear the generative wave instead of a picture (animated at card size and up)
    if let Some((kind, seed)) = crate::gen::playlist_art(&p.id).filter(|_| crate::gen::usable()) {
        let art = this.art(&format!("plcover:{}:{}", p.id, size as i32), crate::gen::Mode::Cover { radius: R }, kind, seed, cx);
        return base.bg(black()).child(div().absolute().top_0().left_0().size_full().child(art));
    }
    if p.cover_album_ids.is_empty() {
        let (a, b) = tile_gradient(&p.id);
        let liked = p.id == LIKED_PLAYLIST_ID;
        return base.flex().items_center().justify_center().bg(linear_gradient(135., linear_color_stop(a, 0.), linear_color_stop(b, 1.)))
            .child(icon(if liked { "heart" } else { "list-music" }, (size * 0.24).clamp(16., 96.), wh(0.8)));
    }
    let ids = &p.cover_album_ids;
    let cells: Vec<String> = if ids.len() == 1 { vec![ids[0].clone()] } else { (0..4).map(|i| ids[i % ids.len()].clone()).collect() };
    let cs = if cells.len() == 1 { size } else { size / 2. };
    let mut grid = div().absolute().inset_0().flex().flex_wrap().bg(surface2());
    for id in cells {
        let im = this.cover(&id, None, cs, window);
        grid = grid.child(match im { Some(i) => div().size(px(cs)).child(img(ImageSource::Render(i)).size(px(cs)).object_fit(ObjectFit::Cover)), None => div().size(px(cs)) });
    }
    base.bg(surface2()).child(grid)
}

impl Rune {
    fn playlist_card(&mut self, p: &PlaylistSummary, card_w: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let id = p.id.clone();
        let (id2, id3) = (id.clone(), id.clone());
        let group = SharedString::from(format!("plc-{id}"));
        let cover = playlist_cover(self, p, card_w, window, cx);
        let spotify = !p.is_rune();
        let sub = format!("{}{}", p.owner.as_ref().map(|o| format!("{o} \u{b7} ")).unwrap_or_default(), plural(p.track_count, "track"));
        v_flex().w(px(card_w)).flex_none().min_w_0()
            .child(div().id(group.clone()).group(group.clone()).relative().w(px(card_w)).h(px(card_w)).rounded(px(R)).cursor_pointer()
                .shadow(vec![BoxShadow { inset: false, color: bk(0.4), offset: point(px(0.), px(8.)), blur_radius: px(22.), spread_radius: px(0.) }])
                .child(cover)
                .when(spotify, |d| d.child(div().absolute().left(px(8.)).bottom(px(8.)).child(badge("Spotify", true))))
                .when(p.is_smart(), |d| d.child(div().absolute().left(px(8.)).bottom(px(8.)).child(badge("Smart", false))))
                .when(p.pinned, |d| d.child(div().absolute().top(px(8.)).right(px(8.)).size(px(22.)).rounded_full().bg(ca(0x0c0c10, 0.78)).border_1().border_color(wh(0.14)).flex().items_center().justify_center().child(icon("pin", 11., c(TEXT)))))
                .child(div().id(SharedString::from(format!("plp-{id}"))).absolute().right(px(8.)).bottom(px(8.)).size(px(42.)).rounded_full().bg(c(ACCENT)).hover(|s| s.bg(c(ACCENT2))).flex().items_center().justify_center()
                    .opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).child(icon("play", 18., c(0x12101f)))
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.play_playlist(&id2, false, 0, cx); })))
                .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Playlist(id3.clone()), cx))))
            .child(div().mt(px(11.)).truncate().text_size(px(14.)).font_weight(w(600.)).child(p.name.clone()))
            .child(div().mt(px(2.)).truncate().text_size(px(13.)).text_color(c(TEXT2)).child(sub))
            .into_any_element()
    }

    pub fn playlists_page(&mut self, find: String, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_playlists(cx);
        let focused = self.playlists_find.read(cx).focus_handle(cx).is_focused(window);
        if !focused && self.playlists_find.read(cx).value().trim() != find { let v = find.clone(); self.playlists_find.update(cx, |s, cx| s.set_value(v, window, cx)); }
        let slot = self.data.playlists.as_ref().map(|c| c.slot.clone());
        let (all, loaded, err): (std::sync::Arc<Vec<PlaylistSummary>>, bool, bool) = match slot { Some(Slot::Ready(l)) => (l, true, false), Some(Slot::Err(_)) => (Default::default(), false, true), _ => (Default::default(), false, false) };
        let needle = fold(&find);
        let shown: Vec<PlaylistSummary> = all.iter().filter(|p| needle.is_empty() || fold(&format!("{} {}", p.name, p.owner.clone().unwrap_or_default())).contains(&needle)).cloned().collect();
        let pinned_first = |mut v: Vec<PlaylistSummary>| { v.sort_by_key(|p| !p.pinned); v };
        let mine = pinned_first(shown.iter().filter(|p| p.is_rune()).cloned().collect());
        let mut spot: Vec<PlaylistSummary> = shown.iter().filter(|p| !p.is_rune()).cloned().collect();
        spot.sort_by_key(|p| p.id != LIKED_PLAYLIST_ID);
        let spot = pinned_first(spot);
        let (cols, card_w) = grid_dims(cw, 170., 22., 1);
        let row_h = card_w + 52.15 + 24.;
        enum R_ { Head, Toolbar, Section(&'static str), Cards(bool, usize), Empty, Space }
        let mut rows = vec![R_::Head];
        if !all.is_empty() { rows.push(R_::Toolbar); }
        if loaded {
            if !needle.is_empty() && shown.is_empty() { rows.push(R_::Empty); }
            if needle.is_empty() && mine.is_empty() { rows.push(R_::Empty); }
            if !mine.is_empty() { rows.push(R_::Section("Your playlists")); for r in 0..mine.len().div_ceil(cols) { rows.push(R_::Cards(true, r)); } }
            if !spot.is_empty() { rows.push(R_::Section("From Spotify")); for r in 0..spot.len().div_ceil(cols) { rows.push(R_::Cards(false, r)); } }
        }
        rows.push(R_::Space);
        let n = rows.len();
        let sub = if !loaded { " ".to_string() } else if !needle.is_empty() { format!("{} of {}", shown.len(), plural(all.len(), "playlist")) } else { plural(all.len(), "playlist") };
        let find_in = self.playlists_find.clone();
        let find2 = find.clone();
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            R_::Head => padded(page_head("Playlists", &sub, Some(h_flex().gap(px(8.)).child(div().id("pl-import").child(btn("Import", Some("upload"), false)).on_click(cx.listener(|this, _, _, cx| this.import_m3u8(None, cx)))).child(div().id("pl-new").child(btn("New playlist", Some("plus"), true)).on_click(cx.listener(|this, _, window, cx| this.open_new_playlist(vec![], window, cx)))).into_any_element()))).into_any_element(),
            R_::Toolbar => padded(div().mb(px(22.)).child(this.find_box(&find_in))).into_any_element(),
            R_::Section(t) => padded(div().pt(px(8.)).child(section_head(t))).into_any_element(),
            R_::Cards(is_mine, r) => {
                let list = if *is_mine { &mine } else { &spot };
                let mut row = h_flex().items_start().gap(px(22.)).h(px(row_h));
                for p in list.iter().skip(r * cols).take(cols) { row = row.child(this.playlist_card(p, card_w, window, cx)); }
                padded(row).into_any_element()
            }
            R_::Empty => padded(if !find2.is_empty() { empty("No playlists match", &format!("Nothing is called \u{201c}{find2}\u{201d}.")) } else if err { fail(cx, "Could not load playlists", "Is the rune server running?") } else { empty("Make your first playlist", "Playlists in rune can mix local files and Spotify tracks. Create one here, or use \u{201c}Add to playlist\u{201d} on any track or album.") }).into_any_element(),
            R_::Space => bottom_space(),
        });
        self.list_page("playlists".into(), (cols as u64) << 4, n, rowfn, cx)
    }
}
