//! People (web `pages/People.tsx`) and Person (`pages/Person.tsx`): everyone credited on something in the library, and one
//! person's page: roles, albums as artist, every album credit with the tracks, and who they often work with.
use super::*;
use super::artists::avatar;
use gpui_kit::component::input::Input;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersonCard { #[serde(default)] pub id: String, #[serde(default)] pub name: String, #[serde(default)] pub album_count: usize, #[serde(default)] pub roles: Vec<String> }

pub const BUCKETS: [(&str, &str); 5] = [("all", "All"), ("producers", "Producers"), ("engineers", "Engineers"), ("musicians", "Musicians"), ("composers", "Composers")];

/// `roleBucketOf`: producers first (an "Executive Producer" is a producer), then engineering, then writing; the rest perform.
pub fn role_bucket(role: &str) -> &'static str {
    let r = role.to_lowercase();
    if r.contains("produc") { "producers" }
    else if ["engineer", "mix", "master", "record"].iter().any(|k| r.contains(k)) { "engineers" }
    else if ["compos", "lyric", "writ", "songwrit", "arrang"].iter().any(|k| r.contains(k)) { "composers" }
    else { "musicians" }
}

pub fn person_in_bucket(roles: &[String], bucket: &str) -> bool { bucket == "all" || roles.iter().any(|r| role_bucket(r) == bucket) }

enum Row { Head, Tools, State(&'static str), Grid(usize), Space }

impl Rune {
    pub fn people_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let slot = self.ensure_json("/people", cx);
        let all: Vec<PersonCard> = slot.ready().and_then(|v| serde_json::from_value((**v).clone()).ok()).unwrap_or_default();
        let loading = matches!(slot, crate::data::Slot::Loading);
        let err = matches!(slot, crate::data::Slot::Err(_));
        let (bucket, needle) = (self.people_bucket, fold(&self.people_q));
        let list: Vec<PersonCard> = all.iter().filter(|p| person_in_bucket(&p.roles, bucket) && (needle.is_empty() || fold(&p.name).contains(&needle))).cloned().collect();
        let (cols, card_w) = grid_dims(cw, 270., 16., 1);
        let mut rows = vec![Row::Head, Row::Tools];
        if err { rows.push(Row::State("error")); } else if loading { rows.push(Row::State("loading")); } else if list.is_empty() { rows.push(Row::State("empty")); }
        else { for r in 0..list.len().div_ceil(cols) { rows.push(Row::Grid(r)); } }
        rows.push(Row::Space);
        let n = rows.len();
        let sub = if loading { " ".to_string() } else if list.len() == all.len() { plural_people(all.len()) } else { format!("{} of {}", list.len(), plural_people(all.len())) };
        let find = self.people_find.clone();
        let q = self.people_q.clone();
        let row: RowFn = Box::new(move |this, ix, window, cx| match &rows[ix] {
            Row::Head => padded(page_head("People", &sub, None)).into_any_element(),
            Row::Tools => padded(h_flex().gap(px(14.)).items_center().flex_wrap().mb(px(22.))
                .child(h_flex().h(px(36.)).w(px(300.)).pl(px(14.)).pr(px(8.)).gap(px(8.)).items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_color(c(TEXT3)).child(icon("search", 16., c(TEXT3))).child(div().flex_1().min_w_0().text_size(px(14.)).child(Input::new(&find).appearance(false).cleanable(false))))
                .child(h_flex().gap(px(8.)).children(BUCKETS.iter().map(|(id, label)| {
                    let on = this.people_bucket == *id;
                    div().id(SharedString::from(format!("pb-{id}"))).h(px(30.)).px(px(14.)).flex().items_center().rounded_full().cursor_pointer().text_size(px(12.5)).font_weight(w(500.)).bg(if on { ca(ACCENT, 0.22) } else { wh(0.08) }).text_color(if on { c(ACCENT2) } else { c(TEXT2) }).hover(|s| s.bg(wh(0.14))).child(label.to_string())
                        .on_click(cx.listener(move |this, _, _, cx| { this.people_bucket = id; cx.notify(); }))
                })))).into_any_element(),
            Row::State(s) => padded(match *s { "error" => fail(cx, "Could not load people", "Is the rune server running?"), "empty" => empty("No people match", &if q.is_empty() { "No credits have been stored for this role yet.".to_string() } else { format!("Nothing for \u{201c}{q}\u{201d} in this role.") }), _ => div().h(px(120.)) }).into_any_element(),
            Row::Grid(r) => {
                let mut line_ = h_flex().items_start().gap(px(16.)).h(px(84.));
                for p in list.iter().skip(r * cols).take(cols) {
                    let id = p.id.clone();
                    line_ = line_.child(h_flex().id(SharedString::from(format!("pc-{}", p.id))).w(px(card_w)).h(px(76.)).flex_none().gap(px(14.)).px(px(12.)).items_center().rounded(px(14.)).bg(surface()).border_1().border_color(line()).cursor_pointer().hover(|s| s.bg(surface2()))
                        .child(avatar(&p.id, &p.name, 52.))
                        .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).child(p.name.clone())).child(div().text_size(px(12.5)).text_color(c(TEXT2)).child(plural(p.album_count, "album"))).child(div().truncate().text_size(px(12.)).text_color(c(TEXT3)).child(p.roles.join(" \u{b7} "))))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Person(id.clone()), cx))));
                }
                let _ = window;
                padded(line_).into_any_element()
            }
            Row::Space => bottom_space(),
        });
        let _ = window;
        self.list_page(format!("people:{bucket}:{needle}"), ((cols as u64) << 8) | n as u64, n, row, cx)
    }

    pub fn person_page(&mut self, id: String, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let slot = self.ensure_json(&format!("/people/{}", rune_mini_core::commands::encode(&id)), cx);
        let back = h_flex().id("pp-back").gap(px(2.)).items_center().mb(px(14.)).ml(px(-4.)).text_size(px(13.5)).font_weight(w(600.)).text_color(c(TEXT2)).cursor_pointer().hover(|s| s.text_color(c(TEXT))).child(icon("chevron-left", 15., c(TEXT2))).child("People").on_click(cx.listener(|this, _, _, cx| this.go(Route::People, cx)));
        let Some(v) = slot.ready().cloned() else {
            return if matches!(slot, crate::data::Slot::Err(_)) { div().size_full().pt(px(22.)).px(px(PAD)).child(back).child(empty("Person not found", "They may not be credited on anything in your library.")).into_any_element() }
            else { div().size_full().pt(px(28.)).px(px(PAD)).child(h_flex().gap(px(26.)).child(div().size(px(112.)).rounded_full().bg(surface()))).into_any_element() };
        };
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let roles: Vec<(String, usize)> = v.get("roles").and_then(|r| r.as_array()).map(|a| a.iter().map(|r| (r.get("role").and_then(|x| x.as_str()).unwrap_or("").to_string(), r.get("count").and_then(|x| x.as_u64()).unwrap_or(0) as usize)).collect()).unwrap_or_default();
        let as_artist: Vec<rune_mini_core::library::AlbumSummary> = v.get("asArtist").and_then(|a| serde_json::from_value(a.clone()).ok()).unwrap_or_default();
        let credits: Vec<Value> = v.get("credits").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let collabs: Vec<Value> = v.get("collaborators").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let body_w = cw.min(1240.);
        let (cols, card_w) = grid_dims(body_w, 170., 22., 2);
        let (n_credits, n_artist) = (credits.len(), as_artist.len());
        let mut rows: Vec<u8> = vec![0, 1]; // hero, (as artist head) ...
        let _ = &mut rows;
        enum R { Hero, ArtistHead, Artist(usize), CreditsHead, Credit(usize), NoCredits, CollabHead, Collabs, Space }
        let mut rs = vec![R::Hero];
        if n_artist > 0 { rs.push(R::ArtistHead); for r in 0..n_artist.div_ceil(cols) { rs.push(R::Artist(r)); } }
        rs.push(R::CreditsHead);
        if n_credits == 0 { rs.push(R::NoCredits); } else { for i in 0..n_credits { rs.push(R::Credit(i)); } }
        if !collabs.is_empty() { rs.push(R::CollabHead); rs.push(R::Collabs); }
        rs.push(R::Space);
        let n = rs.len();
        let pid = id.clone();
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            let wrap = |inner: AnyElement| div().w_full().pl(px(PAD)).pr(px(PAD)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element();
            match &rs[ix] {
                R::Hero => wrap(v_flex().pt(px(22.)).child(h_flex().id("pp-back2").gap(px(2.)).items_center().mb(px(14.)).ml(px(-4.)).text_size(px(13.5)).font_weight(w(600.)).text_color(c(TEXT2)).cursor_pointer().child(icon("chevron-left", 15., c(TEXT2))).child("People").on_click(cx.listener(|this, _, _, cx| this.go(Route::People, cx))))
                    .child(h_flex().gap(px(26.)).items_center().mb(px(12.)).child(avatar(&pid, &name, 112.))
                        .child(v_flex().min_w_0().gap(px(3.)).child(eyebrow("Person")).child(div().font_family(SERIF).text_size(px(44.)).line_height(px(48.)).font_weight(w(600.)).child(name.clone()))
                            .child(div().text_size(px(13.5)).text_color(c(TEXT2)).child(format!("Credited on {}{}", plural(n_credits, "album"), if n_artist > 0 { format!(" \u{b7} {} as artist", plural(n_artist, "album")) } else { String::new() })))
                            .child(h_flex().flex_wrap().gap(px(6.)).mt(px(7.)).children(roles.iter().map(|(r, c_)| h_flex().h(px(28.)).px(px(10.)).gap(px(6.)).items_center().rounded_full().bg(wh(0.07)).border_1().border_color(line()).text_size(px(12.5)).child(r.clone()).child(div().text_size(px(11.)).text_color(c(TEXT3)).child(plural(*c_, "album")))))))).into_any_element()),
                R::ArtistHead => wrap(div().pt(px(36.)).child(sec_head("As artist", Some(div().text_size(px(12.)).text_color(c(TEXT3)).child(plural(n_artist, "album")).into_any_element()))).into_any_element()),
                R::Artist(r) => wrap(this.album_row(&as_artist, r * cols, as_artist.len(), cols, card_w, 22., card_w + 86., window, cx)),
                R::CreditsHead => wrap(div().pt(px(36.)).child(sec_head("Credits", Some(div().text_size(px(12.)).text_color(c(TEXT3)).child(plural(n_credits, "album")).into_any_element()))).into_any_element()),
                R::NoCredits => wrap(div().text_size(px(13.5)).text_color(c(TEXT3)).child("No album credits stored for this person yet.").into_any_element()),
                R::Credit(i) => {
                    let cr = &credits[*i];
                    let alb: rune_mini_core::library::AlbumSummary = cr.get("album").and_then(|a| serde_json::from_value(a.clone()).ok()).unwrap_or_default();
                    let img = this.cover(&alb.id, alb.cover_url.as_deref(), 56., window);
                    let roles: Vec<String> = cr.get("roles").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                    let tracks: Vec<String> = cr.get("tracks").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|t| t.get("title").and_then(|x| x.as_str()).map(String::from)).collect()).unwrap_or_default();
                    let aid = alb.id.clone();
                    let artist_id = alb.artist.id.clone();
                    wrap(h_flex().id(SharedString::from(format!("pcr-{i}"))).gap(px(14.)).py(px(10.)).px(px(8.)).items_center().rounded(px(R)).cursor_pointer().hover(|s| s.bg(wh(0.05)))
                        .child(cover_el(img, &alb.id, &alb.title, 56., R_SM))
                        .child(v_flex().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).child(alb.title.clone()))
                            .child(h_flex().id(SharedString::from(format!("pcra-{i}"))).gap(px(0.)).text_size(px(13.)).text_color(c(TEXT2)).child(div().id(SharedString::from(format!("pcrn-{i}"))).hover(|s| s.text_color(c(TEXT)).underline()).child(alb.artist.name.clone()).on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.go(Route::Artist(artist_id.clone()), cx); }))).children(alb.year.map(|y| div().child(format!(" \u{b7} {y}")))))
                            .child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(roles.join(" \u{b7} ")))
                            .children((!tracks.is_empty()).then(|| div().truncate().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("Tracks: {}", tracks.join(", "))))))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Album(aid.clone()), cx))).into_any_element())
                }
                R::CollabHead => wrap(div().pt(px(36.)).child(sec_head("Often works with", None)).into_any_element()),
                R::Collabs => wrap(h_flex().flex_wrap().gap(px(8.)).children(collabs.iter().enumerate().map(|(i, c_)| {
                    let (cid, cname) = (c_.pointer("/artist/id").and_then(|x| x.as_str()).unwrap_or("").to_string(), c_.pointer("/artist/name").and_then(|x| x.as_str()).unwrap_or("").to_string());
                    let shared = c_.get("sharedAlbums").and_then(|x| x.as_u64()).unwrap_or(0);
                    let cid2 = cid.clone();
                    h_flex().id(SharedString::from(format!("collab-{i}"))).h(px(38.)).pl(px(6.)).pr(px(14.)).gap(px(8.)).items_center().rounded_full().bg(wh(0.08)).cursor_pointer().hover(|s| s.bg(wh(0.14))).text_size(px(13.5))
                        .child(avatar(&cid, &cname, 26.)).child(cname).child(div().text_size(px(12.)).text_color(c(TEXT3)).child(shared.to_string()))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Person(cid2.clone()), cx)))
                })).into_any_element()),
                R::Space => bottom_space(),
            }
        });
        let _ = back;
        self.list_page(format!("person:{id}"), ((cw as u64) << 8) | n as u64, n, row, cx)
    }
}

fn plural_people(n: usize) -> String { if n == 1 { "1 person".into() } else { format!("{} people", crate::util::group(n)) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn roles_fall_into_the_webs_buckets() {
        assert_eq!(role_bucket("Executive Producer"), "producers");
        assert_eq!(role_bucket("mixing engineer"), "engineers");
        assert_eq!(role_bucket("composer"), "composers");
        assert_eq!(role_bucket("guitar"), "musicians");
        assert!(person_in_bucket(&["guitar".into(), "producer".into()], "producers"));
        assert!(person_in_bucket(&[], "all") && !person_in_bucket(&[], "musicians"));
    }
}
