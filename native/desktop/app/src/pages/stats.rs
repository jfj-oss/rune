//! Stats (web `pages/Stats.tsx`): listening time and plays for a period, the daily sparkline, hour-of-day and weekday bars drawn
//! as paths, top albums / tracks / artists / genres, new discoveries and the share of lossless and hi-res listening.
use super::*;
use super::artists::avatar;
use crate::albumlogic::{format_listening, format_stamp};
use crate::charts::*;
use serde_json::Value;

const PERIODS: [(&str, &str); 4] = [("7d", "7 days"), ("30d", "30 days"), ("365d", "Year"), ("all", "All time")];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

pub fn format_share(p: f64) -> String { format!("{:.1}%", (p * 10.).round() / 10.) }
pub fn hour_label(h: usize) -> String { format!("{h:02}:00") }

fn arr(v: &Value, k: &str) -> Vec<Value> { v.get(k).and_then(|x| x.as_array()).cloned().unwrap_or_default() }
fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string() }
fn n(v: &Value, k: &str) -> f64 { v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.) }

fn block(title: &str, count: Option<String>, body: impl IntoElement) -> Div {
    v_flex().mb(px(36.)).child(sec_head(title, count.map(|c_| div().text_size(px(12.)).text_color(c(TEXT3)).child(c_).into_any_element()))).child(body)
}

fn panel() -> Div { v_flex().p(px(16.)).px(px(18.)).rounded(px(14.)).bg(surface()).border_1().border_color(line()).min_w_0() }

fn bars_with_labels(values: Vec<f64>, labels: Vec<String>, every: usize) -> Div {
    let k = labels.len().max(1);
    panel().child(bars(values, 120., c(ACCENT))).child(h_flex().mt(px(6.)).children(labels.into_iter().enumerate().map(move |(i, l)| div().flex_1().text_size(px(11.)).text_color(c(TEXT3)).child(if i % every == 0 { l } else { String::new() }).w(relative(1. / k as f32))))).into()
}

impl Rune {
    pub fn stats_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let period = self.stats_period;
        let slot = self.ensure_json(&format!("/stats/summary?period={period}"), cx);
        let d = slot.ready().cloned();
        let err = matches!(slot, crate::data::Slot::Err(_)) && d.is_none();
        let body_w = cw.min(1240.);
        let wide = body_w >= 900.;
        enum R { Head, Period, State(&'static str), Tiles, Over, Cols, Space }
        let mut rows = vec![R::Head, R::Period];
        if err { rows.push(R::State("error")); } else if d.is_none() { rows.push(R::State("loading")); } else { rows.push(R::Tiles); rows.push(R::Over); rows.push(R::Cols); }
        rows.push(R::Space);
        let nrows = rows.len();
        let loaded = d.is_some();
        let sub = d.as_ref().map(|d| if d.get("from").is_some_and(|f| !f.is_null()) { format!("{} \u{2013} {}", format_stamp(n(d, "from")), format_stamp(n(d, "to"))) } else { "All time".into() }).unwrap_or_else(|| " ".into());
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            let wrap = |inner: AnyElement| div().w_full().pl(px(PAD)).pr(px(PAD)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element();
            match &rows[ix] {
                R::Head => wrap(page_head("Stats", &sub, None).into_any_element()),
                R::Period => wrap(h_flex().p(px(3.)).mb(px(22.)).w_full().rounded_full().bg(surface()).border_1().border_color(line()).children(PERIODS.iter().map(|(id, label)| {
                    let on = this.stats_period == *id;
                    div().id(SharedString::from(format!("sp-{id}"))).h(px(30.)).px(px(14.)).flex().items_center().rounded_full().cursor_pointer().text_size(px(13.)).font_weight(w(500.)).text_color(if on { c(TEXT) } else { c(TEXT2) }).when(on, |d| d.bg(surface3())).child(label.to_string())
                        .on_click(cx.listener(move |this, _, _, cx| { this.stats_period = id; cx.notify(); }))
                })).into_any_element()),
                R::State(st) => wrap(if *st == "error" { fail(cx, "Could not load your stats", "Is the rune server running?").into_any_element() } else { div().h(px(120.)).into_any_element() }),
                R::Tiles => {
                    let d = d.clone().unwrap();
                    let tile = |ic: &'static str, label: &str, v: String| v_flex().flex_1().min_w_0().gap(px(2.)).px(px(18.)).pt(px(18.)).pb(px(16.)).rounded(px(16.)).bg(linear_gradient(140., linear_color_stop(ca(ACCENT, 0.12), 0.), linear_color_stop(surface(), 1.))).border_1().border_color(line())
                        .child(div().mb(px(8.)).child(icon(ic, 18., c(ACCENT2)))).child(div().truncate().text_size(px(28.)).line_height(px(31.)).font_weight(w(700.)).child(v)).child(div().text_size(px(12.)).font_weight(w(600.)).text_color(c(TEXT3)).child(label.to_uppercase()));
                    wrap(h_flex().gap(px(14.)).mb(px(36.)).child(tile("clock", "Listening time", format_listening(n(&d, "totalMs")))).child(tile("play", "Plays", crate::util::group(n(&d, "plays") as usize))).child(tile("disc-3", "Albums", crate::util::group(n(&d, "distinctAlbums") as usize))).child(tile("mic-vocal", "Artists", crate::util::group(n(&d, "distinctArtists") as usize))).into_any_element())
                }
                R::Over => {
                    let d = d.clone().unwrap();
                    let by: Vec<(String, f64)> = arr(&d, "byDay").iter().map(|x| (s(x, "date"), n(x, "ms"))).collect();
                    let series = daily_series(&by, d.get("from").and_then(|f| f.as_f64()), n(&d, "to"), 60);
                    wrap(block("Listening over time", Some(format_listening(n(&d, "totalMs"))), panel().child(if series.is_empty() { div().text_size(px(13.5)).text_color(c(TEXT3)).child("No listening history for this period yet.").into_any_element() } else { sparkline(series, 110.).into_any_element() })).into_any_element())
                }
                R::Cols => {
                    let d = d.clone().unwrap();
                    let colw = if wide { (body_w - 40.) * 0.575 } else { body_w };
                    let by_hour: Vec<f64> = { let mut v: Vec<f64> = arr(&d, "byHour").iter().map(|x| x.as_f64().unwrap_or(0.)).collect(); v.resize(24, 0.); v };
                    let by_wd: Vec<f64> = { let mut v: Vec<f64> = arr(&d, "byWeekday").iter().map(|x| x.as_f64().unwrap_or(0.)).collect(); v.resize(7, 0.); v };
                    let top_albums = arr(&d, "topAlbums"); let top_tracks = arr(&d, "topTracks"); let top_artists = arr(&d, "topArtists"); let genres = arr(&d, "topGenres"); let disc = arr(&d, "newDiscoveries");
                    let plays = n(&d, "plays");
                    let quiet = |t: &str| div().text_size(px(13.5)).text_color(c(TEXT3)).child(t.to_string());
                    let rank = |i: usize| div().w(px(26.)).flex_none().text_size(px(13.)).text_color(c(TEXT3)).child((i + 1).to_string());
                    let mut albums = v_flex();
                    for (i, a) in top_albums.iter().enumerate() {
                        let (id, title) = (s(a, "albumId"), s(a, "title"));
                        let img = this.cover(&id, None, 48., window);
                        let id2 = id.clone();
                        albums = albums.child(h_flex().id(SharedString::from(format!("ta-{i}"))).gap(px(12.)).px(px(6.)).py(px(7.)).items_center().rounded(px(10.)).cursor_pointer().hover(|x| x.bg(wh(0.04)))
                            .child(rank(i)).child(cover_el(img, &id, &title, 48., R_SM))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(600.)).child(title)).child(div().truncate().text_size(px(12.5)).text_color(c(TEXT3)).child(if s(a, "artist").is_empty() { "Unknown artist".to_string() } else { s(a, "artist") })))
                            .child(div().text_size(px(13.)).text_color(c(TEXT2)).child(plural(n(a, "plays") as usize, "play")))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(id2.clone()), cx))));
                    }
                    let mut tracks = v_flex();
                    for (i, t) in top_tracks.iter().enumerate() {
                        let aid = s(t, "albumId");
                        tracks = tracks.child(h_flex().id(SharedString::from(format!("tt-{i}"))).gap(px(12.)).px(px(6.)).py(px(7.)).items_center().rounded(px(10.)).cursor_pointer().hover(|x| x.bg(wh(0.04)))
                            .child(rank(i))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(600.)).child(s(t, "title"))).child(div().truncate().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{}{}", if s(t, "albumTitle").is_empty() { "Unknown album".into() } else { s(t, "albumTitle") }, if s(t, "artist").is_empty() { String::new() } else { format!(" \u{b7} {}", s(t, "artist")) }))))
                            .child(div().text_size(px(13.)).text_color(c(TEXT2)).child(format!("{}\u{d7} \u{b7} {}", n(t, "plays") as usize, format_listening(n(t, "totalMs")))))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(aid.clone()), cx))));
                    }
                    let mut artists = v_flex();
                    for (i, a) in top_artists.iter().enumerate() {
                        let (id, name) = (s(a, "artistId"), s(a, "name"));
                        let id2 = id.clone();
                        artists = artists.child(h_flex().id(SharedString::from(format!("tr-{i}"))).gap(px(12.)).px(px(6.)).py(px(7.)).items_center().rounded(px(10.)).cursor_pointer().hover(|x| x.bg(wh(0.04)))
                            .child(avatar(&id, &name, 40.))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(600.)).child(name)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{} \u{b7} {}", plural(n(a, "albumCount") as usize, "album"), format_listening(n(a, "totalMs"))))))
                            .child(div().text_size(px(13.)).text_color(c(TEXT2)).child(plural(n(a, "plays") as usize, "play")))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id2.clone()), cx))));
                    }
                    let mut gen = v_flex().gap(px(12.));
                    for g in &genres {
                        let share = if plays > 0. { n(g, "plays") / plays * 100. } else { 0. };
                        gen = gen.child(v_flex().gap(px(5.)).child(h_flex().justify_between().text_size(px(13.5)).child(div().child(s(g, "genre"))).child(div().text_color(c(TEXT2)).child(format_share(share)))).child(div().h(px(5.)).rounded(px(3.)).bg(wh(0.10)).overflow_hidden().child(div().h_full().w(relative((share / 100.).min(1.) as f32)).bg(c(ACCENT)))));
                    }
                    let mut dl = v_flex();
                    for (i, x) in disc.iter().enumerate() {
                        let (id, name) = (s(x, "artistId"), s(x, "name"));
                        let id2 = id.clone();
                        dl = dl.child(h_flex().id(SharedString::from(format!("nd-{i}"))).gap(px(12.)).px(px(6.)).py(px(7.)).items_center().rounded(px(10.)).cursor_pointer().hover(|x| x.bg(wh(0.04)))
                            .child(avatar(&id, &name, 36.)).child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(600.)).child(name)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("First played {}", format_stamp(n(x, "firstPlayedAt"))))))
                            .child(div().text_size(px(13.)).text_color(c(TEXT2)).child(plural(n(x, "plays") as usize, "play")))
                            .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Artist(id2.clone()), cx))));
                    }
                    let (lossless, hires) = (d.pointer("/formats/lossless").and_then(|x| x.as_f64()).unwrap_or(0.), d.pointer("/formats/hiRes").and_then(|x| x.as_f64()).unwrap_or(0.));
                    let share = |label: &str, v: f64| v_flex().gap(px(5.)).child(h_flex().justify_between().text_size(px(13.5)).child(div().child(label.to_string())).child(div().font_weight(w(700.)).child(format_share(v)))).child(div().h(px(5.)).rounded(px(3.)).bg(wh(0.10)).overflow_hidden().child(div().h_full().w(relative((v / 100.).min(1.) as f32)).bg(c(ACCENT))));
                    let left = v_flex().w(px(colw)).flex_none().min_w_0()
                        .child(block("Listening by hour", None, bars_with_labels(by_hour, (0..24).map(hour_label).collect(), 6)))
                        .child(block("Listening by weekday", None, bars_with_labels(by_wd, WEEKDAYS.iter().map(|x| x.to_string()).collect(), 1)))
                        .child(block("Top albums", Some(plural(top_albums.len(), "album")), if top_albums.is_empty() { quiet("No album plays in this period.").into_any_element() } else { albums.into_any_element() }))
                        .child(block("Top tracks", Some(plural(top_tracks.len(), "track")), if top_tracks.is_empty() { quiet("No track plays in this period.").into_any_element() } else { tracks.into_any_element() }));
                    let right = v_flex().flex_1().min_w_0()
                        .child(block("Top artists", Some(plural(top_artists.len(), "artist")), if top_artists.is_empty() { quiet("No artist plays in this period.").into_any_element() } else { artists.into_any_element() }))
                        .child(block("Top genres", None, if genres.is_empty() { quiet("No genre data for this period.").into_any_element() } else { gen.into_any_element() }))
                        .child(block("New discoveries", Some(disc.len().to_string()), if disc.is_empty() { quiet("Nothing new in this period.").into_any_element() } else { dl.into_any_element() }))
                        .child(block("Formats", None, panel().gap(px(14.)).child(share("Lossless", lossless)).child(share("Hi-res", hires)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child("Share of listening time from lossless and hi-res files."))));
                    wrap(if wide { h_flex().gap(px(40.)).items_start().child(left).child(right).into_any_element() } else { v_flex().child(left).child(right).into_any_element() })
                }
                R::Space => bottom_space(),
            }
        });
        let _ = window;
        self.list_page(format!("stats:{period}"), ((cw as u64) << 8) | nrows as u64 | (u64::from(loaded) << 40), nrows, row, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn shares_and_hours_read_like_the_web() {
        assert_eq!(format_share(62.44), "62.4%");
        assert_eq!(format_share(100.), "100.0%");
        assert_eq!(hour_label(7), "07:00");
    }
}
