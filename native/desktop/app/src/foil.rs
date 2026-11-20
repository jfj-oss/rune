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
pub const T_WRAP: f32 = 100000.0;

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
pub const BAND_HALF: f32 = 3.0;
pub const STRIP_JITTER: f32 = 4.2;
/// A separator column between two strips is this much as bright as the strip before it (0.4 = 60% dimmer, never black).
pub const SEP_GAIN: f32 = 0.4;
pub const GLOW_SIG: f32 = 7.0;
pub const GLOW_AMP: f32 = 0.2;
/// Gain of the band body (as in the shader).
pub const BODY_GAIN: f32 = 3.6;
pub const STRIP_W: i32 = 2;
pub const DASH_SPEED: f32 = 2.5;
pub const STRAY_DENSITY: f32 = 0.0016;
pub const MOON_R: f32 = 0.05;
pub const MOON_X: f32 = 0.86;
pub const MOON_V: f32 = 0.2;
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

/// Brightness of a strip at time t from its hash (irregular, drifting very slowly).
pub fn strip_bright(h: [f32; 3], t: f32) -> f32 { (0.45 + 0.55 * h[0].powf(1.2)) * (0.88 + 0.12 * (t * 0.5 + h[1] * 6.2832).sin()) }
/// How far (css px) a strip reaches above and below the band's centre line: a wide hashed spread, so some strips are much
/// shorter and some much taller than the band's nominal edge (never under 1.2 px).
pub fn strip_extent(h: [f32; 3]) -> (f32, f32) { ((BAND_HALF + (h[1] * 2.0 - 1.0) * STRIP_JITTER).max(1.2), (BAND_HALF + (h[2] * 2.0 - 1.0) * STRIP_JITTER).max(1.2)) }
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

/// One device column of the wave bands. The columns run as: a strip (1 or 2 device px, hashed per strip), then a 1 px
/// separator, then the next strip, and so on. Every strip keeps its own look (brightness, top and bottom reach, profile);
/// its separator column shares them at [`SEP_GAIN`] of the brightness.
#[derive(Clone, Copy, Debug)]
pub struct Col { pub sep: bool, pub bright_h: [f32; 3], pub top: f32, pub bottom: f32, pub prof: [f32; 5] }

pub fn columns(ncols: usize) -> Vec<Col> {
    let mut out = Vec::with_capacity(ncols + 4);
    let mut i = 0f32;
    while out.len() < ncols {
        let h = hash3(i, 7.0);
        let (top, bottom) = strip_extent(h);
        let prof = strip_profile([hash3(i, 11.0), hash3(i, 12.0)]);
        let w = 1 + (hash3(i, 13.0)[0] >= 0.5) as usize;
        for _ in 0..w { out.push(Col { sep: false, bright_h: h, top, bottom, prof }); }
        out.push(Col { sep: true, bright_h: h, top, bottom, prof });
        i += 1.0;
    }
    out.truncate(ncols);
    out
}

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
pub fn lump(a: f32, k: i32, t: f32) -> f32 { let k = k as f32; 0.78 + 0.22 * (a * 0.07 + k * 1.9 + t * 0.35 + (a * 0.03 + k).sin() * 1.5).sin() }
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

/// Vignette factor (1 in the middle, 0.5 in the far corners), like the shader's.
pub fn vignette(x: f32, asp: f32, v: f32) -> f32 { 1.0 - 0.5 * sstep(0.3, 0.85, ((x / asp - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt()) }

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
    let period = 2.5 + 3.0 * hg[1];
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
        if buf[i + 3] == 0 { buf[i] = (MOON[2] * a) as u8; buf[i + 1] = (MOON[1] * a) as u8; buf[i + 2] = (MOON[0] * a) as u8; buf[i + 3] = (a * 255.0) as u8; }
    }
    for &(x, y, mut col) in &cache.inside {
        let g = glint_at(x as i32 + 7919, y as i32, t, 0.05);
        if g > 0.0 { for c in 0..3 { col[c] += (GLINT[c] - col[c]) * g; } }
        let i = (y * w + x) * 4;
        buf[i] = col[2].min(255.0) as u8; buf[i + 1] = col[1].min(255.0) as u8; buf[i + 2] = col[0].min(255.0) as u8; buf[i + 3] = 255;
    }
}

pub fn render_waves(w: usize, h: usize, scale: f32, t: f32, cols: &[Col], buf: &mut [u8], moon: &mut MoonCache) {
    render_bands(w, h, scale, t, cols, buf);
    render_moon(w, h, scale, t, buf, moon);
}

fn render_bands(w: usize, h: usize, scale: f32, t: f32, cols: &[Col], buf: &mut [u8]) {
    let (wl, hl) = (w as f32 / scale, h as f32 / scale);
    let asp = wl / hl;
    const NODE: usize = 8; // device columns between two evaluated nodes of the (smooth) line geometry
    let nnodes = w / NODE + 2;
    // a table of the glow's gaussian over |sd| in units of sigma 0..GLOW_R
    const GLOW_R: f32 = 1.7;
    const LUT: usize = 128;
    let lut: Vec<f32> = (0..=LUT).map(|i| { let q = i as f32 / LUT as f32 * GLOW_R; (-q * q / 2.0).exp() }).collect();
    let sig_dev = GLOW_SIG * scale;
    // what the nodes share between all lines: x, the part of the base that does not depend on v, the spacing, the slope terms
    struct Nx { x: f32, xl: f32, base0: f32, sp: f32, db: f32, dsp: f32 }
    let nx: Vec<Nx> = (0..nnodes).map(|n| {
        let xl = ((n * NODE) as f32 + 0.5) / scale;
        let x = xl / hl;
        Nx {
            x, xl,
            base0: 0.22 + 0.42 * (x / asp) + 0.12 * (x * 1.6 + t * 0.09).sin() + 0.06 * (x * 3.4 - t * 0.14 + 1.3).sin(),
            sp: spacing(x),
            db: 0.42 / asp + 0.192 * (x * 1.6 + t * 0.09).cos() + 0.204 * (x * 3.4 - t * 0.14 + 1.3).cos(),
            dsp: 0.052 * (x * 1.3 + 0.8).cos(),
        }
    }).collect();
    let line_at = |k: i32, n: &Nx| -> f32 {
        let off = n.sp * (k as f32 - 0.5 + t * 0.025);
        let mut v = n.base0 + 0.02 * (n.x * 9.3 + 1.5 + t * 0.23).sin() + off;
        for _ in 0..2 { v = n.base0 + 0.02 * (n.x * 9.3 + v * 3.0 + t * 0.23).sin() + off; }
        v
    };
    let mut nodes: Vec<[f32; 5]> = Vec::with_capacity(nnodes);
    for k in -14..=18 {
        // a line that is nowhere on screen costs two sines at a few places, no more
        if (0..nnodes).step_by(16).all(|i| { let v = line_at(k, &nx[i]); v < -0.1 || v > 1.1 }) { continue; }
        // geometry at the nodes: (centre row in device px, env, slope, lump, vignette)
        nodes.clear();
        for n in &nx {
            let v = line_at(k, n);
            let m = (v - (n.base0 + 0.02 * (n.x * 9.3 + v * 3.0 + t * 0.23).sin())) / n.sp;
            let sl = n.db + 0.186 * (n.x * 9.3 + v * 3.0 + t * 0.23).cos() + n.dsp * m;
            nodes.push([v * h as f32, env(n.x, v, t), sl, lump(n.xl, k, t), vignette(n.x, asp, v)]);
        }
        if nodes.iter().all(|n| n[0] < -0.1 * h as f32 || n[0] > 1.1 * h as f32) { continue; }
        // per-column numbers of this line
        struct P { valid: bool, yc: f32, inv_c: f32, ht: f32, hb: f32, inv_h: f32, k_body: f32, k_glow: f32, sep: f32, lu: f32, sb: f32, travel: f32, reach: f32, y0: f32, y1: f32 }
        let lut_k = LUT as f32 / (GLOW_R * sig_dev);
        let params: Vec<P> = cols.iter().enumerate().take(w).map(|(xi, col)| {
            let none = P { valid: false, yc: 0., inv_c: 1., ht: 0., hb: 0., inv_h: 1., k_body: 0., k_glow: 0., sep: 1., lu: 0., sb: 0., travel: 0., reach: 0., y0: 1., y1: 0. };
            let (n0, f) = (xi / NODE, (xi % NODE) as f32 / NODE as f32);
            let (p, q) = (&nodes[n0], &nodes[n0 + 1]);
            let l = |i: usize| p[i] + (q[i] - p[i]) * f;
            let (yc, en, sl, lu, vg) = (l(0), l(1), l(2), l(3), l(4));
            if yc < -40.0 * scale || yc > h as f32 + 40.0 * scale { return none; }
            let ev = en * lu * vg;
            if ev < 0.02 { return none; }
            let inv_c = 1.0 / (1.0 + sl * sl).sqrt();
            let sb = strip_bright(col.bright_h, t);
            let (ht, hb) = (col.top * scale, col.bottom * scale);
            let reach = ((GLOW_R * sig_dev).max(ht.max(hb)) / inv_c + 1.0).ceil();
            P { valid: true, yc, inv_c, ht, hb, inv_h: 1.0 / (ht + hb), k_body: sb * ev * BODY_GAIN, k_glow: GLOW_AMP * ev, sep: if col.sep { SEP_GAIN } else { 1.0 }, lu, sb,
                travel: (0.05 + 0.1 * col.bright_h[0]) * t, reach, y0: (yc - reach).floor().max(0.0), y1: (yc + reach).ceil().min(h as f32 - 1.0) }
        }).collect();
        // blocks of 16 columns, row by row: the writes of a row of a block are one cache line
        const BLK: usize = 16;
        for b0 in (0..params.len()).step_by(BLK) {
            let blk = &params[b0..(b0 + BLK).min(params.len())];
            let (ymin, ymax) = blk.iter().filter(|p| p.valid).fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.y0), b.max(p.y1)));
            if ymin > ymax { continue; }
            for y in ymin as usize..=ymax as usize {
                let yf = y as f32 + 0.5;
                for (j, p) in blk.iter().enumerate() {
                    if !p.valid || (y as f32) < p.y0 || (y as f32) > p.y1 { continue; }
                    let xi = b0 + j;
                    let col = &cols[xi];
                    let sd = (yf - p.yc) * p.inv_c; // across the band, device px (down is positive)
                    let qi = (sd.abs() * lut_k) as usize;
                    let mut a = if qi < LUT { p.k_glow * lut[qi] } else { 0.0 };
                    let cov = (sd + p.ht).min(p.hb - sd) + 0.5;
                    let mut m = 0.0;
                    let mut glint = 0.0;
                    if cov > 0.0 {
                        let yy = (sd + p.ht) * p.inv_h + p.travel;
                        let prof = profile_at(col.prof, yy - yy.floor());
                        let body = cov.min(1.0) * prof * p.k_body;
                        // a separator is SEP_GAIN of the strip before it (of its brightness as shown, so exactly 0.4x)
                        a += body.min(1.0) * p.sep;
                        m = ((body - 1.3) / 2.0).clamp(0.0, 1.0);
                        if p.sep == 1.0 && cov >= 1.0 && body > 0.25 { glint = glint_at(xi as i32 + k * 131, y as i32 - p.yc as i32, t, GLINT_SHARE) * body.min(1.0); }
                    }
                    if a < 0.012 { continue; }
                    let a = a.min(1.0);
                    let m = m.max(glint * 0.95);
                    let (mut cr, mut cg, mut cb) = ((WAVE[0] + (HOT[0] - WAVE[0]) * m), (WAVE[1] + (HOT[1] - WAVE[1]) * m), (WAVE[2] + (HOT[2] - WAVE[2]) * m));
                    let mut a = a;
                    if glint > 0.0 { cr += (GLINT[0] - cr) * glint; cg += (GLINT[1] - cg) * glint; cb += (GLINT[2] - cb) * glint; a = a.max(glint); }
                    let i = (y * w + xi) * 4;
                    let (r, g, bb) = (cr * a, cg * a, cb * a);
                    if buf[i + 3] == 0 {
                        buf[i] = bb as u8; buf[i + 1] = g as u8; buf[i + 2] = r as u8; buf[i + 3] = (a * 255.0) as u8;
                    } else {
                        // premultiplied, added to what another line left here
                        let add = |old: u8, v: f32| (old as f32 + v).min(255.0) as u8;
                        buf[i] = add(buf[i], bb); buf[i + 1] = add(buf[i + 1], g); buf[i + 2] = add(buf[i + 2], r); buf[i + 3] = add(buf[i + 3], a * 255.0);
                    }
                    let _ = (p.reach, p.lu, p.sb);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // values computed by the web code for the same inputs: (k, x, t, [line_v, env, (lump is no longer the web's), slope, spacing, base])
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
            for i in [0usize, 1, 3, 4, 5] { assert!((got[i] - w[i]).abs() < 2e-3, "k={k} x={x} t={t} item {i}: {got:?} vs {w:?}"); }
        }
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
                assert_eq!(c.top, cols[i - 1].top);
                assert_eq!(c.prof, cols[i - 1].prof);
            } else { run += 1; }
        }
        assert_eq!(widths.len(), 2, "both widths occur");
    }

    #[test]
    fn strips_vary_a_lot_in_height_and_along_their_height() {
        let cols = columns(2000);
        let tops: Vec<f32> = cols.iter().filter(|c| !c.sep).map(|c| c.top).collect();
        let (lo, hi) = (tops.iter().cloned().fold(9.0, f32::min), tops.iter().cloned().fold(0.0, f32::max));
        assert!(lo <= 1.3 && hi >= BAND_HALF + 3.0, "spread {lo}..{hi}");
        let mut contrast = 0;
        for c in cols.iter().filter(|c| !c.sep) {
            for v in c.prof { assert!((0.2 - 1e-4..=1.0 + 1e-4).contains(&v)); }
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
        render_waves(w, h, 1.0, 40.0, &cols, &mut a, &mut MoonCache::default());
        render_waves(w, h, 1.0, 40.0, &cols, &mut b, &mut MoonCache::default());
        assert_eq!(a, b);
        let lit = a.chunks(4).filter(|p| p[3] > 8).count();
        assert!(lit > 2000 && lit < w * h / 2, "{lit}");
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
}
