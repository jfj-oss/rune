//! The review preview (web `ReviewPreview.tsx`, `lib/previews.ts`): a side sheet that shows a critic score, a review excerpt or
//! a stored text with where it came from, and where the stored reception mentions the critic. The web can also show the
//! original page in an iframe; here "Open original" hands the address to the browser instead.
use crate::albumlogic::*;
use crate::rune::*;
use crate::text::*;
use crate::theme::*;
use crate::widgets::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

#[derive(Clone, Debug)]
pub struct Context_ {
    pub source: String,
    pub url: String,
    pub sentences: Vec<String>,
    pub terms: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Preview {
    pub kind: &'static str,
    pub label: String,
    pub title: String,
    pub author: Option<String>,
    pub quote: Option<String>,
    pub text: Option<String>,
    pub url: String,
    pub score: Option<Score>,
    pub context: Option<Context_>,
    pub attribution: Option<String>,
}

fn context_for(d: Option<&Details>, outlet: &str, author: Option<&str>) -> Option<Context_> {
    let rec = d?.reception.as_ref()?;
    let terms = terms_for(outlet, author);
    let sentences = sentences_mentioning(&rec.value, &terms, 3);
    (!sentences.is_empty()).then(|| Context_ { source: rec.source.clone(), url: rec.url.clone(), sentences, terms })
}

pub fn quote_preview(q: &Quote, d: Option<&Details>) -> Preview {
    Preview { kind: "quote", label: "Review excerpt".into(), title: q.outlet.clone(), author: q.author.clone(), quote: Some(q.quote.clone()), text: None, url: q.url.clone(), score: None, context: context_for(d, &q.outlet, q.author.as_deref()), attribution: None }
}

fn okey(o: &str) -> String { o.to_lowercase().trim_start_matches("the ").trim().to_string() }

pub fn score_preview(s: &Score, d: Option<&Details>) -> Preview {
    let q = d.and_then(|d| d.quotes.iter().find(|x| okey(&x.outlet) == okey(&s.outlet)));
    Preview { kind: "score", label: "Critic score".into(), title: s.outlet.clone(), author: q.and_then(|q| q.author.clone()), quote: q.map(|q| q.quote.clone()), text: None, url: s.url.clone(), score: Some(s.clone()), context: context_for(d, &s.outlet, q.and_then(|q| q.author.as_deref())), attribution: None }
}

/// Whether a score's popup has any words: the outlet's own excerpt or a mention in the stored reception.
pub fn score_has_text(s: &Score, d: Option<&Details>) -> bool {
    let p = score_preview(s, d);
    p.quote.is_some() || p.context.is_some()
}

pub fn text_preview(label: &str, title: &str, src: &Sourced) -> Preview {
    Preview { kind: "text", label: label.into(), title: title.into(), author: None, quote: None, text: Some(src.value.clone()), url: src.url.clone(), score: None, context: None, attribution: Some(src.source.clone()) }
}

fn host_of(url: &str) -> String { url.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").trim_start_matches("www.").to_string() }

impl Rune {
    pub fn preview_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.preview.clone().unwrap();
        let vh = f32::from(window.viewport_size().height);
        let url = p.url.clone();
        let host = host_of(&p.url);
        let mut body = v_flex().gap(px(18.));
        if let Some(s) = &p.score {
            let n = normalize_score(s);
            let tone = match score_tone(n) { Tone::High => c(OK), Tone::Mid => c(WARN), Tone::Low => c(BAD) };
            body = body.child(v_flex().gap(px(8.))
                .child(h_flex().items_baseline().gap(px(4.)).child(div().text_size(px(40.)).font_weight(w(700.)).text_color(tone).child(format_score_value(s))).child(div().text_size(px(16.)).text_color(c(TEXT3)).child(score_suffix(s)))
                    .child(div().ml(px(10.)).text_size(px(13.)).text_color(c(TEXT3)).child(format!("{}/100{}", n.round() as i64, s.review_count.map(|r| format!(" \u{b7} {r} reviews")).unwrap_or_default()))))
                .child(div().h(px(5.)).w_full().rounded(px(3.)).bg(wh(0.10)).child(div().h_full().w(relative((n / 100.) as f32)).rounded(px(3.)).bg(tone))));
        }
        if let Some(q) = &p.quote {
            body = body.child(v_flex().gap(px(10.)).child(div().font_family(SERIF).italic().text_size(px(19.)).line_height(px(29.)).child(format!("\u{201c}{q}\u{201d}")))
                .child(div().text_size(px(13.)).text_color(c(TEXT3)).child(format!("\u{2014} {}{}", p.title, p.author.as_ref().map(|a| format!(", {a}")).unwrap_or_default()))));
        }
        if let Some(cx_) = &p.context {
            let mut col = v_flex().gap(px(10.)).child(eyebrow(&format!("In {}\u{2019}s reception text", cx_.source)));
            for (i, s) in cx_.sentences.iter().enumerate() {
                let runs = Runs::with_marks(s, &match_ranges(s, &cx_.terms));
                col = col.child(div().pl(px(12.)).border_l_2().border_color(ca(ACCENT, 0.5)).font_family(SERIF).text_size(px(16.)).line_height(px(26.)).child(self.rich_text(SharedString::from(format!("pv-ctx-{i}")), &runs, c(0xdcdce3), cx)));
            }
            body = body.child(col);
        }
        if let Some(t) = &p.text {
            let paras: Vec<AnyElement> = t.split("\n\n").enumerate().map(|(i, x)| div().when(i > 0, |d| d.mt(px(14.))).child(x.to_string()).into_any_element()).collect();
            body = body.child(v_flex().font_family(SERIF).text_size(px(16.5)).line_height(px(27.)).text_color(c(0xdcdce3)).children(paras));
        }
        if p.quote.is_none() && p.text.is_none() && p.context.is_none() && p.score.is_some() {
            body = body.child(div().text_size(px(14.)).text_color(c(TEXT2)).child("rune has no text for this score. The outlet\u{2019}s page has the review."));
        }
        let sheet = v_flex().absolute().top_0().right_0().h(px(vh - NPBAR_H)).w(px(480.)).bg(c(0x14151c)).border_l_1().border_color(wh(0.14)).occlude()
            .shadow(vec![BoxShadow { inset: false, color: bk(0.5), offset: point(px(-24.), px(0.)), blur_radius: px(60.), spread_radius: px(0.) }])
            .child(h_flex().flex_none().items_start().justify_between().gap(px(12.)).pl(px(24.)).pr(px(14.)).pt(px(22.)).pb(px(14.)).border_b_1().border_color(line())
                .child(v_flex().min_w_0().gap(px(4.)).child(eyebrow(&p.label)).child(div().text_size(px(21.)).font_weight(w(700.)).child(p.title.clone())))
                .child(div().id("pv-close").role(Role::Button).aria_label("Close").child(btn_icon("x", 20., c(TEXT2), false)).on_click(cx.listener(|this, _, _, cx| { this.preview = None; cx.notify(); }))))
            .child(div().id("pv-body").flex_1().min_h_0().overflow_y_scroll().px(px(24.)).py(px(20.)).child(body))
            .child(h_flex().flex_none().items_center().justify_between().gap(px(12.)).px(px(24.)).py(px(14.)).border_t_1().border_color(line())
                .child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(p.attribution.clone().map(|a| format!("From {a}")).unwrap_or(host.clone())))
                .when(!url.is_empty(), |d| d.child(div().id("pv-open").child(btn(&format!("Open {}", if host.is_empty() { "original".to_string() } else { host.clone() }), Some("external-link"), false)).on_click(cx.listener(move |_, _, _, _| open_url(&url))))));
        div().absolute().top_0().left_0().size_full().child(div().id("pv-away").absolute().size_full().bg(ca(0x06060a, 0.4)).occlude().on_click(cx.listener(|this, _, _, cx| { this.preview = None; cx.notify(); }))).child(sheet)
    }
}
