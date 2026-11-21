//! The web's "Dither" backdrops (`web/src/lib/dither.ts` + `components/DitherBackdrop.tsx`) on the GPU: slow evolving light forms,
//! ordered-dithered with the web's blue-noise table into black + a dark mid tone + one strong colour. One shader
//! (`shaders/dither.wgsl` / `dither.metal`, through the vendored GPUI's shader hook, see vendor/PATCH.md) draws it per device
//! pixel, one dot = `dot_size()` device pixels. Everything that is not per-pixel lives here as pure functions (palettes, the cycle,
//! the album colour, the evolution plan, the new-song wave), ported line by line from the web so the two agree.
use crate::bluenoise;
use gpui_kit::*;
use std::sync::Mutex;

pub const DITHER_SHADER: ShaderId = ShaderId(0x4449_5448);

/// Registers the shader with the blue-noise table spliced in. Call once at start, before the first window.
pub fn register_shader_source() {
    let table = thresholds();
    let join = |sep: &str| table.iter().map(|v| format!("{v:.6}")).collect::<Vec<_>>().join(sep);
    let wgsl = include_str!("shaders/dither.wgsl").replace("//NOISE//", &format!("var<private> NOISE: array<f32, 4096> = array<f32, 4096>({});", join(",")));
    let msl = include_str!("shaders/dither.metal").replace("//NOISE//", &format!("constant float NOISE[4096] = {{{}}};", join(",")));
    // the sources live for the whole run
    register_shader(DITHER_SHADER, ShaderSource { wgsl: Box::leak(wgsl.into_boxed_str()), msl: Box::leak(msl.into_boxed_str()) });
}

/// The web uploads the ranks as bytes (`floor((rank + 0.5) / 4096 * 256)`) and the shader reads `(byte + 0.5) / 256`.
pub fn thresholds() -> Vec<f32> {
    bluenoise::table().iter().map(|&r| {
        let b = (((r as f64 + 0.5) / 4096.0) * 256.0).floor().min(255.0);
        ((b + 0.5) / 256.0) as f32
    }).collect()
}

// ---------------------------------------------------------------- palettes

pub type Rgb = [f64; 3];
/// A dither palette: black plus a dark mid tone and the strong "light" colour (0..255).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Palette { pub mid: Rgb, pub light: Rgb }

const fn hex(h: u32) -> Rgb { [((h >> 16) & 255) as f64, ((h >> 8) & 255) as f64, (h & 255) as f64] }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hue { Red, Blue, Purple, Green, Olive, Lime, Teal, Slate, Amber, Copper, Rose }

impl Hue {
    pub const ALL: [Hue; 11] = [Hue::Red, Hue::Blue, Hue::Purple, Hue::Green, Hue::Olive, Hue::Lime, Hue::Teal, Hue::Slate, Hue::Amber, Hue::Copper, Hue::Rose];
    pub fn name(self) -> &'static str {
        match self { Hue::Red => "red", Hue::Blue => "blue", Hue::Purple => "purple", Hue::Green => "green", Hue::Olive => "olive", Hue::Lime => "lime", Hue::Teal => "teal", Hue::Slate => "slate", Hue::Amber => "amber", Hue::Copper => "copper", Hue::Rose => "rose" }
    }
    /// `DITHER_PALETTES`
    pub fn palette(self) -> Palette {
        let (light, mid) = match self {
            Hue::Red => (0xd4584f, 0x521d1a), Hue::Blue => (0x3f74e8, 0x1c3270), Hue::Purple => (0x8f5ae8, 0x3f2675), Hue::Green => (0x22924c, 0x0e3519),
            Hue::Olive => (0xa39642, 0x464020), Hue::Lime => (0xa2a646, 0x454721), Hue::Teal => (0x00604c, 0x002f26), Hue::Slate => (0x727c90, 0x2c3036),
            Hue::Amber => (0xc68942, 0x49361f), Hue::Copper => (0xdd7736, 0x4d2b13), Hue::Rose => (0xd6497c, 0x541a30),
        };
        Palette { light: hex(light), mid: hex(mid) }
    }
}

/// Cycle order and timing: ~2 min round trip, each colour holds 20 s then eases into the next over 10 s.
pub const CYCLE_ORDER: [Hue; 4] = [Hue::Red, Hue::Purple, Hue::Blue, Hue::Green];
pub const CYCLE_HOLD: f64 = 20.0;
pub const CYCLE_FADE: f64 = 10.0;

fn lerp(a: f64, b: f64, t: f64) -> f64 { a + (b - a) * t }
fn lerp_rgb(a: Rgb, b: Rgb, t: f64) -> Rgb { [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)] }
pub fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 { let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }

/// Blend two palettes (k = 0 -> a, 1 -> b).
pub fn mix_palette(a: Palette, b: Palette, k: f64) -> Palette { Palette { light: lerp_rgb(a.light, b.light, k), mid: lerp_rgb(a.mid, b.mid, k) } }

/// The cycle's palette at `t` seconds (`paletteAt('cycle', t)`).
pub fn cycle_at(t: f64) -> Palette {
    let step = CYCLE_HOLD + CYCLE_FADE;
    let period = step * CYCLE_ORDER.len() as f64;
    let p = ((t % period) + period) % period;
    let i = (p / step).floor() as usize;
    let (a, b) = (CYCLE_ORDER[i].palette(), CYCLE_ORDER[(i + 1) % CYCLE_ORDER.len()].palette());
    mix_palette(a, b, smoothstep(CYCLE_HOLD, step, p - i as f64 * step))
}

fn js_round(x: f64) -> f64 { (x + 0.5).floor() }

/// `hslToRgb` (h in degrees, s and l 0..1), rounded to whole 0..255 like the web.
pub fn hsl_to_rgb(h: f64, s: f64, l: f64) -> Rgb {
    let k = |n: f64| (n + h / 30.0) % 12.0;
    let a = s * l.min(1.0 - l);
    let f = |n: f64| l - a * (-1.0f64).max((k(n) - 3.0).min((9.0 - k(n)).min(1.0)));
    [js_round(f(0.0) * 255.0), js_round(f(8.0) * 255.0), js_round(f(4.0) * 255.0)]
}

fn rgb_to_hsl([r, g, b]: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let l = (max + min) / 2.0;
    if d == 0.0 { return (0.0, 0.0, l); }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r { 60.0 * (((g - b) / d) % 6.0) } else if max == g { 60.0 * ((b - r) / d + 2.0) } else { 60.0 * ((r - g) / d + 4.0) };
    ((h + 360.0) % 360.0, s, l)
}

/// A dither palette in the album's own colour (`paletteFromColour`): a strong dot colour at a fixed brightness and a dark mid tone
/// of the same hue. Greys stay grey-blue.
pub fn palette_from_rgb(c: Rgb) -> Palette {
    let (h, s, _) = rgb_to_hsl(c);
    if s < 0.12 { return Palette { light: hsl_to_rgb(220.0, 0.12, 0.5), mid: hsl_to_rgb(220.0, 0.12, 0.18) }; }
    // yellows/greens look much brighter than blues at the same lightness: pull them down a little
    let l = if (40.0..=160.0).contains(&h) { 0.42 } else { 0.52 };
    let sat = s.clamp(0.55, 0.85);
    Palette { light: hsl_to_rgb(h, sat, l), mid: hsl_to_rgb(h, sat * 0.85, 0.19) }
}

/// FNV-1a over UTF-16 code units (`hashString` in web `lib/color.ts`).
pub fn hash_string(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for u in s.encode_utf16() { h ^= u as u32; h = h.wrapping_mul(16777619); }
    h
}
pub fn hue_of(key: &str) -> f64 { (hash_string(key) % 360) as f64 }

/// The album colour before its cover has been seen: `hsl(hueOf(id) 40% 30%)`, as `useCoverColor` starts with.
pub fn fallback_colour(album_id: &str) -> Rgb { hsl_to_rgb(hue_of(if album_id.is_empty() { "x" } else { album_id }), 0.4, 0.3) }

/// `#rrggbb` -> 0..255 (the web's `isHex`: six hex digits, any case).
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let s = s.trim();
    let s = s.strip_prefix('#').unwrap_or(s);
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    u32::from_str_radix(s, 16).ok().map(hex)
}
pub fn to_hex(c: Rgb) -> String { format!("#{:02x}{:02x}{:02x}", c[0].round() as u8, c[1].round() as u8, c[2].round() as u8) }

/// "Dither · Custom" defaults (`DEFAULT_DUOTONE`) and the presets of the picker.
pub const DEFAULT_CUSTOM: (&str, &str) = ("#5a2a9e", "#ff7a3d");
pub const CUSTOM_PRESETS: [(&str, &str, &str); 4] = [
    ("Purple + orange", "#5a2a9e", "#ff7a3d"), ("Teal + gold", "#0f5560", "#f2c14e"), ("Red + cream", "#7a1820", "#f3e2c0"), ("Blue + pink", "#1d3f8a", "#ff6fa8"),
];
pub fn custom_palette(mid: &str, light: &str) -> Palette {
    let d = |h: &str, f: &str| parse_hex(h).or_else(|| parse_hex(f)).unwrap();
    Palette { mid: d(mid, DEFAULT_CUSTOM.0), light: d(light, DEFAULT_CUSTOM.1) }
}

// ---------------------------------------------------------------- the backdrop choice

/// The Settings -> Background choice (the web's `ambient` plus Foil waves).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Mode { #[default] Foil, Off, Hue(Hue), Cycle, Album, Custom, Video }

impl Mode {
    /// The list of the Settings card: Foil waves, Video loop, then the web's order (hues, Cycle, Album, Custom), then Off.
    pub fn all() -> Vec<Mode> {
        let mut v = vec![Mode::Foil, Mode::Video];
        v.extend(Hue::ALL.iter().map(|&h| Mode::Hue(h)));
        v.extend([Mode::Cycle, Mode::Album, Mode::Custom, Mode::Off]);
        v
    }
    /// The saved id: the web's `rune.ambient` strings (`dither` is red), plus `foil`.
    pub fn id(self) -> String {
        match self { Mode::Foil => "foil".into(), Mode::Video => "video".into(), Mode::Off => "off".into(), Mode::Hue(Hue::Red) => "dither".into(), Mode::Hue(h) => format!("dither-{}", h.name()), Mode::Cycle => "dither-cycle".into(), Mode::Album => "dither-album".into(), Mode::Custom => "dither-custom".into() }
    }
    pub fn from_id(s: &str) -> Option<Mode> {
        match s {
            "foil" => Some(Mode::Foil), "video" => Some(Mode::Video), "off" => Some(Mode::Off), "dither" | "dither-red" => Some(Mode::Hue(Hue::Red)),
            "dither-cycle" => Some(Mode::Cycle), "dither-album" => Some(Mode::Album), "dither-custom" => Some(Mode::Custom),
            _ => Hue::ALL.iter().find(|h| s == format!("dither-{}", h.name())).map(|&h| Mode::Hue(h)),
        }
    }
    pub fn label(self) -> String {
        match self {
            Mode::Foil => "Foil waves".into(), Mode::Video => "Video loop".into(), Mode::Off => "Off".into(), Mode::Cycle => "Dither \u{b7} Cycle".into(), Mode::Album => "Dither \u{b7} Album".into(), Mode::Custom => "Dither \u{b7} Custom".into(),
            Mode::Hue(h) => { let n = h.name(); format!("Dither \u{b7} {}{}", n[..1].to_uppercase(), &n[1..]) }
        }
    }
    pub fn is_dither(self) -> bool { !matches!(self, Mode::Foil | Mode::Off | Mode::Video) }
}

/// What decides the dither colour (`Ambient.tsx`): the mode, the Custom pair, the playing album's palette and the open album page's.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Input {
    pub mode: Mode,
    pub custom: Palette,
    /// the playing album's palette; None while nothing plays (purple)
    pub album: Option<Palette>,
    /// the album page's palette (`pagePalette`): every mode but Custom shows it while an album page is open
    pub page: Option<Palette>,
    /// music is playing (the frame pace: 30 fps rather than 12)
    pub playing: bool,
}

impl Input {
    /// The palette wanted at the animation clock `t` (seconds).
    pub fn want(&self, t: f64) -> Palette {
        match self.mode {
            Mode::Custom => self.custom,
            Mode::Album => self.page.or(self.album).unwrap_or(Hue::Purple.palette()),
            Mode::Cycle => self.page.unwrap_or_else(|| cycle_at(t)),
            Mode::Hue(h) => self.page.unwrap_or_else(|| h.palette()),
            Mode::Foil | Mode::Off | Mode::Video => Hue::Red.palette(),
        }
    }
}

/// The palette the dither backdrop is showing right now (after its blends), for the logo (`backdropShown`); None under Foil / Off.
static SHOWN: Mutex<Option<Palette>> = Mutex::new(None);
pub fn publish_shown(p: Option<Palette>) { if let Ok(mut s) = SHOWN.lock() { *s = p; } }
pub fn shown() -> Option<Palette> { SHOWN.lock().ok().and_then(|s| *s) }

/// Seconds for the dots to blend into a new colour (the next album's).
pub const COLOUR_BLEND_S: f64 = 1.4;
/// The still frame's moment (reduced effects): a nicely composed one.
pub const STILL_T: f64 = 23.0;

// ---------------------------------------------------------------- dots

/// Device-pixel size of one dither dot, the web's `dotSize(.., grain = 'fine')`: ~1.5 CSS px, an integer number of device pixels,
/// grown on huge screens so the canvas never exceeds the pixel budget.
pub fn dot_size(css_w: f64, css_h: f64, dpr: f64) -> f64 {
    let mut dot = (1.5 * dpr + 0.01).floor().max(1.0);
    while (css_w * dpr / dot) * (css_h * dpr / dot) > 2_200_000.0 { dot += 1.0; }
    dot
}
pub fn radius_scale(aspect: f64) -> f64 { aspect.sqrt().min(1.0) }

// ---------------------------------------------------------------- new-song wave

pub const WAVE_RISE: f64 = 3.4;
pub const WAVE_HOLD: f64 = 1.6;
pub const WAVE_FALL: f64 = 3.4;
pub const WAVE_BOUNCE: f64 = 4.0;
const WAVE_BOUNCE_PERIOD: f64 = 3.2;
const WAVE_BOUNCE_DAMPING: f64 = 0.3;
pub const WAVE_LENGTH: f64 = WAVE_RISE + WAVE_HOLD + WAVE_FALL + WAVE_BOUNCE;

/// Field exponent at the wave's peak for a screen shape (width / height).
pub fn wave_peak_exponent(aspect: f64) -> f64 { let k = ((aspect - 0.46) / (1.6 - 0.46)).clamp(0.0, 1.0); 0.24 + (0.16 - 0.24) * k }

/// How far the shapes have swelled out `dt` seconds after the song changed (`waveAt(..).amt`).
pub fn wave_at(dt: f64) -> f64 {
    if !(dt >= 0.0) || dt >= WAVE_LENGTH { return 0.0; }
    if dt < WAVE_RISE { return 0.5 - 0.5 * (std::f64::consts::PI * (dt / WAVE_RISE)).cos(); }
    if dt < WAVE_RISE + WAVE_HOLD { return 1.0; }
    if dt < WAVE_RISE + WAVE_HOLD + WAVE_FALL { let q = (dt - WAVE_RISE - WAVE_HOLD) / WAVE_FALL; return (std::f64::consts::FRAC_PI_2 * q).cos(); }
    let t = dt - WAVE_RISE - WAVE_HOLD - WAVE_FALL;
    let wd = 2.0 * std::f64::consts::PI / WAVE_BOUNCE_PERIOD;
    let w = wd / (1.0 - WAVE_BOUNCE_DAMPING * WAVE_BOUNCE_DAMPING).sqrt();
    let v0 = std::f64::consts::PI / (2.0 * WAVE_FALL);
    let fade = 1.0 - smoothstep(WAVE_BOUNCE * 0.7, WAVE_BOUNCE, t);
    -(v0 / wd) * (-WAVE_BOUNCE_DAMPING * w * t).exp() * (wd * t).sin() * fade
}

/// Minimum gap between drawn frames in ms (`backdropFrameMs`): 60 fps for the new-song swell, 30 while music plays, ~12 otherwise.
pub fn frame_ms(playing: bool, pulsing: bool) -> f64 { if pulsing { 1000.0 / 60.0 } else { 1000.0 / if playing { 30.0 } else { 12.0 } } }

// ---------------------------------------------------------------- evolution (lib/dither.ts mixAt / modulatorsAt / currentAt)

/// Sine-free hash (Dave Hoskins), as `hash2` of the web.
pub fn hash2(x: f64, y: f64) -> f64 {
    let fr = |v: f64| v - v.floor();
    let (mut a, mut b, mut c) = (fr(x * 0.1031), fr(y * 0.1031), fr(x * 0.1031));
    let d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d; b += d; c += d;
    fr((a + b) * c)
}

/// mulberry32, as the web's `rng`.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

struct Segment { ch: usize, end: f64, fade: f64 }
const FIRST_END: f64 = 75.0;
const HOLD_MIN: f64 = 80.0;
const HOLD_SPREAD: f64 = 60.0;
const FADE_MIN: f64 = 20.0;
const FADE_SPREAD: f64 = 20.0;
const SEED: u32 = 20261103;

/// The seeded sequence of characters (0 drift, 1 tide, 2 ripple, 3 aurora), extended as time passes.
pub struct Plan { rng: Rng, bag: Vec<usize>, last: usize, segs: Vec<Segment> }
impl Default for Plan { fn default() -> Self { Plan::new() } }
impl Plan {
    pub fn new() -> Plan {
        let mut rng = Rng(SEED);
        let fade = FADE_MIN + rng.next() * FADE_SPREAD;
        Plan { rng, bag: vec![], last: 1, segs: vec![Segment { ch: 1, end: FIRST_END, fade }] }
    }
    fn next_char(&mut self) -> usize {
        if self.bag.is_empty() {
            self.bag = vec![1, 2, 3]; // drift (0) is out of the rotation
            for i in (1..self.bag.len()).rev() { let j = (self.rng.next() * (i + 1) as f64).floor() as usize; self.bag.swap(i, j); }
            let n = self.bag.len();
            if self.bag[n - 1] == self.last { let k = (self.rng.next() * (n - 1) as f64).floor() as usize; self.bag.swap(k, n - 1); }
        }
        self.last = self.bag.pop().unwrap();
        self.last
    }
    fn extend(&mut self, t: f64) {
        while { let l = self.segs.last().unwrap(); l.end - l.fade / 2.0 <= t } {
            let prev_end = self.segs.last().unwrap().end;
            let ch = self.next_char();
            let end = prev_end + HOLD_MIN + self.rng.next() * HOLD_SPREAD;
            let fade = FADE_MIN + self.rng.next() * FADE_SPREAD;
            self.segs.push(Segment { ch, end, fade });
        }
    }
    /// Weights (sum 1) of drift, tide, ripple, aurora at `t` seconds; starts as pure tide.
    pub fn mix_at(&mut self, t: f64) -> [f64; 4] {
        let mut m = [0.0; 4];
        if !(t > 0.0) { m[1] = 1.0; return m; }
        self.extend(t);
        let (mut lo, mut hi) = (0usize, self.segs.len() - 1);
        while lo < hi { let mid = (lo + hi) >> 1; let s = &self.segs[mid]; if s.end + s.fade / 2.0 > t { hi = mid } else { lo = mid + 1 } }
        let s = &self.segs[lo];
        let from = s.end - s.fade / 2.0;
        if t < from { m[s.ch] = 1.0; return m; }
        let k = smoothstep(0.0, 1.0, (t - from) / s.fade);
        m[s.ch] = 1.0 - k;
        let next = self.segs.get(lo + 1).map(|n| n.ch).unwrap_or(s.ch);
        m[next] += k;
        m
    }
}

/// Slow modulators: flow angle, zoom, warped clock (`modulatorsAt`).
pub fn modulators_at(t: f64) -> [f64; 3] {
    [0.45 * (t / 97.0 + 0.7).sin() + 0.2 * (t / 41.0 + 2.1).sin(), 1.0 + 0.1 * (t / 61.0 + 1.0).sin() + 0.05 * (t / 29.0).sin(), t + 8.0 * (t / 47.0).sin() + 2.0 * (t / 23.0 + 1.0).sin()]
}

/// The occasional travelling current (`currentAt`): direction x, y, position, strength.
pub fn current_at(t: f64) -> [f64; 4] {
    const PERIOD: f64 = 95.0;
    const STRENGTH: f64 = 0.22;
    let p = t / PERIOD;
    let k = p.floor();
    let f = p - k;
    let h = hash2(k * 1.7 + 3.1, 5.3);
    let h2 = hash2(k * 2.9 + 1.3, 8.1);
    let a = h * std::f64::consts::PI * 2.0;
    let on = smoothstep(0.35, 0.55, h2);
    let env = (std::f64::consts::PI * f).sin();
    [a.cos(), a.sin(), -0.75 + 1.5 * f, STRENGTH * on * env * env]
}

// ---------------------------------------------------------------- the shader's floats

/// The app floats of one frame for a window of `w` x `h` device pixels at `scale`, clock `t`, swell `wave` and palette `pal`
/// (the layout is listed at the top of `shaders/dither.wgsl`).
pub fn gpu_data(w: f64, h: f64, scale: f64, t: f64, wave: f64, pal: Palette, plan: &mut Plan) -> Vec<f32> {
    let dot = dot_size(w / scale, h / scale, scale);
    let (cw, ch) = ((w / dot).ceil().max(1.0), (h / dot).ceil().max(1.0));
    let aspect = cw / ch;
    let m = plan.mix_at(t);
    let (md, cu) = (modulators_at(t), current_at(t));
    let d = [
        cw, ch, dot, aspect, radius_scale(aspect), t, wave, wave_peak_exponent(aspect), 1.0,
        pal.mid[0], pal.mid[1], pal.mid[2], pal.light[0], pal.light[1], pal.light[2],
        m[1], m[2], m[3], md[0], md[1], md[2], cu[0], cu[1], cu[2], cu[3],
    ];
    d.iter().map(|&v| v as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn near(a: f64, b: f64) { assert!((a - b).abs() < 2e-9 + 1e-6, "{a} vs {b}"); }
    fn near3(a: Rgb, b: [f64; 3]) { for i in 0..3 { near(a[i], b[i]); } }

    const REF_RED: (f64, f64, f64, f64, f64, f64) = (214.0, 51.0, 51.0, 76.0, 21.0, 21.0);
    const REF_GREEN: (f64, f64, f64, f64, f64, f64) = (99.0, 167.0, 47.0, 45.0, 72.0, 25.0);
    const REF_HUE: u32 = 151;
    const REF_FALLBACK: (f64, f64, f64) = (46.0, 107.0, 78.0);
    const REF_MIX: &[(f64, [f64; 4])] = &[(10.0, [0., 1., 0., 0.]), (60.0, [0., 1., 0., 0.]), (100.0, [0., 0., 1., 0.]), (160.0, [0., 0., 1., 0.]), (300.0, [0., 0., 0., 1.]), (700.0, [0., 1., 0., 0.]), (1500.0, [0., 1., 0., 0.]), (5000.0, [0., 0., 1., 0.])];
    const REF_MOD: &[(f64, [f64; 3])] = &[(10.0, [0.466927326, 1.108738439, 13.670843098]), (60.0, [0.353875474, 1.135522643, 66.755671046]), (100.0, [0.247240853, 1.033044834, 105.181712442]), (160.0, [0.264911409, 0.919040775, 159.91227225]), (300.0, [-0.271219355, 0.92450924, 302.788251752]), (700.0, [0.512720169, 0.94898368, 705.855926346]), (1500.0, [-0.031350733, 1.093849664, 1503.345083977]), (5000.0, [0.212857887, 1.1142243, 4994.659078377])];
    const REF_CUR: &[(f64, [f64; 4])] = &[(10.0, [-0.998944629, -0.045930687, -0.592105263, 0.015109923]), (50.0, [-0.998944629, -0.045930687, 0.039473684, 0.142340123]), (100.0, [-0.775009619, 0.631949437, -0.671052632, 0.0]), (150.0, [-0.775009619, 0.631949437, 0.118421053, 0.0]), (200.0, [-0.879961301, -0.475045375, -0.592105263, 0.0]), (290.0, [0.897041763, 0.441945784, -0.671052632, 0.0]), (400.0, [-0.887787649, 0.46025329, -0.434210526, 0.0]), (777.0, [-0.910349634, 0.413839999, -0.481578947, 0.062507021])];
    const REF_HASH: f64 = 0.507312669;

    // The reference numbers below were printed by the web's own functions (`node --experimental-strip-types` over
    // web/src/lib/dither.ts) at these inputs.

    #[::core::prelude::v1::test]
    fn the_cycle_holds_each_colour_then_eases_into_the_next() {
        let (red, purple) = (Hue::Red.palette(), Hue::Purple.palette());
        assert_eq!(cycle_at(0.0), red);
        assert_eq!(cycle_at(19.9), red, "holds for 20 s");
        let mid = cycle_at(25.0);
        near3(mid.light, [lerp(red.light[0], purple.light[0], 0.5), lerp(red.light[1], purple.light[1], 0.5), lerp(red.light[2], purple.light[2], 0.5)]);
        assert_eq!(cycle_at(30.0), purple);
        assert_eq!(cycle_at(120.0), red, "the round trip is 4 x 30 s");
        assert_eq!(cycle_at(-90.0), cycle_at(30.0), "negative times wrap");
        let g = cycle_at(115.0); // easing from green back to red
        assert!(g.light[0] > Hue::Green.palette().light[0] && g.light[0] < red.light[0]);
    }

    #[::core::prelude::v1::test]
    fn palette_from_colour_matches_the_web() {
        // paletteFromColour('rgb(200 40 40)') -> light #d03b3b-ish, mid; values from the web
        let p = palette_from_rgb([200.0, 40.0, 40.0]);
        near3(p.light, [REF_RED.0, REF_RED.1, REF_RED.2]);
        near3(p.mid, [REF_RED.3, REF_RED.4, REF_RED.5]);
        let g = palette_from_rgb([120.0, 200.0, 60.0]); // a green: the lower lightness
        near3(g.light, [REF_GREEN.0, REF_GREEN.1, REF_GREEN.2]);
        near3(g.mid, [REF_GREEN.3, REF_GREEN.4, REF_GREEN.5]);
        let grey = palette_from_rgb([128.0, 128.0, 128.0]);
        assert_eq!(grey.light, hsl_to_rgb(220.0, 0.12, 0.5));
        assert_eq!(grey.mid, hsl_to_rgb(220.0, 0.12, 0.18));
        // the colour an album has before its cover is read: hsl(hueOf(id) 40% 30%)
        assert_eq!(hue_of("la:6f402539a9d0f13b"), REF_HUE as f64);
        near3(fallback_colour("la:6f402539a9d0f13b"), [REF_FALLBACK.0, REF_FALLBACK.1, REF_FALLBACK.2]);
    }

    #[::core::prelude::v1::test]
    fn custom_colours_parse_like_the_web() {
        assert_eq!(parse_hex("#5a2a9e"), Some([90.0, 42.0, 158.0]));
        assert_eq!(parse_hex("FF7A3D"), Some([255.0, 122.0, 61.0]));
        assert_eq!(parse_hex(" #ff7a3d "), Some([255.0, 122.0, 61.0]));
        for bad in ["", "#fff", "#12345", "#1234567", "#gg0000", "red", "#12 456"] { assert_eq!(parse_hex(bad), None, "{bad}"); }
        assert_eq!(to_hex([90.0, 42.0, 158.0]), "#5a2a9e");
        // an unusable half falls back to the default pair, not to black
        let p = custom_palette("nope", "#ff7a3d");
        assert_eq!(p.mid, parse_hex(DEFAULT_CUSTOM.0).unwrap());
        assert_eq!(p.light, [255.0, 122.0, 61.0]);
    }

    #[::core::prelude::v1::test]
    fn every_mode_round_trips_through_its_saved_id() {
        for m in Mode::all() { assert_eq!(Mode::from_id(&m.id()), Some(m), "{m:?}"); }
        assert_eq!(Mode::all().len(), 17, "foil, video, 11 hues, cycle, album, custom, off");
        assert_eq!(Mode::from_id("dither"), Some(Mode::Hue(Hue::Red)), "the web's id for red");
        assert_eq!(Mode::from_id("dither-red"), Some(Mode::Hue(Hue::Red)));
        assert_eq!(Mode::from_id("dither-cycle"), Some(Mode::Cycle));
        assert_eq!(Mode::from_id("nonsense"), None);
        assert_eq!(Mode::default(), Mode::Foil, "Foil waves stays the default");
        assert_eq!(Mode::Hue(Hue::Teal).label(), "Dither \u{b7} Teal");
        assert!(!Mode::Foil.is_dither() && !Mode::Off.is_dither() && Mode::Custom.is_dither());
    }

    #[::core::prelude::v1::test]
    fn the_palette_follows_mode_album_page_and_custom() {
        let custom = custom_palette("#5a2a9e", "#ff7a3d");
        let album = palette_from_rgb([200.0, 40.0, 40.0]);
        let page = palette_from_rgb([40.0, 80.0, 200.0]);
        let mk = |mode, album, page| Input { mode, custom, album, page, playing: false };
        assert_eq!(mk(Mode::Hue(Hue::Blue), None, None).want(5.0), Hue::Blue.palette());
        assert_eq!(mk(Mode::Hue(Hue::Blue), Some(album), Some(page)).want(5.0), page, "an album page tints every hue");
        assert_eq!(mk(Mode::Album, Some(album), None).want(5.0), album);
        assert_eq!(mk(Mode::Album, None, None).want(5.0), Hue::Purple.palette(), "purple while nothing plays");
        assert_eq!(mk(Mode::Album, Some(album), Some(page)).want(5.0), page);
        assert_eq!(mk(Mode::Cycle, None, None).want(25.0), cycle_at(25.0));
        assert_eq!(mk(Mode::Cycle, None, Some(page)).want(25.0), page);
        assert_eq!(mk(Mode::Custom, Some(album), Some(page)).want(25.0), custom, "Custom ignores the page, like the web");
    }

    #[::core::prelude::v1::test]
    fn dots_and_the_wave_match_the_web() {
        assert_eq!(dot_size(1280.0, 800.0, 1.0), 1.0);
        assert_eq!(dot_size(1280.0, 800.0, 2.0), 3.0);
        assert_eq!(dot_size(1280.0, 800.0, 3.0), 4.0);
        assert!(dot_size(3840.0, 2160.0, 1.0) >= 2.0, "4K at dpr 1 is over the budget: grown");
        assert_eq!(wave_at(-1.0), 0.0);
        near(wave_at(WAVE_RISE / 2.0), 0.5);
        assert_eq!(wave_at(WAVE_RISE + 0.1), 1.0);
        near(wave_at(WAVE_RISE + WAVE_HOLD + WAVE_FALL), 0.0);
        assert!(wave_at(WAVE_RISE + WAVE_HOLD + WAVE_FALL + 1.0) < 0.0, "dips below rest in the bounce");
        assert_eq!(wave_at(WAVE_LENGTH), 0.0);
        near(wave_peak_exponent(1.6), 0.16);
        near(wave_peak_exponent(0.3), 0.24);
        near(frame_ms(true, false), 1000.0 / 30.0);
        near(frame_ms(false, true), 1000.0 / 60.0);
    }

    #[::core::prelude::v1::test]
    fn evolution_matches_the_web() {
        let mut plan = Plan::new();
        assert_eq!(plan.mix_at(0.0), [0.0, 1.0, 0.0, 0.0]);
        for (t, want) in REF_MIX { let m = plan.mix_at(*t); for i in 0..4 { near(m[i], want[i]); } }
        let mut fresh = Plan::new(); // the plan does not depend on the order it is asked in
        let m = fresh.mix_at(REF_MIX[REF_MIX.len() - 1].0);
        for i in 0..4 { near(m[i], REF_MIX[REF_MIX.len() - 1].1[i]); }
        for (t, want) in REF_MOD { let m = modulators_at(*t); for i in 0..3 { near(m[i], want[i]); } }
        for (t, want) in REF_CUR { let c = current_at(*t); for i in 0..4 { near(c[i], want[i]); } }
        near(hash2(3.1, 5.3), REF_HASH);
    }

    #[::core::prelude::v1::test]
    fn thresholds_are_the_webs_bytes() {
        let th = thresholds();
        assert_eq!(th.len(), 4096);
        // every value is (byte + 0.5) / 256 for a byte 0..255: 16 ranks share each
        for v in &th { let b = *v as f64 * 256.0 - 0.5; assert!((b - b.round()).abs() < 1e-4 && (0.0..=255.0).contains(&b.round())); }
        let mut counts = [0u32; 256];
        for v in &th { counts[(*v as f64 * 256.0) as usize] += 1; }
        assert!(counts.iter().all(|&c| c == 16));
    }

    /// The hook's WGSL prelude declares these; the app's source (with the noise table in) must be valid after them.
    #[::core::prelude::v1::test]
    fn dither_wgsl_is_valid() {
        let join = thresholds().iter().map(|v| format!("{v:.6}")).collect::<Vec<_>>().join(",");
        let src = include_str!("shaders/dither.wgsl").replace("//NOISE//", &format!("var<private> NOISE: array<f32, 4096> = array<f32, 4096>({join});"));
        let prelude = "@group(1) @binding(0) var<storage, read> U: array<f32>;\nfn ud(i: u32) -> f32 { return U[12u + i]; }\n";
        let full = format!("{prelude}{src}");
        let m = naga::front::wgsl::parse_str(&full).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&full)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&m).expect("valid");
        assert!(include_str!("shaders/dither.metal").contains("float4 custom_fs(float2 pos, constant float* U)"));
    }

    #[::core::prelude::v1::test]
    fn the_float_array_has_the_documented_layout() {
        let mut plan = Plan::new();
        let d = gpu_data(2560.0, 1600.0, 2.0, 10.0, 0.0, Hue::Blue.palette(), &mut plan);
        assert_eq!(d.len(), 25);
        assert_eq!(d[2], 3.0, "dot");
        assert_eq!(d[0], (2560.0f32 / 3.0).ceil());
        assert_eq!(&d[9..15], &[28.0, 50.0, 112.0, 63.0, 116.0, 232.0]);
        assert_eq!(&d[15..18], &[1.0, 0.0, 0.0], "tide only at the start");
    }
}
