//! Discover (web `pages/Discover.tsx`, `components/DiscoverRow.tsx`, `SongRadio.tsx`): songs from Spotify that are not in the
//! library, grouped by what they are similar to; and the song-radio sheet for one track. Rows play through the same twin
//! routing as everything else (`play_items`).
use super::*;
use crate::menu::{item, pop};
use crate::playroute::Item;
use rune_mini_core::library::{LibTrack, TrackAlbum};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, Clone, Debug, Default)]
pub struct DItem {
    #[serde(default)]
    pub track: LibTrack,
    #[serde(default)]
    pub album: TrackAlbum,
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct DGroup {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub items: Vec<DItem>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Feed {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub groups: Vec<DGroup>,
    #[serde(default)]
    pub items: Vec<DItem>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub notice: Option<String>,
}

/// The state of a feed or radio answer for the page to show.
pub fn feed_state(f: &Feed, items_n: usize) -> &'static str {
    match f.status.as_str() { "rate_limited" => "limit", "unavailable" => "unavailable", _ if items_n == 0 => "empty", _ => "ok" }
}

enum Row { Head, Notice(String), State(&'static str), Group(usize), Item(usize, usize), Space }

impl Rune {
    pub fn parse_feed(&mut self, path: &str, cx: &mut Context<Self>) -> (Option<Feed>, bool, bool) {
        let slot = self.ensure_json(path, cx);
        let loading = matches!(slot, crate::data::Slot::Loading);
        let err = matches!(slot, crate::data::Slot::Err(_));
        (slot.ready().and_then(|v| serde_json::from_value::<Feed>((**v).clone()).ok()), loading, err)
    }

    /// One Discover / radio row: art with play, title, artist and album, why it is here, time, and the actions.
    pub fn drow(&mut self, key: &str, it: &DItem, on_play: impl Fn(&mut Rune, &mut Context<Rune>) + 'static, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let cur = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.track.id.clone());
        let playing = cur.as_deref() == Some(it.track.id.as_str());
        let img = self.cover(&it.album.id, it.album.cover_url.as_deref(), 44., window);
        let group = SharedString::from(format!("dr-{key}"));
        let ids = vec![it.track.id.clone()];
        let menu = self.track_menu_ids(ids.clone(), it.track.title.clone(), Some(it.album.id.clone()), it.track.artists.first().map(|a| a.id.clone()), true, it.track.id.clone());
        let (m2, tid, tid2) = (menu.clone(), it.track.id.clone(), it.track.id.clone());
        let (ids2, ids3) = (ids.clone(), ids.clone());
        let on_play = std::rc::Rc::new(on_play);
        let (op1, op2) = (on_play.clone(), on_play.clone());
        let _ = op2;
        h_flex().id(group.clone()).group(group.clone()).h(px(68.)).px(px(10.)).gap(px(14.)).items_center().rounded(px(R)).cursor_pointer().when(playing, |d| d.bg(ca(ACCENT, 0.12))).when(!playing, |d| d.hover(|s| s.bg(wh(0.05))))
            .child(div().relative().size(px(44.)).flex_none().child(cover_el(img, &it.album.id, &it.album.title, 44., R_SM))
                .child(div().absolute().inset_0().rounded(px(R_SM)).bg(bk(0.55)).flex().items_center().justify_center().when(!playing, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.))).child(icon(if playing { "audio-lines" } else { "play" }, 15., c(TEXT)))))
            .child(v_flex().flex_1().min_w_0()
                .child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).text_color(if playing { c(ACCENT2) } else { c(TEXT) }).child(it.track.title.clone()))
                .child(div().truncate().text_size(px(13.)).text_color(c(TEXT2)).child(format!("{} \u{b7} {}", it.track.artist_line(), it.album.title)))
                .child(div().truncate().text_size(px(12.)).text_color(c(TEXT3)).child(it.reason.clone())))
            .child(div().text_size(px(13.)).text_color(c(TEXT3)).child(format_duration(it.track.duration_ms)))
            .child(h_flex().gap(px(0.)).opacity(0.).group_hover(group.clone(), |s| s.opacity(1.))
                .child(div().id(SharedString::from(format!("drq-{key}"))).child(btn_icon("list-plus", 17., c(TEXT2), false)).on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.enqueue_ids(ids2.clone(), false, cx); })))
                .child(div().id(SharedString::from(format!("drp-{key}"))).child(btn_icon("list-music", 17., c(TEXT2), false)).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                    cx.stop_propagation(); let p = ev.position();
                    let mut m = pop(f32::from(p.x) - 200., f32::from(p.y) + 20., vec![item("list-plus", "Add to playlist", MenuAct::AddToPlaylistToggle)]);
                    m.items[0].chevron = true; m.add_open = true; m.add_ids = ids3.clone(); m.add_label = "song".into(); this.open_menu(m, cx);
                })))
                .child(div().id(SharedString::from(format!("drx-{key}"))).child(btn_icon("x", 17., c(TEXT2), false)).on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.dismiss_song(&tid, cx); })))
                .child(div().id(SharedString::from(format!("drm-{key}"))).child(btn_icon("ellipsis", 18., c(TEXT2), false)).on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { cx.stop_propagation(); let p = ev.position(); let mut m = m2.clone(); m.x = f32::from(p.x) - 200.; m.y = f32::from(p.y) + 20.; this.open_menu(m, cx); }))))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| { let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y); this.open_menu(m, cx); }))
            .on_click(cx.listener(move |this, _, _, cx| op1(this, cx)))
            .child(div().hidden().child(tid2))
            .into_any_element()
    }

    /// "Not for me": hidden at once, remembered by the server.
    pub fn dismiss_song(&mut self, track_id: &str, cx: &mut Context<Self>) {
        self.dismissed.insert(track_id.to_string());
        cx.notify();
        let id = track_id.to_string();
        self.spawn_send(cx, "POST", "/discover/dismiss".into(), Some(json!({"trackId": id})), move |me, r, cx| {
            if r.is_err() { me.dismissed.remove(&id); me.say("Could not dismiss that song", cx); }
            else { me.forget_json("/discover/"); }
        });
    }

    pub fn play_ditems(&mut self, items: &[DItem], i: usize, cx: &mut Context<Self>) {
        let list: Vec<Item> = items.iter().map(|d| Item::from_track(&d.track)).collect();
        self.play_items(list, i, false, None, cx);
    }

    pub fn discover_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let _ = cw;
        let path = if self.discover_refresh { "/discover/new?limit=100&refresh=1" } else { "/discover/new?limit=100" };
        let (feed, loading, err) = self.parse_feed(path, cx);
        if self.discover_refresh && !loading && feed.is_some() { self.discover_refresh = false; }
        let dismissed = self.dismissed.clone();
        let groups: Vec<DGroup> = feed.as_ref().map(|f| f.groups.iter().map(|g| DGroup { title: g.title.clone(), items: g.items.iter().filter(|i| !dismissed.contains(&i.track.id)).cloned().collect() }).filter(|g| !g.items.is_empty()).collect()).unwrap_or_default();
        let state = feed.as_ref().map(|f| feed_state(f, groups.len())).unwrap_or("ok");
        let mut rows = vec![Row::Head];
        if let Some(n) = feed.as_ref().and_then(|f| f.notice.clone()) { rows.push(Row::Notice(n)); }
        if err { rows.push(Row::State("error")); } else if loading && feed.is_none() { rows.push(Row::State("loading")); } else if state != "ok" { rows.push(Row::State(state)); }
        else { for (gi, g) in groups.iter().enumerate() { rows.push(Row::Group(gi)); for ii in 0..g.items.len() { rows.push(Row::Item(gi, ii)); } } }
        rows.push(Row::Space);
        let n = rows.len();
        let msg = feed.as_ref().and_then(|f| f.message.clone());
        let refreshing = self.discover_refresh && loading;
        let row: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            Row::Head => padded(h_flex().items_end().justify_between().pt(px(28.)).mb(px(20.))
                .child(v_flex().child(page_title("Discover")).child(div().mt(px(4.)).text_size(px(14.)).text_color(c(TEXT3)).child("New songs from Spotify that aren\u{2019}t in your likes, playlists or library.")))
                .child(div().id("dc-refresh").child(btn(if refreshing { "Refreshing\u{2026}" } else { "Refresh" }, Some("refresh-cw"), false)).on_click(cx.listener(|this, _, _, cx| { this.discover_refresh = true; this.forget_json("/discover/new"); cx.notify(); })))).into_any_element(),
            Row::Notice(t) => padded(h_flex().gap(px(8.)).items_center().mb(px(14.)).text_size(px(13.)).text_color(c(TEXT2)).child(icon("clock", 14., c(TEXT2))).child(t.clone())).into_any_element(),
            Row::State(s) => padded(match *s {
                "limit" => v_flex().items_center().py(px(48.)).gap(px(8.)).child(icon("clock", 28., c(TEXT2))).child(div().text_size(px(17.)).font_weight(w(600.)).child("Spotify is taking a break")).child(div().max_w(px(520.)).text_color(c(TEXT2)).child(msg.clone().unwrap_or_else(|| "Spotify is rate-limiting rune \u{2014} try again later.".into()))).child(div().text_size(px(12.)).text_color(c(TEXT3)).child("Discover shares a small request budget, so a busy hour never locks the app out for a day.")),
                "unavailable" => empty("Discover is unavailable", &msg.clone().unwrap_or_else(|| "Could not reach Spotify right now. Try again in a moment.".into())),
                "empty" => empty("Nothing new right now", "Everything similar is already in your likes, playlists or library. Try again later, or open a song radio from any track."),
                "error" => empty("Could not load Discover", "Check that the rune server is running, then try again."),
                _ => v_flex().gap(px(12.)).children((0..4).map(|_| h_flex().h(px(60.)).gap(px(14.)).items_center().child(div().size(px(44.)).rounded(px(6.)).bg(surface())).child(div().h(px(13.)).w(px(260.)).rounded(px(6.)).bg(surface())))),
            }).into_any_element(),
            Row::Group(gi) => padded(h_flex().items_baseline().gap(px(14.)).pt(px(if *gi == 0 { 6. } else { 36. })).pb(px(10.)).child(div().text_size(px(19.)).font_weight(w(700.)).child(groups[*gi].title.clone())).child(div().text_size(px(13.)).text_color(c(TEXT3)).child(format!("{} you don\u{2019}t have", plural(groups[*gi].items.len(), "song"))))).into_any_element(),
            Row::Item(gi, ii) => {
                let g = groups[*gi].items.clone();
                let it = g[*ii].clone();
                let i = *ii;
                padded(this.drow(&format!("{gi}-{ii}"), &it, move |me, cx| me.play_ditems(&g, i, cx), window, cx)).into_any_element()
            }
            Row::Space => bottom_space(),
        });
        self.list_page("discover".into(), n as u64, n, row, cx)
    }

    /// The song-radio sheet: songs similar to one track that you do not have.
    pub fn song_radio_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (tid, title, artist) = self.song_radio.clone().unwrap();
        let vh = f32::from(window.viewport_size().height);
        let (feed, loading, err) = self.parse_feed(&format!("/discover/track/{}/similar?limit=30", rune_mini_core::commands::encode(&tid)), cx);
        let dismissed = self.dismissed.clone();
        let items: Vec<DItem> = feed.as_ref().map(|f| f.items.iter().filter(|i| !dismissed.contains(&i.track.id)).cloned().collect()).unwrap_or_default();
        let state = feed.as_ref().map(|f| feed_state(f, items.len())).unwrap_or("ok");
        let mut body = v_flex().id("sr-body").flex_1().min_h_0().overflow_y_scroll().px(px(10.)).py(px(8.));
        if err { body = body.child(empty("Could not load song radio", "Check that the rune server is running.")); }
        else if loading && feed.is_none() { body = body.children((0..6).map(|_| h_flex().h(px(60.)).gap(px(14.)).px(px(10.)).items_center().child(div().size(px(44.)).rounded(px(6.)).bg(surface())).child(div().h(px(13.)).w(px(200.)).rounded(px(6.)).bg(surface())))); }
        else if state == "limit" { body = body.child(empty("Spotify is taking a break", &feed.as_ref().and_then(|f| f.message.clone()).unwrap_or_default())); }
        else if state == "unavailable" { body = body.child(empty("Radio unavailable", &feed.as_ref().and_then(|f| f.message.clone()).unwrap_or_else(|| "Could not reach Spotify right now.".into()))); }
        else if items.is_empty() { body = body.child(empty("No new songs for this one", "Everything similar is already in your likes, playlists or library. Try another track.")); }
        else { for (i, it) in items.iter().enumerate() { let all = items.clone(); body = body.child(self.drow(&format!("sr{i}"), it, move |me, cx| me.play_ditems(&all, i, cx), window, cx)); } }
        let all = items.clone();
        div().absolute().top_0().left_0().size_full().child(div().id("sr-away").absolute().size_full().bg(ca(0x06060a, 0.4)).occlude().on_click(cx.listener(|this, _, _, cx| { this.song_radio = None; cx.notify(); })))
            .child(v_flex().absolute().top_0().right_0().h(px(vh - NPBAR_H)).w(px(480.)).bg(c(0x14151c)).border_l_1().border_color(wh(0.14)).occlude()
                .child(h_flex().flex_none().items_start().justify_between().gap(px(12.)).pl(px(24.)).pr(px(14.)).pt(px(22.)).pb(px(14.)).border_b_1().border_color(line())
                    .child(v_flex().min_w_0().gap(px(4.)).child(eyebrow("Song radio \u{b7} new to you")).child(div().truncate().text_size(px(20.)).font_weight(w(700.)).child(title)).child(div().truncate().text_size(px(13.)).text_color(c(TEXT3)).child(artist)))
                    .child(h_flex().gap(px(4.)).items_center()
                        .when(!all.is_empty(), |d| d.child(div().id("sr-all").child(btn("Play all", Some("play"), true)).on_click(cx.listener(move |this, _, _, cx| this.play_ditems(&all, 0, cx)))))
                        .child(div().id("sr-close").child(btn_icon("x", 20., c(TEXT2), false)).on_click(cx.listener(|this, _, _, cx| { this.song_radio = None; cx.notify(); }))))) 
                .child(body))
    }
}
