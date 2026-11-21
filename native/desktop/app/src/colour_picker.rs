//! A visual colour picker (the web's `<input type="color">`, drawn natively): a saturation/value square with a draggable thumb, a hue
//! strip and a hex field. Ported from native mega's paint panel: the same HSV maths, and the drag follows the pointer through
//! WINDOW-level mouse listeners, because the panel occludes the window and its own handlers cannot see a drag that leaves it.
//!
//! Reusable: the owner keeps a `State`, renders `panel(..)` (usually inside `deferred(anchored())` under a swatch), and gets a call to
//! `changed` with the new HSV each time the pointer picks.
use crate::dither::Rgb;
use crate::theme::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;

/// Hue in degrees 0..360, saturation and value 0..1.
pub type Hsv = [f32; 3];

pub fn rgb_to_hsv(c: Rgb) -> Hsv {
    let [r, g, b] = [(c[0] / 255.) as f32, (c[1] / 255.) as f32, (c[2] / 255.) as f32];
    let mx = r.max(g).max(b);
    let d = mx - r.min(g).min(b);
    let mut h = 0.;
    if d > 0. { h = if mx == r { ((g - b) / d + 6.) % 6. } else if mx == g { (b - r) / d + 2. } else { (r - g) / d + 4. }; }
    [h * 60., if mx > 0. { d / mx } else { 0. }, mx]
}

pub fn hsv_to_rgb(hsv: Hsv) -> Rgb {
    let [h, s, v] = hsv;
    let f = |n: f32| { let k = (n + h / 60.) % 6.; (v - v * s * k.min(4. - k).clamp(0., 1.)) * 255. };
    [f(5.).round().clamp(0., 255.) as f64, f(3.).round().clamp(0., 255.) as f64, f(1.).round().clamp(0., 255.) as f64]
}

pub fn rgb_u32(c: Rgb) -> u32 { ((c[0].round() as u32) << 16) | ((c[1].round() as u32) << 8) | c[2].round() as u32 }

/// Where a pointer position lands in the square (left to right = saturation, top to bottom = value 1..0) and on the hue strip.
pub fn sv_at(x: f32, y: f32, b: Bounds<Pixels>) -> (f32, f32) {
    let (l, t, w, h) = (f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width).max(1.), f32::from(b.size.height).max(1.));
    (((x - l) / w).clamp(0., 1.), 1. - ((y - t) / h).clamp(0., 1.))
}
pub fn hue_at(x: f32, b: Bounds<Pixels>) -> f32 {
    let (l, w) = (f32::from(b.origin.x), f32::from(b.size.width).max(1.));
    (((x - l) / w).clamp(0., 1.) * 359.).round()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Drag { Sv, Hue }

pub struct State {
    pub hsv: Hsv,
    pub drag: Option<Drag>,
    sv: Rc<Cell<Bounds<Pixels>>>,
    hue: Rc<Cell<Bounds<Pixels>>>,
}

impl State {
    pub fn new(hsv: Hsv) -> State { State { hsv, drag: None, sv: Rc::new(Cell::new(Bounds::default())), hue: Rc::new(Cell::new(Bounds::default())) } }
    /// Follow the pointer to `pos` for the drag in progress; false when no drag is.
    pub fn drag_to(&mut self, pos: Point<Pixels>) -> bool {
        let (x, y) = (f32::from(pos.x), f32::from(pos.y));
        match self.drag {
            Some(Drag::Sv) => { let (s, v) = sv_at(x, y, self.sv.get()); self.hsv[1] = s; self.hsv[2] = v; true }
            Some(Drag::Hue) => { self.hsv[0] = hue_at(x, self.hue.get()); true }
            None => false,
        }
    }
    /// Test hook: a pick as the pointer would make, in the middle of the square / strip (fractions 0..1).
    pub fn set_sv(&mut self, s: f32, v: f32) { self.hsv[1] = s.clamp(0., 1.); self.hsv[2] = v.clamp(0., 1.); }
    pub fn set_hue(&mut self, h: f32) { self.hsv[0] = h.clamp(0., 359.); }
}

pub const PANEL_W: f32 = 232.;
const SQ_H: f32 = 140.;
const HUE_H: f32 = 14.;
const THUMB: f32 = 16.;

/// The popover's content. `get` finds the picker state inside the owner; `changed` is told the new HSV after every pick (drag or
/// click) and should recolour whatever the picker edits. The owner closes it (Esc, click outside).
pub fn panel<T: 'static>(
    st: &State,
    hex: &Entity<InputState>,
    cx: &mut Context<T>,
    get: fn(&mut T) -> Option<&mut State>,
    changed: fn(&mut T, Hsv, &mut Window, &mut Context<T>),
) -> Stateful<Div> {
    let hsv = st.hsv;
    let hue_col = rgb_u32(hsv_to_rgb([hsv[0], 1., 1.]));
    let cur = rgb_u32(hsv_to_rgb(hsv));
    let (sv_b, hue_b) = (st.sv.clone(), st.hue.clone());
    let sv = div().id("cp-sv").relative().w_full().h(px(SQ_H)).cursor_crosshair()
        .child(canvas({ let b = sv_b.clone(); move |bb, _, _| b.set(bb) }, move |bb, _, window, _| {
            let rr = |mut q: PaintQuad| { q.corner_radii = Corners::all(px(8.)); q };
            window.paint_quad(rr(fill(bb, c(hue_col))));
            window.paint_quad(rr(fill(bb, linear_gradient(90., linear_color_stop(c(0xffffff), 0.), linear_color_stop(ca(0xffffff, 0.), 1.)))));
            window.paint_quad(rr(fill(bb, linear_gradient(180., linear_color_stop(ca(0x000000, 0.), 0.), linear_color_stop(c(0x000000), 1.)))));
        }).absolute().top_0().left_0().size_full())
        .child(div().absolute().left(relative(hsv[1])).top(relative(1. - hsv[2])).ml(px(-THUMB / 2.)).mt(px(-THUMB / 2.)).size(px(THUMB)).rounded_full().border_2().border_color(c(0xffffff)).bg(c(cur)).shadow(vec![BoxShadow { inset: false, color: bk(0.5), offset: point(px(0.), px(1.)), blur_radius: px(3.), spread_radius: px(0.) }]))
        .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
            let Some(s) = get(this) else { return };
            s.drag = Some(Drag::Sv); s.drag_to(ev.position);
            let h = s.hsv; changed(this, h, window, cx); cx.stop_propagation();
        }));
    let hue = div().id("cp-hue").relative().w_full().h(px(HUE_H)).mt(px(10.)).cursor_pointer()
        .child(canvas({ let b = hue_b.clone(); move |bb, _, _| b.set(bb) }, move |bb, _, window, _| {
            let stops = [0xff0000u32, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xff0000];
            let (x, y, w, h) = (f32::from(bb.origin.x), f32::from(bb.origin.y), f32::from(bb.size.width), f32::from(bb.size.height));
            let seg = w / 6.;
            for i in 0..6 {
                let b = Bounds::new(point(px(x + seg * i as f32), px(y)), size(px(seg + if i < 5 { 0.5 } else { 0. }), px(h)));
                let mut q = fill(b, linear_gradient(90., linear_color_stop(c(stops[i]), 0.), linear_color_stop(c(stops[i + 1]), 1.)));
                let r = px(h / 2.);
                if i == 0 { q.corner_radii = Corners { top_left: r, bottom_left: r, top_right: px(0.), bottom_right: px(0.) }; }
                if i == 5 { q.corner_radii = Corners { top_left: px(0.), bottom_left: px(0.), top_right: r, bottom_right: r }; }
                window.paint_quad(q);
            }
        }).absolute().top_0().left_0().size_full())
        .child(div().absolute().left(relative(hsv[0] / 359.)).top(px(-(THUMB - HUE_H) / 2.)).ml(px(-THUMB / 2.)).size(px(THUMB)).rounded_full().border_2().border_color(c(0xffffff)).bg(c(hue_col)).shadow(vec![BoxShadow { inset: false, color: bk(0.5), offset: point(px(0.), px(1.)), blur_radius: px(3.), spread_radius: px(0.) }]))
        .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
            let Some(s) = get(this) else { return };
            s.drag = Some(Drag::Hue); s.drag_to(ev.position);
            let h = s.hsv; changed(this, h, window, cx); cx.stop_propagation();
        }));
    // the panel occludes, so the page's own handlers cannot see a drag that leaves it: listen on the window instead
    let me = cx.entity();
    let follow = canvas(|_, _, _| (), move |_, _, window, _| {
        let m = me.clone();
        window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
            if phase != DispatchPhase::Capture { return; }
            m.update(cx, |this, cx| {
                let Some(s) = get(this) else { return };
                if s.drag.is_none() { return; }
                if ev.pressed_button.is_none() { s.drag = None; return; }
                s.drag_to(ev.position);
                let h = s.hsv; changed(this, h, window, cx);
            });
        });
        let m = me.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
            if phase != DispatchPhase::Capture { return; }
            m.update(cx, |this, _| { if let Some(s) = get(this) { s.drag = None; } });
        });
    }).absolute().size_0();
    v_flex().id("cp-panel").w(px(PANEL_W)).p(px(12.)).gap(px(2.)).rounded(px(12.)).bg(c(0x1b1c24)).border_1().border_color(wh(0.16)).occlude()
        .shadow(vec![BoxShadow { inset: false, color: bk(0.55), offset: point(px(0.), px(14.)), blur_radius: px(36.), spread_radius: px(0.) }])
        .text_color(c(TEXT)).text_size(px(13.))
        .on_scroll_wheel(cx.listener(|_, _, _, cx| cx.stop_propagation()))
        .child(follow).child(sv).child(hue)
        .child(h_flex().mt(px(10.)).gap(px(8.)).items_center()
            .child(div().size(px(26.)).flex_none().rounded(px(6.)).border_1().border_color(wh(0.25)).bg(c(cur)))
            .child(div().h(px(32.)).flex_1().min_w_0().px(px(10.)).flex().items_center().rounded_full().bg(surface2()).border_1().border_color(line()).child(div().flex_1().child(Input::new(hex).appearance(false).cleanable(false)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn hsv_round_trips_primaries_and_greys() {
        for c in [[255., 0., 0.], [0., 255., 0.], [0., 0., 255.], [255., 255., 255.], [0., 0., 0.], [90., 42., 158.], [255., 122., 61.], [128., 128., 128.]] {
            assert_eq!(hsv_to_rgb(rgb_to_hsv(c)), c, "{c:?}");
        }
        assert_eq!(rgb_to_hsv([255., 0., 0.]), [0., 1., 1.]);
        let g = rgb_to_hsv([0., 255., 0.]); assert!((g[0] - 120.).abs() < 1e-3);
        let b = rgb_to_hsv([0., 0., 255.]); assert!((b[0] - 240.).abs() < 1e-3);
        assert_eq!(rgb_to_hsv([128., 128., 128.])[1], 0.);
    }
    #[::core::prelude::v1::test]
    fn hex_through_hsv() {
        let c = crate::dither::parse_hex("#5a2a9e").unwrap();
        assert_eq!(crate::dither::to_hex(hsv_to_rgb(rgb_to_hsv(c))), "#5a2a9e");
        assert_eq!(rgb_u32(c), 0x5a2a9e);
        // every 8-bit colour survives the trip (the hex field and the square agree)
        for v in (0..=255).step_by(5) { for u in (0..=255).step_by(17) { for w in (0..=255).step_by(51) { let c = [v as f64, u as f64, w as f64]; assert_eq!(hsv_to_rgb(rgb_to_hsv(c)), c); } } }
    }
    #[::core::prelude::v1::test]
    fn pointer_maps_into_the_square_and_strip_and_clamps_outside() {
        let b = Bounds::new(point(px(100.), px(50.)), size(px(200.), px(100.)));
        assert_eq!(sv_at(100., 50., b), (0., 1.));      // top left: no saturation, full value
        assert_eq!(sv_at(300., 150., b), (1., 0.));     // bottom right
        assert_eq!(sv_at(200., 100., b), (0.5, 0.5));
        assert_eq!(sv_at(-500., 900., b), (0., 0.));    // far outside (a drag that left the square) clamps
        assert_eq!(sv_at(900., -500., b), (1., 1.));
        assert_eq!(hue_at(100., b), 0.);
        assert_eq!(hue_at(300., b), 359.);
        assert_eq!(hue_at(5000., b), 359.);
        assert_eq!(hue_at(-5., b), 0.);
    }
    #[::core::prelude::v1::test]
    fn dragging_outside_keeps_following() {
        let mut s = State::new([0., 0., 0.]);
        s.sv.set(Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.))));
        assert!(!s.drag_to(point(px(50.), px(50.))));
        s.drag = Some(Drag::Sv);
        assert!(s.drag_to(point(px(250.), px(-40.))));
        assert_eq!((s.hsv[1], s.hsv[2]), (1., 1.));
    }
}
