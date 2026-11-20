//! The album page (web `pages/Album.tsx` + `album/TrackList.tsx`): hero, tab strip, track list, more by the artist.
//! Phase 1 has the Tracks section; Review, About, Credits and Fix match are phase 3 (PORT-PLAN.md).
use super::*;
use crate::actions::album_track_ids;
use rune_mini_core::library::*;
use crate::pages::album_sections::*;
use serde_json::Value;

#[derive(Clone)]
enum Row { Banner, Hero, Tabs, TracksHead, Disc(u32, bool), Track(usize), Sec(&'static str), ReviewLoading, Review, AboutMeta, AboutSub(&'static str), Notes, Background, Credits, Plays, ConnHead, Conn(usize), MoreHead, More(usize), Space }

const BODY_MAX: f32 = 1240.;

impl Rune {
    pub fn album_page(&mut self, id: String, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_album(&id, cx);
        let slot = self.data.album.get(&id).map(|c| c.slot.clone());
        let album = match slot {
            Some(crate::data::Slot::Ready(a)) => a,
            Some(crate::data::Slot::Err(_)) => return div().size_full().pt(px(28.)).px(px(PAD)).child(empty("Album not found", "It may have been removed from the library.")).into_any_element(),
            _ => return div().size_full().child(div().pt(px(44.)).px(px(PAD)).child(h_flex().gap(px(40.)).child(div().size(px(300.)).rounded(px(6.)).bg(surface()))
                .child(v_flex().gap(px(12.)).child(div().h(px(14.)).w(px(80.)).rounded(px(6.)).bg(surface())).child(div().h(px(40.)).w(px(360.)).rounded(px(6.)).bg(surface()))))).into_any_element(),
        };
        self.ensure_artist(&album.summary.artist.id, cx);
        let ex = self.album_extra(&id, cx);
        let more: Vec<AlbumSummary> = self.data.artist.get(&album.summary.artist.id).and_then(|c| c.slot.ready()).map(|a| a.albums.iter().filter(|x| x.id != album.summary.id).cloned().collect()).unwrap_or_default();
        let ids = album_track_ids(&album);
        let mut tracks: Vec<&LibTrack> = album.tracks.iter().collect();
        tracks.sort_by_key(|t| (t.disc, t.number));
        let multi = tracks.iter().map(|t| t.disc).collect::<std::collections::HashSet<_>>().len() > 1;
        let body_w = cw.min(BODY_MAX);
        let (card_w, gap) = (170., 20.);
        let more_n = ((body_w + gap) / (card_w + gap)).floor().max(1.) as usize;

        // what the sections have to show
        let d = ex.details.clone();
        let has_review = d.as_ref().is_some_and(|d| d.reception.is_some() || !d.scores.is_empty() || !d.quotes.is_empty());
        let ed_has = ex.editions.as_ref().is_some_and(|e| {
            let n = |k: &str| e.get(k).and_then(|x| x.as_array()).is_some_and(|a| !a.is_empty());
            e.get("originalReleaseDate").and_then(|x| x.as_str()).is_some() || e.get("releaseGroupType").and_then(|x| x.as_str()).is_some() || n("secondaryTypes") || n("editions") || n("otherVersionsInLibrary")
        });
        let has_notes = d.as_ref().is_some_and(|d| !d.artist_notes.is_empty());
        let has_bg = d.as_ref().is_some_and(|d| d.background.is_some());
        let has_about = has_notes || has_bg || ed_has;
        let has_credits = !album.credits.is_empty();
        let conns: Vec<Value> = ex.connections.as_ref().and_then(|v| v.get("connections")).and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let (cols_c, _) = grid_dims(body_w, 170., 20., 1);
        let low_conf = album.summary.source == "local" && album.match_confidence.is_some_and(|c| c < 0.7);

        let mut rows: Vec<Row> = vec![];
        let mut tabs: Vec<(&'static str, usize)> = vec![];
        if low_conf { rows.push(Row::Banner); }
        rows.push(Row::Hero);
        rows.push(Row::Tabs);
        tabs.push(("Tracks", rows.len()));
        rows.push(Row::TracksHead);
        let mut last = 0;
        for (i, t) in tracks.iter().enumerate() {
            if multi && t.disc != last { rows.push(Row::Disc(t.disc, i == 0)); last = t.disc; }
            rows.push(Row::Track(i));
        }
        if ex.details_loading { tabs.push(("Review", rows.len())); rows.push(Row::Sec("Critical reception")); rows.push(Row::ReviewLoading); }
        else if has_review { tabs.push(("Review", rows.len())); rows.push(Row::Sec("Critical reception")); rows.push(Row::Review); }
        if has_about {
            tabs.push(("About", rows.len()));
            rows.push(Row::Sec("About"));
            if ed_has { rows.push(Row::AboutMeta); }
            if has_notes { rows.push(Row::AboutSub("In the artist\u{2019}s words")); rows.push(Row::Notes); }
            if has_bg { rows.push(Row::AboutSub("Background")); rows.push(Row::Background); }
        }
        if has_credits { tabs.push(("Credits", rows.len())); rows.push(Row::Sec("Credits")); rows.push(Row::Credits); }
        rows.push(Row::Sec("Your plays")); rows.push(Row::Plays);
        if !conns.is_empty() { rows.push(Row::ConnHead); for r in 0..conns.len().div_ceil(cols_c) { rows.push(Row::Conn(r)); } }
        if !more.is_empty() { rows.push(Row::Sec("More by")); rows.push(Row::More(0)); }
        rows.push(Row::Space);

        let order: Vec<LibTrack> = tracks.into_iter().cloned().collect();
        let n = rows.len();
        let key = format!("album:{id}");
        let tabs2 = tabs.clone();
        let active0 = self.album_active_tab(&key, &tabs);
        let key2 = key.clone();
        let album2 = album.clone();
        let rowfn: RowFn = Box::new(move |this, ix, window, cx| {
            let Some(r) = rows.get(ix).cloned() else { return div().into_any_element() };
            let album = album2.clone();
            match r {
                Row::Banner => div().w_full().flex().items_center().gap(px(12.)).px(px(PAD)).py(px(12.)).bg(ca(WARN, 0.17)).border_b_1().border_color(ca(WARN, 0.4)).text_size(px(14.)).text_color(c(0xf3d38f))
                    .child(icon("triangle-alert", 18., c(WARN))).child("This album may be matched wrongly.")
                    .child({ let id = album.summary.id.clone(); div().id("fix-banner").ml(px(4.)).px(px(14.)).py(px(5.)).rounded_full().bg(c(WARN)).text_color(c(0x1a1306)).text_size(px(13.)).font_weight(w(700.)).cursor_pointer().child("Fix match").on_click(cx.listener(move |this, _, _, cx| this.run_menu_act(MenuAct::FixMatch(id.clone()), cx))) }).into_any_element(),
                Row::Hero => this.album_hero(&album, &ids, d.as_deref(), cw, window, cx),
                Row::Tabs => full(this.tab_strip(&key2, &tabs2, active0, cx), body_w),
                Row::TracksHead => full(div().pt(px(36.)).child(section_head("Tracks")), body_w),
                Row::Disc(d_, first) => full(div().pt(px(if first { 4. } else { 18. })).pb(px(8.)).px(px(8.)).text_size(px(12.5)).font_weight(w(600.)).text_color(c(TEXT3)).child(format!("DISC {d_}")), body_w),
                Row::Track(i) => { let t = order[i].clone(); full(this.track_row(&album, &t, i, &ids, &order, window, cx), body_w) }
                Row::Sec(t) => full(div().pt(px(36.)).child(section_head(&if t == "More by" { format!("More by {}", album.summary.artist.name) } else { t.to_string() })), body_w),
                Row::ReviewLoading => full(v_flex().gap(px(10.)).child(div().text_size(px(13.5)).text_color(c(TEXT3)).child("Looking up reviews\u{2026}")).children([1., 0.92, 0.78, 0.86].map(|f| div().h(px(14.)).w(relative(f)).rounded(px(6.)).bg(surface()))), body_w),
                Row::Review => match &d { Some(dd) => full(this.review_section(dd, body_w, cx), body_w), None => div().into_any_element() },
                Row::AboutMeta => match &ex.editions { Some(e) => { let e = e.clone(); match this.about_meta(&e, body_w, window, cx) { Some(el) => full(el, body_w), None => div().into_any_element() } } None => div().into_any_element() },
                Row::AboutSub(t) => full(div().pt(px(30.)).pb(px(12.)).child(eyebrow(t)), body_w),
                Row::Notes => match &d { Some(dd) => full(this.artist_notes(&dd.artist_notes, &album, body_w, cx), body_w), None => div().into_any_element() },
                Row::Background => match d.as_ref().and_then(|dd| dd.background.clone()) {
                    Some(bg) => full(v_flex().child(this.prose("background", &bg.value, 9, body_w, cx)).child(crate::pages::album_sections::source_line(this, "src-bg", &bg.source, crate::preview::text_preview("Background", "Background", &bg), cx)), body_w),
                    None => div().into_any_element() },
                Row::Credits => full(this.credits_section(&album, body_w, window, cx), body_w),
                Row::Plays => full(this.plays_section(ex.plays.as_deref(), ex.plays_loading, body_w), body_w),
                Row::ConnHead => full(v_flex().pt(px(36.)).child(sec_head("Connections", Some(div().text_size(px(12.)).text_color(c(TEXT3)).child(conns.len().to_string()).into_any_element()))).child(div().text_size(px(13.5)).text_color(c(TEXT3)).mb(px(14.)).child("Other albums in your library that share people with this one.")), body_w),
                Row::Conn(ri) => { let v = serde_json::json!({"connections": conns.iter().skip(ri * cols_c).take(cols_c).cloned().collect::<Vec<_>>()}); let els = this.connections_rows(&v, body_w, window, cx); full(v_flex().children(els), body_w) }
                Row::More(_) => {
                    let mut row = h_flex().gap(px(gap)).h(px(card_w + 64.)).items_start();
                    for a in more.iter().take(more_n) { row = row.child(this.album_card(a, card_w, window, cx)); }
                    full(row, body_w)
                }
                Row::MoreHead => div().into_any_element(),
                Row::Space => bottom_space(),
            }
        });
        let list = self.list_page(key.clone(), ((cw as u64) << 8) | u64::from(ex.details.is_some()) | (n as u64) << 40, n, rowfn, cx);
        // the strip sticks to the top once the hero has scrolled past; scroll-spy follows the list position
        let st = self.lists.get(&key).cloned();
        let me = cx.entity();
        if let Some(st) = &st { st.set_scroll_handler(move |_, _, app| { me.update(app, |_, cx| cx.notify()); }); }
        let stuck = st.as_ref().is_some_and(|s| { let t = s.logical_scroll_top(); t.item_ix > 1 || (t.item_ix == 1 && f32::from(t.offset_in_item) > 0.) });
        let active = self.album_active_tab(&key, &tabs);
        let overlay = stuck.then(|| div().absolute().top_0().left_0().right_0().bg(ca(BG, 0.94)).border_b_1().border_color(wh(0.07)).pl(px(PAD)).pr(px(PAD)).child(div().w(px(body_w)).max_w_full().mx_auto().child(self.tab_strip(&key, &tabs, active, cx))));
        div().relative().size_full().child(list).children(overlay).into_any_element()
    }

    /// The tab whose section the top of the page is in (scroll-spy).
    fn album_active_tab(&self, key: &str, tabs: &[(&'static str, usize)]) -> usize {
        let top = self.lists.get(key).map(|s| s.logical_scroll_top().item_ix).unwrap_or(0);
        tabs.iter().rposition(|(_, row)| *row <= top + 1).unwrap_or(0)
    }

    fn tab_strip(&mut self, key: &str, tabs: &[(&'static str, usize)], active: usize, cx: &mut Context<Self>) -> Div {
        let mut strip = h_flex().h(px(52.)).items_end().gap(px(0.));
        for (i, (label, row)) in tabs.iter().enumerate() {
            let on = i == active;
            let (k, row) = (key.to_string(), *row);
            strip = strip.child(div().id(SharedString::from(format!("tab-{key}-{i}"))).relative().h_full().pr(px(18.)).mr(px(12.)).flex().items_center().cursor_pointer().text_size(px(14.)).font_weight(w(600.)).text_color(if on { c(TEXT) } else { c(TEXT3) }).hover(|s| s.text_color(c(TEXT2)))
                .child(label.to_string()).when(on, |d| d.child(div().absolute().left_0().right(px(18.)).bottom(px(-1.)).h(px(2.)).rounded(px(2.)).bg(c(ACCENT))))
                .on_click(cx.listener(move |this, _, _, cx| { if let Some(s) = this.lists.get(&k) { s.scroll_to(ListOffset { item_ix: row, offset_in_item: px(0.) }); } cx.notify(); })));
        }
        strip
    }

    fn album_hero(&mut self, a: &Album, ids: &[String], details: Option<&crate::albumlogic::Details>, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let s = &a.summary;
        let img = self.cover(&s.id, s.cover_url.as_deref(), 300., window);
        let total_ms: f64 = a.tracks.iter().map(|t| t.duration_ms).sum();
        let (aid, aname) = (s.artist.id.clone(), s.artist.name.clone());
        let id = s.id.clone();
        let (i1, i2, i3) = (id.clone(), id.clone(), id.clone());
        let mut menu = self.album_menu(a, ids.to_vec());
        if s.source == "local" { menu.items.push(crate::menu::item("wrench", "Fix match", MenuAct::FixMatch(s.id.clone()))); }
        if let Some(p) = &a.folder_path { menu.items.push(crate::menu::item("copy", "Copy folder path", MenuAct::CopyText(p.clone(), "Folder path copied".into()))); }
        let scores = details.filter(|d| !d.scores.is_empty()).map(|d| self.hero_scores(d, cx));
        let dot = || div().mx(px(9.)).text_color(c(TEXT3)).child("\u{b7}");
        let fmt = if s.source == "spotify" { Some(("Spotify".to_string(), true)) } else { s.format.clone().map(|f| (f, false)) };
        let text = v_flex().flex_1().min_w_0().gap(px(12.)).pb(px(4.))
            .child(eyebrow("Album").text_color(ca(TEXT, 0.62)))
            .child(div().font_family(SERIF).text_size(px(49.)).line_height(px(54.)).font_weight(w(600.)).child(s.title.clone()))
            .child(h_flex().flex_wrap().items_baseline().text_size(px(15.)).text_color(c(TEXT2))
                .child(div().id("hero-artist").font_weight(w(600.)).text_color(c(TEXT)).cursor_pointer().hover(|st| st.underline()).child(aname).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(aid.clone()), cx))))
                .children(s.year.map(|y| h_flex().child(dot()).child(div().id("hero-year").cursor_pointer().hover(|st| st.text_color(c(TEXT)).underline()).child(y.to_string()).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Albums(AlbumsQ { year: Some(y), ..Default::default() }), cx))))))
                .children(a.label.clone().map(|l| { let l2 = l.clone(); h_flex().child(dot()).child(div().id("hero-label").cursor_pointer().hover(|st| st.text_color(c(TEXT)).underline()).child(l).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Albums(AlbumsQ { label: Some(l2.clone()), ..Default::default() }), cx)))) }))
                .child(dot()).child(div().child(format!("{}, {}", plural(a.tracks.len(), "track"), format_total_length(total_ms)))))
            .child(h_flex().flex_wrap().items_center().gap(px(8.))
                .children(fmt.map(|(t, sp)| badge(&t, sp).h(px(28.)).px(px(11.)).text_size(px(12.))))
                .children(s.pinned.then(|| badge("Pinned", false).h(px(28.)).px(px(11.)).text_size(px(12.)).text_color(c(ACCENT2))))
                .children(a.genres.iter().enumerate().map(|(i, g)| {
                    let g2 = g.clone();
                    div().id(SharedString::from(format!("genre-{i}"))).cursor_pointer().hover(|st| st.bg(wh(0.14))).rounded_full().child(chip(g))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Albums(AlbumsQ { genre: Some(g2.clone()), ..Default::default() }), cx)))
                })))
            .child(h_flex().flex_wrap().gap(px(10.)).mt(px(8.))
                .child(div().id("a-play").child(btn("Play", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| this.play_album(&i1, false, 0, cx))))
                .child(div().id("a-shuffle").child(btn("Shuffle", Some("shuffle"), false)).on_click(cx.listener(move |this, _, _, cx| this.play_album(&i2, true, 0, cx))))
                .child(div().id("a-queue").child(btn("Queue", Some("plus"), false)).on_click(cx.listener(move |this, _, _, cx| this.enqueue_album(&i3, false, cx))))
                .child(div().id("a-more").child(btn_icon40("ellipsis")).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { let p = ev.position(); let mut m = menu.clone(); m.x = f32::from(p.x) - 20.; m.y = f32::from(p.y) + 24.; this.open_menu(m, cx); }))))
            .children(scores);
        let _ = cw;
        div().w_full().pt(px(44.)).pb(px(30.)).pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(
            h_flex().w_full().max_w(px(BODY_MAX)).mx_auto().gap(px(40.)).items_end()
                .child(div().w(px(300.)).flex_none().child(cover_el(img, &s.id, &s.title, 300., 6.).shadow(vec![
                    BoxShadow { inset: false, color: bk(0.6), offset: point(px(0.), px(30.)), blur_radius: px(70.), spread_radius: px(-10.) },
                    BoxShadow { inset: false, color: bk(0.35), offset: point(px(0.), px(8.)), blur_radius: px(24.), spread_radius: px(0.) }])))
                .child(text)).into_any_element()
    }

    fn track_row(&mut self, album: &Album, t: &LibTrack, i: usize, ids: &[String], order: &[LibTrack], _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let _ = order;
        let cur = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.track.id.clone());
        let playing = cur.as_deref() == Some(t.id.as_str());
        let status_playing = self.model.player.as_ref().is_some_and(|p| p.status == rune_mini_core::model::Status::Playing);
        let differs = t.artists.len() != 1 || t.artists.first().map(|a| &a.id) != Some(&album.summary.artist.id);
        let group = SharedString::from(format!("tr-{}", t.id));
        let ids_all = ids.to_vec();
        let menu = self.track_menu_ids(vec![t.id.clone()], t.title.clone(), Some(album.summary.id.clone()), t.artists.first().map(|a| a.id.clone()), t.source == "spotify", t.id.clone());
        let (menu2, ids2) = (menu.clone(), ids_all.clone());
        let order2 = order.to_vec();
        let artist_line = if differs { t.artist_line() } else { String::new() };
        h_flex().id(group.clone()).group(group.clone()).h(px(48.)).px(px(6.)).items_center().rounded(px(R)).cursor_pointer()
            .when(playing, |d| d.bg(ca(ACCENT, 0.12))).when(!playing, |d| d.hover(|s| s.bg(wh(0.05))))
            .child(div().w(px(44.)).h_full().flex_none().flex().items_center().justify_center().text_size(px(14.)).text_color(c(TEXT3))
                .child(div().group_hover(group.clone(), |s| s.invisible()).child(if playing { icon(if status_playing { "audio-lines" } else { "audio-lines" }, 14., c(ACCENT2)).into_any_element() } else { div().child(t.number.to_string()).into_any_element() }))
                .child(div().absolute().invisible().group_hover(group.clone(), |s| s.visible()).child(icon("play", 14., c(TEXT)))))
            .child(div().flex_grow(1.).flex_basis(relative(0.58)).min_w_0().truncate().text_size(px(14.5)).font_weight(w(500.)).text_color(if playing { c(ACCENT2) } else { c(TEXT) }).child(t.title.clone()))
            .child(div().flex_grow(1.).flex_basis(relative(0.42)).min_w_0().truncate().text_size(px(13.)).text_color(c(TEXT2)).child(artist_line))
            .child(div().w(px(56.)).flex_none().text_right().pr(px(8.)).text_size(px(13.)).text_color(c(TEXT3)).child(format_duration(t.duration_ms)))
            .child(div().id(SharedString::from(format!("tm-{}", t.id))).w(px(40.)).flex_none().flex().justify_center().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.))
                .child(btn_icon("ellipsis", 18., c(TEXT2), false))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = menu2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); })))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
            .on_click(cx.listener(move |this, _, _, cx| { let _ = &ids2; this.play_tracks(order2.clone(), i, false, cx) }))
            .into_any_element()
    }
}

/// A row's content centred in the page's 1240 px body column.
fn full(inner: impl IntoElement, body_w: f32) -> AnyElement {
    div().w_full().pl(px(PAD)).pr(px(PAD + SCROLLBAR)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element()
}
