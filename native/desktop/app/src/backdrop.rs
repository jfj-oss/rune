//! The page backdrop (web `Ambient.tsx` + `FoilBackdrop.tsx`): "Foil waves", drawn on the CPU off the UI thread.
//!
//! A worker thread draws frames of [`crate::foil`] at a low internal resolution (about 3 px per dot), expands them to
//! whole device pixels (GPUI samples images with linear filtering and has no custom shaders, so the crisp dots are made
//! here) and hands them to the UI as a `RenderImage`; the plain dark tint goes over it. Frames are only asked for while
//! they can be seen: never with the backdrop off, never under "Reduce effects" (one still frame), and, with "Battery
//! saver" (on by default here), never while the window is not the active one (minimised, hidden or behind another).
//! A paused backdrop does nothing but wake twice a second to see whether that changed.
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

/// What a drawn frame was made for: grid, texels per dot, still or moving.
pub type Sig = (usize, usize, usize, bool);

struct Job { w: usize, h: usize, ex: usize, t: f64, sig: Sig, logical: (f32, f32) }
struct Done { w: usize, h: usize, ex: usize, bytes: Vec<u8>, sig: Sig, logical: (f32, f32) }

pub struct Backdrop {
    pub prefs: Prefs,
    img: Option<Arc<RenderImage>>,
    logical: (f32, f32),
    tx: Sender<Job>,
    in_flight: bool,
    /// seconds of animation; only advances while frames are drawn, so the waves carry on where they stopped
    t: f64,
    last: Instant,
    was_animating: bool,
    shown: Option<Sig>,
    /// frames handed to the screen (tests / measurements)
    pub drawn: u64,
    _tasks: Vec<Task<()>>,
}

impl Backdrop {
    pub fn new(prefs: Prefs, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = channel::<Job>();
        let (dtx, mut drx) = futures::channel::mpsc::unbounded::<Done>();
        std::thread::Builder::new().name("rune-foil".into()).spawn(move || {
            let mut r = foil::Renderer::new();
            while let Ok(mut j) = rx.recv() {
                while let Ok(n) = rx.try_recv() { j = n; } // only the newest request matters
                let bytes = r.frame(j.w, j.h, j.ex, j.t);
                if dtx.unbounded_send(Done { w: j.w, h: j.h, ex: j.ex, bytes, sig: j.sig, logical: j.logical }).is_err() { break; }
            }
        }).expect("foil thread");
        let t0 = std::env::var("RUNE_DESKTOP_FOIL_T").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let recv = cx.spawn_in(window, async move |this, cx| {
            while let Some(d) = drx.next().await {
                if this.update_in(cx, |b, window, cx| b.got(d, window, cx)).is_err() { break; }
            }
        });
        let tick = cx.spawn_in(window, async move |this, cx| loop {
            let wait = match this.update_in(cx, |b, window, cx| b.tick(window, cx)) { Ok(w) => w, Err(_) => break };
            cx.background_executor().timer(wait).await;
        });
        Backdrop { prefs, img: None, logical: (0., 0.), tx, in_flight: false, t: t0, last: Instant::now(), was_animating: false, shown: None, drawn: 0, _tasks: vec![recv, tick] }
    }

    pub fn set_prefs(&mut self, p: Prefs, cx: &mut Context<Self>) {
        if p == self.prefs { return; }
        self.prefs = p;
        cx.notify();
    }

    fn got(&mut self, d: Done, window: &mut Window, cx: &mut Context<Self>) {
        self.in_flight = false;
        self.shown = Some(d.sig);
        if !self.prefs.on { return; }
        let (wpx, hpx) = ((d.w * d.ex) as u32, (d.h * d.ex) as u32);
        let Some(rgba) = image::RgbaImage::from_raw(wpx, hpx, d.bytes) else { return };
        let new = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]));
        if let Some(old) = self.img.replace(new) { let _ = window.drop_image(old); }
        self.logical = d.logical;
        self.drawn += 1;
        cx.notify();
    }

    /// Called on a timer; asks the worker for a frame when one is wanted, and says how long to sleep.
    fn tick(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> Duration {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        if !self.prefs.on {
            if let Some(old) = self.img.take() { let _ = window.drop_image(old); }
            self.shown = None;
            self.was_animating = false;
            return Duration::from_millis(500);
        }
        let vs = window.viewport_size();
        let scale = window.scale_factor();
        let (pw, ph) = ((f32::from(vs.width) * scale).round() as u32, (f32::from(vs.height) * scale).round() as u32);
        if pw == 0 || ph == 0 { return Duration::from_millis(500); }
        let (w, h, dot, ex) = foil::grid_for(pw, ph, scale);
        let live = animating(self.prefs, window.is_window_active());
        // the clock runs only while frames are drawn, and starts counting from the second animated tick
        if live && self.was_animating { self.t += dt.min(0.5); }
        self.was_animating = live;
        let sig: Sig = (w, h, ex, !self.prefs.reduce);
        let logical = ((w * dot) as f32 / scale, (h * dot) as f32 / scale);
        if !self.in_flight && (live || needs_still(self.prefs, self.shown, sig)) {
            let t = if self.prefs.reduce { foil::STILL_T } else { self.t };
            self.in_flight = true;
            let _ = self.tx.send(Job { w, h, ex, t, sig, logical });
        }
        if live { Duration::from_secs_f32(1.0 / foil::FPS) } else { Duration::from_millis(500) }
    }
}

impl Render for Backdrop {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let root = div().absolute().top_0().left_0().size_full().overflow_hidden();
        let Some(i) = self.img.clone().filter(|_| self.prefs.on) else { return root };
        root.bg(c(0x05091a))
            .child(img(ImageSource::Render(i)).absolute().top_0().left_0().w(px(self.logical.0)).h(px(self.logical.1)).object_fit(ObjectFit::Fill))
            // the plain tint that keeps text readable (the web's .ambient__foiltint)
            .child(div().absolute().top_0().left_0().size_full().bg(ca(0x030612, 0.28)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let sig = (427, 267, 3, false);
        assert!(needs_still(p, None, sig));
        assert!(!needs_still(p, Some(sig), sig));
        assert!(needs_still(p, Some(sig), (500, 300, 3, false)), "resized");
        assert!(!needs_still(Prefs { on: false, ..p }, None, sig));
    }

    #[test]
    fn defaults_are_on_and_saving() {
        assert_eq!(Prefs::default(), Prefs { on: true, reduce: false, saver: true });
    }
}
