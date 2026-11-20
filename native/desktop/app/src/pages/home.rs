//! Home (web `pages/Home.tsx`): a greeting, then Recently added, Recently played, Spotify and Rediscover.
use super::*;
use rune_mini_core::library::HistoryAlbum;

const CARD: f32 = 180.;

fn greeting() -> &'static str {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let off = std::env::var("RUNE_DESKTOP_TZ_OFFSET_H").ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or_else(local_offset_h);
    let h = (((secs / 3600 + off) % 24) + 24) % 24;
    if h < 5 { "Late night" } else if h < 12 { "Good morning" } else if h < 18 { "Good afternoon" } else { "Good evening" }
}

/// The local UTC offset in hours, from the TZ the C library knows (`date +%z` is not run: read /etc/localtime via `chrono`-free math).
fn local_offset_h() -> i64 {
    std::process::Command::new("date").arg("+%z").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| {
        let s = s.trim().to_string();
        let sign = if s.starts_with('-') { -1 } else { 1 };
        s.get(1..3).and_then(|h| h.parse::<i64>().ok()).map(|h| sign * h)
    }).unwrap_or(0)
}

enum Sec { Head, Added, Played, Spotify, RediscoverHead, RediscoverRow(usize), Space }

impl Rune {
    fn album_ids_row(&mut self, hist: &str, cx: &mut Context<Self>) -> Vec<String> {
        match self.ensure_json(hist, cx).ready().and_then(|v| serde_json::from_value::<Vec<HistoryAlbum>>((**v).clone()).ok()) { Some(v) => v.into_iter().map(|h| h.album_id).collect(), None => vec![] }
    }

    pub fn home_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let added = self.ensure_json("/library/albums?sort=added&limit=16", cx);
        let spotify = self.ensure_json("/library/albums?sort=added&source=spotify&limit=16", cx);
        let rec_ids = self.album_ids_row("/history/recent?limit=12", cx);
        let red_ids = self.album_ids_row("/history/rediscover?limit=8&olderThanDays=90", cx);
        let played = if rec_ids.is_empty() { None } else { albums_of(&self.ensure_json(&format!("/library/albums?ids={}", rec_ids.join(",")), cx)) };
        let redis = if red_ids.is_empty() { None } else { albums_of(&self.ensure_json(&format!("/library/albums?ids={}", red_ids.join(",")), cx)) };
        let added_err = matches!(added, crate::data::Slot::Err(_));
        let added = albums_of(&added);
        let spotify = albums_of(&spotify);
        let total = added.as_ref().map(|p| p.total);
        let (cols, card_w) = grid_dims(cw, 170., 22., 2);
        let redis_items = redis.map(|p| p.items).unwrap_or_default();
        let mut secs = vec![Sec::Head, Sec::Added];
        if played.as_ref().is_some_and(|p| !p.items.is_empty()) { secs.push(Sec::Played); }
        if spotify.as_ref().is_some_and(|p| p.total > 0) { secs.push(Sec::Spotify); }
        if !redis_items.is_empty() { secs.push(Sec::RediscoverHead); for r in 0..redis_items.len().div_ceil(cols) { secs.push(Sec::RediscoverRow(r)); } }
        secs.push(Sec::Space);
        let n = secs.len();
        let title = greeting();
        let row: RowFn = Box::new(move |this, ix, window, cx| match &secs[ix] {
            Sec::Head => padded(page_head(title, &total.map(|t| format!("{} in your library", plural(t, "album"))).unwrap_or_else(|| " ".into()), None)).into_any_element(),
            Sec::Added if added_err => padded(fail(cx, "Could not load your library", "Is the rune server running?")).pb(px(44.)).into_any_element(),
            Sec::Added => {
                let cards: Vec<AnyElement> = match &added { Some(p) => p.items.iter().map(|a| this.album_card(a, CARD, window, cx)).collect(), None => (0..8).map(|_| skeleton_card(CARD)).collect() };
                let all = div().id("home-all-added").text_size(px(12.5)).font_weight(w(500.)).text_color(c(TEXT3)).cursor_pointer().hover(|s| s.text_color(c(ACCENT2))).child("See all").on_click(cx.listener(|this, _, _, cx| this.go(Route::Albums(AlbumsQ::default()), cx))).into_any_element();
                v_flex().pb(px(44.)).child(padded(sec_head("Recently added", Some(all)))).child(this.hscroll("home-added", cards, cx)).into_any_element()
            }
            Sec::Played => {
                let cards: Vec<AnyElement> = played.as_ref().map(|p| p.items.iter().map(|a| this.album_card(a, CARD, window, cx)).collect()).unwrap_or_default();
                v_flex().pb(px(44.)).child(padded(sec_head("Recently played", None))).child(this.hscroll("home-played", cards, cx)).into_any_element()
            }
            Sec::Spotify => {
                let cards: Vec<AnyElement> = spotify.as_ref().map(|p| p.items.iter().map(|a| this.album_card(a, CARD, window, cx)).collect()).unwrap_or_default();
                let all = div().id("home-all-spotify").text_size(px(12.5)).font_weight(w(500.)).text_color(c(TEXT3)).cursor_pointer().hover(|s| s.text_color(c(ACCENT2))).child("See all").on_click(cx.listener(|this, _, _, cx| this.go(Route::Albums(AlbumsQ::spotify()), cx))).into_any_element();
                v_flex().pb(px(44.)).child(padded(sec_head("From Spotify \u{2014} your saved albums", Some(all)))).child(this.hscroll("home-spotify", cards, cx)).into_any_element()
            }
            Sec::RediscoverHead => {
                let l = h_flex().id("home-rediscover").gap(px(6.)).items_center().text_size(px(12.5)).font_weight(w(500.)).text_color(c(TEXT3)).cursor_pointer().hover(|s| s.text_color(c(ACCENT2)))
                    .child(icon("shuffle", 13., c(TEXT3))).child("Not played in 90 days").on_click(cx.listener(|this, _, _, cx| this.go(Route::Albums(AlbumsQ { sort: Sort::Title, ..Default::default() }), cx))).into_any_element();
                padded(sec_head("Rediscover", Some(l))).into_any_element()
            }
            Sec::RediscoverRow(r) => padded(this.album_row(&redis_items, r * cols, redis_items.len(), cols, card_w, 22., card_w + 64. + 22., window, cx)).into_any_element(),
            Sec::Space => bottom_space(),
        });
        self.list_page("home".into(), ((cols as u64) << 8) | cw as u64 & 0xff, n, row, cx)
    }
}
