//! "Foil waves": the maths of the backdrop, a port of `web/src/lib/foil.ts` (the web draws it per pixel in a WebGL shader at
//! full device resolution; GPUI has no custom shaders, so [`crate::backdrop`] draws the same picture from these pieces):
//!
//!  * the background: a field woven entirely of very fine short diagonal dashes (1 px thick, 2-4 px long, up to the right, each
//!    in its own dark shade; some pure black, most near-black navy, a few lighter navy-blue) with rare brighter stray pixels,
//!    and the moon's marks, as one pre-rendered image at device resolution, moved by whole device pixels as it drifts (so it
//!    stays crisp, and moving it costs nothing),
//!  * the wave bands as vector paths (soft glow) plus per-device-column strips: short vertical dashes with their own top,
//!    bottom and brightness, which stay put on screen while the band slides through them.
//!
//! Everything here is pure maths (positions in, numbers out) so it can be tested without a window. Coordinates: `x` and `v`
//! are logical pixels divided by the viewport height; `asp` is width / height.

/// Frames per second of the wave overlay (bands, glints, moon). The bands drift a few pixels a second; more frames cost more CPU.
pub const FPS: f32 = 10.0;
/// The still frame (reduced motion).
pub const STILL_T: f32 = 40.0;
/// Seconds of one loop of the waves: a band travels from the middle to the edge in about this time; the dust drift (2.5 px/s) repeats after 3 loops.
pub const T_LOOP: f32 = 25.6;
pub const T_WRAP: f32 = 76800.0; // 3000 loops
pub const N_BANDS: usize = 8;
/// A band's radius grows as phase^BAND_GAMMA (spacing grows outward, as in the reference).
pub const BAND_GAMMA: f32 = 1.25;
/// The largest radius is this much of the window's half diagonal, so a wavefront has left every corner before it restarts.
pub const RMAX_K: f32 = 1.3;
/// Half thickness (css px) at the middle and at the window's corners.
pub const HW_MIN: f32 = 1.0;
pub const HW_MAX: f32 = 9.5;
/// Ragged top and bottom of a strip: device px, 1 + 0.05 x half thickness, at most 2.
pub const JIT_BASE: f32 = 1.0;
pub const JIT_SLOPE: f32 = 0.05;
pub const JIT_MAX: f32 = 2.0;
/// Share of a band's strips lit at its birth, and the radius share (of the half diagonal) from which all are lit.
pub const FILL_MIN: f32 = 0.06;
pub const FILL_FULL_AT: f32 = 0.62;
pub const GLOW_K: f32 = 1.8;
pub const N_DASH: f32 = 110.0;

pub const BASE: [f32; 3] = [6.0, 10.0, 26.0];
pub const WAVE: [f32; 3] = [105.0, 125.0, 255.0];
pub const HOT: [f32; 3] = [205.0, 222.0, 255.0];
/// Glints: pixels (runs of 1-3) inside the strips that flash almost white and fade.
pub const GLINT: [f32; 3] = [240.0, 246.0, 255.0];
pub const GLINT_SHARE: f32 = 0.05;
pub const STRAY: [f32; 3] = [130.0, 145.0, 255.0];
/// Share of dashes that are pure black / the lighter navy-blue ones (the rest: near-black navy).
pub const DUST_BLACK: f32 = 0.3;
pub const DUST_LIGHT: f32 = 0.1;
pub const MOON: [f32; 3] = [120.0, 135.0, 255.0];
/// A separator column between two strips is this much as bright as the strip before it (0.4 = 60% dimmer, never black).
pub const SEP_GAIN: f32 = 0.4;
pub const GLOW_AMP: f32 = 0.2;
/// Gain of the band body (as in the shader).
pub const BODY_GAIN: f32 = 3.6;
pub const STRIP_W: i32 = 2;
pub const DASH_SPEED: f32 = 2.5;
pub const STRAY_DENSITY: f32 = 0.0016;
pub const MOON_R: f32 = 0.05;
pub const MOON_X: f32 = 0.86;
pub const MOON_V: f32 = 0.2;
/// How much of its brightness the moon keeps (it sits inside the fade to black).
pub const MOON_DIM: f32 = 0.55;
/// Drift distance (device px) after which the dust pattern repeats exactly.
/// (192 divides evenly by 2, 3 and 4, the dash lengths.)
pub const DUST_CYCLE: i32 = 192;

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

/// Brightness of a strip at time t from its hash (irregular, drifting slowly; two full swings per loop).
pub fn strip_bright(h: [f32; 3], t: f32) -> f32 { (0.45 + 0.55 * h[0].powf(1.2)) * (0.88 + 0.12 * (TAU * 2.0 * t / T_LOOP + h[1] * TAU).sin()) }
/// Raggedness of a strip's top and bottom, in -1..1 (scaled by [`jitter_px`]): hashed per strip.
pub fn strip_jitter(h: [f32; 3]) -> (f32, f32) { (h[1] * 2.0 - 1.0, h[2] * 2.0 - 1.0) }
/// How far (device px) a strip's ends may stray from the band's edge: about 1 px at the thin middle, up to 2 px at the thick edge.
pub fn jitter_px(hw: f32) -> f32 { (JIT_BASE + JIT_SLOPE * hw).min(JIT_MAX) }
/// Reach (device px) of a strip above (`top`) and below its band's centre line, for the band's half thickness `hw` (device px).
pub fn strip_reach(hw: f32, jt: f32, jb: f32) -> (f32, f32) { let j = jitter_px(hw); ((hw + jt * j).max(1.0), (hw + jb * j).max(1.0)) }
/// Brightness along a strip's own height: five control points (top .. bottom, the last equal to the first so that the
/// profile can slowly travel down the strip as a loop) of hashed, contrasty values.
pub fn strip_profile(h: [[f32; 3]; 2]) -> [f32; 5] {
    let q = |v: f32| 0.2 + 0.8 * v.powf(1.5);
    [q(h[0][0]), q(h[0][1]), q(h[0][2]), q(h[1][0]), q(h[0][0])] // closed: the profile travels along the strip as a loop
}
/// The profile at y01 (0 top .. 1 bottom): smooth (smoothstep) between the control points, so no banding.
pub fn profile_at(p: [f32; 5], y01: f32) -> f32 {
    let u = y01.clamp(0.0, 1.0) * 4.0;
    let i = (u.floor() as usize).min(3);
    let f = u - i as f32;
    p[i] + (p[i + 1] - p[i]) * f * f * (3.0 - 2.0 * f)
}
/// How many times (1-3) the brightness profile of a strip travels down it in one loop.
pub fn travel_loops(h0: f32) -> f32 { 1.0 + (h0 * 3.0).floor().min(2.0) }

/// One device column of the wave bands. The columns run as: a strip (1 or 2 device px, hashed per strip), then a 1 px
/// separator, then the next strip, and so on. Every strip keeps its own look (brightness, ragged ends, profile); its
/// separator column shares them at [`SEP_GAIN`] of the brightness. `id` numbers the strips (it seeds which strips are lit).
#[derive(Clone, Copy, Debug)]
pub struct Col { pub id: u32, pub sep: bool, pub bright_h: [f32; 3], pub jt: f32, pub jb: f32, pub prof: [f32; 5] }

pub fn columns(ncols: usize) -> Vec<Col> {
    let mut out = Vec::with_capacity(ncols + 4);
    let mut i = 0f32;
    while out.len() < ncols {
        let h = hash3(i, 7.0);
        let (jt, jb) = strip_jitter(h);
        let prof = strip_profile([hash3(i, 11.0), hash3(i, 12.0)]);
        let w = 1 + (hash3(i, 13.0)[0] >= 0.5) as usize;
        for _ in 0..w { out.push(Col { id: i as u32, sep: false, bright_h: h, jt, jb, prof }); }
        out.push(Col { id: i as u32, sep: true, bright_h: h, jt, jb, prof });
        i += 1.0;
    }
    out.truncate(ncols);
    out
}

/// Is strip `id` lit in band `k` where the band is `fill` full (0..1)? A hashed scatter: the same strips stay lit as `fill` grows.
pub fn strip_lit(id: u32, k: usize, fill: f32) -> bool { hash3(id as f32, 20.0 + k as f32)[0] < fill }

pub fn lump(a: f32, k: i32, t: f32) -> f32 { let k = k as f32; 0.78 + 0.22 * (a * 0.07 + k * 1.9 + TAU * t / T_LOOP + (a * 0.03 + k).sin() * 1.5).sin() }

// ------------------------------------------------------------------------------------------ the waves
//
// A family of N_BANDS wavefronts that travel outward from the middle of the window and repeat exactly every T_LOOP seconds.
// Band k is born at the centre when (t / T_LOOP + k / N_BANDS) crosses a whole number, grows outward, thicker and fuller the
// further out it is, and leaves the window at the edge. Each is an ARC (not a closed ring) of a wobbly polar curve
// r = R(theta), with the ends of the reference's composition: one end breaks up into dashes, every other band's end curls into
// a hook. Everything about band k that is random is hashed from k, so the loop is exact.

pub const TAU: f32 = std::f32::consts::TAU;
type P = (f32, f32);

/// The fixed look of band slot `k`: where its arc starts and how far it runs (radians), its hook (0 = none, else how far the
/// end curls inward as a share of the radius), and four phases for the wobble.
#[derive(Clone, Copy, Debug)]
pub struct Band { pub th0: f32, pub span: f32, pub hook: f32, pub ph: [f32; 4], pub rot: f32 }

pub fn band(k: usize) -> Band {
    let (h, g, q) = (hash3(k as f32 + 0.5, 101.0), hash3(k as f32 + 0.5, 102.0), hash3(k as f32 + 0.5, 103.0));
    Band { th0: h[0] * TAU, span: 3.4 + 2.4 * h[1], hook: if k % 2 == 1 { 0.14 + 0.14 * h[2] } else { 0.0 }, ph: [g[0] * TAU, g[1] * TAU, g[2] * TAU, q[0] * TAU], rot: q[1] * TAU }
}

/// Where band slot `k` is in its life, 0 (born at the centre) .. 1 (gone), at time t.
pub fn band_phase(t: f32, k: usize) -> f32 { fract(t / T_LOOP + k as f32 / N_BANDS as f32) }

/// The window's centre and the largest radius a band reaches (a band is gone once its smallest radius passes every corner).
pub fn centre(w: f32, h: f32) -> P { (w * 0.5, h * 0.5) }
pub fn half_diag(w: f32, h: f32) -> f32 { 0.5 * w.hypot(h) }
pub fn r_max(w: f32, h: f32) -> f32 { half_diag(w, h) * RMAX_K }

/// Angle at which band `k`'s arc starts at phase p (it also rotates a little, and back, over a life).
pub fn start_angle(b: &Band, p: f32) -> f32 { b.th0 + 0.35 * (TAU * p + b.rot).sin() }

/// The radius of band `b` at phase `p`, in direction `th`, for the largest radius `rmax`, and the arc fraction `u` (0..1 inside
/// the arc; outside it is >= 1). The wobble (speed and bend vary smoothly around the band) travels along the band.
pub fn band_r(b: &Band, p: f32, th: f32, rmax: f32) -> (f32, f32) {
    let tp = TAU * p;
    let wob = 0.10 * (3.0 * th + b.ph[0] + tp).sin() + 0.06 * (5.0 * th + b.ph[1] - tp).sin() + 0.03 * (8.0 * th + b.ph[2] + 2.0 * tp).sin() + 0.012 * (14.0 * th + b.ph[3] - 3.0 * tp).sin();
    let u = pmod(th - start_angle(b, p), TAU) / b.span;
    let hk = sstep(0.74, 1.0, u.min(1.0));
    (rmax * p.powf(BAND_GAMMA) * (1.0 + wob) * (1.0 - b.hook * hk * hk), u)
}

/// Half thickness (device px) of a band at radius r (the window's half diagonal is 1): thin in the middle, thicker outward.
pub fn half_thick(rn: f32, scale: f32) -> f32 { scale * (HW_MIN + (HW_MAX - HW_MIN) * rn.clamp(0.0, 1.35).powf(1.2)) }
/// How much of a band's strips are lit at radius share `rn`: a few scattered ones in the middle, all of them further out.
pub fn fill_at(rn: f32) -> f32 { FILL_MIN + (1.0 - FILL_MIN) * sstep(0.06, FILL_FULL_AT, rn) }
/// Glow width (device px) for a band of half thickness `hw`.
pub fn glow_sigma(hw: f32, scale: f32) -> f32 { (GLOW_K * hw).max(3.0 * scale) }
/// Brightness of a band along its arc (0..1 fraction `u`, radians `span`), without the fade: lumps, and the ends: the far end
/// breaks into dashes.
pub fn arc_ev(u: f32, span: f32, k: usize, t: f32) -> f32 {
    let dz = ((1.0 - u) / 0.22).min(1.0);
    let dashed = if dz >= 1.0 || fract(u * N_DASH) < 0.25 + 0.75 * dz { 1.0 } else { 0.0 };
    lump(u * span * 60.0, k as i32, t) * dashed
}

/// Fade of the backdrop towards black: 0 in the middle of the window, 1 at the top-right corner, smooth.
pub fn fade_at(u: f32, v: f32) -> f32 { sstep(0.0, 0.85, (u - 0.5) + (0.5 - v)) }
/// Brightness base by position (window fractions): dimmer towards the upper left.
pub fn base_ev(u: f32, v: f32) -> f32 { 0.75 + 0.35 * ((u + v - 0.6) / 1.2).clamp(0.0, 1.0) }

/// One band of the waves, in device pixels, as a dense polyline with what the painter needs along it.
pub struct Curve {
    pub pts: Vec<[f32; 2]>,
    /// distance along the arc from its start / to its end (device px; R x angle)
    pub s: Vec<f32>, pub se: Vec<f32>,
    pub ev: Vec<f32>, pub hw: Vec<f32>, pub fill: Vec<f32>,
    pub idx: i32,
}

/// All bands at time t for a w x h device-pixel window (`scale` device px per logical px) that are on the window.
pub fn curves(w: f32, h: f32, scale: f32, t: f32) -> Vec<Curve> {
    let (cx, cy) = centre(w, h);
    let (hd, rmax) = (half_diag(w, h), r_max(w, h));
    let mut out = Vec::with_capacity(N_BANDS);
    for k in 0..N_BANDS {
        let (b, p) = (band(k), band_phase(t, k));
        let th0 = start_angle(&b, p);
        let mut c = Curve { pts: vec![], s: vec![], se: vec![], ev: vec![], hw: vec![], fill: vec![], idx: k as i32 };
        let mut a = 0.0f32; // angle travelled from the start
        while a <= b.span {
            let th = th0 + a;
            let (r, u) = band_r(&b, p, th, rmax);
            let (x, y) = (cx + r * th.cos(), cy + r * th.sin());
            let (fu, fv) = (x / w, y / h);
            let rn = r / hd;
            c.pts.push([x, y]);
            c.s.push(r * a);
            c.se.push(r * (b.span - a));
            c.ev.push(base_ev(fu, fv) * arc_ev(u, b.span, k, t) * (1.0 - fade_at(fu, fv)));
            c.hw.push(half_thick(rn, scale));
            c.fill.push(fill_at(rn));
            a += (2.0 / r.max(2.0)).clamp(1e-4, 0.05); // about 2 px along the arc
        }
        if c.pts.len() > 1 && c.pts.iter().any(|q| q[0] > -60.0 && q[0] < w + 60.0 && q[1] > -60.0 && q[1] < h + 60.0) { out.push(c); }
    }
    out
}

/// Seconds wrapped like the web's `foilClock`.
pub fn clock(secs: f32) -> f32 { secs % T_WRAP }
/// Drift step (whole device pixels) at time t.
pub fn shift_at(t: f32) -> i32 { ((t * DASH_SPEED).floor() as i32).rem_euclid(DUST_CYCLE) }

/// One device pixel of the background: the colour of the dash it belongs to (every pixel belongs to one), a rare brighter stray
/// pixel (0 = none) and the dash's identity for tests. `py` counts from the top; `shift` is the drift step (whole pixels).
/// Rows are 1 px apart across the up-right diagonal; along a row the dashes have a hashed length of 2-4 px and a hashed offset,
/// so neighbouring rows are staggered and no grid shows. `moon`: the moon's version, the same marks in periwinkle.
pub struct Dust { pub rgb: [f32; 3], pub stray: f32, pub row: i32, pub cell: i32, pub len: i32 }

pub fn dust(px: i32, py: i32, shift: i32, moon: bool) -> Dust {
    let sh = shift.rem_euclid(DUST_CYCLE);
    let (xs, ys) = (px - sh, py + sh);
    let (a, b) = (xs + ys, xs - ys);
    let hr = hash3(a as f32, 3.0);
    let len = 2 + (hr[0] * 3.0).floor() as i32;
    let phase = (hr[1] * len as f32).floor() as i32;
    let cell = (b.div_euclid(2) + phase).rem_euclid(DUST_CYCLE) / len;
    let h = hash3(a as f32 + 0.5, cell as f32 + 17.0);
    let rgb = if moon && h[0] < 0.75 { let k = 0.3 + 0.6 * h[1]; [MOON[0] * k, MOON[1] * k, MOON[2] * k] }
        else if h[0] < DUST_BLACK { [0.0, 0.0, 0.0] }
        else if h[0] > 1.0 - DUST_LIGHT { [10.0 + 7.0 * h[1], 15.0 + 8.0 * h[1], 33.0 + 13.0 * h[1]] }
        else { [2.0 + 5.0 * h[1], 3.0 + 6.0 * h[1], 8.0 + 14.0 * h[1]] };
    let hs = hash3(a as f32 + 0.25, b.rem_euclid(2 * DUST_CYCLE) as f32 + 0.75);
    Dust { rgb, stray: if hs[0] < STRAY_DENSITY { 0.4 + 0.6 * hs[1] } else { 0.0 }, row: a, cell, len }
}

fn bgra(c: [f32; 3], stray: f32) -> [u8; 4] {
    let mut c = c;
    if stray > 0.0 { for i in 0..3 { c[i] += STRAY[i] * stray; } }
    [c[2].min(255.0) as u8, c[1].min(255.0) as u8, c[0].min(255.0) as u8, 255]
}

/// The background as an opaque image of w x h device pixels covering the screen pixels x in [-DUST_CYCLE, w - DUST_CYCLE),
/// y in [0, h) (so it can be slid up and to the right by `shift` < DUST_CYCLE and still cover the screen): BGRA.
pub fn dust_image(w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    for iy in 0..h {
        for ix in 0..w {
            let d = dust(ix as i32 - DUST_CYCLE, iy as i32, 0, false);
            let i = (iy * w + ix) * 4;
            out[i..i + 4].copy_from_slice(&bgra(d.rgb, d.stray));
        }
    }
    out
}

/// Moon centre and radius in device pixels for a viewport of w x h logical pixels at this scale.
pub fn moon_dev(w: f32, h: f32, scale: f32) -> (f32, f32, f32) { (w / h * MOON_X * h * scale, MOON_V * h * scale, MOON_R * h * scale) }


/// Draws the wave bands of a w x h device-pixel window (`scale` device px per logical px) at time t into `buf`
/// (premultiplied BGRA, w * h * 4 bytes, zeroed): for every line, a soft glow plus the strips, column by column, each strip a
/// short vertical dash with its own top, bottom and brightness profile and a dimmer separator column after it.
/// How lit a glint is at the pixel with band-relative coordinates (x, yr) at time t (0..1): hashed positions and times, runs of
/// 1-3 pixels along the strip, each flashing sharply and fading over 0.3-1 s, every few seconds. `share`: how many pixels can glint.
pub fn glint_at(x: i32, yr: i32, t: f32, share: f32) -> f32 {
    let block = yr.div_euclid(3);
    // a cheap integer hash decides first (nearly every pixel stops here)
    let mut hh = (x as u32).wrapping_mul(0x9E37_79B1) ^ (block as u32).wrapping_mul(0x85EB_CA77);
    hh = (hh ^ (hh >> 15)).wrapping_mul(0x2C1B_3C6D);
    if ((hh >> 8) & 0xFFFF) as f32 / 65536.0 > share * 3.0 { return 0.0; } // a block of 3 rows holds at most one glint: 3 x the share of the pixels
    let hg = hash3(x as f32 + 0.5, block as f32 + 3.0);
    let len = 1 + (hg[2] * 3.0).floor() as i32;
    let off = (fract(hg[2] * 7.3) * (4 - len) as f32).floor() as i32;
    let r = yr.rem_euclid(3);
    if r < off || r >= off + len { return 0.0; }
    let period = T_LOOP / (T_LOOP / (2.5 + 3.0 * hg[1])).round().max(1.0); // a whole number of flashes per loop
    let dur = 0.3 + 0.7 * fract(hg[1] * 5.1);
    let phase = (t + hg[1] * 17.0).rem_euclid(period);
    if phase >= dur { return 0.0; }
    (1.0 - phase / dur).powf(1.5)
}

/// What the moon looks like between two drift steps (it only changes every 0.4 s): kept by the worker so a frame only adds the
/// glints. Pixels: (buffer index x, y, colour of an inside pixel, or glow alpha for an outside one).
#[derive(Default)]
pub struct MoonCache { key: (usize, usize, u32, i32), inside: Vec<(usize, usize, [f32; 3])>, glow: Vec<(usize, usize, f32)> }

/// The moon into the same overlay: a faint soft glow around it, then the ragged-edged disc of the same marks as the field
/// but in brighter periwinkle with stippled single pixels, and glints that flash near-white and fade. Crisp on exact pixels.
pub fn render_moon(w: usize, h: usize, scale: f32, t: f32, buf: &mut [u8], cache: &mut MoonCache) {
    let (wl, hl) = (w as f32 / scale, h as f32 / scale);
    let (cx, cy, r) = moon_dev(wl, hl, scale);
    let shift = shift_at(t);
    let key = (w, h, scale.to_bits(), shift);
    if cache.key != key || cache.inside.is_empty() {
        cache.key = key;
        cache.inside.clear();
        cache.glow.clear();
        let reach = r + 14.0 * scale + 3.0;
        let (x0, x1) = (((cx - reach).floor().max(0.0)) as usize, ((cx + reach).ceil().min(w as f32 - 1.0)).max(0.0) as usize);
        let (y0, y1) = (((cy - reach).floor().max(0.0)) as usize, ((cy + reach).ceil().min(h as f32 - 1.0)).max(0.0) as usize);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                let d = (dx * dx + dy * dy).sqrt();
                let edge = (hash3(x as f32 + 31.0, y as f32 + 31.0)[0] - 0.5) * 3.0;
                if d >= r + edge {
                    let q = (d - r) / (5.0 * scale);
                    let a = 0.2 * (-q * q / 2.0).exp();
                    if a > 0.004 { cache.glow.push((x, y, a)); }
                    continue;
                }
                let dd = dust(x as i32, y as i32, shift, true);
                let mut col = [dd.rgb[0] * 1.5, dd.rgb[1] * 1.5, dd.rgb[2] * 1.5];
                let hp = hash3(x as f32 + 53.0, y as f32 + 53.0);
                if hp[0] < 0.3 { let m = 0.5 + 0.5 * hash3(x as f32 + 9.0, y as f32 + 9.0)[1]; for c in 0..3 { col[c] += (HOT[c] * 0.3 + MOON[c] * 0.8) * m; } }
                for c in 0..3 { col[c] += STRAY[c] * dd.stray; }
                cache.inside.push((x, y, col));
            }
        }
    }
    for &(x, y, a) in &cache.glow {
        let i = (y * w + x) * 4;
        if buf[i + 3] == 0 { buf[i] = (MOON[2] * a * MOON_DIM) as u8; buf[i + 1] = (MOON[1] * a * MOON_DIM) as u8; buf[i + 2] = (MOON[0] * a * MOON_DIM) as u8; buf[i + 3] = (a * 255.0) as u8; }
    }
    for &(x, y, mut col) in &cache.inside {
        let g = glint_at(x as i32 + 7919, y as i32, t, 0.05);
        if g > 0.0 { for c in 0..3 { col[c] += (GLINT[c] - col[c]) * g; } }
        let i = (y * w + x) * 4;
        // the moon stays visible but dimmer, as it sits in the fade
        for c in &mut col { *c *= MOON_DIM; }
        buf[i] = col[2].min(255.0) as u8; buf[i + 1] = col[1].min(255.0) as u8; buf[i + 2] = col[0].min(255.0) as u8; buf[i + 3] = 255;
    }
}

pub fn render_waves(w: usize, h: usize, scale: f32, t: f32, cols: &[Col], buf: &mut [u8], moon: &mut MoonCache) {
    render_bands(w, h, scale, t, cols, buf);
    render_moon(w, h, scale, t, buf, moon);
}

/// What the painter needs for one pixel of a band (see [`render_bands`]).
struct Painter<'a> { w: usize, h: usize, scale: f32, t: f32, cols: &'a [Col], sbs: Vec<f32>, lut: Vec<f32> }

const GLOW_R: f32 = 1.5;
const LUT: usize = 128;

impl Painter<'_> {
    /// One pixel (xi, y) at signed perpendicular distance `sd` (device px, positive down / to the right) from the band's centre
    /// line; `hw`: the band's half thickness there, `fill`: how full the band is there (see [`strip_lit`]), `k` the band.
    #[allow(clippy::too_many_arguments)]
    fn pixel(&self, buf: &mut [u8], xi: usize, y: usize, sd: f32, hw: f32, fill: f32, ev: f32, travel: f32, gk: (i32, i32), k: usize) {
        let col = &self.cols[xi];
        if !strip_lit(col.id, k, fill) { return; }
        let (ht, hb) = strip_reach(hw, col.jt, col.jb);
        let sb = self.sbs[xi];
        let sep = if col.sep { SEP_GAIN } else { 1.0 };
        let q = sd.abs() / glow_sigma(hw, self.scale);
        let mut a = if q < GLOW_R { GLOW_AMP * ev * fill * self.lut[(q / GLOW_R * LUT as f32) as usize] } else { 0.0 };
        let cov = (sd + ht).min(hb - sd) + 0.5;
        let (mut m, mut glint) = (0.0, 0.0);
        if cov > 0.0 {
            let yy = (sd + ht) / (ht + hb) + travel;
            let body = cov.min(1.0) * profile_at(col.prof, yy - yy.floor()) * sb * ev * BODY_GAIN;
            // a separator is SEP_GAIN of the strip before it (of its brightness as shown, so exactly 0.4x)
            a += body.min(1.0) * sep;
            m = ((body - 1.3) / 2.0).clamp(0.0, 1.0);
            if !col.sep && cov >= 1.0 && body > 0.25 { glint = glint_at(gk.0, gk.1, self.t, GLINT_SHARE) * body.min(1.0); }
        }
        if a < 0.012 { return; }
        let mut a = a.min(1.0);
        let m = m.max(glint * 0.95);
        let (mut cr, mut cg, mut cb) = (WAVE[0] + (HOT[0] - WAVE[0]) * m, WAVE[1] + (HOT[1] - WAVE[1]) * m, WAVE[2] + (HOT[2] - WAVE[2]) * m);
        if glint > 0.0 { cr += (GLINT[0] - cr) * glint; cg += (GLINT[1] - cg) * glint; cb += (GLINT[2] - cb) * glint; a = a.max(glint); }
        let i = (y * self.w + xi) * 4;
        // premultiplied; where bands meet the brighter one wins
        buf[i] = buf[i].max((cb * a) as u8); buf[i + 1] = buf[i + 1].max((cg * a) as u8); buf[i + 2] = buf[i + 2].max((cr * a) as u8); buf[i + 3] = buf[i + 3].max((a * 255.0) as u8);
    }
}

/// Draws every band (strips with separators, ragged ends, brightness profiles, glints, glow) into `buf`.
/// A shallow piece of a band is painted column by column (a vertical dash per column), a steep piece row by row (the band's
/// width spread over the columns it crosses, each column its own strip): the same strips either way.
fn render_bands(w: usize, h: usize, scale: f32, t: f32, cols: &[Col], buf: &mut [u8]) {
    let lut: Vec<f32> = (0..=LUT).map(|i| { let q = i as f32 / LUT as f32 * GLOW_R; (-q * q / 2.0).exp() }).collect();
    let sbs: Vec<f32> = cols.iter().map(|c| strip_bright(c.bright_h, t)).collect(); // (a power and a sine per column: once a frame, not once a pixel)
    let p = Painter { w, h, scale, t, cols, sbs, lut };
    let (wf, hf) = (w as f32, h as f32);
    for c in curves(wf, hf, scale, t) {
        let k = c.idx as usize;
        // every strip stops a little short of the arc's ends, each at its own place: ragged, comb-like ends
        let ragged = |xi: usize, s: f32, se: f32| { let h = hash3(xi as f32 + 0.5, 3.3); s < h[0] * 12.0 * scale || se < h[1] * 12.0 * scale };
        let travel_of = |xi: usize| travel_loops(cols[xi.min(cols.len() - 1)].bright_h[0]) * t / T_LOOP;
        for j in 0..c.pts.len() - 1 {
            let (a, b) = (c.pts[j], c.pts[j + 1]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len = dx.hypot(dy);
            if len < 1e-3 { continue; }
            let (ev0, ev1, hw0, hw1, fl0, fl1) = (c.ev[j], c.ev[j + 1], c.hw[j], c.hw[j + 1], c.fill[j], c.fill[j + 1]);
            if ev0.max(ev1) < 0.02 { continue; }
            let reach_of = |hw: f32| (GLOW_R * glow_sigma(hw, scale)).max(hw + JIT_MAX) + 1.0;
            if dy.abs() <= dx.abs() {
                // shallow: one vertical dash per column
                let (x0, x1) = (a[0].min(b[0]), a[0].max(b[0]));
                let (i0, i1) = (((x0 - 0.5).ceil().max(0.0)) as i64, ((x1 - 0.5).ceil() as i64 - 1).min(w as i64 - 1));
                for xi in i0..=i1 {
                    let f = ((xi as f32 + 0.5) - a[0]) / dx;
                    let (y, ev, hw, fl) = (a[1] + dy * f, ev0 + (ev1 - ev0) * f, hw0 + (hw1 - hw0) * f, fl0 + (fl1 - fl0) * f);
                    let (s, se) = (c.s[j] + (c.s[j + 1] - c.s[j]) * f, c.se[j] + (c.se[j + 1] - c.se[j]) * f);
                    if ev < 0.02 || ragged(xi as usize, s, se) { continue; }
                    let inv_c = 1.0 / (1.0 + (dy / dx) * (dy / dx)).sqrt();
                    let reach = reach_of(hw) / inv_c;
                    let (y0, y1) = ((y - reach).floor().max(0.0) as usize, (y + reach).ceil().min(hf - 1.0).max(0.0) as usize);
                    for yy in y0..=y1 {
                        let sd = (yy as f32 + 0.5 - y) * inv_c;
                        p.pixel(buf, xi as usize, yy, sd, hw, fl, ev, travel_of(xi as usize), (xi as i32 + c.idx * 131, yy as i32 - y as i32), k);
                    }
                }
            } else {
                // steep: one horizontal run of columns per row
                let (y0, y1) = (a[1].min(b[1]), a[1].max(b[1]));
                let (r0, r1) = (((y0 - 0.5).ceil().max(0.0)) as i64, ((y1 - 0.5).ceil() as i64 - 1).min(h as i64 - 1));
                let cos_phi = dy.abs() / len;
                for yy in r0..=r1 {
                    let f = ((yy as f32 + 0.5) - a[1]) / dy;
                    let (x, ev, hw, fl) = (a[0] + dx * f, ev0 + (ev1 - ev0) * f, hw0 + (hw1 - hw0) * f, fl0 + (fl1 - fl0) * f);
                    let (s, se) = (c.s[j] + (c.s[j + 1] - c.s[j]) * f, c.se[j] + (c.se[j + 1] - c.se[j]) * f);
                    if ev < 0.02 { continue; }
                    let reach = reach_of(hw) / cos_phi;
                    let (x0, x1) = ((x - reach).floor().max(0.0) as usize, (x + reach).ceil().min(wf - 1.0).max(0.0) as usize);
                    for xi in x0..=x1 {
                        let sd = (xi as f32 + 0.5 - x) * cos_phi;
                        if ragged(xi, s, se) { continue; }
                        p.pixel(buf, xi, yy as usize, sd, hw, fl, ev, travel_of(xi), (xi as i32 - x as i32 + 7000 + c.idx * 131, yy as i32), k);
                    }
                }
            }
        }
    }
}

/// Where the band slots start in the float array of the GPU shader (see `shaders/foil.wgsl`), and the column table after them.
pub const GPU_BANDS_AT: usize = 16;
pub const GPU_COLS_AT: usize = 96;

/// The app's floats for the GPU shader of a w x h device-pixel window: 0 width, 1 height, 2 scale, 3 t, 4 dust shift, 5 columns,
/// 6-8 the moon (x, y, radius); from 16 the bands (10 floats each: start angle, span, hook, four phases, phase p, r_max x p^gamma,
/// 0); from 96 one float per device column (strip id x 2 + 1 for a separator). Everything per-frame that the shader cannot
/// cheaply derive: a few hundred floats and the column table (cached by the caller, copied here).
pub fn gpu_data(w: f32, h: f32, scale: f32, t: f32, cols: &[Col]) -> Vec<f32> {
    let mut d = vec![0.0f32; GPU_COLS_AT + cols.len()];
    let (mx, my, mr) = (w * MOON_X, MOON_V * h, MOON_R * h);
    d[..9].copy_from_slice(&[w, h, scale, t, shift_at(t) as f32, cols.len() as f32, mx, my, mr]);
    let rmax = r_max(w, h);
    for k in 0..N_BANDS {
        let (b, p) = (band(k), band_phase(t, k));
        let o = GPU_BANDS_AT + k * 10;
        d[o..o + 9].copy_from_slice(&[start_angle(&b, p), b.span, b.hook, b.ph[0], b.ph[1], b.ph[2], b.ph[3], p, rmax * p.powf(BAND_GAMMA)]);
    }
    for (i, c) in cols.iter().enumerate() { d[GPU_COLS_AT + i] = (c.id * 2 + c.sep as u32) as f32; }
    d
}

/// The fade to black as an image of w x h device pixels: black with an alpha from [`fade_at`], dithered (4x4 ordered) so the
/// 8-bit steps of the gradient do not show as bands over the dash field. Premultiplied BGRA.
pub fn fade_image(w: usize, h: usize) -> Vec<u8> {
    const B: [f32; 16] = [0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.];
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        let v = (y as f32 + 0.5) / h as f32;
        for x in 0..w {
            let f = fade_at((x as f32 + 0.5) / w as f32, v) * 255.0;
            let d = (B[(y & 3) * 4 + (x & 3)] + 0.5) / 16.0;
            out[(y * w + x) * 4 + 3] = (f + d).floor().min(255.0) as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_waves_repeat_exactly_every_loop() {
        let (w, h) = (1280.0, 800.0);
        for t in [0.0f32, 3.3, 17.0, 40.0] {
            let (a, b) = (curves(w, h, 1.0, t), curves(w, h, 1.0, t + T_LOOP));
            assert_eq!(a.len(), b.len());
            for (x, y) in a.iter().zip(&b) { assert_eq!(x.idx, y.idx); for (p, q) in x.pts.iter().zip(&y.pts).step_by(9) { assert!((p[0] - q[0]).hypot(p[1] - q[1]) < 0.05, "{p:?} {q:?}"); } }
        }
        // bands are spaced a whole slot apart: one slot later, the picture is the same set of phases
        for k in 0..N_BANDS { assert!((band_phase(5.0, k) - band_phase(5.0 + T_LOOP / N_BANDS as f32, (k + N_BANDS - 1) % N_BANDS)).abs() < 1e-4 || (band_phase(5.0, k) - band_phase(5.0 + T_LOOP / N_BANDS as f32, (k + N_BANDS - 1) % N_BANDS)).abs() > 0.999); }
        // per-band randomness depends only on the slot
        assert_eq!(band(3).th0, band(3).th0);
        // the strips and glints loop too
        let c = columns(50);
        for x in &c { assert!((strip_bright(x.bright_h, 2.0) - strip_bright(x.bright_h, 2.0 + T_LOOP)).abs() < 1e-3); }
        for x in 0..200 { for yr in -5..5 { assert!((glint_at(x, yr, 1.7, 0.2) - glint_at(x, yr, 1.7 + T_LOOP, 0.2)).abs() < 1e-3); } }
    }

    #[test]
    fn the_waves_travel_outward_from_the_middle() {
        let (w, h) = (1280.0, 800.0);
        let (cx, cy) = centre(w, h);
        let mean_r = |t: f32, k: usize| { let c = curves(w, h, 1.0, t).into_iter().find(|c| c.idx == k as i32); c.map(|c| c.pts.iter().map(|p| (p[0] - cx).hypot(p[1] - cy)).sum::<f32>() / c.pts.len() as f32) };
        // a band born at phase 0 is tiny, and phase p puts it at rmax * p^gamma (in its mean direction)
        let t0 = 0.0;
        let b0: Vec<(f32, usize)> = (0..N_BANDS).map(|k| (band_phase(t0, k), k)).collect();
        let young = b0.iter().min_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).unwrap();
        let old = b0.iter().filter(|b| b.0 < 0.7).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).unwrap();
        let (ry, ro) = (mean_r(t0, young.1), mean_r(t0, old.1));
        if let (Some(ry), Some(ro)) = (ry, ro) { assert!(ro > ry * 1.5, "older bands are further out: {ry} {ro}"); }
        // radius of a fixed direction grows monotonically along a life
        let b = band(2);
        let mut last = -1.0;
        for i in 1..50 { let (r, _) = band_r(&b, i as f32 / 50.0, 1.0, 1000.0); assert!(r > last * 0.8, "outward"); if i % 10 == 0 { assert!(r > last || i < 3); } last = r; }
        // wobbly, not a circle: the radius varies by more than a few per cent around the band, but stays within +-25%
        let (mn, mx) = (0..200).fold((9e9f32, 0f32), |(a, c), i| { let (r, _) = band_r(&b, 0.6, i as f32 * TAU / 200.0, 1000.0); (a.min(r), c.max(r)) });
        assert!(mx / mn > 1.15 && mx / mn < 1.8, "{mn}..{mx}");
    }

    #[test]
    fn bands_get_thicker_and_fuller_the_further_out_and_start_nearly_empty() {
        for s in [1.0f32, 2.0] {
            let mut last = 0.0;
            for i in 0..=12 { let hw = half_thick(i as f32 * 0.1, s); assert!(hw >= last); last = hw; }
            assert!(half_thick(0.0, s) <= 1.05 * s && half_thick(1.0, s) >= 9.0 * s);
        }
        assert!(fill_at(0.0) <= 0.07 && fill_at(0.7) >= 0.999);
        let mut last = 0.0;
        for i in 0..=20 { let f = fill_at(i as f32 * 0.05); assert!(f >= last); last = f; }
        // the lit strips near the middle are a sparse scatter (5-10%) and stay lit as it fills
        let lit = |f: f32| (0..4000u32).filter(|id| strip_lit(*id, 3, f)).count() as f32 / 4000.0;
        assert!((lit(fill_at(0.0)) - 0.06).abs() < 0.025, "{}", lit(fill_at(0.0)));
        assert!(lit(1.0) > 0.999);
        for id in 0..4000u32 { if strip_lit(id, 5, 0.3) { assert!(strip_lit(id, 5, 0.6)); } }
    }

    #[test]
    fn strip_ends_stray_by_only_a_pixel_or_two() {
        for hw in [1.0f32, 5.0, 10.0, 20.0, 40.0] { let j = jitter_px(hw); assert!((1.0..=2.0).contains(&j), "{hw}: {j}"); }
        assert!(jitter_px(2.0) < jitter_px(30.0));
        for hw in [4.0f32, 12.0, 25.0] {
            for k in 0..300 {
                let (jt, jb) = strip_jitter(hash3(k as f32, 7.0));
                let (top, bot) = strip_reach(hw, jt, jb);
                assert!((top - hw).abs() <= 2.001 && (bot - hw).abs() <= 2.001, "{hw}: {top} {bot}");
            }
        }
    }

    #[test]
    fn the_far_ends_of_the_arcs_break_into_dashes() {
        let cs = curves(1280.0, 800.0, 1.0, 12.0);
        let c = cs.iter().max_by_key(|c| c.pts.len()).unwrap();
        let n = c.ev.len();
        let tail: Vec<f32> = c.ev[n - n / 12..].to_vec();
        let on = tail.iter().filter(|e| **e > 0.001).count();
        assert!(on > 0 && on < tail.len(), "dashes, not a solid line and not nothing ({on} of {})", tail.len());
    }

    #[test]
    fn the_fade_runs_from_the_middle_to_the_top_right_corner() {
        assert!(fade_at(0.5, 0.5) < 0.01);
        assert!(fade_at(0.0, 1.0) == 0.0 && fade_at(0.1, 0.9) == 0.0);
        assert!(fade_at(1.0, 0.0) > 0.99);
        let mut last = -1.0;
        for i in 0..=20 { let f = fade_at(0.5 + i as f32 * 0.025, 0.5 - i as f32 * 0.025); assert!(f >= last); last = f; }
        // dithered image: alpha follows the gradient within one step, and neighbouring pixels differ by at most one step
        let img = fade_image(320, 200);
        let a = |x: usize, y: usize| img[(y * 320 + x) * 4 + 3] as i32;
        assert!(a(0, 199) == 0 && a(319, 0) >= 254 && a(160, 100) <= 1);
        let mut mid_levels = std::collections::BTreeSet::new();
        for x in 100..300 { let v = a(x, 100 - (x - 100) / 2); mid_levels.insert(v); }
        assert!(mid_levels.len() > 30, "a smooth ramp, many levels");
        for y in 0..200 { for x in 1..320 { assert!((a(x, y) - a(x - 1, y)).abs() <= 3); } }
    }

    #[test]
    fn dust_covers_every_pixel_with_a_dark_dash() {
        let (mut black, mut light, mut n, mut mx, mut stray) = (0, 0, 0, 0f32, 0);
        for y in 0..200 { for x in 0..300 {
            let d = dust(x, y, 5, false);
            n += 1;
            let l: f32 = d.rgb.iter().sum();
            for c in d.rgb { mx = mx.max(c); }
            if l == 0.0 { black += 1; } else if l > 50.0 { light += 1; }
            assert!(d.rgb[2] >= d.rgb[0]);
            if d.stray > 0.0 { stray += 1; }
        } }
        let f = |c: i32| c as f32 / n as f32;
        assert!(f(black) > 0.2 && f(black) < 0.45, "black {}", f(black));
        assert!(f(light) > 0.05 && f(light) < 0.2, "light {}", f(light));
        assert!(mx < 50.0, "{mx}");
        assert!(f(stray) > 0.0008 && f(stray) < 0.004, "{}", f(stray));
    }

    #[test]
    fn dust_is_woven_of_two_to_four_pixel_dashes_up_and_right() {
        let mut lens = std::collections::BTreeSet::new();
        for y in 40..60 { for x in 40..140 {
            let d = dust(x, y, 5, false);
            assert!((2..=4).contains(&d.len));
            let u = dust(x + 1, y - 1, 5, false);
            assert_eq!(u.row, d.row);
            assert!((0..=1).contains(&(u.cell - d.cell)) || (u.cell - d.cell) < 0, "cells run on along the row (wrapping at the cycle)");
            lens.insert(d.len);
        } }
        assert_eq!(lens.into_iter().collect::<Vec<_>>(), vec![2, 3, 4]);
        let d0 = dust(60, 60, 5, false);
        let mut run = 1;
        let mut i = 1; while i < 10 && dust(60 + i, 60 - i, 5, false).cell == d0.cell { run += 1; i += 1; }
        i = 1; while i < 10 && dust(60 - i, 60 + i, 5, false).cell == d0.cell { run += 1; i += 1; }
        assert_eq!(run, d0.len);
    }

    #[test]
    fn dust_drifts_a_pixel_at_a_time_and_repeats_after_the_cycle() {
        for y in 2..80 { for x in 2..120 { assert_eq!(dust(x - 1, y + 1, 7, false).rgb, dust(x, y, 8, false).rgb); } }
        for i in 0..400 { assert_eq!(dust(i, i % 37, 3, false).rgb, dust(i, i % 37, 3 + DUST_CYCLE, false).rgb); }
        assert_eq!(shift_at(0.0), 0);
        assert_eq!(shift_at(1.0), 2);
        assert!(shift_at(1e5) < DUST_CYCLE);
    }

    #[test]
    fn dust_image_slides_to_equal_the_direct_dust() {
        let (w, h) = (300usize, 100usize);
        let c = DUST_CYCLE as usize;
        let img = dust_image(w + c, h + c);
        let iw = w + c;
        let s = 37usize;
        for y in 0..h { for x in 0..w {
            // screen pixel (x, y) at shift s is image pixel (x - s + CYCLE, y + s)
            let i = ((y + s) * iw + (x + c - s)) * 4;
            let d = dust(x as i32, y as i32, s as i32, false);
            assert_eq!(&img[i..i + 4], &bgra(d.rgb, d.stray));
        } }
    }

    #[test]
    fn columns_run_strip_then_one_pixel_separator() {
        let cols = columns(600);
        assert_eq!(cols.len(), 600);
        let (mut run, mut widths) = (0, std::collections::BTreeSet::new());
        for (i, c) in cols.iter().enumerate() {
            if c.sep {
                assert!(run == 1 || run == 2, "strips are 1 or 2 px wide, got {run} at column {i}");
                widths.insert(run);
                run = 0;
                if i + 1 < cols.len() { assert!(!cols[i + 1].sep, "never two separators in a row"); }
                assert_eq!(c.jt, cols[i - 1].jt);
                assert_eq!(c.prof, cols[i - 1].prof);
            } else { run += 1; }
        }
        assert_eq!(widths.len(), 2, "both widths occur");
    }

    #[test]
    fn strips_vary_along_their_height_and_in_brightness() {
        let cols = columns(2000);
        let mut contrast = 0;
        for c in cols.iter().filter(|c| !c.sep) {
            for v in c.prof { assert!((0.2 - 1e-4..=1.0 + 1e-4).contains(&v)); }
            assert!((-1.0..=1.0).contains(&c.jt) && (-1.0..=1.0).contains(&c.jb));
            let (mn, mx) = (c.prof.iter().cloned().fold(9.0, f32::min), c.prof.iter().cloned().fold(0.0, f32::max));
            if mx - mn > 0.4 { contrast += 1; }
            let br = strip_bright(c.bright_h, 9.0);
            assert!(br > 0.2 && br < 1.001);
        }
        assert!(contrast * 3 > cols.iter().filter(|c| !c.sep).count(), "a third of the strips swing by more than 0.4");
        // smooth: the profile never jumps between neighbouring rows of a strip
        for c in cols.iter().take(300) { for i in 0..100 { assert!((profile_at(c.prof, i as f32 / 100.0) - profile_at(c.prof, (i + 1) as f32 / 100.0)).abs() < 0.12); } }
    }

    #[test]
    fn waves_render_deterministically_with_dimmer_separators() {
        let (w, h) = (640usize, 400usize);
        let cols = columns(w);
        let mut a = vec![0u8; w * h * 4];
        let mut b = vec![0u8; w * h * 4];
        render_waves(w, h, 1.0, 12.0, &cols, &mut a, &mut MoonCache::default());
        render_waves(w, h, 1.0, 12.0, &cols, &mut b, &mut MoonCache::default());
        assert_eq!(a, b);
        let lit = a.chunks(4).filter(|p| p[3] > 8).count();
        assert!(lit > 4000 && lit < w * h * 6 / 10, "{lit}");
        // along the brightest row of a band, a separator is dimmer than the strip before it (same row, adjacent columns)
        let (mut checked, mut dimmer) = (0, 0);
        for y in 0..h { for x in 1..w {
            if cols[x].sep && !cols[x - 1].sep {
                let (s, p) = (a[(y * w + x - 1) * 4 + 3] as f32, a[(y * w + x) * 4 + 3] as f32);
                if s > 150.0 { checked += 1; if p < s * 0.75 { dimmer += 1; } }
            }
        } }
        assert!(checked > 50, "{checked}");
        assert!(dimmer * 10 > checked * 7, "{dimmer} of {checked}");
    }

    #[test]
    fn glints_flash_and_fade_in_runs_of_one_to_three_pixels() {
        let (mut active, mut total, mut runs) = (0, 0, std::collections::BTreeSet::new());
        for x in 0..300 { for yr in -30..30 { total += 1; if glint_at(x, yr, 5.0, GLINT_SHARE) > 0.0 { active += 1; } } }
        let share = active as f32 / total as f32;
        assert!(share > 0.002 && share < 0.06, "{share}");
        // a glint's brightness falls monotonically during its flash (0.3-1 s), then it is gone until its next turn
        for x in 0..200 { for yr in 0..30 {
            if glint_at(x, yr, 0.0, 0.5) > 0.0 {
                let mut last = 2.0; let mut ended = false;
                for i in 0..120 { let g = glint_at(x, yr, i as f32 * 0.02, 0.5); if g == 0.0 { ended = true; } else if !ended { assert!(g <= last + 1e-5); last = g; } }
                assert!(ended, "flash over within 2.4 s");
            }
        } }
        for x in 0..300 { let mut run = 0; for yr in 0..30 { if glint_at(x, yr, 5.0, GLINT_SHARE) > 0.0 { run += 1; } else { if run > 0 { runs.insert(run); } run = 0; } } }
        assert!(runs.iter().all(|r| *r >= 1 && *r <= 9), "a glint is 1-3 pixels; neighbours may touch: {runs:?}");
    }

    #[test]
    fn moon_is_a_bright_ragged_disc_with_a_soft_glow() {
        let (w, h) = (1280usize, 800usize);
        let mut buf = vec![0u8; w * h * 4];
        render_moon(w, h, 1.0, 40.0, &mut buf, &mut MoonCache::default());
        let (cx, cy, r) = moon_dev(1280.0, 800.0, 1.0);
        let inside = buf.chunks(4).filter(|p| p[3] == 255).count() as f32;
        assert!((inside / (std::f32::consts::PI * r * r) - 1.0).abs() < 0.1);
        let glow = buf.chunks(4).filter(|p| p[3] > 0 && p[3] < 255).count();
        assert!(glow > 200, "{glow}");
        // brighter than the field: some pixels are bright periwinkle, some near-white
        let bright = buf.chunks(4).filter(|p| p[3] == 255 && p[0] > 150).count();
        assert!(bright as f32 > inside * 0.1, "{bright}");
        let _ = (cx, cy);
    }

    #[test]
    fn gpu_data_packs_header_bands_and_columns() {
        let cols = columns(40);
        let d = gpu_data(1280.0, 800.0, 2.0, 12.0, &cols);
        assert_eq!(d.len(), GPU_COLS_AT + 40);
        assert_eq!(&d[..6], &[1280.0, 800.0, 2.0, 12.0, shift_at(12.0) as f32, 40.0]);
        assert!(d[6] > 1000.0 && d[7] > 0.0 && d[8] > 0.0, "moon");
        for k in 0..N_BANDS {
            let o = GPU_BANDS_AT + k * 10;
            assert!((d[o + 7] - band_phase(12.0, k)).abs() < 1e-6);
            assert!((d[o + 8] - r_max(1280.0, 800.0) * d[o + 7].powf(BAND_GAMMA)).abs() < 1e-2);
            assert!(d[o + 1] > 3.0 && d[o + 1] < 6.0, "span");
        }
        assert!(GPU_BANDS_AT + N_BANDS * 10 <= GPU_COLS_AT);
        for (i, c) in cols.iter().enumerate() { assert_eq!(d[GPU_COLS_AT + i] as u32 >> 1, c.id); assert_eq!(d[GPU_COLS_AT + i] as u32 & 1 == 1, c.sep); }
    }

    /// Not a test: `cargo test bench_waves --release -- --ignored --nocapture` prints the time of one frame of the wave overlay.
    #[test]
    #[ignore]
    fn bench_waves() {
        for (w, h, sc) in [(1280usize, 800usize, 1.0f32), (2560, 1600, 2.0)] {
            let cols = columns(w);
            let mut moon = MoonCache::default();
            let mut buf = vec![0u8; w * h * 4];
            render_waves(w, h, sc, 40.0, &cols, &mut buf, &mut moon);
            let n = 20;
            let t0 = std::time::Instant::now();
            for i in 0..n { let mut b = vec![0u8; w * h * 4]; render_waves(w, h, sc, 40.0 + i as f32 * 0.1, &cols, &mut b, &mut moon); std::hint::black_box(&b); }
            let t1 = t0.elapsed() / n;
            let t0 = std::time::Instant::now();
            for _ in 0..n { let b = vec![0u8; w * h * 4]; std::hint::black_box(&b); }
            let t0 = std::time::Instant::now();
            for i in 0..n { let mut b = vec![0u8; w * h * 4]; render_bands(w, h, sc, 40.0 + i as f32 * 0.1, &cols, &mut b); std::hint::black_box(&b); }
            println!("  bands only: {:?}", t0.elapsed() / n);
            { let mut b = vec![0u8; w * h * 4]; render_bands(w, h, sc, 40.0, &cols, &mut b); println!("  pixels written: {}", b.chunks(4).filter(|p| p[3] > 0).count()); }
            let t0 = std::time::Instant::now();
            for i in 0..n { let mut b = vec![0u8; w * h * 4]; render_moon(w, h, sc, 40.0 + i as f32 * 0.1, &mut b, &mut moon); std::hint::black_box(&b); }
            println!("  moon only (cache rebuilt every 4th): {:?}", t0.elapsed() / n);
            println!("{w}x{h}: {:?} per frame of the overlay (an empty buffer of the same size: {:?})", t1, t0.elapsed() / n);
        }
    }

    /// Not a test: `RUNE_FOIL_DUMP=<dir> cargo test dump_composite --release -- --ignored` writes the bare backdrop (dust, fade,
    /// waves, moon, the app's tint and edge shade left out) at 1280x800 for t = 4 + 3.2 i, i = 0..8, as <dir>/bare-<i>.png.
    #[test]
    #[ignore]
    fn dump_composite() {
        let Some(dir) = std::env::var_os("RUNE_FOIL_DUMP") else { return };
        let (w, h) = (1280usize, 800usize);
        let c = DUST_CYCLE as usize;
        let dust_img = dust_image(w + c, h + c);
        let fade = fade_image(w, h);
        let cols = columns(w);
        let mut moon = MoonCache::default();
        for i in 0..8 {
            let t = 4.0 + i as f32 * 3.2;
            let shift = shift_at(t) as usize;
            let mut waves = vec![0u8; w * h * 4];
            render_waves(w, h, 1.0, t, &cols, &mut waves, &mut moon);
            let mut out = image::RgbaImage::new(w as u32, h as u32);
            for y in 0..h { for x in 0..w {
                let di = ((y + shift) * (w + c) + (x + c - shift)) * 4;
                let mut px = [dust_img[di + 2] as f32, dust_img[di + 1] as f32, dust_img[di] as f32];
                let fa = fade[(y * w + x) * 4 + 3] as f32 / 255.0;
                for v in &mut px { *v *= 1.0 - fa; }
                let wi = (y * w + x) * 4;
                let wa = waves[wi + 3] as f32 / 255.0;
                px[0] = px[0] * (1.0 - wa) + waves[wi + 2] as f32; px[1] = px[1] * (1.0 - wa) + waves[wi + 1] as f32; px[2] = px[2] * (1.0 - wa) + waves[wi] as f32;
                out.put_pixel(x as u32, y as u32, image::Rgba([px[0].min(255.0) as u8, px[1].min(255.0) as u8, px[2].min(255.0) as u8, 255]));
            } }
            out.save(std::path::Path::new(&dir).join(format!("bare-{i}.png"))).unwrap();
        }
    }
}
