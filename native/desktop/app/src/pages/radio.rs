//! Radio (web `pages/Radio.tsx`): internet radio stations: search by name, tag or country, genre chips, favourites, and a grid
//! of station cards that play live on the zone on screen.
use super::*;
use crate::playroute::{Item, Source};
use gpui_kit::component::input::Input;
use serde::Deserialize;
use serde_json::Value;

const GENRES: [&str; 6] = ["jazz", "ambient", "classical", "electronic", "lofi", "news"];

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub bitrate: u32,
    #[serde(default)]
    pub logo_url: Option<String>,
    #[serde(default)]
    pub favicon: Option<String>,
}

pub fn station_tags(s: &Station) -> String {
    let t = s.tags.iter().take(3).cloned().collect::<Vec<_>>().join(" \u{b7} ");
    if !t.is_empty() { t } else { s.country.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| "Internet radio".into()) }
}

/// The stations to show for a search: the name search, plus the country and tag searches (merged, each station once, at most 90).
pub fn merge_stations(lists: Vec<Vec<Station>>, cap: usize) -> Vec<Station> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for l in lists { for s in l { if seen.insert(s.id.clone()) { out.push(s); } } }
    out.truncate(cap);
    out
}

fn stations_of(v: &Value) -> Vec<Station> {
    v.get("items").and_then(|i| serde_json::from_value(i.clone()).ok()).or_else(|| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

enum Row { Head, Search, Chips, FavHead, Favs, ResHead, State(&'static str), Grid(usize), Space }

impl Rune {
    fn station_card(&mut self, s: &Station, w_: f32, fav: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let img = self.cover(&s.id, s.logo_url.as_deref().or(s.favicon.as_deref()), w_, window);
        let cur = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.track.id.clone());
        let playing = cur.as_deref() == Some(s.id.as_str());
        let group = SharedString::from(format!("rc-{}", s.id));
        let (sid, sid2, st2) = (s.id.clone(), s.id.clone(), s.clone());
        v_flex().w(px(w_)).flex_none().min_w_0()
            .child(div().id(group.clone()).group(group.clone()).relative().size(px(w_)).rounded(px(R)).cursor_pointer()
                .shadow(vec![BoxShadow { inset: false, color: bk(0.4), offset: point(px(0.), px(8.)), blur_radius: px(22.), spread_radius: px(0.) }])
                .when(playing, |d| d.border_2().border_color(c(ACCENT)))
                .child(cover_el(img, &s.id, &s.name, w_, R))
                .child(div().absolute().inset_0().rounded(px(R)).bg(bk(0.35)).flex().items_center().justify_center().opacity(0.).group_hover(group.clone(), |x| x.opacity(1.))
                    .child(div().size(px(48.)).rounded_full().bg(c(ACCENT)).flex().items_center().justify_center().child(icon("play", 20., c(0x12101f)))))
                .when(playing, |d| d.child(div().absolute().left(px(8.)).top(px(8.)).h(px(18.)).px(px(7.)).gap(px(5.)).flex().items_center().rounded_full().bg(bk(0.6)).text_size(px(10.)).font_weight(w(700.)).child(div().size(px(5.)).rounded_full().bg(c(BAD))).child("LIVE")))
                .child(div().id(SharedString::from(format!("rf-{sid}"))).absolute().right(px(8.)).top(px(8.)).size(px(32.)).rounded_full().bg(ca(0x0f1013, 0.7)).flex().items_center().justify_center().cursor_pointer().hover(|x| x.bg(ca(0x0f1013, 0.9)))
                    .child(icon("heart", 17., if fav { c(ACCENT2) } else { c(TEXT) }))
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.toggle_station_fav(&sid2, !fav, cx); })))
                .on_click(cx.listener(move |this, _, _, cx| this.play_items(vec![Item { id: st2.id.clone(), source: Source::Radio, title: st2.name.clone(), artists: vec![], duration_ms: 0., album_id: st2.id.clone() }], 0, false, None, cx))))
            .child(div().mt(px(11.)).truncate().text_size(px(14.)).font_weight(w(600.)).child(s.name.clone()))
            .child(div().mt(px(2.)).truncate().text_size(px(12.5)).text_color(c(TEXT2)).child(station_tags(s)))
            .child(h_flex().mt(px(4.)).gap(px(7.)).overflow_hidden().whitespace_nowrap().text_size(px(12.)).text_color(c(TEXT3)).children(s.country.clone().filter(|c| !c.is_empty()).map(|c| div().child(c))).children((s.bitrate > 0).then(|| div().child(format!("\u{b7} {} kbps", s.bitrate)))))
            .into_any_element()
    }

    pub fn toggle_station_fav(&mut self, id: &str, on: bool, cx: &mut Context<Self>) {
        self.fav_override.insert(id.to_string(), on);
        cx.notify();
        let id2 = id.to_string();
        let (method, path, body) = if on { ("POST", "/radio/favourites".to_string(), Some(serde_json::json!({"id": id}))) } else { ("DELETE", format!("/radio/favourites?id={}", rune_mini_core::commands::encode(id)), None) };
        self.spawn_send(cx, method, path, body, move |me, r, cx| {
            me.fav_override.remove(&id2);
            if r.is_err() { me.say("Could not update favourites", cx); }
            me.forget_json("/radio/favourites");
            cx.notify();
        });
    }

    pub fn radio_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (q, tag) = (self.radio_q.clone(), self.radio_tag.clone());
        let qs = |extra: &[(&str, String)]| { let mut p = vec![("sort", "votes".to_string())]; p.extend(extra.iter().cloned()); format!("/radio/stations{}", rune_mini_core::client_ext::qs(&p)) };
        let tag_p = tag.clone().map(|t| ("tag", t));
        let mut paths: Vec<String> = vec![];
        if q.is_empty() { let mut e = vec![("limit", "60".to_string())]; if let Some(t) = &tag_p { e.push((t.0, t.1.clone())); } paths.push(qs(&e)); }
        else {
            let mut a = vec![("q", q.clone()), ("limit", "40".into())]; let mut b = vec![("country", q.clone()), ("limit", "40".into())];
            if let Some(t) = &tag_p { a.push((t.0, t.1.clone())); b.push((t.0, t.1.clone())); }
            paths.push(qs(&a)); paths.push(qs(&b));
            if tag.is_none() { paths.push(qs(&[("tag", q.clone()), ("limit", "40".into())])); }
        }
        let slots: Vec<crate::data::Slot<Value>> = paths.iter().map(|p| self.ensure_json(p, cx)).collect();
        let loading = slots.iter().any(|s| matches!(s, crate::data::Slot::Loading)) && !slots.iter().any(|s| s.ready().is_some());
        let failed = slots.iter().all(|s| matches!(s, crate::data::Slot::Err(_)));
        let results = merge_stations(slots.iter().filter_map(|s| s.ready().map(|v| stations_of(v))).collect(), 90);
        let favs_all: Vec<Station> = self.ensure_json("/radio/favourites", cx).ready().map(|v| stations_of(v)).unwrap_or_default();
        let ov = self.fav_override.clone();
        let is_fav = move |s: &Station| ov.get(&s.id).copied().unwrap_or_else(|| favs_all.iter().any(|f| f.id == s.id));
        let favs_all2: Vec<Station> = self.ensure_json("/radio/favourites", cx).ready().map(|v| stations_of(v)).unwrap_or_default();
        let favs: Vec<Station> = favs_all2.iter().filter(|s| is_fav(s)).cloned().collect();
        let (cols, card_w) = grid_dims(cw, 168., 22., 2);
        let mut rows = vec![Row::Head, Row::Search, Row::Chips];
        if !favs.is_empty() { rows.push(Row::FavHead); rows.push(Row::Favs); }
        rows.push(Row::ResHead);
        if failed { rows.push(Row::State("error")); } else if loading { rows.push(Row::State("loading")); } else if results.is_empty() { rows.push(Row::State("empty")); }
        else { for r in 0..results.len().div_ceil(cols) { rows.push(Row::Grid(r)); } }
        rows.push(Row::Space);
        let n = rows.len();
        let zone = self.zone_name();
        let find = self.radio_find.clone();
        let heading = if !q.is_empty() { format!("Results for \u{201c}{q}\u{201d}") } else if let Some(t) = &tag { format!("{}{} stations", t[..1].to_uppercase(), &t[1..]) } else { "All stations".into() };
        let count = results.len();
        let row: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            Row::Head => padded(v_flex().pt(px(28.)).mb(px(20.)).child(h_flex().gap(px(6.)).items_center().text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT3)).child(icon("radio", 13., c(TEXT3))).child("INTERNET RADIO")).child(page_title("Radio")).child(div().mt(px(4.)).text_size(px(14.)).text_color(c(TEXT3)).child(format!("Live stations from the whole world, playing on {zone}.")))).into_any_element(),
            Row::Search => padded(h_flex().h(px(44.)).w(px(720.)).max_w_full().mb(px(14.)).pl(px(16.)).pr(px(12.)).gap(px(10.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3))
                .child(icon("search", 17., c(TEXT3))).child(div().flex_1().min_w_0().text_size(px(14.5)).child(Input::new(&find).appearance(false).cleanable(false)))).into_any_element(),
            Row::Chips => padded(h_flex().flex_wrap().gap(px(8.)).mb(px(22.)).children(GENRES.iter().map(|g| {
                let on = this.radio_tag.as_deref() == Some(*g);
                let g2 = g.to_string();
                div().id(SharedString::from(format!("rg-{g}"))).h(px(30.)).px(px(14.)).flex().items_center().rounded_full().cursor_pointer().text_size(px(12.5)).font_weight(w(500.)).bg(if on { ca(ACCENT, 0.22) } else { wh(0.08) }).text_color(if on { c(ACCENT2) } else { c(TEXT2) }).hover(|s| s.bg(wh(0.14))).child(format!("{}{}", g[..1].to_uppercase(), &g[1..]))
                    .on_click(cx.listener(move |this, _, _, cx| { this.radio_tag = if this.radio_tag.as_deref() == Some(g2.as_str()) { None } else { Some(g2.clone()) }; cx.notify(); }))
            }))).into_any_element(),
            Row::FavHead => padded(sec_head("Favourites", Some(div().text_size(px(12.5)).text_color(c(TEXT3)).child(favs.len().to_string()).into_any_element()))).into_any_element(),
            Row::Favs => { let cards: Vec<AnyElement> = favs.iter().map(|s| this.station_card(s, 168., true, window, cx)).collect(); v_flex().pb(px(36.)).child(this.hscroll("radio-favs", cards, cx)).into_any_element() }
            Row::ResHead => padded(sec_head(&heading, if !loading { Some(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{} {}", count, if count == 1 { "station" } else { "stations" })).into_any_element()) } else { None })).into_any_element(),
            Row::State(s) => padded(match *s {
                "error" => empty("Could not load radio stations", "The radio directory may be unreachable."),
                "empty" => empty("No stations found", "Try another name, tag or country."),
                _ => h_flex().gap(px(22.)).children((0..cols).map(|_| skeleton_card(card_w))),
            }).into_any_element(),
            Row::Grid(r) => {
                let mut line_ = h_flex().items_start().gap(px(22.)).h(px(card_w + 92.));
                for s in results.iter().skip(r * cols).take(cols) { let fav = is_fav(s); line_ = line_.child(this.station_card(s, card_w, fav, window, cx)); }
                padded(line_).into_any_element()
            }
            Row::Space => bottom_space(),
        });
        self.list_page(format!("radio:{q}:{tag:?}"), ((cols as u64) << 8) | n as u64, n, row, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn st(id: &str) -> Station { Station { id: id.into(), name: id.into(), ..Default::default() } }
    #[::core::prelude::v1::test]
    fn the_three_searches_merge_without_repeats() {
        let m = merge_stations(vec![vec![st("a"), st("b")], vec![st("b"), st("c")], vec![st("a")]], 90);
        assert_eq!(m.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(merge_stations(vec![(0..100).map(|i| st(&i.to_string())).collect()], 90).len(), 90);
    }
    #[::core::prelude::v1::test]
    fn the_tag_line_falls_back_to_the_country() {
        let mut s = st("a");
        assert_eq!(station_tags(&s), "Internet radio");
        s.country = Some("Norway".into());
        assert_eq!(station_tags(&s), "Norway");
        s.tags = vec!["jazz".into(), "soul".into()];
        assert_eq!(station_tags(&s), "jazz \u{b7} soul");
    }
}
