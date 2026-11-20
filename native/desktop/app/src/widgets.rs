//! Small building blocks shared by every page: icons (Lucide, the web's icon set), covers, buttons, chips, badges.
use crate::theme::*;
use crate::util::initials;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::sync::Arc;

pub fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(color)
}

/// A square cover: the picture (never cropped), or the web's initials tile while it loads / when there is none.
pub fn cover_el(img: Option<Arc<RenderImage>>, id: &str, title: &str, size: f32, radius: f32) -> Div {
    let base = div().relative().size(px(size)).flex_none().rounded(px(radius)).overflow_hidden().flex().items_center().justify_center();
    match img {
        Some(i) => base.bg(surface2()).child(img_el(i, size)),
        None => {
            let (a, b) = tile_gradient(id);
            base.bg(linear_gradient(135., linear_color_stop(a, 0.), linear_color_stop(b, 1.)))
                .child(div().font_weight(w(700.)).text_color(wh(0.7)).text_size(px((size * 0.3).clamp(11., 64.))).child(initials(title)))
        }
    }
}

fn img_el(i: Arc<RenderImage>, size: f32) -> impl IntoElement {
    img(ImageSource::Render(i)).size(px(size)).object_fit(ObjectFit::Contain)
}

pub fn eyebrow(t: &str) -> Div {
    div().text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT3)).child(t.to_uppercase())
}

pub fn badge(text: &str, spotify: bool) -> Div {
    h_flex().h(px(22.)).px(px(8.)).gap(px(6.)).items_center().rounded(px(R_SM)).bg(ca(0x0c0c10, 0.78)).border_1().border_color(wh(0.14))
        .text_size(px(11.)).font_weight(w(600.)).text_color(c(TEXT)).whitespace_nowrap()
        .when(spotify, |d| d.child(div().size(px(7.)).rounded_full().bg(c(SPOTIFY))))
        .child(text.to_string())
}

pub fn chip(text: &str) -> Div {
    h_flex().h(px(28.)).px(px(12.)).items_center().rounded_full().bg(wh(0.08)).text_size(px(12.5)).font_weight(w(500.)).text_color(c(TEXT2)).child(text.to_string())
}

/// The web's `.btn`: 40 px pill, 14/600.
pub fn btn(label: &str, icon_name: Option<&str>, primary: bool) -> Div {
    let fg = if primary { c(0x12101f) } else { c(TEXT) };
    h_flex().h(px(40.)).px(px(18.)).gap(px(8.)).items_center().justify_center().rounded_full().cursor_pointer().flex_none()
        .text_size(px(14.)).font_weight(w(600.)).text_color(fg)
        .when(primary, |d| d.bg(c(ACCENT)).hover(|s| s.bg(c(ACCENT2))))
        .when(!primary, |d| d.bg(wh(0.09)).border_1().border_color(wh(0.10)).hover(|s| s.bg(wh(0.15))))
        .when_some(icon_name, |d, n| d.child(icon(n, 18., fg)))
        .child(label.to_string())
}

/// `.btn.btn--icon`: a 40 px pill with only an icon.
pub fn btn_icon40(icon_name: &str) -> Div {
    h_flex().size(px(40.)).items_center().justify_center().rounded_full().cursor_pointer().flex_none().bg(wh(0.09)).border_1().border_color(wh(0.10)).hover(|s| s.bg(wh(0.15))).child(icon(icon_name, 20., c(TEXT)))
}

/// `.btn-icon`: a quiet 36 px round icon button.
pub fn btn_icon(icon_name: &str, size: f32, color: Hsla, on: bool) -> Div {
    h_flex().relative().size(px(36.)).items_center().justify_center().rounded_full().cursor_pointer().flex_none()
        .hover(|s| s.bg(wh(0.08)))
        .child(icon(icon_name, size, if on { c(ON) } else { color }))
        .when(on, |d| d.child(div().absolute().bottom(px(1.)).left(px(16.)).size(px(4.)).rounded_full().bg(c(ON))))
}

/// A `.sechead`: eyebrow title over a hairline.
pub fn section_head(title: &str) -> Div {
    h_flex().justify_between().items_baseline().mb(px(14.)).pb(px(10.)).border_b_1().border_color(wh(0.07)).child(eyebrow(title))
}

pub fn page_title(t: &str) -> Div {
    div().font_family(SERIF).text_size(px(37.)).line_height(px(41.)).font_weight(w(600.)).child(t.to_string())
}

pub fn text_link(label: String, color: Hsla) -> Div {
    div().text_color(color).hover(|s| s.text_color(c(TEXT)).underline()).cursor_pointer().child(label)
}

pub fn empty(title: &str, body: &str) -> Div {
    v_flex().items_center().gap(px(6.)).py(px(64.)).px(px(24.)).child(div().text_size(px(17.)).font_weight(w(600.)).child(title.to_string())).child(div().text_color(c(TEXT2)).max_w(px(520.)).child(body.to_string()))
}
