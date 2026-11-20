//! The generative art of the web (`WaveCover.tsx`, `AsciiWaves.tsx`, `lib/waveCover.ts`) on the GPU: dithered wave / ripple /
//! aurora / dunes covers for albums and playlists that have no picture, and the sparse ASCII sea behind an album hero. One shader
//! (`shaders/gen.wgsl` / `gen.metal`, through the vendored GPUI's shader hook, see vendor/PATCH.md) draws either, per device
//! pixel, with the web's maths and the web's blue-noise table. Colours are the opposite of the backdrop's, like the web's.
use crate::bluenoise;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const GEN_SHADER: ShaderId = ShaderId(0x4745_4E31);

/// Registers the shader with the blue-noise table spliced in. Call once at start, after the foil shader.
pub fn register_shader_source() {
    let table = bluenoise::thresholds();
    let join = |sep: &str| table.iter().map(|v| format!("{v:.5}")).collect::<Vec<_>>().join(sep);
    let wgsl = include_str!("shaders/gen.wgsl").replace("//NOISE//", &format!("var<private> NOISE: array<f32, 4096> = array<f32, 4096>({});", join(",")));
    let msl = include_str!("shaders/gen.metal").replace("//NOISE//", &format!("constant float NOISE[4096] = {{{}}};", join(",")));
    // the sources live for the whole run
    register_shader(GEN_SHADER, ShaderSource { wgsl: Box::leak(wgsl.into_boxed_str()), msl: Box::leak(msl.into_boxed_str()) });
}

/// The four generative kinds, as the web's `GenKind`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Wave, Ripple, Aurora, Dunes }

impl Kind {
    fn index(self) -> f32 { match self { Kind::Wave => 0., Kind::Ripple => 1., Kind::Aurora => 2., Kind::Dunes => 3. } }
}

/// FNV-1a with murmur3's finaliser (`hash` in waveCover.ts), so an album wears the same pattern as on the web.
pub fn hash(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for u in s.encode_utf16() { h ^= u as u32; h = h.wrapping_mul(16777619); }
    h ^= h >> 16; h = h.wrapping_mul(0x85ebca6b); h ^= h >> 13; h = h.wrapping_mul(0xc2b2ae35); h ^= h >> 16;
    h
}

/// The pattern an album with no artwork wears (always one, fixed by the id): `genKindFor`.
pub fn kind_for(id: &str) -> (Kind, u32) {
    let k = hash(&format!("{id}#kind"));
    ([Kind::Wave, Kind::Ripple, Kind::Aurora, Kind::Dunes][(k % 4) as usize], (k >> 8) % 7)
}

/// The two playlists that wear the wave instead of their Spotify picture (`genArtFor`).
pub const WAVE_COVER_IDS: [&str; 2] = ["pl:sp:0gE0wwKJ6rGKGFUF7YfZPu", "pl:sp:44JPFAQyJioNkmIdEoWdzK"];
pub fn playlist_art(id: &str) -> Option<(Kind, u32)> { (WAVE_COVER_IDS.contains(&id) || crate::covers::force_gen()).then(|| (Kind::Wave, hash(id) % 7)) }

// ---- colours: the opposite of the backdrop's (`oppositePalette`)

pub type Rgb = [f32; 3];

fn rgb_to_hsl([r, g, b]: Rgb) -> (f32, f32, f32) {
    let (r, g, b) = (r / 255., g / 255., b / 255.);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.;
    if max == min { return (0., 0., l); }
    let d = max - min;
    let s = if l > 0.5 { d / (2. - max - min) } else { d / (max + min) };
    let h = if max == r { (g - b) / d + if g < b { 6. } else { 0. } } else if max == g { (b - r) / d + 2. } else { (r - g) / d + 4. };
    (h / 6., s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> Rgb {
    if s == 0. { return [l * 255.; 3]; }
    let q = if l < 0.5 { l * (1. + s) } else { l + s - l * s };
    let p = 2. * l - q;
    let f = |t: f32| {
        let t = ((t % 1.) + 1.) % 1.;
        if t < 1. / 6. { p + (q - p) * 6. * t } else if t < 0.5 { q } else if t < 2. / 3. { p + (q - p) * (2. / 3. - t) * 6. } else { p }
    };
    [f(h + 1. / 3.) * 255., f(h) * 255., f(h - 1. / 3.) * 255.]
}

/// The complementary colour: hue turned half way round, same saturation and lightness.
pub fn opposite(c: Rgb) -> Rgb { let (h, s, l) = rgb_to_hsl(c); hsl_to_rgb(h + 0.5, s, l) }

static REDUCE: AtomicBool = AtomicBool::new(false);
pub fn set_effects(_backdrop_on: bool, reduce: bool) { REDUCE.store(reduce, Ordering::Relaxed); }
fn reduced() -> bool { REDUCE.load(Ordering::Relaxed) }

/// (light, mid) of the art: the opposite of the web's default backdrop palette (red `#d4584f` / `#521d1a`), a teal that sits
/// well on the native foil's blue too, and gives pairs the same colours as the web.
pub fn palette() -> (Rgb, Rgb) { (opposite([212., 88., 79.]), opposite([82., 29., 26.])) }

fn cover_data(kind: Kind, seed: u32, t: f32, scale: f32, w_css: f32, radius_css: f32) -> Arc<[f32]> {
    let (light, mid) = palette();
    let dot = (1.5 * scale + 0.01).floor().max(1.);
    let _ = w_css;
    vec![0., kind.index(), seed as f32, t, scale, light[0], light[1], light[2], mid[0], mid[1], mid[2], dot, (seed * 7) as f32, (seed * 13) as f32, radius_css * scale].into()
}

fn ascii_data(kind: Kind, t: f32, scale: f32) -> Arc<[f32]> {
    let (light, mid) = palette();
    vec![1., kind.index(), 0., t, scale, light[0], light[1], light[2], mid[0], mid[1], mid[2], 0., 0., 0., 0.].into()
}

/// Is the shader usable? (Pending counts as usable: the first frame has not been seen by the renderer yet.)
pub fn usable() -> bool { !matches!(shader_status(GEN_SHADER), ShaderStatus::Failed(_)) }

/// A still wave cover (list thumbnails: the web keeps covers under 64 px still, drawn at t = 4).
pub fn still_cover(kind: Kind, seed: u32, size: f32, radius: f32) -> Div {
    let q = shader_quad(GEN_SHADER, move |_, window| cover_data(kind, seed, 4.0, window.scale_factor(), size, radius));
    div().relative().size(px(size)).flex_none().rounded(px(radius)).overflow_hidden().bg(gpui_kit::black()).child(q.absolute().top_0().left_0().size_full())
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode { Cover { radius: f32 }, Ascii }

/// An animated piece of generative art. It owns its clock and a timer that only runs while it is on screen and the window is
/// active (and never under "Reduce effects"): 24 frames a second for a cover, 20 for the ASCII header, like the web.
pub struct GenArt {
    mode: Mode,
    kind: Kind,
    seed: u32,
    born: Instant,
    painted: Rc<Cell<Option<Instant>>>,
    timer: bool,
}

impl GenArt {
    pub fn new(mode: Mode, kind: Kind, seed: u32) -> Self { GenArt { mode, kind, seed, born: Instant::now(), painted: Rc::new(Cell::new(None)), timer: false } }
    pub fn set(&mut self, mode: Mode, kind: Kind, seed: u32) { self.mode = mode; self.kind = kind; self.seed = seed; }
    fn frame(&self) -> Duration { Duration::from_millis(if matches!(self.mode, Mode::Ascii) { 50 } else { 42 }) }
    fn ensure_timer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.timer || reduced() || !window.is_window_active() { return; }
        self.timer = true;
        cx.spawn_in(window, async move |this, cx| loop {
            let wait = match this.update_in(cx, |s, _, _| s.frame()) { Ok(w) => w, Err(_) => break };
            cx.background_executor().timer(wait).await;
            // keep going only while the art was painted a moment ago and the window is active
            let keep = this.update_in(cx, |s, window, cx| {
                let seen = s.painted.get().is_some_and(|p| p.elapsed() < Duration::from_millis(400));
                let live = seen && window.is_window_active() && !reduced();
                if live { cx.notify(); } else { s.timer = false; }
                live
            });
            if !matches!(keep, Ok(true)) { break; }
        }).detach();
    }
}

impl Render for GenArt {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_timer(window, cx);
        let (mode, kind, seed, born, painted) = (self.mode, self.kind, self.seed, self.born, self.painted.clone());
        shader_quad(GEN_SHADER, move |bounds, window| {
            painted.set(Some(Instant::now()));
            let scale = window.scale_factor();
            let w = f32::from(bounds.size.width);
            match mode {
                // thumbnails under 64 px stay still (and so does everything under "Reduce effects")
                Mode::Cover { radius } => { let t = if reduced() || w < 64. { 4.0 } else { born.elapsed().as_secs_f32() }; cover_data(kind, seed, t, scale, w, radius) }
                Mode::Ascii => { let t = if reduced() { 0.0 } else { born.elapsed().as_secs_f32() }; ascii_data(kind, t, scale) }
            }
        }).size_full()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn the_pattern_is_fixed_by_the_id_like_the_web() {
        // values computed with web/src/lib/waveCover.ts genKindFor
        // from web/src/lib/waveCover.ts genKindFor
        assert_eq!(kind_for("la:6f402539a9d0f13b"), (Kind::Wave, 4));
        assert_eq!(kind_for("abc"), (Kind::Wave, 5));
        assert_eq!(hash(""), { let mut h = 2166136261u32; h ^= h >> 16; h = h.wrapping_mul(0x85ebca6b); h ^= h >> 13; h = h.wrapping_mul(0xc2b2ae35); h ^ (h >> 16) });
        assert!(playlist_art(WAVE_COVER_IDS[0]).is_some() && playlist_art("pl:rune:x").is_none());
    }

    #[::core::prelude::v1::test]
    fn the_opposite_turns_the_hue_half_way_round() {
        let o = opposite([212., 88., 79.]); // the web's red
        assert!(o[0] < 100. && o[1] > 180. && o[2] > 180., "{o:?}");
        let back = opposite(o);
        for i in 0..3 { assert!((back[i] - [212., 88., 79.][i]).abs() < 1.5, "{back:?}"); }
    }

    #[::core::prelude::v1::test]
    fn the_shader_sources_are_valid_wgsl_with_the_noise_in() {
        let table = bluenoise::thresholds();
        assert_eq!(table.len(), 4096);
        let join = table.iter().map(|v| format!("{v:.5}")).collect::<Vec<_>>().join(",");
        let src = include_str!("shaders/gen.wgsl").replace("//NOISE//", &format!("var<private> NOISE: array<f32, 4096> = array<f32, 4096>({join});"));
        // the hook's prelude declares U and ud; stand in for it
        let full = format!("@group(1) @binding(0) var<storage, read> U: array<f32>;\nfn ud(i: u32) -> f32 {{ return U[12u + i]; }}\n{src}");
        let m = naga::front::wgsl::parse_str(&full).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&full)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&m).expect("valid");
    }
}
