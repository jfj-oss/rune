//! The album page's sections below the tracks (web `components/album/*`): Review (reception prose, scores, quotes), About
//! (editions facts and table, artist notes, background), Credits, Your plays, Connections, and the hero's critic scores.
use super::*;
use crate::albumlogic::*;
use crate::charts::*;
use crate::preview::*;
use crate::text::*;
use rune_mini_core::library::{Album, LibTrack};
use serde_json::Value;
use std::sync::Arc;

/// Everything the album page reads besides the album itself, as the server last said (None = not there or still loading).
#[derive(Clone, Default)]
pub struct Extra {
    pub details: Option<Arc<Details>>,
    pub details_loading: bool,
    pub editions: Option<Arc<Value>>,
    pub editions_loading: bool,
    pub plays: Option<Arc<Value>>,
    pub plays_loading: bool,
    pub connections: Option<Arc<Value>>,
}

impl Rune {
    pub fn album_extra(&mut self, id: &str, cx: &mut Context<Self>) -> Extra {
        let e = rune_mini_core::commands::encode(id);
        let d = self.ensure_json(&format!("/albums/{e}/details"), cx);
        let ed = self.ensure_json(&format!("/albums/{e}/editions"), cx);
        let pl = self.ensure_json(&format!("/stats/album/{e}?period=all"), cx);
        let co = self.ensure_json(&format!("/albums/{e}/connections"), cx);
        let ready = |s: &crate::data::Slot<Value>| s.ready().cloned();
        Extra {
            details: ready(&d).and_then(|v| serde_json::from_value::<Details>((*v).clone()).ok()).map(Arc::new),
            details_loading: matches!(d, crate::data::Slot::Loading),
            editions: ready(&ed),
            editions_loading: matches!(ed, crate::data::Slot::Loading),
            plays: ready(&pl),
            plays_loading: matches!(pl, crate::data::Slot::Loading),
            connections: ready(&co),
        }
    }
}

fn tone_color(t: Tone) -> Hsla { match t { Tone::High => c(OK), Tone::Mid => c(WARN), Tone::Low => c(BAD) } }

pub fn sec_title(t: &str) -> Div { section_head(t) }

pub fn source_line(this: &Rune, id: &str, source: &str, preview: Preview, cx: &mut Context<Rune>) -> AnyElement {
    let _ = this;
    div().mt(px(12.)).text_size(px(12.5)).text_color(c(TEXT3)).child(h_flex().gap(px(4.)).child("From")
        .child(div().id(SharedString::from(id.to_string())).text_color(c(TEXT2)).cursor_pointer().hover(|s| s.text_color(c(ACCENT2))).child(format!("{source} \u{203a}"))
            .on_click(cx.listener(move |this, _, _, cx| { this.preview = Some(preview.clone()); cx.notify(); })))).into_any_element()
}

impl Rune {
    fn legend(&self) -> Div {
        h_flex().flex_wrap().gap(px(12.)).mb(px(8.)).text_size(px(12.)).text_color(c(TEXT2))
            .child(div().font_weight(w(600.)).text_color(c(OK)).child("75+ high")).child(div().font_weight(w(600.)).text_color(c(WARN)).child("55\u{2013}74 mid")).child(div().font_weight(w(600.)).text_color(c(BAD)).child("under 55 low"))
            .child(div().text_color(c(TEXT3)).child("Every score is scaled to 100 first."))
    }

    fn score_chip(&self, s: &Score, d: &Details, i: usize, cx: &mut Context<Self>) -> AnyElement {
        let n = normalize_score(s);
        let has = score_has_text(s, Some(d));
        let (sc, dd, url) = (s.clone(), d.clone(), s.url.clone());
        h_flex().id(SharedString::from(format!("chip-{i}"))).h(px(36.)).pl(px(12.)).pr(px(14.)).gap(px(8.)).items_baseline().self_center().rounded_full().bg(bk(0.6)).border_1().border_color(wh(0.12)).cursor_pointer().hover(|s| s.bg(bk(0.75)))
            .child(h_flex().items_baseline().child(div().text_size(px(16.)).font_weight(w(700.)).text_color(tone_color(score_tone(n))).child(format_score_value(s))).child(div().text_size(px(11.)).opacity(0.6).child(score_suffix(s))))
            .child(div().text_size(px(12.5)).font_weight(w(500.)).text_color(c(TEXT2)).child(s.outlet.clone()))
            .when(!has, |d| d.child(icon("external-link", 12., c(TEXT3))))
            .on_click(cx.listener(move |this, _, _, cx| { if has { this.preview = Some(score_preview(&sc, Some(&dd))); cx.notify(); } else { open_url(&url); } }))
            .into_any_element()
    }

    /// The hero's rating: stars, the mean, "N critic scores", the tally, and the chips when opened.
    pub fn hero_scores(&mut self, d: &Details, cx: &mut Context<Self>) -> AnyElement {
        let agg = aggregate_score(&d.scores);
        let mut tally = [0usize; 3];
        for s in &d.scores { match score_tone(normalize_score(s)) { Tone::High => tally[0] += 1, Tone::Mid => tally[1] += 1, Tone::Low => tally[2] += 1 } }
        let open = self.hscores_open;
        let pill = |n: usize, col: Hsla| div().min_w(px(22.)).h(px(22.)).px(px(6.)).flex().items_center().justify_center().rounded_full().bg(bk(0.55)).border_1().border_color(wh(0.14)).text_size(px(12.)).font_weight(w(700.)).text_color(col).child(n.to_string());
        let head = h_flex().id("hero-scores").mt(px(6.)).gap(px(10.)).items_center().cursor_pointer()
            .children(agg.map(|(stars, _, _)| h_flex().gap(px(10.)).items_center().child(div().opacity(0.8).child(glass_stars(stars, 22.))).child(div().text_size(px(17.)).font_weight(w(700.)).child(format!("{stars:.1}"))).into_any_element()))
            .child(div().text_size(px(12.5)).text_color(c(TEXT2)).child(format!("{} critic score{}", d.scores.len(), if d.scores.len() == 1 { "" } else { "s" })))
            .child(h_flex().gap(px(4.)).children((tally[0] > 0).then(|| pill(tally[0], c(OK)))).children((tally[1] > 0).then(|| pill(tally[1], c(WARN)))).children((tally[2] > 0).then(|| pill(tally[2], c(BAD)))))
            .child(icon(if open { "chevron-up" } else { "chevron-down" }, 15., c(TEXT2)))
            .on_click(cx.listener(|this, _, _, cx| { this.hscores_open = !this.hscores_open; cx.notify(); }));
        let mut col = v_flex().gap(px(8.)).child(head);
        if open {
            let chips: Vec<AnyElement> = d.scores.iter().enumerate().map(|(i, s)| self.score_chip(s, d, i, cx)).collect();
            col = col.child(h_flex().flex_wrap().gap(px(8.)).children(chips)).child(self.legend());
        }
        col.into_any_element()
    }

    fn score_row(&self, s: &Score, d: &Details, i: usize, cx: &mut Context<Self>) -> AnyElement {
        let n = normalize_score(s);
        let tone = tone_color(score_tone(n));
        let has = score_has_text(s, Some(d));
        let (sc, dd, url) = (s.clone(), d.clone(), s.url.clone());
        v_flex().id(SharedString::from(format!("srow-{i}"))).gap(px(7.)).px(px(14.)).py(px(12.)).mb(px(8.)).rounded(px(10.)).bg(wh(0.07)).border_1().border_color(ca(0xffffff, 0.0)).cursor_pointer().hover(|s| s.border_color(line()).bg(surface2()))
            .child(h_flex().justify_between().items_baseline()
                .child(h_flex().gap(px(6.)).items_center().text_size(px(13.5)).font_weight(w(500.)).child(s.outlet.clone()).child(icon(if has { "chevron-right" } else { "external-link" }, 13., c(TEXT3))))
                .child(h_flex().items_baseline().child(div().text_size(px(22.)).font_weight(w(700.)).text_color(tone).child(format_score_value(s))).child(div().text_size(px(12.)).opacity(0.55).child(score_suffix(s)))))
            .child(div().h(px(4.)).rounded(px(2.)).bg(wh(0.10)).overflow_hidden().child(div().h_full().w(relative((n / 100.) as f32)).bg(tone)))
            .children(s.review_count.map(|r| div().text_size(px(12.)).text_color(c(TEXT3)).child(format!("{} reviews", crate::util::group(r as usize)))))
            .on_click(cx.listener(move |this, _, _, cx| { if has { this.preview = Some(score_preview(&sc, Some(&dd))); cx.notify(); } else { open_url(&url); } }))
            .into_any_element()
    }

    fn quote_card(&self, q: &Quote, d: &Details, i: usize, w_: f32, cx: &mut Context<Self>) -> AnyElement {
        let (qq, dd) = (q.clone(), d.clone());
        v_flex().id(SharedString::from(format!("quote-{i}"))).w(px(w_)).flex_none().justify_between().gap(px(16.)).px(px(22.)).pt(px(22.)).pb(px(18.)).rounded(px(14.)).bg(surface()).border_1().border_color(line()).cursor_pointer().hover(|s| s.bg(surface2()).border_color(ca(ACCENT, 0.45)))
            .child(div().font_family(SERIF).italic().text_size(px(17.)).line_height(px(26.)).child(format!("\u{201c}{}\u{201d}", q.quote)))
            .child(h_flex().justify_between().items_baseline().gap(px(12.)).text_size(px(13.)).text_color(c(TEXT3))
                .child(div().child(format!("\u{2014} {}{}", q.outlet, q.author.as_ref().map(|a| format!(", {a}")).unwrap_or_default())))
                .child(h_flex().items_center().text_color(c(ACCENT2)).font_weight(w(600.)).text_size(px(12.5)).child("Read in context").child(icon("chevron-right", 13., c(ACCENT2)))))
            .on_click(cx.listener(move |this, _, _, cx| { this.preview = Some(quote_preview(&qq, Some(&dd))); cx.notify(); })).into_any_element()
    }

    /// Critical reception: the stored prose and its source, pull quotes, and the scores beside them on a wide page.
    pub fn review_section(&mut self, d: &Details, body_w: f32, cx: &mut Context<Self>) -> AnyElement {
        let wide = body_w + 2. * PAD >= 980.;
        let main_w = if wide { body_w - 56. - 320. } else { body_w };
        let mut main = v_flex().min_w_0().w(px(main_w));
        if let Some(r) = &d.reception {
            main = main.child(self.prose("review", &r.value, 10, main_w, cx)).child(source_line(self, "src-reception", &r.source, text_preview("Critical reception", "Critical reception", r), cx));
        }
        let shown = quotes_not_in_reception(&d.quotes, d.reception.as_ref().map(|r| r.value.as_str()));
        if !shown.is_empty() {
            let cols = ((main_w + 16.) / (270. + 16.)).floor().max(1.) as usize;
            let qw = (main_w - 16. * (cols as f32 - 1.)) / cols as f32;
            let cards: Vec<AnyElement> = shown.iter().enumerate().map(|(i, q)| self.quote_card(q, d, i, qw, cx)).collect();
            main = main.child(h_flex().flex_wrap().gap(px(16.)).mt(px(32.)).children(cards));
        }
        let mut row = h_flex().gap(px(56.)).items_start().child(main);
        if !d.scores.is_empty() {
            let rows: Vec<AnyElement> = d.scores.iter().enumerate().map(|(i, s)| self.score_row(s, d, i, cx)).collect();
            let aside = v_flex().w(px(if wide { 320. } else { body_w })).flex_none().gap(px(4.)).child(eyebrow("Scores").mb(px(8.))).child(self.legend()).children(rows);
            if wide { row = row.child(aside); } else { return v_flex().gap(px(36.)).child(row).child(aside).into_any_element(); }
        }
        row.into_any_element()
    }

    fn fact(&self, k: &str, v: String) -> Div {
        v_flex().gap(px(2.)).child(div().text_size(px(11.5)).font_weight(w(600.)).text_color(c(TEXT3)).child(k.to_uppercase())).child(div().text_size(px(15.)).font_weight(w(600.)).child(v))
    }

    /// The editions facts and table.
    pub fn about_meta(&mut self, ed: &Value, body_w: f32, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        let editions: Vec<Value> = ed.get("editions").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let secondary: Vec<String> = ed.get("secondaryTypes").and_then(|e| e.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let typ = s(ed, "releaseGroupType");
        let others: Vec<rune_mini_core::library::AlbumSummary> = ed.get("otherVersionsInLibrary").and_then(|o| serde_json::from_value(o.clone()).ok()).unwrap_or_default();
        let orig = s(ed, "originalReleaseDate");
        let secondary: Vec<String> = secondary.into_iter().filter(|t| Some(t.to_lowercase()) != typ.as_ref().map(|x| x.to_lowercase())).collect();
        let has_facts = orig.is_some() || typ.is_some() || !secondary.is_empty() || !editions.is_empty();
        if !has_facts && others.is_empty() { return None; }
        let mut col = v_flex().gap(px(22.));
        if has_facts {
            let mut facts = h_flex().flex_wrap().gap(px(14.)).gap_x(px(36.));
            if let Some(o) = &orig { facts = facts.child(self.fact("Originally released", format_short_date(o))); }
            if let Some(t) = &typ { facts = facts.child(self.fact("Release type", format!("{t}{}", if secondary.is_empty() { String::new() } else { format!(" \u{b7} {}", secondary.join(" \u{b7} ")) }))); }
            if !editions.is_empty() { facts = facts.child(self.fact("Editions", crate::util::plural(editions.len(), "known release"))); }
            col = col.child(facts);
        }
        if !editions.is_empty() {
            let cols: [(&str, f32); 7] = [("Title", 2.2), ("Released", 1.), ("Country", 0.7), ("Label", 1.4), ("Catalogue", 1.), ("Format", 0.9), ("Tracks", 0.6)];
            let head = h_flex().px(px(12.)).py(px(10.)).gap(px(12.)).border_b_1().border_color(line()).children(cols.iter().map(|(n, f)| div().flex_grow(*f).flex_basis(px(0.)).min_w_0().text_size(px(11.5)).font_weight(w(600.)).text_color(c(TEXT3)).child(n.to_uppercase())));
            let mut table = v_flex().w_full().max_w(px(body_w.min(1100.))).rounded(px(14.)).border_1().border_color(line()).overflow_hidden().child(head);
            for e in &editions {
                let this_one = e.get("isThisOne").and_then(|x| x.as_bool()).unwrap_or(false);
                let g = |k: &str| s(e, k).unwrap_or_else(|| "\u{2014}".into());
                let date = s(e, "date").map(|d| format_short_date(&d)).unwrap_or_else(|| "\u{2014}".into());
                let tc = e.get("trackCount").and_then(|x| x.as_u64()).unwrap_or(0).to_string();
                let cell = |t: String, f: f32, col: Hsla| div().flex_grow(f).flex_basis(px(0.)).min_w_0().truncate().text_size(px(13.)).text_color(col).child(t);
                let base = if this_one { c(TEXT) } else { c(TEXT2) };
                table = table.child(h_flex().px(px(12.)).py(px(10.)).gap(px(12.)).items_start().border_b_1().border_color(wh(0.05)).when(this_one, |d| d.bg(ca(ACCENT, 0.10)))
                    .child(h_flex().flex_grow(2.2).flex_basis(px(0.)).min_w_0().gap(px(8.)).items_center().child(div().truncate().text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT)).child(g("title"))).when(this_one, |d| d.child(badge("This one", false).text_color(c(ACCENT2)))))
                    .child(cell(date, 1., base)).child(cell(g("country"), 0.7, base)).child(cell(g("label"), 1.4, base)).child(cell(g("catalogNumber"), 1., base)).child(cell(g("format"), 0.9, base)).child(cell(tc, 0.6, base)));
            }
            col = col.child(table);
        }
        if !others.is_empty() {
            let (cols, cw_) = grid_dims(body_w, 170., 22., 2);
            let mut g = v_flex().gap(px(24.)).child(sec_head("Other versions in your library", Some(div().text_size(px(12.)).text_color(c(TEXT3)).child(crate::util::plural(others.len(), "version")).into_any_element())));
            for r in 0..others.len().div_ceil(cols) { g = g.child(this_row(self, &others, r * cols, cols, cw_, window, cx)); }
            col = col.child(g);
        }
        if orig.is_some() { col = col.child(div().text_size(px(12.5)).text_color(c(TEXT3)).child("Dates and editions from MusicBrainz.")); }
        Some(col.into_any_element())
    }

    /// The artist's notes (the one about a track first names it).
    pub fn artist_notes(&mut self, notes: &[Note], album: &Album, body_w: f32, cx: &mut Context<Self>) -> AnyElement {
        let w_ = body_w.min(760.);
        let mut col = v_flex().w(px(w_)).gap(px(40.));
        for (i, n) in notes.iter().enumerate() {
            let track: Option<&LibTrack> = n.track_id.as_ref().and_then(|t| album.tracks.iter().find(|x| &x.id == t));
            let title = track.map(|t| t.title.clone()).unwrap_or_else(|| "About the album".into());
            let head = h_flex().gap(px(12.)).items_center().mb(px(10.)).flex_wrap()
                .child(if track.is_some() { div().text_size(px(13.)).font_weight(w(600.)).text_color(c(ACCENT2)).child(title.clone()) } else { div().text_size(px(12.)).font_weight(w(600.)).text_color(c(TEXT3)).child("ABOUT THE ALBUM") })
                .when(n.verified_artist, |d| d.child(h_flex().h(px(22.)).px(px(9.)).gap(px(5.)).items_center().rounded_full().bg(ca(ACCENT, 0.22)).text_size(px(12.)).font_weight(w(600.)).text_color(c(ACCENT2)).child(icon("badge-check", 13., c(ACCENT2))).child("Verified artist")));
            let label = if n.verified_artist { "In the artist\u{2019}s words" } else { "Artist notes" };
            col = col.child(v_flex().child(head).child(self.prose(&format!("note{i}"), &n.s.value, 8, w_, cx)).child(source_line(self, &format!("src-note{i}"), &n.s.source, text_preview(label, &title, &n.s), cx)));
        }
        col.into_any_element()
    }

    pub fn credits_section(&mut self, a: &Album, body_w: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let _ = window;
        let (cols, cw_) = grid_dims(body_w, 250., 24., 1);
        let mut col = v_flex().gap(px(34.));
        for g in group_credits(&a.credits) {
            let mut grid = v_flex().gap(px(16.));
            for chunk in g.people.chunks(cols) {
                let mut r = h_flex().gap(px(24.)).items_start();
                for p in chunk {
                    let id = p.artist.id.clone();
                    let roles = p.roles.iter().map(|r| match &r.track_ids { Some(t) if !t.is_empty() => format!("{} ({})", r.role, format_track_refs(t, &a.tracks)), _ => r.role.clone() }).collect::<Vec<_>>().join(", ");
                    r = r.child(h_flex().id(SharedString::from(format!("cr-{}", p.artist.id))).w(px(cw_)).flex_none().gap(px(14.)).items_center().min_w_0().cursor_pointer()
                        .child(super::artists::avatar(&p.artist.id, &p.artist.name, 44.))
                        .child(v_flex().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).hover(|s| s.underline()).child(p.artist.name.clone())).child(div().text_size(px(12.5)).text_color(c(TEXT2)).line_height(px(17.)).child(roles)))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(Route::Person(id.clone()), cx))));
                }
                grid = grid.child(r);
            }
            col = col.child(v_flex().child(eyebrow(g.name).mb(px(14.))).child(grid));
        }
        col.into_any_element()
    }

    /// "Your plays": four tiles and the daily sparkline.
    pub fn plays_section(&mut self, st: Option<&Value>, loading: bool, body_w: f32) -> AnyElement {
        let quiet = |t: &str| div().text_size(px(13.5)).text_color(c(TEXT3)).child(t.to_string()).into_any_element();
        if loading { return div().h(px(80.)).into_any_element(); }
        let Some(s) = st else { return quiet("You haven\u{2019}t played this yet.") };
        let n = |k: &str| s.get(k).and_then(|x| x.as_f64());
        let plays = n("plays").unwrap_or(0.);
        if plays <= 0. { return quiet("No plays recorded yet."); }
        let tile = |v: String, k: &str, tw: f32| v_flex().w(px(tw)).flex_none().gap(px(3.)).p(px(16.)).rounded(px(14.)).bg(surface()).border_1().border_color(line()).child(div().truncate().text_size(px(23.)).line_height(px(26.)).font_weight(w(700.)).child(v)).child(div().text_size(px(11.5)).font_weight(w(600.)).text_color(c(TEXT3)).child(k.to_uppercase()));
        let tw = (body_w - 36.) / 4.;
        let by: Vec<(String, f64)> = s.get("byDay").and_then(|b| b.as_array()).map(|a| a.iter().filter_map(|d| Some((d.get("date")?.as_str()?.to_string(), d.get("ms")?.as_f64()?))).collect()).unwrap_or_default();
        let series = daily_series(&by, n("from"), n("to").unwrap_or(0.), 60);
        v_flex().gap(px(12.))
            .child(h_flex().gap(px(12.))
                .child(tile(crate::util::group(plays as usize), "Plays", tw)).child(tile(format_listening(n("totalMs").unwrap_or(0.)), "Listening time", tw))
                .child(tile(n("firstPlayedAt").map(format_stamp).unwrap_or_else(|| "\u{2014}".into()), "First played", tw)).child(tile(n("lastPlayedAt").map(format_stamp).unwrap_or_else(|| "\u{2014}".into()), "Last played", tw)))
            .children((series.len() > 1).then(|| div().w(px(body_w.min(720.))).mt(px(4.)).child(sparkline(series, 88.))))
            .into_any_element()
    }

    /// "Connections": albums that share people with this one, each with who ("With A (guitar), B ...", the names are links).
    pub fn connections_rows(&mut self, v: &Value, body_w: f32, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let list = v.get("connections").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let (cols, cw_) = grid_dims(body_w, 170., 20., 1);
        let mut out = vec![];
        for (ri, chunk) in list.chunks(cols).enumerate() {
            let mut r = h_flex().gap(px(20.)).items_start().pb(px(24.));
            for (ci, conn) in chunk.iter().enumerate() {
                let Some(alb) = conn.get("album").and_then(|a| serde_json::from_value::<rune_mini_core::library::AlbumSummary>(a.clone()).ok()) else { continue };
                let people = conn.get("people").and_then(|p| p.as_array()).cloned().unwrap_or_default();
                let mut runs = Runs::new();
                runs.push("With ", Kind::Muted);
                for (i, p) in people.iter().take(3).enumerate() {
                    if i > 0 { runs.push(", ", Kind::Muted); }
                    let (id, name) = (p.pointer("/artist/id").and_then(|x| x.as_str()).unwrap_or(""), p.pointer("/artist/name").and_then(|x| x.as_str()).unwrap_or(""));
                    runs.link(name, Act::Go(Route::Person(id.to_string())));
                    let roles: Vec<&str> = p.get("roles").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                    if !roles.is_empty() { runs.push(&format!(" ({})", roles.join(", ")), Kind::Muted); }
                }
                if people.len() > 3 { runs.push(&format!(" and {} more", people.len() - 3), Kind::Muted); }
                let card = self.album_card(&alb, cw_, window, cx);
                let txt = self.rich_text(SharedString::from(format!("conn-{ri}-{ci}")), &runs, c(TEXT3), cx);
                r = r.child(v_flex().w(px(cw_)).flex_none().child(card).child(div().mt(px(8.)).text_size(px(12.5)).line_height(px(18.)).child(txt)));
            }
            out.push(r.into_any_element());
        }
        out
    }
}

fn this_row(this: &mut Rune, items: &[rune_mini_core::library::AlbumSummary], start: usize, cols: usize, card_w: f32, window: &mut Window, cx: &mut Context<Rune>) -> AnyElement {
    this.album_row(items, start, items.len(), cols, card_w, 22., card_w + 64., window, cx)
}
