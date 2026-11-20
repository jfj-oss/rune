//! Text with links, marks and bold runs inside one flowing paragraph (the "run-based text element" of PORT-PLAN.md phase 3):
//! GPUI's `StyledText` lays the whole paragraph out as one piece and `InteractiveText` reports clicks on the ranges that are
//! links, so a link wraps across lines like in the web. Also: the serif prose block with "Read more".
use crate::rune::*;
use crate::route::*;
use crate::theme::*;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Go(Route),
    Open(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Plain,
    Bold,
    Muted,
    /// a highlighted term (the review preview marks where the critic is mentioned)
    Mark,
    Link(Act),
}

/// A paragraph as runs; `text()` is what is laid out.
#[derive(Clone, Default, Debug)]
pub struct Runs {
    text: String,
    spans: Vec<(Range<usize>, Kind)>,
}

impl Runs {
    pub fn new() -> Runs { Runs::default() }
    pub fn push(&mut self, s: &str, kind: Kind) -> &mut Self {
        if s.is_empty() { return self; }
        let start = self.text.len();
        self.text.push_str(s);
        if kind != Kind::Plain { self.spans.push((start..self.text.len(), kind)); }
        self
    }
    pub fn plain(&mut self, s: &str) -> &mut Self { self.push(s, Kind::Plain) }
    pub fn link(&mut self, s: &str, act: Act) -> &mut Self { self.push(s, Kind::Link(act)) }
    pub fn text(&self) -> &str { &self.text }
    pub fn links(&self) -> Vec<(Range<usize>, Act)> { self.spans.iter().filter_map(|(r, k)| if let Kind::Link(a) = k { Some((r.clone(), a.clone())) } else { None }).collect() }
    /// Marks over a text: the ranges `ranges` of `s`, the rest plain.
    pub fn with_marks(s: &str, ranges: &[Range<usize>]) -> Runs {
        let mut r = Runs::new();
        let mut at = 0;
        for m in ranges { if m.start >= at && m.end <= s.len() { r.plain(&s[at..m.start]); r.push(&s[m.clone()], Kind::Mark); at = m.end; } }
        r.plain(&s[at..]);
        r
    }
}

/// Open a web address in the user's browser (a click on a source link; never run by the tests).
pub fn open_url(url: &str) {
    if std::env::var("RUNE_DESKTOP_NO_OPEN").is_ok() || !(url.starts_with("https://") || url.starts_with("http://")) { return; }
    let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(cmd).arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

impl Rune {
    pub fn run_act(&mut self, a: &Act, cx: &mut Context<Self>) {
        match a { Act::Go(r) => self.go(r.clone(), cx), Act::Open(u) => open_url(u) }
    }

    /// One paragraph of runs, linked ranges clickable. `color` is the plain text colour.
    pub fn rich_text(&self, id: impl Into<ElementId>, runs: &Runs, color: Hsla, cx: &mut Context<Self>) -> AnyElement {
        let links = runs.links();
        let mut hl: Vec<(Range<usize>, HighlightStyle)> = vec![];
        for (r, k) in &runs.spans {
            let st = match k {
                Kind::Bold => HighlightStyle { font_weight: Some(w(700.)), color: Some(c(TEXT)), ..Default::default() },
                Kind::Muted => HighlightStyle { color: Some(c(TEXT3)), ..Default::default() },
                Kind::Mark => HighlightStyle { background_color: Some(ca(ACCENT, 0.28)), color: Some(c(TEXT)), ..Default::default() },
                Kind::Link(_) => HighlightStyle { color: Some(c(ACCENT2)), underline: Some(UnderlineStyle { thickness: px(1.), color: Some(ca(ACCENT2, 0.55)), wavy: false }), ..Default::default() },
                Kind::Plain => continue,
            };
            hl.push((r.clone(), st));
        }
        let styled = StyledText::new(runs.text().to_string()).with_highlights(hl);
        if links.is_empty() { return div().text_color(color).child(styled).into_any_element(); }
        let me = cx.entity();
        let acts: Vec<Act> = links.iter().map(|l| l.1.clone()).collect();
        div().text_color(color).child(InteractiveText::new(id, styled).on_click(links.into_iter().map(|l| l.0).collect(), move |ix, _w, app| {
            let a = acts[ix].clone();
            me.update(app, |this, cx| this.run_act(&a, cx));
        })).into_any_element()
    }
}

/// How many text lines a prose needs in a column `width` px wide at `size` px (an estimate: serif averages 0.47 em a letter).
pub fn est_lines(text: &str, width: f32, size: f32) -> usize {
    let per = (width / (size * 0.47)).max(8.) as usize;
    text.split("\n\n").map(|p| p.chars().count().div_ceil(per).max(1)).sum::<usize>() + text.split("\n\n").count().saturating_sub(1) * 6 / 10
}

impl Rune {
    /// Serif prose folded to `lines` lines; "Read more" opens it (scrolling inside when it is long), "Show less" folds it back.
    pub fn prose(&mut self, key: &str, text: &str, lines: usize, width: f32, cx: &mut Context<Self>) -> AnyElement {
        const SIZE: f32 = 17.;
        const LH: f32 = 28.9;
        let width = width.min(SIZE * 0.55 * 70.);
        let need = est_lines(text, width, SIZE);
        let overflow = need > lines + 1;
        let open = self.prose_open.contains(key);
        let paras: Vec<AnyElement> = text.split("\n\n").enumerate().map(|(i, p)| div().when(i > 0, |d| d.mt(px(SIZE))).child(p.to_string()).into_any_element()).collect();
        let body = v_flex().w(px(width)).max_w_full().font_family(SERIF).text_size(px(SIZE)).line_height(px(LH)).text_color(c(0xdcdce3)).children(paras);
        let clip: AnyElement = if open {
            let cap = 560.;
            if (need as f32) * LH > cap { div().id(SharedString::from(format!("pro-{key}"))).max_h(px(cap)).overflow_y_scroll().child(body).into_any_element() } else { body.into_any_element() }
        } else if overflow {
            div().relative().max_h(px(LH * lines as f32)).overflow_hidden().child(body)
                .child(div().absolute().left_0().right_0().bottom_0().h(px(LH * 2.4)).bg(linear_gradient(180., linear_color_stop(ca(BG, 0.), 0.), linear_color_stop(ca(BG, 1.), 1.)))).into_any_element()
        } else { body.into_any_element() };
        let k = key.to_string();
        v_flex().child(clip)
            .when(overflow, |d| d.child(div().id(SharedString::from(format!("rm-{key}"))).mt(px(8.)).text_size(px(13.5)).font_weight(w(600.)).text_color(c(ACCENT2)).cursor_pointer().hover(|s| s.underline()).child(if open { "Show less" } else { "Read more" })
                .on_click(cx.listener(move |this, _, _, cx| { if !this.prose_open.remove(&k) { this.prose_open.insert(k.clone()); } cx.notify(); }))))
            .into_any_element()
    }
}
