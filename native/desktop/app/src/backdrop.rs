//! The page backdrop (web `Ambient.tsx` + `FoilBackdrop.tsx`): "Foil waves", crisp at device resolution.
//!
//! GPUI has no custom shaders, so the picture is put together from what it does well (see [`crate::foil`]):
//!  * the background dust (fine dim diagonal dashes, stray pixels) is ONE pre-rendered image at device resolution, made once per
//!    window size on a worker thread and then only slid by whole device pixels (up and to the right, as the web's dust drifts),
//!  * the moon (the same marks, packed) is a small opaque image redrawn at each drift step,
//!  * the wave bands are painted as vector paths (soft glow) and per-device-column strips (short vertical dashes with their
//!    own top, bottom and brightness) with `paint_quad`, anti-aliased by the GPU.
//! Nothing is drawn at a lower resolution and then scaled. Frames are only asked for while they can be seen: never with the
//! backdrop off, never under "Reduce effects" (one still frame), and, with "Battery saver" (on by default here), never while
//! the window is not the active one (minimised, hidden or behind another). A paused backdrop only wakes twice a second.
use crate::foil;
use crate::theme::*;
use futures::StreamExt;
use gpui_kit::*;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The three Settings -> Background switches (the web's Background picker, Reduce effects and Battery saver).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Prefs {
    /// Foil waves on; off shows the plain dark page (the web's "Off").
    pub on: bool,
    /// Reduce effects: one still frame, no animation.
    pub reduce: bool,
    /// Battery saver: hold still while another window has focus.
    pub saver: bool,
}

impl Default for Prefs { fn default() -> Self { Prefs { on: true, reduce: false, saver: true } } }

/// Should frames be drawn right now? The one rule the whole backdrop follows (unit tested).
pub fn animating(p: Prefs, window_active: bool) -> bool { p.on && !p.reduce && (!p.saver || window_active) }

/// Should a frame be drawn although nothing moves (first paint, resize, a setting changed)? Only the backdrop being on matters.
pub fn needs_still(p: Prefs, shown: Option<Sig>, want: Sig) -> bool { p.on && shown != Some(want) }

/// What a drawn frame was made for: physical size, scale (bits), still or moving.
pub type Sig = (u32, u32, u32, bool);

fn rgba(c: [f32; 3], a: f32) -> Hsla {
    Rgba { r: c[0] / 255.0, g: c[1] / 255.0, b: c[2] / 255.0, a: a.clamp(0.0, 1.0) }.into()
}

struct Done { w: usize, h: usize, bytes: Vec<u8> }

pub struct Backdrop {
    pub prefs: Prefs,
    dust: Option<(Arc<RenderImage>, usize, usize)>,
    /// the physical size the dust image was made for (or is being made for)
    dust_for: Option<(u32, u32)>,
    moon: Option<(Arc<RenderImage>, i32, i32, usize)>,
    moon_for: Option<(u32, u32, u32, i32)>,
    strips_h: Arc<Vec<[f32; 3]>>,
    tx: Sender<(usize, usize)>,
    /// seconds of animation; only advances while frames are drawn, so the waves carry on where they stopped
    t: f32,
    last: Instant,
    was_animating: bool,
    shown: Option<Sig>,
    size: (f32, f32),
    scale: f32,
    /// frames handed to the screen (tests / measurements)
    pub drawn: u64,
    _tasks: Vec<Task<()>>,
}

impl Backdrop {
    pub fn new(prefs: Prefs, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = channel::<(usize, usize)>();
        let (dtx, mut drx) = futures::channel::mpsc::unbounded::<Done>();
        std::thread::Builder::new().name("rune-foil".into()).spawn(move || {
            while let Ok(mut j) = rx.recv() {
                while let Ok(n) = rx.try_recv() { j = n; } // only the newest request matters
                let bytes = foil::dust_image(j.0, j.1);
                if dtx.unbounded_send(Done { w: j.0, h: j.1, bytes }).is_err() { break; }
            }
        }).expect("foil thread");
        let t0 = std::env::var("RUNE_DESKTOP_FOIL_T").ok().and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
        let recv = cx.spawn_in(window, async move |this, cx| {
            while let Some(d) = drx.next().await {
                if this.update_in(cx, |b, window, cx| b.got(d, window, cx)).is_err() { break; }
            }
        });
        let tick = cx.spawn_in(window, async move |this, cx| loop {
            let wait = match this.update_in(cx, |b, window, cx| b.tick(window, cx)) { Ok(w) => w, Err(_) => break };
            cx.background_executor().timer(wait).await;
        });
        Backdrop {
            prefs, dust: None, dust_for: None, moon: None, moon_for: None, strips_h: Arc::new(vec![]), tx, t: t0, last: Instant::now(), was_animating: false,
            shown: None, size: (0., 0.), scale: 1., drawn: 0, _tasks: vec![recv, tick],
        }
    }

    pub fn set_prefs(&mut self, p: Prefs, cx: &mut Context<Self>) {
        if p == self.prefs { return; }
        self.prefs = p;
        cx.notify();
    }

    fn got(&mut self, d: Done, window: &mut Window, cx: &mut Context<Self>) {
        if !self.prefs.on { self.dust_for = None; return; }
        let Some(rgba) = image::RgbaImage::from_raw(d.w as u32, d.h as u32, d.bytes) else { return };
        let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
        if let Some((old, _, _)) = self.dust.replace((new, d.w, d.h)) { let _ = window.drop_image(old); }
        self.drawn += 1;
        cx.notify();
    }

    fn drop_images(&mut self, window: &mut Window) {
        if let Some((i, _, _)) = self.dust.take() { let _ = window.drop_image(i); }
        if let Some((i, ..)) = self.moon.take() { let _ = window.drop_image(i); }
        self.dust_for = None;
        self.moon_for = None;
        self.shown = None;
    }

    /// Called on a timer: keeps the images for the current size, advances the clock, asks for a repaint when one is wanted,
    /// and says how long to sleep.
    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Duration {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32();
        self.last = now;
        if !self.prefs.on {
            self.drop_images(window);
            self.was_animating = false;
            return Duration::from_millis(500);
        }
        let vs = window.viewport_size();
        let scale = window.scale_factor();
        let (w, h) = (f32::from(vs.width), f32::from(vs.height));
        let (pw, ph) = ((w * scale).round() as u32, (h * scale).round() as u32);
        if pw == 0 || ph == 0 { return Duration::from_millis(500); }
        let live = animating(self.prefs, window.is_window_active());
        // the clock runs only while frames are drawn, and starts counting from the second animated tick
        if live && self.was_animating { self.t = foil::clock(self.t + dt.min(0.5)); }
        self.was_animating = live;
        let t = if self.prefs.reduce { foil::STILL_T } else { self.t };
        self.size = (w, h);
        self.scale = scale;
        if self.strips_h.len() < (pw as usize).div_ceil(foil::STRIP_W as usize) + 2 { self.strips_h = Arc::new(foil::strip_hashes(pw as i32)); }
        // the dust image: once per window size, on the worker
        if self.dust_for != Some((pw, ph)) {
            self.dust_for = Some((pw, ph));
            let c = foil::DUST_CYCLE as usize;
            let _ = self.tx.send((pw as usize + c, ph as usize + c));
        }
        // the moon: tiny, redrawn at each drift step
        let shift = foil::shift_at(t);
        let msig = (pw, ph, scale.to_bits(), shift);
        if self.moon_for != Some(msig) {
            let (x0, y0, size, bytes) = foil::moon_image(w, h, scale, shift);
            if let Some(rgba) = image::RgbaImage::from_raw(size as u32, size as u32, bytes) {
                let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
                if let Some((old, ..)) = self.moon.replace((new, x0, y0, size)) { let _ = window.drop_image(old); }
            }
            self.moon_for = Some(msig);
        }
        let sig: Sig = (pw, ph, scale.to_bits(), !self.prefs.reduce);
        if live || needs_still(self.prefs, self.shown, sig) {
            self.shown = Some(sig);
            self.drawn += 1;
            cx.notify();
        }
        if live { Duration::from_secs_f32(1.0 / foil::FPS) } else { Duration::from_millis(500) }
    }
}

impl Render for Backdrop {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let root = div().absolute().top_0().left_0().size_full().overflow_hidden();
        if !self.prefs.on || self.size.0 == 0. { return root; }
        let t = if self.prefs.reduce { foil::STILL_T } else { self.t };
        let (w, h, scale) = (self.size.0, self.size.1, self.scale);
        let (dust, moon, hs) = (self.dust.clone(), self.moon.clone(), self.strips_h.clone());
        let edge = |a: f32| ca(0x05091a, a);
        root.child(canvas(|_, _, _| (), move |bounds, _, window, _| paint(window, bounds, w, h, scale, t, dust, moon, &hs)).absolute().top_0().left_0().size_full())
            // the plain tint that keeps text readable, and a dark vignette at the edges
            .child(div().absolute().top_0().left_0().size_full().bg(ca(0x030612, 0.28)))
            .child(div().absolute().top_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(180., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().bottom_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(0., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().top_0().left_0().h_full().w(relative(0.25)).bg(linear_gradient(90., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().top_0().right_0().h_full().w(relative(0.25)).bg(linear_gradient(270., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
    }
}

#[allow(clippy::too_many_arguments)]
fn paint(window: &mut Window, bounds: Bounds<Pixels>, w: f32, h: f32, scale: f32, t: f32, dust: Option<(Arc<RenderImage>, usize, usize)>, moon: Option<(Arc<RenderImage>, i32, i32, usize)>, hs: &[[f32; 3]]) {
    let o = bounds.origin;
    let at = |x: f32, y: f32| point(o.x + px(x), o.y + px(y));
    window.paint_quad(fill(bounds, rgba(foil::BASE, 1.0)));
    let shift = foil::shift_at(t);
    if let Some((img, iw, ih)) = dust {
        // screen pixel (x, y) shows image pixel (x - shift + CYCLE, y + shift): the image sits at (shift - CYCLE, -shift)
        let origin = at((shift - foil::DUST_CYCLE) as f32 / scale, -(shift as f32) / scale);
        let image_bounds = Bounds { origin, size: size(px(iw as f32 / scale), px(ih as f32 / scale)) };
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), img, 0, false);
    }
    if let Some((img, x0, y0, sz)) = moon {
        let image_bounds = Bounds { origin: at(x0 as f32 / scale, y0 as f32 / scale), size: size(px(sz as f32 / scale), px(sz as f32 / scale)) };
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), img, 0, false);
    }
    let prof: u32 = std::env::var("RUNE_FOIL_PROFILE").ok().and_then(|v| v.parse().ok()).unwrap_or(0); // measurement aid: 1 no strips, 2 no glow, 3 no waves, 4 nothing painted at all
    if prof >= 3 { return; }
    let (strips, glows) = foil::waves(w, h, scale, t, hs);
    let (strips, glows) = (if prof == 1 { vec![] } else { strips }, if prof == 2 { vec![] } else { glows });
    for g in &glows {
        // the glow's soft edge: three strokes, wide and faint to narrow and brighter
        for (width, a) in [(3.6 * foil::GLOW_SIG, 0.30), (2.0 * foil::GLOW_SIG, 0.36), (1.0 * foil::GLOW_SIG, 0.42)] {
            let mut pb = PathBuilder::stroke(px(width));
            for (i, p) in g.pts.iter().enumerate() { if i == 0 { pb.move_to(at(p.0, p.1)); } else { pb.line_to(at(p.0, p.1)); } }
            if let Ok(path) = pb.build() { window.paint_path(path, rgba(foil::WAVE, g.alpha * foil::GLOW_AMP * a)); }
        }
    }
    for s in &strips {
        // two halves, each a vertical gradient between the brightness at its ends: the strip's own profile along its height
        let (x, wd) = (s.x_dev as f32 / scale, foil::STRIP_W as f32 / scale);
        let mid = (s.top + s.bottom) / 2.0;
        for (y0, y1, a0, a1) in [(s.top, mid, s.alpha[0], s.alpha[1]), (mid, s.bottom, s.alpha[1], s.alpha[2])] {
            let bq = Bounds { origin: at(x, y0), size: size(px(wd), px(y1 - y0)) };
            window.paint_quad(fill(bq, linear_gradient(180., linear_color_stop(rgba(s.rgb, a0), 0.), linear_color_stop(rgba(s.rgb, a1), 1.))));
        }
    }
}

#[cfg(test)]
mod tests {
    // explicit names: a glob of super::* also pulls in gpui's own `test` macro
    use super::{animating, needs_still, Prefs};

    #[test]
    fn animates_only_while_it_can_be_seen() {
        let p = Prefs::default();
        assert!(animating(p, true));
        assert!(!animating(p, false), "unfocused / minimised / hidden: no frames");
        assert!(animating(Prefs { saver: false, ..p }, false), "Battery saver off: keeps moving behind other windows");
        assert!(!animating(Prefs { reduce: true, ..p }, true), "Reduce effects: no animation");
        assert!(!animating(Prefs { on: false, ..p }, true), "backdrop off: nothing");
    }

    #[test]
    fn a_still_frame_is_drawn_once_and_again_after_a_change() {
        let p = Prefs { reduce: true, ..Prefs::default() };
        let sig = (1280, 800, 1, false);
        assert!(needs_still(p, None, sig));
        assert!(!needs_still(p, Some(sig), sig));
        assert!(needs_still(p, Some(sig), (1500, 900, 1, false)), "resized");
        assert!(!needs_still(Prefs { on: false, ..p }, None, sig));
    }

    #[test]
    fn defaults_are_on_and_saving() {
        assert_eq!(Prefs::default(), Prefs { on: true, reduce: false, saver: true });
    }
}
