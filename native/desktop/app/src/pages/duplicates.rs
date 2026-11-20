//! Duplicates (web `pages/Duplicates.tsx`): groups of albums that look like the same release stored more than once, a
//! recommended version in each, "Hide the others" / "Keep all", and the list of hidden albums with Unhide.
use super::*;
use serde_json::Value;

pub fn kind_label(k: &str) -> &'static str { match k { "release-group" => "Same release", "same-title" => "Same title and tracks", _ => "Matching release and tracks" } }

pub fn version_detail(v: &Value) -> String {
    let mut p: Vec<String> = vec![];
    if let Some(f) = v.get("format").and_then(|x| x.as_str()).filter(|f| !f.is_empty()) { p.push(f.into()); }
    let t = v.get("trackCount").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    p.push(plural(t, "track"));
    let d = v.get("discCount").and_then(|x| x.as_u64()).unwrap_or(1);
    if d > 1 { p.push(format!("{d} discs")); }
    p.join(" \u{b7} ")
}

fn sv(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string() }

impl Rune {
    pub fn hide_albums(&mut self, ids: Vec<String>, hide: bool, what: String, cx: &mut Context<Self>) {
        if ids.is_empty() { return; }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_spawn(async move { for id in ids { client.send_json(if hide { "POST" } else { "DELETE" }, &format!("/albums/{}/hide", rune_mini_core::commands::encode(&id)), None)?; } Ok::<_, String>(()) }).await;
            let _ = this.update(cx, move |me, cx| { me.forget_json("/library/duplicates"); for l in me.data.albums.values_mut() { l.at = None; } me.say(if r.is_ok() { what } else { "That did not work".to_string() }, cx); });
        }).detach();
    }

    pub fn duplicates_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let slot = self.ensure_json("/library/duplicates", cx);
        let d = slot.ready().cloned();
        let err = matches!(slot, crate::data::Slot::Err(_)) && d.is_none();
        let groups: Vec<Value> = d.as_ref().and_then(|d| d.get("groups")).and_then(|g| g.as_array()).cloned().unwrap_or_default();
        let scanned = d.as_ref().and_then(|d| d.get("albumsScanned")).and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        let body_w = cw.min(960.);
        enum R { Head, State(&'static str), Note, Group(usize), HiddenHead, Hidden(usize, usize), Space }
        let mut rows = vec![R::Head];
        let mut hidden: Vec<(usize, usize)> = vec![];
        for (gi, g) in groups.iter().enumerate() { for (vi, v) in g.get("albums").and_then(|a| a.as_array()).cloned().unwrap_or_default().iter().enumerate() { if v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) { hidden.push((gi, vi)); } } }
        if err { rows.push(R::State("error")); } else if d.is_none() { rows.push(R::State("loading")); }
        else { rows.push(R::Note); if groups.is_empty() { rows.push(R::State("empty")); } else { for gi in 0..groups.len() { rows.push(R::Group(gi)); } } if !hidden.is_empty() { rows.push(R::HiddenHead); for (a, b) in &hidden { rows.push(R::Hidden(*a, *b)); } } }
        rows.push(R::Space);
        let n = rows.len();
        let sub = if d.is_some() { format!("{} \u{b7} {} scanned", plural(groups.len(), "group"), plural(scanned, "album")) } else { " ".into() };
        let row: RowFn = Box::new(move |this, ix, window, cx| {
            let wrap = |inner: AnyElement| div().w_full().pl(px(PAD)).pr(px(PAD)).child(div().w(px(body_w)).max_w_full().mx_auto().child(inner)).into_any_element();
            match &rows[ix] {
                R::Head => wrap(page_head("Duplicates", &sub, Some(div().id("dup-rescan").child(btn("Rescan", Some("refresh-cw"), false)).on_click(cx.listener(|this, _, _, cx| { this.forget_json("/library/duplicates"); cx.notify(); })).into_any_element())).into_any_element()),
                R::State(s) => wrap(match *s { "error" => fail(cx, "Could not check for duplicates", "Is the rune server running?"), "empty" => empty("No duplicates found", "Every album in your library looks distinct. Rescan after adding new folders."), _ => div().h(px(120.)) }.into_any_element()),
                R::Note => wrap(div().mb(px(18.)).max_w(px(720.)).text_size(px(13.5)).text_color(c(TEXT2)).child("These albums look like the same release stored more than once. rune compares folder names, tags and track lists; hiding a version keeps its files on disk but takes it out of the library views.").into_any_element()),
                R::Group(gi) => {
                    let g = groups[*gi].clone();
                    let best = sv(&g, "bestAlbumId");
                    let vers: Vec<Value> = g.get("albums").and_then(|a| a.as_array()).cloned().unwrap_or_default();
                    let others: Vec<String> = vers.iter().filter(|v| sv(v, "albumId") != best && !v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false)).map(|v| sv(v, "albumId")).collect();
                    let hid: Vec<String> = vers.iter().filter(|v| v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false)).map(|v| sv(v, "albumId")).collect();
                    let title = sv(&g, "title");
                    let mut col = v_flex().gap(px(12.)).p(px(20.)).mb(px(18.)).rounded(px(16.)).bg(surface()).border_1().border_color(line())
                        .child(h_flex().justify_between().items_start().child(v_flex().child(div().text_size(px(19.)).font_family(SERIF).font_weight(w(600.)).child(title.clone())).child(div().text_size(px(13.5)).text_color(c(TEXT2)).child(sv(&g, "artist")))).child(chip(kind_label(&sv(&g, "kind")))))
                        .child(h_flex().gap(px(8.)).items_center().text_size(px(13.)).text_color(c(TEXT2)).child(icon("badge-check", 16., c(OK))).child(sv(&g, "reason")));
                    for (vi, v) in vers.iter().enumerate() {
                        let (aid, vt) = (sv(v, "albumId"), sv(v, "title"));
                        let is_best = aid == best;
                        let hidden_v = v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false);
                        let img = this.cover(&aid, None, 52., window);
                        let (a2, t2) = (aid.clone(), vt.clone());
                        let line_ = [v.get("year").and_then(|y| y.as_i64()).map(|y| y.to_string()), Some(version_detail(v))].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} ");
                        col = col.child(h_flex().gap(px(14.)).p(px(10.)).items_center().rounded(px(12.)).border_1().border_color(if is_best { ca(OK, 0.5) } else { line() }).when(hidden_v, |d| d.opacity(0.6))
                            .child(cover_el(img, &aid, &vt, 52., R_SM))
                            .child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.5)).font_weight(w(600.)).child(vt.clone())).child(div().text_size(px(12.5)).text_color(c(TEXT2)).child(line_))
                                .child(div().truncate().text_size(px(12.)).text_color(c(TEXT3)).child(sv(v, "folderName")))
                                .child(h_flex().gap(px(6.)).mt(px(3.)).children(is_best.then(|| badge("Recommended", false).text_color(c(OK)))).children(hidden_v.then(|| badge("Hidden", false))).children((!v.get("hasCover").and_then(|x| x.as_bool()).unwrap_or(true)).then(|| badge("No cover", false)))))
                            .child(if is_best { div().text_size(px(13.)).font_weight(w(600.)).text_color(c(OK)).child("Best pick").into_any_element() } else if hidden_v { div().id(SharedString::from(format!("unh-{gi}-{vi}"))).child(btn("Unhide", None, false)).on_click(cx.listener(move |this, _, _, cx| this.hide_albums(vec![a2.clone()], false, format!("Unhid \u{201c}{t2}\u{201d}"), cx))).into_any_element() } else { div().into_any_element() }));
                    }
                    let (o2, t3, h2, t4) = (others.clone(), title.clone(), hid.clone(), title.clone());
                    col = col.child(h_flex().gap(px(10.)).justify_end().pt(px(4.))
                        .child(div().id(SharedString::from(format!("keep-{gi}"))).child(btn("Keep all", Some("check"), false)).when(hid.is_empty(), |d| d.opacity(0.4)).on_click(cx.listener(move |this, _, _, cx| { let n = h2.len(); this.hide_albums(h2.clone(), false, format!("Kept {} of \u{201c}{t4}\u{201d}", plural(n, "version")), cx) })))
                        .child(div().id(SharedString::from(format!("hide-{gi}"))).child(btn(&format!("Hide the others{}", if others.is_empty() { String::new() } else { format!(" ({})", others.len()) }), Some("eye-off"), true)).when(others.is_empty(), |d| d.opacity(0.4)).on_click(cx.listener(move |this, _, _, cx| { let n = o2.len(); this.hide_albums(o2.clone(), true, format!("Hid {} of \u{201c}{t3}\u{201d}", plural(n, "version")), cx) }))));
                    wrap(col.into_any_element())
                }
                R::HiddenHead => wrap(v_flex().pt(px(20.)).child(sec_head("Hidden albums", Some(div().text_size(px(12.)).text_color(c(TEXT3)).child(hidden.len().to_string()).into_any_element()))).child(div().text_size(px(13.5)).text_color(c(TEXT3)).mb(px(10.)).child("Hidden versions stay on disk but are left out of the album grid. Bring one back at any time.")).into_any_element()),
                R::Hidden(gi, vi) => {
                    let g = &groups[*gi];
                    let v = g.get("albums").and_then(|a| a.get(*vi)).cloned().unwrap_or(Value::Null);
                    let (aid, vt) = (sv(&v, "albumId"), sv(&v, "title"));
                    let img = this.cover(&aid, None, 44., window);
                    let (a2, t2) = (aid.clone(), vt.clone());
                    wrap(h_flex().gap(px(12.)).py(px(8.)).items_center().child(cover_el(img, &aid, &vt, 44., R_SM)).child(v_flex().flex_1().min_w_0().child(div().truncate().text_size(px(14.)).font_weight(w(600.)).child(vt)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{} \u{b7} {}", sv(g, "title"), version_detail(&v)))))
                        .child(div().id(SharedString::from(format!("hu-{gi}-{vi}"))).child(btn("Unhide", None, false)).on_click(cx.listener(move |this, _, _, cx| this.hide_albums(vec![a2.clone()], false, format!("Unhid \u{201c}{t2}\u{201d}"), cx)))).into_any_element())
                }
                R::Space => bottom_space(),
            }
        });
        self.list_page("duplicates".into(), ((cw as u64) << 8) | n as u64 | (u64::from(d.is_some()) << 40), n, row, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn versions_and_kinds_read_like_the_web() {
        assert_eq!(kind_label("release-group"), "Same release");
        assert_eq!(kind_label("other"), "Matching release and tracks");
        assert_eq!(version_detail(&serde_json::json!({"format": "FLAC 24/96", "trackCount": 12, "discCount": 2})), "FLAC 24/96 \u{b7} 12 tracks \u{b7} 2 discs");
        assert_eq!(version_detail(&serde_json::json!({"trackCount": 1})), "1 track");
    }
}
