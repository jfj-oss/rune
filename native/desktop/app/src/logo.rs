//! The mark (web `Logo.tsx` + `lib/dotLogo.ts`): four balls on a square, one diagonal pair at a time swapping corners with a
//! motion trail. Drawn as a soft brightness field, then ordered-dithered with the web's blue-noise thresholds into very fine
//! dots, one dot per CSS pixel (`max(1, round(scale))` device pixels). Colours come from the foil's own periwinkle. Animated
//! only while the window is active; one still frame (t = 0) under "Reduce effects", like the web's reduced-motion path.
//! The maths is a line-by-line port of the web's, so motion, timing and dithering match.
use crate::bluenoise;
use gpui_kit::*;
use std::f32::consts::{PI, SQRT_2};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// One loop: pair A swaps in the first half, pair B in the second.
pub const LOOP_MS: f32 = 1500.0;
const MOVE: f32 = 0.5;
const B_START: f32 = 0.5;
const HALF_SIDE: f32 = 0.17;
const RADIUS: f32 = 0.15;
const BOW: f32 = 0.07;
const SWELL: f32 = 0.16;
const TRAIL_STEPS: usize = 9;
const TRAIL_GAP_MS: f32 = 20.0;

/// The foil's periwinkle (`shaders/foil.wgsl` WAVE, 105/125/255) is the light tone. The mid tone is a darker periwinkle, about 0.6 of
/// it (the web's red palette uses 0.39, but that vanishes on the navy foil).
pub const LIGHT: [u8; 3] = [105, 125, 255];
pub const MID: [u8; 3] = [62, 74, 150];

static REDUCE: AtomicBool = AtomicBool::new(false);
/// Reduce effects (set with the backdrop's preferences): the logo stays on its still frame.
pub fn set_reduce(r: bool) { REDUCE.store(r, Ordering::Relaxed); }

/// cubic-bezier(x1, y1, x2, y2) as an easing function (Newton on x, then y), as the web's `cubicBezier`.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 {
    let bx = move |t: f32| 3. * x1 * t * (1. - t).powi(2) + 3. * x2 * t * t * (1. - t) + t.powi(3);
    let by = move |t: f32| 3. * y1 * t * (1. - t).powi(2) + 3. * y2 * t * t * (1. - t) + t.powi(3);
    let dx = move |t: f32| 3. * x1 * (1. - t).powi(2) + 6. * (x2 - x1) * t * (1. - t) + 3. * (1. - x2) * t * t;
    move |x: f32| {
        if x <= 0. { return 0.; }
        if x >= 1. { return 1.; }
        let mut t = x;
        for _ in 0..6 {
            let d = dx(t);
            if d.abs() < 1e-6 { break; }
            t = (t - (bx(t) - x) / d).clamp(0., 1.);
        }
        by(t)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ball { pub x: f32, pub y: f32, pub r: f32 }

/// The four balls at time `ms` (positions and radius as fractions of the logo's width).
pub fn balls_at(ms: f32) -> [Ball; 4] {
    let ease = cubic_bezier(0.72, 0., 0.18, 1.14);
    let phase = ms.rem_euclid(LOOP_MS) / LOOP_MS;
    // pair A: top-left <-> bottom-right; pair B: top-right <-> bottom-left
    let pairs: [([f32; 2], [f32; 2], f32); 2] = [([-1., -1.], [1., 1.], 0.), ([1., -1.], [-1., 1.], B_START)];
    let mut out = [Ball { x: 0., y: 0., r: 0. }; 4];
    let mut n = 0;
    for (from, to, start) in pairs {
        let u = ((phase - start) / MOVE).clamp(0., 1.);
        let k = ease(u);
        let lift = (PI * u).sin();
        let px = -(to[1] - from[1]) / (2. * SQRT_2);
        let py = (to[0] - from[0]) / (2. * SQRT_2);
        for dir in [1., -1.] {
            let (a, b) = if dir == 1. { (from, to) } else { (to, from) };
            out[n] = Ball {
                x: 0.5 + HALF_SIDE * (a[0] + (b[0] - a[0]) * k) + px * BOW * lift * dir,
                y: 0.5 + HALF_SIDE * (a[1] + (b[1] - a[1]) * k) + py * BOW * lift * dir,
                r: RADIUS * (1. + SWELL * lift),
            };
            n += 1;
        }
    }
    out
}

/// Brightness (0..1+) of every cell of a `w` x `w` grid at `ms`: soft balls plus their trail (earlier samples, fainter and smaller).
pub fn brightness(ms: f32, w: usize) -> Vec<f32> {
    let mut into = vec![0f32; w * w];
    let wf = w as f32;
    let mut layers: Vec<([Ball; 4], f32, f32)> = vec![(balls_at(ms), 1.25, 1.0)];
    for k in 1..=TRAIL_STEPS {
        let kf = k as f32;
        layers.push((balls_at(ms - kf * TRAIL_GAP_MS), 0.8 * (1. - kf / (TRAIL_STEPS as f32 + 1.)), 1. - kf * 0.06));
    }
    for (balls, gain, scale) in layers {
        for b in balls {
            let r = b.r * scale * wf;
            let (cx, cy) = (b.x * wf, b.y * wf);
            let x0 = (cx - r).floor().max(0.) as usize;
            let x1 = ((cx + r).ceil().min(wf - 1.)).max(0.) as usize;
            let y0 = (cy - r).floor().max(0.) as usize;
            let y1 = ((cy + r).ceil().min(wf - 1.)).max(0.) as usize;
            for y in y0..=y1 { for x in x0..=x1 {
                let d2 = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)) / (r * r);
                if d2 >= 1. { continue; }
                let f = (1. - d2) * (1. - d2);
                let v = &mut into[y * w + x];
                *v = v.max(f * gain);
            } }
        }
    }
    into
}

const LIGHT_SHARE: f32 = 0.26;
const MID_SHARE: f32 = 0.74;
/// Light / mid pixel shares for a tone (web `densities`).
pub fn densities(tau: f32) -> (f32, f32) {
    let t = tau.clamp(0., 1.);
    let dl = t.powf(1.6) * LIGHT_SHARE;
    let dm = (1. - dl).min(t.powf(0.6) * MID_SHARE);
    (dl, dm)
}

/// Dither the field: 0 = black (or see-through, see [`cells`]), 1 = mid, 2 = light.
pub fn dither_levels(field: &[f32], w: usize) -> Vec<u8> {
    let th = bluenoise::thresholds();
    let mut out = vec![0u8; w * w];
    for y in 0..w { for x in 0..w {
        let i = y * w + x;
        let (dl, dm) = densities(field[i].min(1.));
        let t = th[(y % bluenoise::N) * bluenoise::N + (x % bluenoise::N)];
        out[i] = if t < dl { 2 } else if t < dl + dm { 1 } else { 0 };
    } }
    out
}

/// Per cell: `Some(level)` where something is drawn (level 0 = the black gaps inside a ball or trail), `None` where see-through.
pub fn cells(ms: f32, w: usize) -> Vec<Option<u8>> {
    let f = brightness(ms, w);
    dither_levels(&f, w).into_iter().zip(f).map(|(l, b)| if l > 0 || b > 0.015 { Some(l) } else { None }).collect()
}

fn start() -> Instant { static S: OnceLock<Instant> = OnceLock::new(); *S.get_or_init(Instant::now) }

pub fn logo(size: f32) -> impl IntoElement {
    canvas(|_, _, _| (), move |b, _, window, _| {
        let scale = window.scale_factor();
        let dot = scale.round().max(1.0);
        let w = (((size * scale) / dot).round() as usize).max(8);
        let reduce = REDUCE.load(Ordering::Relaxed);
        // RUNE_DESKTOP_LOGO_MS=<ms> (test tool): freeze the logo at that time, to compare frames with the web's
        let frozen = std::env::var("RUNE_DESKTOP_LOGO_MS").ok().and_then(|v| v.parse::<f32>().ok());
        let live = !reduce && frozen.is_none() && window.is_window_active();
        let ms = if reduce { 0.0 } else { frozen.unwrap_or_else(|| start().elapsed().as_secs_f32() * 1000.0) };
        if live { window.request_animation_frame(); }
        let cell = dot / scale;
        // a grid slightly off the box (rounding) is centred in it
        let (ox, oy) = (f32::from(b.origin.x) + (size - w as f32 * cell) / 2., f32::from(b.origin.y) + (size - w as f32 * cell) / 2.);
        let grid = cells(ms, w);
        for y in 0..w {
            let mut x = 0;
            while x < w {
                let Some(l) = grid[y * w + x] else { x += 1; continue };
                let mut e = x + 1;
                while e < w && grid[y * w + e] == Some(l) { e += 1; }
                let col = match l { 2 => LIGHT, 1 => MID, _ => [0, 0, 0] };
                let rgb = ((col[0] as u32) << 16) | ((col[1] as u32) << 8) | col[2] as u32;
                window.paint_quad(fill(Bounds { origin: point(px(ox + x as f32 * cell), px(oy + y as f32 * cell)), size: gpui_kit::size(px((e - x) as f32 * cell), px(cell)) }, rgba(rgb << 8 | 0xff)));
                x = e;
            }
        }
    }).size(px(size)).flex_none()
}

#[cfg(test)]
mod tests {
    use super::{balls_at, brightness, cells, cubic_bezier, densities, dither_levels, Ball, HALF_SIDE, LOOP_MS, RADIUS, SWELL};
    const E: f32 = 1e-4;
    fn near(a: Ball, x: f32, y: f32, r: f32) { assert!((a.x - x).abs() < E && (a.y - y).abs() < E && (a.r - r).abs() < E, "{a:?} vs {x} {y} {r}"); }

    #[test]
    fn easing_ends_and_overshoots() {
        let e = cubic_bezier(0.72, 0., 0.18, 1.14);
        assert_eq!((e(0.), e(1.)), (0., 1.));
        assert!(e(0.5) > 0.0 && e(0.5) < 1.0);
        assert!((0..100).any(|i| e(i as f32 / 100.) > 1.0), "the small overshoot past the corner");
    }

    #[test]
    fn balls_sit_on_the_square_at_loop_start_and_swap_at_the_half() {
        let (lo, hi) = (0.5 - HALF_SIDE, 0.5 + HALF_SIDE);
        let b = balls_at(0.);
        near(b[0], lo, lo, RADIUS); near(b[1], hi, hi, RADIUS); near(b[2], hi, lo, RADIUS); near(b[3], lo, hi, RADIUS);
        // pair A has landed (swapped) when pair B starts
        let h = balls_at(LOOP_MS * 0.5);
        near(h[0], hi, hi, RADIUS); near(h[1], lo, lo, RADIUS); near(h[2], hi, lo, RADIUS);
        // mid-flight: the ball swells and bows off the diagonal
        let q = balls_at(LOOP_MS * 0.25);
        assert!((q[0].r - RADIUS * (1. + SWELL)).abs() < E);
        assert!((q[0].x - q[0].y).abs() > 0.05, "bowed apart");
        assert!((q[0].x + q[1].x - 1.).abs() < E && (q[0].y + q[1].y - 1.).abs() < E, "the pair is symmetric about the centre");
    }

    /// The four balls are interchangeable, so compare them as a set (a pair that has swapped looks like the start).
    fn set(mut b: [Ball; 4]) -> [Ball; 4] { b.sort_by_key(|p| ((p.x * 100.).round() as i32, (p.y * 100.).round() as i32)); b }

    #[test]
    fn the_loop_is_seamless() {
        for k in 0..3 {
            let (a, b) = (set(balls_at(0.)), set(balls_at(k as f32 * LOOP_MS)));
            for i in 0..4 { near(a[i], b[i].x, b[i].y, b[i].r); }
        }
        // the end of the loop (both pairs landed) is the start; negative times wrap
        let (e, s) = (set(balls_at(LOOP_MS - 0.01)), set(balls_at(0.)));
        for i in 0..4 { near(e[i], s[i].x, s[i].y, s[i].r); }
        let (neg, pos) = (balls_at(-20.), balls_at(LOOP_MS - 20.));
        for i in 0..4 { near(neg[i], pos[i].x, pos[i].y, pos[i].r); }
        // the picture (balls and trails) is identical a loop later
        assert_eq!(brightness(0., 36), brightness(LOOP_MS, 36));
        assert_eq!(cells(0., 36), cells(LOOP_MS, 36));
    }

    #[test]
    fn dither_shares_match_the_web_densities() {
        assert_eq!(densities(0.), (0., 0.));
        let (l, m) = densities(1.);
        assert!((l - 0.26).abs() < 1e-6 && (m - 0.74).abs() < 1e-6);
        // a uniformly full field: about 26 % light, 74 % mid, no black (the blue-noise ranks are an exact permutation)
        let n = 64;
        let lv = dither_levels(&vec![1.0; n * n], n);
        let count = |v| lv.iter().filter(|&&x| x == v).count();
        assert!((count(2) as f32 / (n * n) as f32 - 0.26).abs() < 0.002, "light {}", count(2));
        assert!((count(1) as f32 / (n * n) as f32 - 0.74).abs() < 0.002, "mid {}", count(1));
        assert_eq!(count(0), 0);
        // an empty field draws nothing

        assert!(dither_levels(&vec![0.0; n * n], n).iter().all(|&x| x == 0));
    }

    #[test]
    fn a_frame_has_dots_inside_the_balls_and_see_through_outside() {
        let c = cells(0., 36);
        assert!(c.iter().filter(|x| **x == Some(2)).count() > 30);
        assert!(c.iter().filter(|x| **x == Some(1)).count() > 100);
        assert!(c.iter().filter(|x| **x == Some(0)).count() > 0, "black gaps");
        assert_eq!(c[0], None, "the corner is outside every ball");
    }
}
