//! The page backdrop (web `Ambient.tsx` + `FoilBackdrop.tsx`): "Foil waves", crisp at device resolution.
//!
//! Default: ONE custom shader (`shaders/foil.wgsl` / `foil.metal`, through the shader hook of the vendored GPUI, see
//! vendor/PATCH.md) draws the whole picture per device pixel on the GPU, at the display's frame rate. The CPU path below is the
//! fallback (Prefs::software, `RUNE_DESKTOP_FOIL=software`, or no renderer support): the picture is put together from what GPUI
//! does without shaders (see [`crate::foil`]), all at device resolution and moved or swapped as whole images:
//!  * the background (a field woven of fine dark diagonal dashes, stray pixels) is ONE pre-rendered image, made once per window
//!    size on a worker thread and then only slid by whole device pixels (up and to the right, as the field drifts),
//!  * the wave bands (soft glow + strips with separators, ragged tops and bottoms, brightness that varies along each strip, glints)
//!    and the moon (stippled periwinkle, glints, a faint glow) are drawn by the worker into one transparent overlay image per frame.
//! The UI thread only swaps images. Nothing is drawn at a lower resolution and then scaled. Frames are only asked for while
//! they can be seen: never with the backdrop off, never under "Reduce effects" (one still frame), and, with "Battery saver"
//! (on by default here), never while the window is not the active one (minimised, hidden or behind another). A paused backdrop
//! only wakes twice a second.
use crate::foil;
use crate::theme::*;
use futures::StreamExt;
use gpui_kit::*;
use std::cell::RefCell;
use std::rc::Rc;
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
    /// Draw on the CPU (the worker thread and images below) instead of the GPU shader. Also the fallback when the shader
    /// cannot be used. Default off; `RUNE_DESKTOP_FOIL=software` forces it.
    pub software: bool,
}

impl Default for Prefs { fn default() -> Self { Prefs { on: true, reduce: false, saver: true, software: false } } }

/// Should frames be drawn right now? The one rule the whole backdrop follows (unit tested).
pub fn animating(p: Prefs, window_active: bool) -> bool { p.on && !p.reduce && (!p.saver || window_active) }

/// Should a frame be drawn although nothing moves (first paint, resize, a setting changed)? Only the backdrop being on matters.
pub fn needs_still(p: Prefs, shown: Option<Sig>, want: Sig) -> bool { p.on && shown != Some(want) }

/// `RUNE_DESKTOP_FOIL_BARE=1` (test tool): only the backdrop, without the app, the tint and the edge shading.
pub fn bare() -> bool { std::env::var_os("RUNE_DESKTOP_FOIL_BARE").is_some() }

/// The GPU shader of the backdrop (registered once at start, see [`register_shaders`]).
pub const FOIL_SHADER: ShaderId = ShaderId(0x464F_494C);

/// Registers the app's custom shaders with the (patched) GPUI. Call once, before the first window.
pub fn register_shaders() {
    register_shader(FOIL_SHADER, ShaderSource { wgsl: include_str!("shaders/foil.wgsl"), msl: include_str!("shaders/foil.metal") });
}

/// The animation state of the GPU path, shared with the paint closure (the clock advances while frames are painted).
struct Anim {
    t: f32,
    last: Option<Instant>,
    was_live: bool,
    /// frames are being requested right now (so the timer need not wake the view)
    running: bool,
    /// the shader cannot be used (build failed, or the renderer does not know custom shaders): use the CPU path
    failed: bool,
    first_paint: Option<Instant>,
    frozen: bool,
    cols_w: usize,
    cols: Vec<foil::Col>,
}

/// What a drawn frame was made for: physical size, scale (bits), still or moving.
pub type Sig = (u32, u32, u32, bool);

fn rgba(c: [f32; 3], a: f32) -> Hsla {
    Rgba { r: c[0] / 255.0, g: c[1] / 255.0, b: c[2] / 255.0, a: a.clamp(0.0, 1.0) }.into()
}

enum Job { Dust(usize, usize), Waves { w: usize, h: usize, scale: f32, t: f32, cols: Arc<Vec<foil::Col>> } }
enum Done { Dust { w: usize, h: usize, bytes: Vec<u8> }, Fade { w: usize, h: usize, bytes: Vec<u8> }, Waves { w: usize, h: usize, bytes: Vec<u8> } }

pub struct Backdrop {
    pub prefs: Prefs,
    dust: Option<(Arc<RenderImage>, usize, usize)>,
    fade: Option<(Arc<RenderImage>, usize, usize)>,
    /// the physical size the dust image was made for (or is being made for)
    dust_for: Option<(u32, u32)>,
    waves: Option<(Arc<RenderImage>, usize, usize)>,
    waves_in_flight: bool,
    cols: Arc<Vec<foil::Col>>,
    tx: Sender<Job>,
    /// seconds of animation; only advances while frames are drawn, so the waves carry on where they stopped
    t: f32,
    last: Instant,
    was_animating: bool,
    shown: Option<Sig>,
    size: (f32, f32),
    scale: f32,
    /// frames handed to the screen (tests / measurements)
    pub drawn: u64,
    anim: Rc<RefCell<Anim>>,
    _tasks: Vec<Task<()>>,
}

impl Backdrop {
    pub fn new(prefs: Prefs, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = channel::<Job>();
        let (dtx, mut drx) = futures::channel::mpsc::unbounded::<Done>();
        std::thread::Builder::new().name("rune-foil".into()).spawn(move || {
            let mut moon = foil::MoonCache::default();
            while let Ok(first) = rx.recv() {
                // only the newest request of each kind matters; the dust (rare) goes first
                let (mut dust, mut waves) = (None, None);
                for j in std::iter::once(first).chain(rx.try_iter()) { match j { Job::Dust(..) => dust = Some(j), Job::Waves { .. } => waves = Some(j) } }
                for j in [dust, waves].into_iter().flatten() { if run(j, &dtx, &mut moon).is_err() { return; } }
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
            prefs, dust: None, fade: None, dust_for: None, waves: None, waves_in_flight: false, cols: Arc::new(vec![]), tx, t: t0, last: Instant::now(),
            was_animating: false, shown: None, size: (0., 0.), scale: 1., drawn: 0, anim: Rc::new(RefCell::new(Anim { t: t0, last: None, was_live: false, running: false, failed: false, first_paint: None, frozen: std::env::var_os("RUNE_DESKTOP_FOIL_FREEZE").is_some(), cols_w: 0, cols: vec![] })), _tasks: vec![recv, tick],
        }
    }

    pub fn set_prefs(&mut self, p: Prefs, cx: &mut Context<Self>) {
        if p == self.prefs { return; }
        self.prefs = p;
        cx.notify();
    }

    fn got(&mut self, d: Done, window: &mut Window, cx: &mut Context<Self>) {
        match d {
            Done::Dust { w, h, bytes } => {
                if !self.prefs.on { self.dust_for = None; return; }
                let Some(rgba) = image::RgbaImage::from_raw(w as u32, h as u32, bytes) else { return };
                let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
                if let Some((old, _, _)) = self.dust.replace((new, w, h)) { let _ = window.drop_image(old); }
            }
            Done::Fade { w, h, bytes } => {
                if !self.prefs.on { return; }
                let Some(rgba) = image::RgbaImage::from_raw(w as u32, h as u32, bytes) else { return };
                let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
                if let Some((old, _, _)) = self.fade.replace((new, w, h)) { let _ = window.drop_image(old); }
            }
            Done::Waves { w, h, bytes } => {
                self.waves_in_flight = false;
                if !self.prefs.on { return; }
                let Some(rgba) = image::RgbaImage::from_raw(w as u32, h as u32, bytes) else { return };
                let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
                if let Some((old, _, _)) = self.waves.replace((new, w, h)) { let _ = window.drop_image(old); }
            }
        }
        self.drawn += 1;
        cx.notify();
    }

    fn drop_images(&mut self, window: &mut Window) {
        if let Some((i, _, _)) = self.dust.take() { let _ = window.drop_image(i); }
        if let Some((i, ..)) = self.waves.take() { let _ = window.drop_image(i); }
        if let Some((i, ..)) = self.fade.take() { let _ = window.drop_image(i); }
        self.dust_for = None;
        self.shown = None;
    }

    /// Called on a timer: keeps the images for the current size, advances the clock, asks for a repaint when one is wanted,
    /// and says how long to sleep.
    /// Is the backdrop drawn by the GPU shader (the default) rather than by the CPU path?
    fn gpu(&self) -> bool {
        !self.prefs.software && !self.anim.borrow().failed && std::env::var("RUNE_DESKTOP_FOIL").map(|v| v != "software").unwrap_or(true)
    }

    /// The timer of the GPU path: frames are requested by the painter itself while it can be seen; this only starts them again
    /// (window active again, a setting changed) and notices a shader that cannot be used.
    fn tick_gpu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Duration {
        if self.dust.is_some() || self.waves.is_some() || self.fade.is_some() { self.drop_images(window); }
        let live = animating(self.prefs, window.is_window_active());
        let running = self.anim.borrow().running;
        if live && !running { cx.notify(); }
        if !live && running { self.anim.borrow_mut().running = false; }
        Duration::from_millis(500)
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Duration {
        if self.prefs.on && self.gpu() { return self.tick_gpu(window, cx); }
        if self.prefs.on && self.anim.borrow().failed { cx.notify(); }
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
        if self.cols.len() != pw as usize { self.cols = Arc::new(foil::columns(pw as usize)); }
        // the dust image: once per window size, on the worker
        if self.dust_for != Some((pw, ph)) {
            self.dust_for = Some((pw, ph));
            let c = foil::DUST_CYCLE as usize;
            let _ = self.tx.send(Job::Dust(pw as usize + c, ph as usize + c));
        }
        let sig: Sig = (pw, ph, scale.to_bits(), !self.prefs.reduce);
        // the waves: one overlay per frame from the worker (skipped while it is still busy with the last one)
        if (live || needs_still(self.prefs, self.shown, sig)) && !self.waves_in_flight {
            self.shown = Some(sig);
            self.waves_in_flight = true;
            let _ = self.tx.send(Job::Waves { w: pw as usize, h: ph as usize, scale, t, cols: self.cols.clone() });
        }
        if live { Duration::from_secs_f32(1.0 / foil::FPS) } else { Duration::from_millis(500) }
    }
}

impl Backdrop {
    /// The GPU path: one shader quad over the whole window; the tint and edge shading go on top as before.
    fn render_gpu(&mut self, root: Div) -> Div {
        let (anim, prefs) = (self.anim.clone(), self.prefs);
        let quad = shader_quad(FOIL_SHADER, move |bounds, window| {
            let scale = window.scale_factor();
            let (pw, ph) = ((f32::from(bounds.size.width) * scale).round(), (f32::from(bounds.size.height) * scale).round());
            let mut a = anim.borrow_mut();
            let now = Instant::now();
            // a shader that is not ready after a moment (an old or unsupported renderer) or failed: the CPU path takes over
            let first = *a.first_paint.get_or_insert(now);
            match shader_status(FOIL_SHADER) {
                ShaderStatus::Failed(e) => { if !a.failed { eprintln!("rune: the foil shader could not be built, drawing the backdrop on the CPU instead: {e}"); } a.failed = true }
                ShaderStatus::Pending if now.duration_since(first) > Duration::from_millis(1500) => { if !a.failed { eprintln!("rune: this renderer does not run custom shaders, drawing the backdrop on the CPU instead"); } a.failed = true }
                _ => {}
            }
            let live = animating(prefs, window.is_window_active());
            let dt = a.last.map(|l| now.duration_since(l).as_secs_f32()).unwrap_or(0.0);
            a.last = Some(now);
            if live && a.was_live && !a.frozen { a.t = foil::clock(a.t + dt.min(0.5)); }
            a.was_live = live;
            a.running = live;
            if live { window.request_animation_frame(); } else if a.failed { window.request_animation_frame(); }
            if a.cols_w != pw as usize { a.cols = foil::columns(pw as usize); a.cols_w = pw as usize; }
            let t = if prefs.reduce { foil::STILL_T } else { a.t };
            foil::gpu_data(pw, ph, scale, t, &a.cols).into()
        });
        let root = root.child(quad.absolute().top_0().left_0().size_full());
        if bare() { return root; }
        root
            // the plain tint that keeps text readable, and a dark vignette at the edges
            .child(div().absolute().top_0().left_0().size_full().bg(ca(0x030612, 0.28)))
            .child(div().absolute().top_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(180., linear_color_stop(ca(0x05091a, 0.5), 0.), linear_color_stop(ca(0x05091a, 0.), 1.))))
            .child(div().absolute().bottom_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(0., linear_color_stop(ca(0x05091a, 0.5), 0.), linear_color_stop(ca(0x05091a, 0.), 1.))))
            .child(div().absolute().top_0().left_0().h_full().w(relative(0.25)).bg(linear_gradient(90., linear_color_stop(ca(0x05091a, 0.5), 0.), linear_color_stop(ca(0x05091a, 0.), 1.))))
            .child(div().absolute().top_0().right_0().h_full().w(relative(0.25)).bg(linear_gradient(270., linear_color_stop(ca(0x05091a, 0.5), 0.), linear_color_stop(ca(0x05091a, 0.), 1.))))
    }
}

impl Render for Backdrop {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let root = div().absolute().top_0().left_0().size_full().overflow_hidden();
        if self.prefs.on && self.gpu() { return self.render_gpu(root); }
        if !self.prefs.on || self.size.0 == 0. { return root; }
        let t = if self.prefs.reduce { foil::STILL_T } else { self.t };
        let (w, h, scale) = (self.size.0, self.size.1, self.scale);
        let (dust, fade, waves) = (self.dust.clone(), self.fade.clone(), self.waves.clone());
        let edge = |a: f32| ca(0x05091a, a);
        root.child(canvas(|_, _, _| (), move |bounds, _, window, _| paint(window, bounds, scale, t, dust, fade, waves)).absolute().top_0().left_0().size_full())
            // the plain tint that keeps text readable, and a dark vignette at the edges
            .child(div().absolute().top_0().left_0().size_full().bg(ca(0x030612, 0.28)))
            .child(div().absolute().top_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(180., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().bottom_0().left_0().w_full().h(relative(0.3)).bg(linear_gradient(0., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().top_0().left_0().h_full().w(relative(0.25)).bg(linear_gradient(90., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
            .child(div().absolute().top_0().right_0().h_full().w(relative(0.25)).bg(linear_gradient(270., linear_color_stop(edge(0.5), 0.), linear_color_stop(edge(0.), 1.))))
    }
}

fn run(j: Job, tx: &futures::channel::mpsc::UnboundedSender<Done>, moon: &mut foil::MoonCache) -> Result<(), ()> {
    let d = match j {
        Job::Dust(w, h) => {
            // the fade to black belongs to the screen (not to the drifting dust image): its size is the dust image minus the margin
            let c = foil::DUST_CYCLE as usize;
            tx.unbounded_send(Done::Fade { w: w - c, h: h - c, bytes: foil::fade_image(w - c, h - c) }).map_err(|_| ())?;
            Done::Dust { w, h, bytes: foil::dust_image(w, h) }
        }
        Job::Waves { w, h, scale, t, cols } => { let mut b = vec![0u8; w * h * 4]; foil::render_waves(w, h, scale, t, &cols, &mut b, moon); Done::Waves { w, h, bytes: b } }
    };
    tx.unbounded_send(d).map_err(|_| ())
}

fn paint(window: &mut Window, bounds: Bounds<Pixels>, scale: f32, t: f32, dust: Option<(Arc<RenderImage>, usize, usize)>, fade: Option<(Arc<RenderImage>, usize, usize)>, waves: Option<(Arc<RenderImage>, usize, usize)>) {
    let o = bounds.origin;
    let at = |x: f32, y: f32| point(o.x + px(x), o.y + px(y));
    window.paint_quad(fill(bounds, rgba(foil::BASE, 1.0))); // (the dust image covers it; the base shows before the image is ready)
    let shift = foil::shift_at(t);
    if let Some((img, iw, ih)) = dust {
        // screen pixel (x, y) shows image pixel (x - shift + CYCLE, y + shift): the image sits at (shift - CYCLE, -shift)
        let origin = at((shift - foil::DUST_CYCLE) as f32 / scale, -(shift as f32) / scale);
        let image_bounds = Bounds { origin, size: size(px(iw as f32 / scale), px(ih as f32 / scale)) };
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), img, 0, false);
    }
    if let Some((img, iw, ih)) = fade {
        // the fade to black over the dust (the waves and the moon dim themselves)
        let image_bounds = Bounds { origin: at(0., 0.), size: size(px(iw as f32 / scale), px(ih as f32 / scale)) };
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), img, 0, false);
    }
    if let Some((img, iw, ih)) = waves {
        let image_bounds = Bounds { origin: at(0., 0.), size: size(px(iw as f32 / scale), px(ih as f32 / scale)) };
        let _ = window.paint_image(bounds, image_bounds, Corners::default(), img, 0, false);
    }
}

/// The window's root view: the page colour, the backdrop, and the app on top. The app view is CACHED, so a frame of the
/// animated backdrop does not rebuild the whole app (GPUI replays the app's last frame unless the app itself changed).
pub struct Root { pub rune: Entity<crate::rune::Rune>, pub backdrop: Entity<Backdrop> }

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> AnyElement {
        let mut full = StyleRefinement::default();
        full.size.width = Some(relative(1.).into());
        full.size.height = Some(relative(1.).into());
        if bare() { return div().relative().size_full().bg(c(BG)).child(self.backdrop.clone()).into_any_element(); }
        div().relative().size_full().bg(c(BG)).child(self.backdrop.clone()).child(AnyView::from(self.rune.clone()).cached(full)).into_any_element()
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

    /// The hook's WGSL prelude (vendor/gpui-pre-wgpu-0.3.12/src/custom_shader.rs) declares these; the app's source must be valid after them.
    #[test]
    fn foil_wgsl_is_valid() {
        let prelude = "struct GlobalParams { viewport_size: vec2<f32>, premultiplied_alpha: u32, pad: u32, }\n@group(0) @binding(0) var<uniform> globals: GlobalParams;\n@group(1) @binding(0) var<storage, read> U: array<f32>;\nfn ud(i: u32) -> f32 { return U[12u + i]; }\n";
        let src = format!("{prelude}{}", include_str!("shaders/foil.wgsl"));
        let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).expect("validates");
        assert!(include_str!("shaders/foil.metal").contains("float4 custom_fs(float2 pos, constant float* U)"));
    }

    #[test]
    fn defaults_are_on_and_saving() {
        assert_eq!(Prefs::default(), Prefs { on: true, reduce: false, saver: true, software: false });
    }
}
