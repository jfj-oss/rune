//! "Foil waves": the maths of the backdrop, a port of `web/src/lib/foil.ts` (the web draws it per pixel in a WebGL shader at
//! full device resolution; GPUI has no custom shaders, so [`crate::backdrop`] draws the same picture from these pieces):
//!
//!  * the background dust (very fine dim diagonal dashes, rare stray pixels, the moon's marks) as one pre-rendered image at
//!    device resolution, moved by whole device pixels (so it stays crisp, and moving it costs nothing),
//!  * the wave bands as vector paths (soft glow) plus per-device-column strips: short vertical dashes with their own top,
//!    bottom and brightness, which stay put on screen while the band slides through them.
//!
//! Everything here is pure maths (positions in, numbers out) so it can be tested without a window. Coordinates: `x` and `v`
//! are logical pixels divided by the viewport height; `asp` is width / height.

pub const FPS: f32 = 24.0;
/// The still frame (reduced motion).
pub const STILL_T: f32 = 40.0;
pub const T_WRAP: f32 = 100000.0;

pub const BASE: [f32; 3] = [6.0, 10.0, 26.0];
pub const WAVE: [f32; 3] = [118.0, 134.0, 255.0];
pub const HOT: [f32; 3] = [190.0, 205.0, 255.0];
pub const DUST: [f32; 3] = [96.0, 112.0, 235.0];
pub const STRAY: [f32; 3] = [160.0, 175.0, 255.0];
pub const MOON: [f32; 3] = [120.0, 135.0, 255.0];
pub const BAND_HALF: f32 = 3.0;
pub const STRIP_JITTER: f32 = 1.7;
pub const GLOW_SIG: f32 = 7.0;
pub const GLOW_AMP: f32 = 0.14;
/// Gain of the band body (as in the shader).
pub const BODY_GAIN: f32 = 2.0;
pub const STRIP_W: i32 = 2;
pub const DASH_PERIOD: i32 = 48;
pub const DASH_DENSITY: f32 = 0.065;
pub const DASH_SPEED: f32 = 2.5;
pub const WRAP_J: i32 = 8;
pub const STRAY_DENSITY: f32 = 0.0004;
pub const MOON_R: f32 = 0.05;
pub const MOON_X: f32 = 0.86;
pub const MOON_V: f32 = 0.2;
/// Drift distance (device px) after which the dust pattern repeats exactly.
pub const DUST_CYCLE: i32 = WRAP_J * DASH_PERIOD / 2;

fn fract(x: f32) -> f32 { x - x.floor() }
fn pmod(x: f32, m: f32) -> f32 { x - m * (x / m).floor() }
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = ((x - a) / (b - a)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }

/// The sin-free hash (Hoskins), three values in 0..1 for a 2D id; the same operations as the shader, in f32.
pub fn hash3(x: f32, y: f32) -> [f32; 3] {
    let (mut a, mut b, mut c) = (fract(x * 0.1031), fract(y * 0.1030), fract(x * 0.0973));
    let d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
    a += d; b += d; c += d;
    [fract((a + b) * c), fract((b + c) * a), fract((c + a) * b)]
}

/// Brightness of a strip from its hash, at time t (irregular, drifting very slowly).
pub fn strip_bright(h: [f32; 3], t: f32) -> f32 { (0.3 + 0.7 * h[0].powf(1.4)) * (0.88 + 0.12 * (t * 0.5 + h[1] * 6.2832).sin()) }
/// The hash of the strip holding device column `col`.
pub fn strip_hash(col: i32) -> [f32; 3] { hash3(col.div_euclid(STRIP_W) as f32, 7.0) }
/// Brightness along a strip's own height: its three control points (top, middle, bottom), from the column's hash.
pub fn strip_profile(col: i32) -> [f32; 3] {
    let h = hash3(col.div_euclid(STRIP_W) as f32, 11.0);
    [0.15 + 0.85 * h[0].powf(1.3), 0.15 + 0.85 * h[1].powf(1.3), 0.15 + 0.85 * h[2].powf(1.3)]
}
/// The same profile at y01 (0 top .. 1 bottom), linear between the control points.
pub fn profile_at(p: [f32; 3], y01: f32) -> f32 { let y = y01.clamp(0.0, 1.0); if y < 0.5 { p[0] + (p[1] - p[0]) * y * 2.0 } else { p[1] + (p[2] - p[1]) * (y * 2.0 - 1.0) } }
/// How far (px) a strip reaches above and below the band's centre line.
pub fn strip_extent(h: [f32; 3]) -> (f32, f32) { (BAND_HALF + (h[1] * 2.0 - 1.0) * STRIP_JITTER, BAND_HALF + (h[2] * 2.0 - 1.0) * STRIP_JITTER) }

pub fn base(x: f32, asp: f32, v: f32, t: f32) -> f32 {
    0.22 + 0.42 * (x / asp) + 0.12 * (x * 1.6 + t * 0.09).sin() + 0.06 * (x * 3.4 - t * 0.14 + 1.3).sin() + 0.02 * (x * 9.3 + v * 3.0 + t * 0.23).sin()
}
pub fn spacing(x: f32) -> f32 { 0.115 + 0.04 * (x * 1.3 + 0.8).sin() }
/// Height v of line k at x.
pub fn line_v(k: i32, x: f32, asp: f32, t: f32) -> f32 {
    let sp = spacing(x);
    let mut v = base(x, asp, 0.5, t) + sp * (k as f32 - 0.5 + t * 0.025);
    for _ in 0..2 { v = base(x, asp, v, t) + sp * (k as f32 - 0.5 + t * 0.025); }
    v
}
pub fn env(x: f32, v: f32, t: f32) -> f32 { 0.1 + 0.9 * sstep(0.3, 0.78, 0.5 + 0.5 * (x * 1.8 + v * 2.2 - t * 0.05 + (v * 3.0 + t * 0.03).sin()).sin()) }
pub fn lump(a: f32, k: i32, t: f32) -> f32 { let k = k as f32; 0.62 + 0.38 * (a * 0.07 + k * 1.9 + t * 0.35 + (a * 0.03 + k).sin() * 1.5).sin() }
pub fn slope(x: f32, v: f32, asp: f32, t: f32) -> f32 {
    let sp = spacing(x);
    let m = (v - base(x, asp, v, t)) / sp;
    let db = 0.42 / asp + 0.192 * (x * 1.6 + t * 0.09).cos() + 0.204 * (x * 3.4 - t * 0.14 + 1.3).cos() + 0.186 * (x * 9.3 + v * 3.0 + t * 0.23).cos();
    db + 0.052 * (x * 1.3 + 0.8).cos() * m
}

/// Seconds wrapped like the web's `foilClock`.
pub fn clock(secs: f32) -> f32 { secs % T_WRAP }
/// Drift step (whole device pixels) at time t.
pub fn shift_at(t: f32) -> i32 { ((t * DASH_SPEED).floor() as i32).rem_euclid(DUST_CYCLE) }

/// The background mark at device pixel (px, py) (py from the top) with the dust drifted by `shift` pixels: (dash, stray).
pub fn dust(px: i32, py: i32, shift: i32, density: f32) -> (f32, f32) {
    let sh = shift.rem_euclid(DUST_CYCLE);
    let (xs, ys) = (px - sh, py + sh);
    let (a, b) = ((xs + ys) as f32, (xs - ys) as f32);
    let p = DASH_PERIOD as f32;
    let bw = pmod(b, p * WRAP_J as f32);
    let j = (bw / p).floor();
    let h = hash3(a, j + 0.5);
    let mut dash = 0.0;
    if h[0] < density {
        let n = 2.0 + (h[1].powf(1.6) * 3.0).floor(); // mostly 2-3 pixels, sometimes 4
        let mut start = (h[2] * (p - 2.0 * n)).floor();
        start += pmod(a, 2.0) - pmod(start, 2.0);
        let local = bw - j * p - start;
        if local >= 0.0 && local < 2.0 * n && pmod(local, 2.0) == 0.0 { dash = 0.22 + 0.38 * fract(h[1] * 13.7); }
    }
    let hs = hash3(a + 0.25, bw + 0.75);
    // (the web's strays also twinkle; here they are steady at the middle of their range)
    let stray = if hs[0] < STRAY_DENSITY { 0.9 } else { 0.0 };
    (dash, stray)
}

fn put(buf: &mut [u8], i: usize, rgb: [f32; 3], a: f32) {
    // premultiplied BGRA
    let a = a.clamp(0.0, 1.0);
    buf[i] = (rgb[2] * a) as u8; buf[i + 1] = (rgb[1] * a) as u8; buf[i + 2] = (rgb[0] * a) as u8; buf[i + 3] = (a * 255.0) as u8;
}

/// The dust as an image of w x h device pixels covering the screen pixels x in [-DUST_CYCLE, w - DUST_CYCLE), y in [0, h)
/// (so it can be slid up and to the right by `shift` < DUST_CYCLE and still cover the screen): premultiplied BGRA.
pub fn dust_image(w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    for iy in 0..h {
        for ix in 0..w {
            let (d, s) = dust(ix as i32 - DUST_CYCLE, iy as i32, 0, DASH_DENSITY);
            if d > 0.0 { put(&mut out, (iy * w + ix) * 4, DUST, d); }
            else if s > 0.0 { put(&mut out, (iy * w + ix) * 4, STRAY, s); }
        }
    }
    out
}

/// Moon centre and radius in device pixels for a viewport of w x h logical pixels at this scale.
pub fn moon_dev(w: f32, h: f32, scale: f32) -> (f32, f32, f32) { (w / h * MOON_X * h * scale, MOON_V * h * scale, MOON_R * h * scale) }

/// The moon as an opaque image of its bounding square: ragged-edged disc of the same marks, packed. Returns (x0, y0, size, BGRA)
/// with x0, y0 the top-left in device pixels.
pub fn moon_image(w: f32, h: f32, scale: f32, shift: i32) -> (i32, i32, usize, Vec<u8>) {
    let (cx, cy, r) = moon_dev(w, h, scale);
    let size = (2.0 * r + 8.0).ceil() as usize;
    let (x0, y0) = (cx as i32 - size as i32 / 2, cy as i32 - size as i32 / 2);
    let mut out = vec![0u8; size * size * 4];
    for iy in 0..size {
        for ix in 0..size {
            let (x, y) = (x0 + ix as i32, y0 + iy as i32);
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let edge = (hash3(x as f32 + 31.0, y as f32 + 31.0)[0] - 0.5) * 3.0;
            if (dx * dx + dy * dy).sqrt() >= r + edge { continue; }
            let i = (iy * size + ix) * 4;
            let mut col = BASE;
            let (d, s) = dust(x, y, shift, 0.8);
            for c in 0..3 { col[c] += DUST[c] * d * 1.7 + STRAY[c] * s; }
            if hash3(x as f32 + 53.0, y as f32 + 53.0)[0] < 0.22 {
                let m = 0.35 + 0.5 * hash3(x as f32 + 9.0, y as f32 + 9.0)[1];
                for c in 0..3 { col[c] += MOON[c] * m; }
            }
            out[i] = col[2].min(255.0) as u8; out[i + 1] = col[1].min(255.0) as u8; out[i + 2] = col[0].min(255.0) as u8; out[i + 3] = 255;
        }
    }
    (x0, y0, size, out)
}

/// Vignette factor (1 in the middle, 0.5 in the far corners), like the shader's.
pub fn vignette(x: f32, asp: f32, v: f32) -> f32 { 1.0 - 0.5 * sstep(0.3, 0.85, ((x / asp - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt()) }

/// One strip of one wave line, ready to paint: x range in device pixels, vertical extent in logical px, colour and alpha.
#[derive(Clone, Copy, Debug)]
/// The strip is painted as two halves (top to middle, middle to bottom), each a vertical gradient between the alphas at its ends.
pub struct Strip { pub x_dev: i32, pub top: f32, pub bottom: f32, pub rgb: [f32; 3], pub alpha: [f32; 3] }

/// A piece of glow for one line: a polyline (logical px) and its alpha.
#[derive(Clone, Debug)]
pub struct Glow { pub pts: Vec<(f32, f32)>, pub alpha: f32 }

/// Everything the wave bands need for one frame of a w x h (logical px) window at `scale` and time t.
pub fn waves(w: f32, h: f32, scale: f32, t: f32, strips_h: &[[f32; 3]]) -> (Vec<Strip>, Vec<Glow>) {
    let asp = w / h;
    let ncols = (w * scale).ceil() as i32;
    let nstrips = (ncols + STRIP_W - 1) / STRIP_W;
    const NODE: i32 = 8; // strips between two evaluated nodes of the (smooth) line geometry
    let nnodes = (nstrips / NODE + 2) as usize;
    let mut strips = Vec::with_capacity(8192);
    let mut glows = Vec::new();
    for k in -14..=18 {
        // geometry at the nodes: (v, env, slope, lump, vignette)
        let mut nodes = Vec::with_capacity(nnodes);
        for n in 0..nnodes as i32 {
            let xdev = (n * NODE * STRIP_W) as f32 + 1.0;
            let xl = xdev / scale; // logical px
            let x = xl / h;
            let v = line_v(k, x, asp, t);
            nodes.push((v, env(x, v, t), slope(x, v, asp, t), lump(xl, k, t), vignette(x, asp, v), xl));
        }
        if nodes.iter().all(|n| n.0 < -0.1 || n.0 > 1.1) { continue; }
        // glow: pieces of ~6 nodes
        let mut i = 0;
        while i + 1 < nodes.len() {
            let end = (i + 6).min(nodes.len() - 1);
            let seg = &nodes[i..=end];
            let a = seg.iter().map(|n| n.1 * n.3 * n.4).sum::<f32>() / seg.len() as f32;
            if a > 0.05 && seg.iter().any(|n| n.0 > -0.05 && n.0 < 1.05) { glows.push(Glow { pts: seg.iter().map(|n| (n.5, n.0 * h)).collect(), alpha: a }); }
            i = end;
        }
        for s in 0..nstrips {
            let (n0, f) = ((s / NODE) as usize, (s % NODE) as f32 / NODE as f32);
            let (p, q) = (&nodes[n0], &nodes[n0 + 1]);
            let l = |a: f32, b: f32| a + (b - a) * f;
            let (v, en, sl, lu, vg) = (l(p.0, q.0), l(p.1, q.1), l(p.2, q.2), l(p.3, q.3), l(p.4, q.4));
            if v < -0.05 || v > 1.05 { continue; }
            let hs = strips_h[s as usize];
            let sb = strip_bright(hs, t);
            let prof = strip_profile(s * STRIP_W);
            let b = sb * lu * en * BODY_GAIN;
            if b * prof[0].max(prof[1]).max(prof[2]) < 0.03 { continue; }
            let (et, eb) = strip_extent(hs);
            let c = (1.0 + sl * sl).sqrt();
            let m = (sb * prof[1] * lu * 1.5 - 0.45).clamp(0.0, 1.0);
            let rgb = [WAVE[0] + (HOT[0] - WAVE[0]) * m, WAVE[1] + (HOT[1] - WAVE[1]) * m, WAVE[2] + (HOT[2] - WAVE[2]) * m];
            let yc = v * h;
            strips.push(Strip { x_dev: s * STRIP_W, top: yc - et * c, bottom: yc + eb * c, rgb, alpha: [(b * prof[0] * vg).min(1.0), (b * prof[1] * vg).min(1.0), (b * prof[2] * vg).min(1.0)] });
        }
    }
    (strips, glows)
}

/// Strip hashes for a viewport that is `ncols` device pixels wide.
pub fn strip_hashes(ncols: i32) -> Vec<[f32; 3]> { (0..(ncols + STRIP_W - 1) / STRIP_W + 2).map(|s| hash3(s as f32, 7.0)).collect() }

#[cfg(test)]
mod tests {
    use super::*;

    // values computed by the web code for the same inputs: (k, x, t, [line_v, env, lump(x*800), slope, spacing, base])
    const GOLD: [(i32, f32, f32, [f32; 6]); 4] = [
        (0, 0.3, 0.0, [0.31103, 1.00000, 0.33225, 0.12877, 0.15213, 0.38711]),
        (2, 0.9, 12.5, [0.84608, 0.52022, 0.81126, -0.04647, 0.15185, 0.57085]),
        (-3, 1.4, 40.0, [0.21020, 1.00000, 0.35155, 0.61003, 0.13493, 0.54753]),
        (5, 0.1, 123.4, [1.26166, 0.10000, 0.63983, 0.32565, 0.14706, 0.14618]),
    ];

    #[test]
    fn wave_geometry_matches_the_web_values() {
        for (k, x, t, w) in GOLD {
            let v = line_v(k, x, 1.6, t);
            let got = [v, env(x, v, t), lump(x * 800.0, k, t), slope(x, v, 1.6, t), spacing(x), base(x, 1.6, v, t)];
            for i in 0..6 { assert!((got[i] - w[i]).abs() < 2e-3, "k={k} x={x} t={t} item {i}: {got:?} vs {w:?}"); }
        }
    }

    #[test]
    fn dust_is_sparse_dim_and_rare_strays() {
        let (mut dash, mut stray, mut mx, mut n) = (0, 0, 0f32, 0);
        for y in 0..300 { for x in 0..400 { let (d, s) = dust(x, y, 5, DASH_DENSITY); n += 1; if d > 0.0 { dash += 1; mx = mx.max(d); } if s > 0.0 { stray += 1; } } }
        let share = dash as f32 / n as f32;
        assert!(share > 0.003 && share < 0.03, "{share}");
        assert!(mx <= 0.6 + 1e-6);
        assert!((stray as f32 / n as f32) < 0.002);
    }

    #[test]
    fn dashes_run_up_and_right_mostly_two_to_four_pixels() {
        let mut set = std::collections::HashSet::new();
        for y in 0..120 { for x in 0..160 { if dust(x, y, 5, DASH_DENSITY).0 > 0.0 { set.insert((x, y)); } } }
        assert!(set.len() > 100);
        let (mut longest, mut short, mut all) = (0, 0, 0);
        for &(x, y) in &set {
            if set.contains(&(x - 1, y + 1)) { continue; }
            let mut n = 1;
            while set.contains(&(x + n, y - n)) { n += 1; }
            longest = longest.max(n);
            all += 1;
            if n <= 3 { short += 1; }
        }
        assert!(longest >= 4 && longest <= 8, "{longest}");
        assert!(short as f32 / all as f32 > 0.6, "{short} of {all} dashes are 3 pixels or shorter");
    }

    #[test]
    fn dust_drifts_a_pixel_at_a_time_and_repeats_after_the_cycle() {
        for y in 2..80 { for x in 2..120 { assert_eq!(dust(x - 1, y + 1, 7, DASH_DENSITY).0, dust(x, y, 8, DASH_DENSITY).0); } }
        for i in 0..400 { assert_eq!(dust(i, i % 37, 3, DASH_DENSITY).0, dust(i, i % 37, 3 + DUST_CYCLE, DASH_DENSITY).0); }
        assert_eq!(shift_at(0.0), 0);
        assert_eq!(shift_at(1.0), 2);
        assert!(shift_at(1e5) < DUST_CYCLE);
    }

    #[test]
    fn dust_image_slides_to_equal_the_direct_dust() {
        let (w, h) = (300usize, 100usize);
        let img = dust_image(w + DUST_CYCLE as usize, h + DUST_CYCLE as usize);
        let iw = w + DUST_CYCLE as usize;
        let s = 37;
        for y in 0..h { for x in 0..w {
            // screen pixel (x, y) at shift s is image pixel (x - s + CYCLE, y + s)
            let i = ((y + s as usize) * iw + (x + DUST_CYCLE as usize - s as usize)) * 4;
            let (d, _) = dust(x as i32, y as i32, s, DASH_DENSITY);
            assert_eq!(img[i + 3] > 0 && d > 0.0, d > 0.0 && img[i + 3] > 0);
            if d > 0.0 { assert!((img[i + 3] as f32 / 255.0 - d).abs() < 0.01); }
        } }
    }

    #[test]
    fn strips_are_irregular_and_in_range() {
        let mut tops = std::collections::HashSet::new();
        for c in 0..300 {
            let h = strip_hash(c * STRIP_W);
            assert_eq!(strip_hash(c * STRIP_W), strip_hash(c * STRIP_W + 1));
            let (t, b) = strip_extent(h);
            for v in [t, b] { assert!(v >= BAND_HALF - STRIP_JITTER - 1e-4 && v <= BAND_HALF + STRIP_JITTER + 1e-4); }
            let br = strip_bright(h, 9.0);
            assert!(br > 0.2 && br < 1.001);
            tops.insert((t * 100.0) as i32);
        }
        assert!(tops.len() > 100);
    }

    #[test]
    fn strip_profiles_vary_along_each_strip() {
        let (mut top_heavy, mut mid_heavy) = (0, 0);
        for c in 0..400 {
            let p = strip_profile(c * STRIP_W);
            assert_eq!(p, strip_profile(c * STRIP_W + 1));
            for v in p { assert!((0.15 - 1e-4..=1.0 + 1e-4).contains(&v)); }
            assert!((profile_at(p, 0.0) - p[0]).abs() < 1e-6 && (profile_at(p, 0.5) - p[1]).abs() < 1e-6 && (profile_at(p, 1.0) - p[2]).abs() < 1e-6);
            if p[0] > p[1] + 0.2 && p[1] >= p[2] - 0.05 { top_heavy += 1; }
            if p[1] > p[0] + 0.2 && p[1] > p[2] + 0.2 { mid_heavy += 1; }
        }
        assert!(top_heavy > 10 && mid_heavy > 10, "{top_heavy} {mid_heavy}");
    }

    #[test]
    fn waves_are_deterministic_and_on_screen() {
        let hs = strip_hashes(1280);
        let (a, ga) = waves(1280.0, 800.0, 1.0, 40.0, &hs);
        let (b, gb) = waves(1280.0, 800.0, 1.0, 40.0, &hs);
        assert_eq!(a.len(), b.len());
        assert_eq!(ga.len(), gb.len());
        assert!(a.len() > 1500 && a.len() < 9000, "{}", a.len());
        assert!(!ga.is_empty());
        for s in &a { assert!(s.bottom > s.top && s.alpha.iter().all(|a| *a >= 0.0 && *a <= 1.0)); assert_eq!(s.x_dev % STRIP_W, 0); }
    }

    #[test]
    fn moon_is_a_ragged_disc_of_the_same_marks() {
        let (x0, y0, size, img) = moon_image(1280.0, 800.0, 1.0, 3);
        let (cx, cy, r) = moon_dev(1280.0, 800.0, 1.0);
        assert!((x0 as f32 + size as f32 / 2.0 - cx).abs() < 2.0 && (y0 as f32 + size as f32 / 2.0 - cy).abs() < 2.0);
        let inside = img.chunks(4).filter(|p| p[3] == 255).count() as f32;
        let area = std::f32::consts::PI * r * r;
        assert!((inside / area - 1.0).abs() < 0.1, "{inside} vs {area}");
    }
}
