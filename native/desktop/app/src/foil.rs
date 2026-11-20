//! "Foil waves": the maths of the backdrop, a port of `web/src/lib/foil.ts` (the web draws it with a WebGL shader; GPUI has
//! no custom shaders, so here it is drawn on the CPU, off the UI thread, at a low internal resolution).
//!
//! Two implementations of the same picture:
//!  * [`cell`]: the exact port, one cell at a time (the reference; tests pin it to values computed by the web code),
//!  * [`Renderer::frame`]: the fast whole-frame version used by the app. The smooth fields (wave coordinate, spacing,
//!    envelope, cloud density) are evaluated on a coarse grid (every [`K`] cells) and interpolated; the thin wave profile
//!    comes from a table. The stipple decisions use the same integer noise tile, so it matches [`cell`] closely.

use std::f32::consts::PI;

pub const N: usize = 128;
/// Size of one dot, in CSS pixels (a window pixel on a 1x screen). The web uses the same.
pub const DOT: f32 = 3.0;
/// Frames per second while animating (the web caps at 30; the slow drift does not need it).
pub const FPS: f32 = 15.0;
/// Seconds are wrapped like the web's `foilClock`.
pub const T_WRAP: f64 = 100000.0;
/// The still frame (reduced motion).
pub const STILL_T: f64 = 40.0;

const BASE: [f64; 3] = [6.0, 10.0, 26.0];
const WAVE: [f64; 3] = [118.0, 134.0, 255.0];
const CLOUD: [f64; 3] = [130.0, 176.0, 255.0];
const MOON: [f64; 3] = [116.0, 130.0, 255.0];
const GLINT: [f64; 3] = [226.0, 238.0, 255.0];
const GAIN: f64 = 0.85;

fn h32(x: i32, y: i32, c: i32) -> u8 {
    let mut h = x.wrapping_mul(374761393).wrapping_add(y.wrapping_mul(668265263)).wrapping_add((c + 1).wrapping_mul(-2048144777));
    h = (h ^ (((h as u32) >> 13) as i32)).wrapping_mul(1274126177);
    h ^= ((h as u32) >> 16) as i32;
    ((h as u32) >> 24) as u8
}

/// N x N RGBA bytes: R = wave stipple, G = cloud stipple, B = glint phase, A = brightness variance (same bytes as the web).
pub fn noise() -> Vec<u8> {
    let mut t = vec![0u8; N * N * 4];
    for y in 0..N { for x in 0..N { for c in 0..4 { t[(y * N + x) * 4 + c] = h32(x as i32, y as i32, c as i32); } } }
    t
}

#[inline]
fn nz(n: &[u8], x: i64, y: i64, c: usize) -> f64 {
    let (xi, yi) = (x.rem_euclid(N as i64) as usize, y.rem_euclid(N as i64) as usize);
    (n[(yi * N + xi) * 4 + c] as f64 + 0.5) / 256.0
}

fn sstep(a: f64, b: f64, x: f64) -> f64 { let t = ((x - a) / (b - a)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }
fn fract(x: f64) -> f64 { x - x.floor() }

/// Wrap a time in seconds.
pub fn clock(secs: f64) -> f64 { secs % T_WRAP }

/// Colour (0..255, unrounded) of cell (cx, cy) of a w x h frame at time t seconds. The exact reference.
pub fn cell(cx: i64, cy: i64, w: f64, h: f64, t: f64, n: &[u8]) -> [f64; 3] {
    let asp = w / h;
    let u = (cx as f64 + 0.5) / w;
    let v = (cy as f64 + 0.5) / h;
    let x = u * asp;
    let (px, py) = (x * 1.25, v * 1.25);
    let a = (px * 2.1 + 1.4 * (py * 2.7 + t * 0.05).sin() + t * 0.03).sin();
    let b = (py * 2.9 - 1.2 * (px * 1.9 - t * 0.04).sin() - t * 0.025 + 2.0).sin();
    let c3 = ((px + py) * 3.7 + t * 0.045).sin();
    let cl = 0.5 + 0.5 * (0.45 * a + 0.35 * b + 0.2 * c3);
    let br = 0.82 + 0.18 * (t * 0.13).sin();
    let dc = sstep(0.52, 0.9, cl) * 0.85 * br + 0.3 * (-x * 2.0).exp() * (0.5 + 0.5 * cl);

    let base = 0.22 + 0.42 * u + 0.12 * (x * 1.6 + t * 0.09).sin() + 0.06 * (x * 3.4 - t * 0.14 + 1.3).sin() + 0.02 * (x * 9.3 + v * 3.0 + t * 0.23).sin();
    let sp = 0.115 + 0.04 * (x * 1.3 + 0.8).sin();
    let s = (v - base) / sp - t * 0.025;
    let d = ((fract(s + 0.5) - 0.5).abs()) * sp;
    let sig = 1.05 / h;
    let env = 0.1 + 0.9 * sstep(0.3, 0.78, 0.5 + 0.5 * (x * 1.8 + v * 2.2 - t * 0.05 + (v * 3.0 + t * 0.03).sin()).sin());
    let dw = ((-(d * d) / (2.0 * sig * sig)).exp() + 0.13 * (-(d * d) / (2.0 * (3.2 * sig) * (3.2 * sig))).exp()) * env * 0.88;

    let mx = asp * 0.86 + 0.008 * (t * 0.07).sin();
    let my = 0.2 + 0.008 * (t * 0.05).cos();
    let dm = 0.75 * (1.0 - sstep(0.0425, 0.05, (x - mx).hypot(v - my)));

    let (n_r, n_g, n_b, n_a) = (nz(n, cx, cy, 0), nz(n, cx, cy, 1), nz(n, cx, cy, 2), nz(n, cx, cy, 3));
    let n_m = nz(n, cx + 53, cy + 11, 0);
    let vr = 0.55 + 0.6 * n_a;
    let ph = (n_b - 0.72) / 0.28;
    let g = if n_b > 0.72 { (t * 0.7 + ph * 6.2832).sin().max(0.0).powf(30.0) } else { 0.0 };
    let ph2 = (n_b - 0.99) / 0.01;
    let star = if n_b > 0.99 { (t * 0.5 + ph2 * 6.2832).sin().max(0.0).powf(12.0) } else { 0.0 };

    let mut lit = true;
    let mut col = if n_r < dw { [WAVE[0] * vr, WAVE[1] * vr, WAVE[2] * vr] }
        else if n_m < dm { [MOON[0] * vr, MOON[1] * vr, MOON[2] * vr] }
        else if n_g < dc { let k = vr * 0.72; [CLOUD[0] * k, CLOUD[1] * k, CLOUD[2] * k] }
        else { lit = false; let k = cl * br; [BASE[0] + 4.0 * k + 150.0 * 0.6 * star, BASE[1] + 8.0 * k + 170.0 * 0.6 * star, BASE[2] + 18.0 * k + 230.0 * 0.6 * star] };
    if lit && g > 0.0 { let m = g * 0.9; for i in 0..3 { col[i] += (GLINT[i] - col[i]) * m; } }
    let vig = (1.0 - 0.5 * sstep(0.3, 0.85, (u - 0.5).hypot(v - 0.5))) * GAIN;
    [(col[0] * vig).min(255.0), (col[1] * vig).min(255.0), (col[2] * vig).min(255.0)]
}

// ------------------------------------------------------------------------------------------------ the fast frame

/// Cells between two evaluated points of the smooth fields.
const K: usize = 8;
const LUT_N: usize = 512;
const LUT_MAX: f32 = 10.5;

fn ss(a: f32, b: f32, x: f32) -> f32 { let t = ((x - a) / (b - a)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }

/// For a window of phys_w x phys_h physical pixels on a display with this scale factor: the cell grid (w, h), the dot size
/// in physical pixels, and how many texels per dot the picture is made with (`ex`). With `ex == dot` the image maps 1:1 to
/// device pixels, so the dots stay crisp even though GPUI samples images with linear filtering (it has no nearest filter);
/// a very large window uses fewer texels per dot (a picture of about 2.4 megapixels at most) and its dots get a soft edge.
pub fn grid_for(phys_w: u32, phys_h: u32, scale: f32) -> (usize, usize, usize, usize) {
    let dot = ((DOT * scale).round() as usize).max(2);
    let w = (phys_w as usize).div_ceil(dot).max(8);
    let h = (phys_h as usize).div_ceil(dot).max(8);
    let mut ex = dot;
    while ex > 1 && w * ex * h * ex > 2_400_000 { ex -= 1; }
    (w, h, dot, ex)
}

pub struct Renderer {
    noise: Vec<u8>,
    lut: Vec<f32>,
    vig: Vec<f32>,
    vig_for: (usize, usize),
}

impl Default for Renderer { fn default() -> Self { Self::new() } }

impl Renderer {
    pub fn new() -> Self {
        let mut lut = vec![0f32; LUT_N + 1];
        for (i, l) in lut.iter_mut().enumerate() {
            let q = i as f32 / LUT_N as f32 * LUT_MAX;
            *l = (-(q * q) / 2.0).exp() + 0.13 * (-(q * q) / (2.0 * 3.2 * 3.2)).exp();
        }
        Renderer { noise: noise(), lut, vig: vec![], vig_for: (0, 0) }
    }

    /// One frame of a w x h cell grid at time t, expanded `dot` x `dot` and written as BGRA (what GPUI wants) into a new
    /// buffer of (w*dot) x (h*dot) pixels.
    pub fn frame(&mut self, w: usize, h: usize, dot: usize, t: f64) -> Vec<u8> {
        let t = clock(t) as f32;
        let (wf, hf) = (w as f32, h as f32);
        let asp = wf / hf;
        if self.vig_for != (w, h) {
            self.vig = (0..w * h).map(|i| {
                let (cx, cy) = (i % w, i / w);
                let (u, v) = ((cx as f32 + 0.5) / wf, (cy as f32 + 0.5) / hf);
                (1.0 - 0.5 * ss(0.3, 0.85, (u - 0.5).hypot(v - 0.5))) * GAIN as f32
            }).collect();
            self.vig_for = (w, h);
        }
        // coarse grid of the smooth fields: s, spacing, env, cloud density, cloud tint
        let (gw, gh) = (w / K + 2, h / K + 2);
        let mut grid = vec![[0f32; 5]; gw * gh];
        let br = 0.82 + 0.18 * (t * 0.13).sin();
        for gy in 0..gh {
            let v = ((gy * K) as f32 + 0.5) / hf;
            for gx in 0..gw {
                let u = ((gx * K) as f32 + 0.5) / wf;
                let x = u * asp;
                let (px, py) = (x * 1.25, v * 1.25);
                let a = (px * 2.1 + 1.4 * (py * 2.7 + t * 0.05).sin() + t * 0.03).sin();
                let b = (py * 2.9 - 1.2 * (px * 1.9 - t * 0.04).sin() - t * 0.025 + 2.0).sin();
                let c3 = ((px + py) * 3.7 + t * 0.045).sin();
                let cl = 0.5 + 0.5 * (0.45 * a + 0.35 * b + 0.2 * c3);
                let dc = ss(0.52, 0.9, cl) * 0.85 * br + 0.3 * (-x * 2.0).exp() * (0.5 + 0.5 * cl);
                let base = 0.22 + 0.42 * u + 0.12 * (x * 1.6 + t * 0.09).sin() + 0.06 * (x * 3.4 - t * 0.14 + 1.3).sin() + 0.02 * (x * 9.3 + v * 3.0 + t * 0.23).sin();
                let sp = 0.115 + 0.04 * (x * 1.3 + 0.8).sin();
                let s = (v - base) / sp - t * 0.025;
                let env = 0.1 + 0.9 * ss(0.3, 0.78, 0.5 + 0.5 * (x * 1.8 + v * 2.2 - t * 0.05 + (v * 3.0 + t * 0.03).sin()).sin());
                grid[gy * gw + gx] = [s, sp, env, dc, cl * br];
            }
        }
        let sig = 1.05 / hf;
        let lut_scale = LUT_N as f32 / LUT_MAX / sig;
        let mx = asp * 0.86 + 0.008 * (t * 0.07).sin();
        let my = 0.2 + 0.008 * (t * 0.05).cos();
        let (c_max_row, c_min_row) = (((my + 0.06) * hf) as i64, ((my - 0.06) * hf) as i64);
        let wd = w * dot;
        let mut out = vec![0u8; wd * h * dot * 4];
        let mut row = vec![[0f32; 5]; gw];
        let mut cells = vec![0u32; w];
        for cy in 0..h {
            let (gy, fy) = (cy / K, (cy % K) as f32 / K as f32);
            for gx in 0..gw {
                let (p, q) = (grid[gy * gw + gx], grid[(gy + 1) * gw + gx]);
                for i in 0..5 { row[gx][i] = p[i] + (q[i] - p[i]) * fy; }
            }
            let v = (cy as f32 + 0.5) / hf;
            let moon_row = (cy as i64) >= c_min_row && (cy as i64) <= c_max_row;
            for cx in 0..w {
                let (gx, fx) = (cx / K, (cx % K) as f32 / K as f32);
                let (p, q) = (&row[gx], &row[gx + 1]);
                let s = p[0] + (q[0] - p[0]) * fx;
                let sp = p[1] + (q[1] - p[1]) * fx;
                let env = p[2] + (q[2] - p[2]) * fx;
                let dc = p[3] + (q[3] - p[3]) * fx;
                let k = p[4] + (q[4] - p[4]) * fx;
                let ni = ((cy & (N - 1)) * N + (cx & (N - 1))) * 4;
                let nb = (self.noise[ni + 2] as f32 + 0.5) / 256.0;
                let n_r = (self.noise[ni] as f32 + 0.5) / 256.0;
                let n_g = (self.noise[ni + 1] as f32 + 0.5) / 256.0;
                let vr = 0.55 + 0.6 * ((self.noise[ni + 3] as f32 + 0.5) / 256.0);
                // wave
                let d = ((s + 0.5) - (s + 0.5).floor() - 0.5).abs() * sp;
                let qi = (d * lut_scale) as usize;
                let dw = if qi < LUT_N { self.lut[qi] * env * 0.88 } else { 0.0 };
                let (lit, mut col);
                if n_r < dw { lit = true; col = [WAVE[0] as f32 * vr, WAVE[1] as f32 * vr, WAVE[2] as f32 * vr]; }
                else {
                    let mut moon = false;
                    if moon_row {
                        let x = (cx as f32 + 0.5) / wf * asp;
                        let dm = 0.75 * (1.0 - ss(0.0425, 0.05, (x - mx).hypot(v - my)));
                        if dm > 0.0 {
                            let ni2 = (((cy + 11) & (N - 1)) * N + ((cx + 53) & (N - 1))) * 4;
                            if (self.noise[ni2] as f32 + 0.5) / 256.0 < dm { moon = true; }
                        }
                    }
                    if moon { lit = true; col = [MOON[0] as f32 * vr, MOON[1] as f32 * vr, MOON[2] as f32 * vr]; }
                    else if n_g < dc { lit = true; let kk = vr * 0.72; col = [CLOUD[0] as f32 * kk, CLOUD[1] as f32 * kk, CLOUD[2] as f32 * kk]; }
                    else {
                        lit = false;
                        let star = if nb > 0.99 { (t * 0.5 + (nb - 0.99) / 0.01 * 6.2832).sin().max(0.0).powf(12.0) } else { 0.0 };
                        col = [BASE[0] as f32 + 4.0 * k + 90.0 * star, BASE[1] as f32 + 8.0 * k + 102.0 * star, BASE[2] as f32 + 18.0 * k + 138.0 * star];
                    }
                }
                if lit && nb > 0.72 {
                    let g = (t * 0.7 + (nb - 0.72) / 0.28 * 2.0 * PI).sin().max(0.0).powf(30.0);
                    if g > 0.0 { let m = g * 0.9; for i in 0..3 { col[i] += (GLINT[i] as f32 - col[i]) * m; } }
                }
                let vg = self.vig[cy * w + cx];
                let (r, g, b) = ((col[0] * vg).min(255.0) as u32, (col[1] * vg).min(255.0) as u32, (col[2] * vg).min(255.0) as u32);
                cells[cx] = b | (g << 8) | (r << 16) | (255 << 24); // BGRA in memory (little endian u32 = A R G B)
            }
            // expand: each cell dot x dot device pixels, the first row written, the others copied from it
            let r0 = cy * dot * wd * 4;
            {
                let dst = &mut out[r0..r0 + wd * 4];
                for (cx, c) in cells.iter().enumerate() {
                    let b = c.to_le_bytes();
                    for j in 0..dot { let o = (cx * dot + j) * 4; dst[o..o + 4].copy_from_slice(&b); }
                }
            }
            for j in 1..dot { out.copy_within(r0..r0 + wd * 4, r0 + j * wd * 4); }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // values computed by the web code (web/src/lib/foil.ts foilCell) for the same cells
    const GOLD: [(i64, i64, f64, f64, f64, [f64; 3]); 12] = [
        (0, 0, 427., 267., 0., [39.0115, 50.7003, 70.6624]),
        (10, 7, 48., 30., 3., [54.3238, 73.5460, 106.5582]),
        (200, 100, 427., 267., 40., [108.6453, 123.3768, 234.7843]),
        (300, 50, 427., 267., 40., [6.0345, 10.4086, 26.3250]),
        (365, 40, 427., 267., 40., [5.2608, 9.0729, 22.9493]),
        (100, 200, 427., 267., 123.4, [5.9548, 10.2422, 25.9630]),
        (426, 266, 427., 267., 40., [3.3910, 5.7858, 14.7613]),
        (17, 250, 320., 200., 7777.5, [3.3449, 5.8398, 14.6270]),
        (160, 100, 320., 200., 12., [7.0493, 12.3986, 30.8719]),
        (5, 5, 427., 267., 40., [38.1098, 51.5948, 74.7538]),
        (60, 130, 427., 267., 40., [6.1253, 10.5774, 26.7273]),
        (250, 130, 427., 267., 40., [78.5344, 106.3235, 154.0483]),
    ];

    #[test]
    fn noise_matches_the_web_tile() {
        let n = noise();
        assert_eq!(&n[..8], &[125, 0, 197, 77, 234, 41, 149, 11]);
        assert_eq!(n[127 * N * 4 + 127 * 4 + 3], 170);
        assert_eq!(n[50 * N * 4 + 77 * 4 + 1], 73);
    }

    #[test]
    fn cell_matches_the_web_values() {
        let n = noise();
        for (x, y, w, h, t, want) in GOLD {
            let got = cell(x, y, w, h, t, &n);
            for i in 0..3 { assert!((got[i] - want[i]).abs() < 0.01, "cell ({x},{y}) {w}x{h} t={t}: {got:?} vs {want:?}"); }
        }
    }

    #[test]
    fn frames_are_deterministic_and_move_slowly() {
        let mut r = Renderer::new();
        let a = r.frame(96, 60, 2, 20.0);
        assert_eq!(a, r.frame(96, 60, 2, 20.0));
        let b = r.frame(96, 60, 2, 20.5);
        let moved = a.chunks(4).zip(b.chunks(4)).filter(|(p, q)| (p[0] as i32 - q[0] as i32).abs() > 40).count() as f64 / (a.len() / 4) as f64;
        assert!(moved > 0.002 && moved < 0.35, "moved {moved}");
    }

    #[test]
    fn the_fast_frame_matches_the_reference() {
        let (w, h) = (160usize, 100usize);
        let mut r = Renderer::new();
        let f = r.frame(w, h, 1, 40.0);
        let n = noise();
        let (mut bad, mut sum) = (0usize, 0f64);
        for cy in 0..h { for cx in 0..w {
            let e = cell(cx as i64, cy as i64, w as f64, h as f64, 40.0, &n);
            let o = (cy * w + cx) * 4;
            let (er, eb) = (e[0], e[2]);
            let d = (f[o + 2] as f64 - er).abs().max((f[o] as f64 - eb).abs());
            sum += d;
            if d > 12.0 { bad += 1; }
        } }
        let share = bad as f64 / (w * h) as f64;
        assert!(share < 0.03, "{share} of cells differ by more than 12 levels");
        assert!(sum / ((w * h) as f64) < 3.0, "mean abs error {}", sum / (w * h) as f64);
    }

    #[test]
    fn frame_layout_is_bgra_expanded() {
        let mut r = Renderer::new();
        let f = r.frame(16, 10, 3, 5.0);
        assert_eq!(f.len(), 16 * 3 * 10 * 3 * 4);
        assert!(f.chunks(4).all(|p| p[3] == 255));
        // a dot is dot x dot identical pixels
        for cx in 0..16 { let a = &f[cx * 3 * 4..cx * 3 * 4 + 4]; assert_eq!(a, &f[(cx * 3 + 2) * 4..(cx * 3 + 2) * 4 + 4]); }
        assert_eq!(&f[..4], &f[16 * 3 * 4 * 2..16 * 3 * 4 * 2 + 4]);
    }

    #[test]
    fn grid_uses_whole_pixel_dots_and_caps_big_windows() {
        assert_eq!(grid_for(1280, 800, 1.0), (427, 267, 3, 3));
        assert_eq!(grid_for(2560, 1600, 2.0), (427, 267, 6, 4));
        let (w, h, dot, ex) = grid_for(3840, 2160, 1.0);
        assert!(dot == 3 && ex < dot && w * ex * h * ex <= 2_400_000);
        assert_eq!(grid_for(1, 1, 1.0).0, 8);
    }
}
