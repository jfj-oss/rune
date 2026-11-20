// "Foil waves" backdrop: the whole picture (dust field, fade, wave bands, moon) for one device pixel. A GPU port of foil.rs
// (the CPU fallback); keep the two in step. Appended to the hook's prelude, which provides `U`, `ud(i)` and the vertex stage.
//
// App floats (ud): 0 width px, 1 height px, 2 scale, 3 t (seconds), 4 dust shift (px), 5 columns, 6 moon x, 7 moon y, 8 moon r,
// 16.. bands (10 floats each: start angle, span, hook, 4 phases, p, r_max * p^gamma, 0), then the column table (id * 2 + separator).

const TAU: f32 = 6.2831853;
const T_LOOP: f32 = 25.6;
const N_BANDS: u32 = 8u;
const BANDS_AT: u32 = 16u;
const COLS_AT: u32 = 96u;
const BODY_GAIN: f32 = 3.6;
const SEP_GAIN: f32 = 0.4;
const GLOW_AMP: f32 = 0.2;
const GLOW_R: f32 = 1.5;
const GLOW_K: f32 = 1.8;
const GLINT_SHARE: f32 = 0.05;
const N_DASH: f32 = 110.0;
const HW_MIN: f32 = 1.0;
const HW_MAX: f32 = 9.5;
const JIT_BASE: f32 = 1.0;
const JIT_SLOPE: f32 = 0.05;
const JIT_MAX: f32 = 2.0;
const FILL_MIN: f32 = 0.06;
const FILL_FULL_AT: f32 = 0.62;
const MOON_DIM: f32 = 0.55;
const DUST_CYCLE: i32 = 192;
const WAVE: vec3<f32> = vec3<f32>(105.0, 125.0, 255.0);
const HOT: vec3<f32> = vec3<f32>(205.0, 222.0, 255.0);
const GLINT: vec3<f32> = vec3<f32>(240.0, 246.0, 255.0);
const STRAY: vec3<f32> = vec3<f32>(130.0, 145.0, 255.0);
const MOON: vec3<f32> = vec3<f32>(120.0, 135.0, 255.0);
var<private> BAYER: array<f32, 16> = array<f32, 16>(0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);

fn fract1(x: f32) -> f32 { return x - floor(x); }
fn pmod(x: f32, m: f32) -> f32 { return x - m * floor(x / m); }
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn div_e(a: i32, m: i32) -> i32 { var q = a / m; if (a - q * m < 0) { q = q - 1; } return q; }
fn rem_e(a: i32, m: i32) -> i32 { return a - div_e(a, m) * m; }

// the sin-free hash (Hoskins), three values in 0..1; the same operations as foil.rs
fn hash3(x: f32, y: f32) -> vec3<f32> {
    var a = fract1(x * 0.1031);
    var b = fract1(y * 0.1030);
    var c = fract1(x * 0.0973);
    let d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
    a += d; b += d; c += d;
    return vec3<f32>(fract1((a + b) * c), fract1((b + c) * a), fract1((c + a) * b));
}

fn fade_at(u: f32, v: f32) -> f32 { return sstep(0.0, 0.85, (u - 0.5) + (0.5 - v)); }
fn base_ev(u: f32, v: f32) -> f32 { return 0.75 + 0.35 * clamp((u + v - 0.6) / 1.2, 0.0, 1.0); }

// ---- the dust field: rgb in 0..255 (with the stray pixel added), `moon` selects the moon's periwinkle marks
fn dust(px: i32, py: i32, shift: i32, moon: bool) -> vec3<f32> {
    let xs = px - shift;
    let ys = py + shift;
    let a = xs + ys;
    let b = xs - ys;
    let hr = hash3(f32(a), 3.0);
    let len = 2 + i32(floor(hr.x * 3.0));
    let phase = i32(floor(hr.y * f32(len)));
    let cell = rem_e(div_e(b, 2) + phase, DUST_CYCLE) / len;
    let h = hash3(f32(a) + 0.5, f32(cell) + 17.0);
    var rgb: vec3<f32>;
    if (moon && h.x < 0.75) { rgb = MOON * (0.3 + 0.6 * h.y); }
    else if (h.x < 0.3) { rgb = vec3<f32>(0.0); }
    else if (h.x > 0.9) { rgb = vec3<f32>(10.0 + 7.0 * h.y, 15.0 + 8.0 * h.y, 33.0 + 13.0 * h.y); }
    else { rgb = vec3<f32>(2.0 + 5.0 * h.y, 3.0 + 6.0 * h.y, 8.0 + 14.0 * h.y); }
    let hs = hash3(f32(a) + 0.25, f32(rem_e(b, 2 * DUST_CYCLE)) + 0.75);
    var stray = 0.0;
    if (hs.x < 0.0016) { stray = 0.4 + 0.6 * hs.y; }
    if (moon) { rgb = rgb * 1.5; }
    return rgb + STRAY * stray;
}

// ---- glints: a hashed flash that fades, a whole number of flashes per loop
fn glint_at(x: i32, yr: i32, t: f32, share: f32) -> f32 {
    let block = div_e(yr, 3);
    var hh = (bitcast<u32>(x) * 0x9E3779B1u) ^ (bitcast<u32>(block) * 0x85EBCA77u);
    hh = (hh ^ (hh >> 15u)) * 0x2C1B3C6Du;
    if (f32((hh >> 8u) & 0xFFFFu) / 65536.0 > share * 3.0) { return 0.0; }
    let hg = hash3(f32(x) + 0.5, f32(block) + 3.0);
    let len = 1 + i32(floor(hg.z * 3.0));
    let off = i32(floor(fract1(hg.z * 7.3) * f32(4 - len)));
    let r = rem_e(yr, 3);
    if (r < off || r >= off + len) { return 0.0; }
    let period = T_LOOP / max(round(T_LOOP / (2.5 + 3.0 * hg.y)), 1.0);
    let dur = 0.3 + 0.7 * fract1(hg.y * 5.1);
    let phase = pmod(t + hg.y * 17.0, period);
    if (phase >= dur) { return 0.0; }
    return pow(1.0 - phase / dur, 1.5);
}

fn profile_at(p: array<f32, 5>, y01: f32) -> f32 {
    let u = clamp(y01, 0.0, 1.0) * 4.0;
    let i = min(i32(floor(u)), 3);
    let f = u - f32(i);
    return p[i] + (p[i + 1] - p[i]) * f * f * (3.0 - 2.0 * f);
}
fn pq(v: f32) -> f32 { return 0.2 + 0.8 * pow(v, 1.5); }

struct BandEval { R: f32, dR: f32, u: f32, a: f32 }

// the radius of band slot k in direction th, its slope dR/dth, the arc fraction u and the angle a from the arc's start
fn band_eval(b0: u32, th: f32) -> BandEval {
    let start = ud(b0);
    let span = ud(b0 + 1u);
    let hook = ud(b0 + 2u);
    let p = ud(b0 + 7u);
    let rscale = ud(b0 + 8u);
    let tp = TAU * p;
    let w1 = 3.0 * th + ud(b0 + 3u) + tp; let w2 = 5.0 * th + ud(b0 + 4u) - tp; let w3 = 8.0 * th + ud(b0 + 5u) + 2.0 * tp; let w4 = 14.0 * th + ud(b0 + 6u) - 3.0 * tp;
    let wob = 0.10 * sin(w1) + 0.06 * sin(w2) + 0.03 * sin(w3) + 0.012 * sin(w4);
    let dwob = 0.30 * cos(w1) + 0.30 * cos(w2) + 0.24 * cos(w3) + 0.168 * cos(w4);
    let a = pmod(th - start, TAU);
    let u = a / span;
    let ht = sstep(0.74, 1.0, u);
    let hmul = 1.0 - hook * ht * ht;
    var dht = 0.0;
    if (u > 0.74 && u < 1.0) { let q = (u - 0.74) / 0.26; dht = 6.0 * q * (1.0 - q) / (0.26 * span); }
    return BandEval(rscale * (1.0 + wob) * hmul, rscale * (dwob * hmul + (1.0 + wob) * (-hook * 2.0 * ht * dht)), u, a);
}

// ---- one band's contribution at the pixel: premultiplied colour (0..255) and alpha (0..255), or zero
fn band_pixel(k: u32, px: i32, py: i32, t: f32, scale: f32, wh: vec2<f32>, id: u32, sep: bool) -> vec4<f32> {
    let b0 = BANDS_AT + k * 10u;
    let span = ud(b0 + 1u);
    let c0 = wh * 0.5;
    let hd = 0.5 * length(wh);
    let cp = vec2<f32>(f32(px) + 0.5, f32(py) + 0.5);
    let d = cp - c0;
    let r = length(d);
    if (r < 1.0) { return vec4<f32>(0.0); }
    let th = atan2(d.y, d.x);
    let e0 = band_eval(b0, th);
    if (e0.u >= 1.5) { return vec4<f32>(0.0); }
    // how far the pixel is from the band's centre line, and which way the line faces
    let hw0 = scale * (HW_MIN + (HW_MAX - HW_MIN) * pow(clamp(e0.R / hd, 0.0, 1.35), 1.2));
    let reach0 = max(GLOW_R * max(GLOW_K * hw0, 3.0 * scale), hw0 + JIT_MAX) + 1.0;
    let off = r - e0.R;
    if (abs(off) > reach0 * 1.9) { return vec4<f32>(0.0); }
    let norm = sqrt(1.0 + (e0.dR / r) * (e0.dR / r));
    let dist = off / norm;
    let nrm = (vec2<f32>(cos(th), sin(th)) - (e0.dR / r) * vec2<f32>(-sin(th), cos(th))) / norm;
    let shallow = abs(nrm.y) >= abs(nrm.x);
    // the point of the line straight above/below (shallow) or beside (steep) the pixel: where the CPU painter paints this column or row
    var qp: vec2<f32>;
    var sd: f32;
    var gk: vec2<i32>;
    if (shallow) {
        qp = vec2<f32>(cp.x, cp.y - dist / nrm.y);
        sd = dist * sign(nrm.y);
        gk = vec2<i32>(px + i32(k) * 131, py - i32(qp.y));
    } else {
        qp = vec2<f32>(cp.x - dist / nrm.x, cp.y);
        sd = dist * sign(nrm.x);
        gk = vec2<i32>(px - i32(qp.x) + 7000 + i32(k) * 131, py);
    }
    let th2 = atan2(qp.y - c0.y, qp.x - c0.x);
    let e1 = band_eval(b0, th2);
    if (e1.u >= 1.0) { return vec4<f32>(0.0); }
    let u = e1.u;
    let rn = e1.R / hd;
    let hw = scale * (HW_MIN + (HW_MAX - HW_MIN) * pow(clamp(rn, 0.0, 1.35), 1.2));
    let sig = max(GLOW_K * hw, 3.0 * scale);
    // which strips are lit
    let fill = FILL_MIN + (1.0 - FILL_MIN) * sstep(0.06, FILL_FULL_AT, rn);
    if (hash3(f32(id), 20.0 + f32(k)).x >= fill) { return vec4<f32>(0.0); }
    // the band's own brightness here: lumps, dashed far end, the fade towards the top right
    let fuv = qp / wh;
    let dz = min((1.0 - u) / 0.22, 1.0);
    var dashed = 0.0;
    if (dz >= 1.0 || fract1(u * N_DASH) < 0.25 + 0.75 * dz) { dashed = 1.0; }
    let la = u * span * 60.0;
    let lump = 0.78 + 0.22 * sin(la * 0.07 + f32(k) * 1.9 + TAU * t / T_LOOP + sin(la * 0.03 + f32(k)) * 1.5);
    let ev = base_ev(fuv.x, fuv.y) * lump * dashed * (1.0 - fade_at(fuv.x, fuv.y));
    if (ev < 0.02) { return vec4<f32>(0.0); }
    // strips stop short of the arc's ends, each at its own place
    let hr = hash3(f32(px) + 0.5, 3.3);
    if (e1.R * e1.a < hr.x * 12.0 * scale || e1.R * (span - e1.a) < hr.y * 12.0 * scale) { return vec4<f32>(0.0); }
    // the strip of this column
    let h7 = hash3(f32(id), 7.0);
    let jit = min(JIT_BASE + JIT_SLOPE * hw, JIT_MAX);
    let top = max(hw + (h7.y * 2.0 - 1.0) * jit, 1.0);
    let bot = max(hw + (h7.z * 2.0 - 1.0) * jit, 1.0);
    let h11 = hash3(f32(id), 11.0);
    let h12 = hash3(f32(id), 12.0);
    var prof = array<f32, 5>(pq(h11.x), pq(h11.y), pq(h11.z), pq(h12.x), pq(h11.x));
    let sb = (0.45 + 0.55 * pow(h7.x, 1.2)) * (0.88 + 0.12 * sin(TAU * 2.0 * t / T_LOOP + h7.y * TAU));
    let travel = (1.0 + min(floor(h7.x * 3.0), 2.0)) * t / T_LOOP;
    let sepg = select(1.0, SEP_GAIN, sep);
    let gq = abs(sd) / sig;
    var al = 0.0;
    if (gq < GLOW_R) { al = GLOW_AMP * ev * fill * exp(-gq * gq * 0.5); }
    let cov = min(sd + top, bot - sd) + 0.5;
    var m = 0.0;
    var glint = 0.0;
    if (cov > 0.0) {
        let yy = (sd + top) / (top + bot) + travel;
        let body = min(cov, 1.0) * profile_at(prof, yy - floor(yy)) * sb * ev * BODY_GAIN;
        al += min(body, 1.0) * sepg;
        m = clamp((body - 1.3) / 2.0, 0.0, 1.0);
        if (!sep && cov >= 1.0 && body > 0.25) { glint = glint_at(gk.x, gk.y, t, GLINT_SHARE) * min(body, 1.0); }
    }
    if (al < 0.012) { return vec4<f32>(0.0); }
    al = min(al, 1.0);
    m = max(m, glint * 0.95);
    var col = mix(WAVE, HOT, m);
    if (glint > 0.0) { col = mix(col, GLINT, glint); al = max(al, glint); }
    return vec4<f32>(col * al, al * 255.0);
}

fn custom_fs(pos: vec2<f32>) -> vec4<f32> {
    let p = pos - vec2<f32>(U[0], U[1]);
    let px = i32(floor(p.x));
    let py = i32(floor(p.y));
    let wh = vec2<f32>(ud(0u), ud(1u));
    let scale = ud(2u);
    let t = ud(3u);
    let shift = i32(ud(4u));
    // dust, then the fade to black over it (alpha dithered 4x4 like the CPU image)
    var base = min(dust(px, py, shift, false), vec3<f32>(255.0));
    let f = fade_at((f32(px) + 0.5) / wh.x, (f32(py) + 0.5) / wh.y) * 255.0;
    let bay = (BAYER[(py & 3) * 4 + (px & 3)] + 0.5) / 16.0;
    base = base * (1.0 - min(floor(f + bay), 255.0) / 255.0);
    // wave bands: where bands meet the brighter one wins, per channel
    let cid = ud(COLS_AT + u32(clamp(px, 0, i32(ud(5u)) - 1)));
    let sep = (u32(cid) & 1u) == 1u;
    let id = u32(cid) >> 1u;
    var acc = vec4<f32>(0.0);
    for (var k = 0u; k < N_BANDS; k++) { acc = max(acc, band_pixel(k, px, py, t, scale, wh, id, sep)); }
    // the moon: a disc of stippled marks over everything, a faint glow only where no band is
    let mc = vec2<f32>(ud(6u), ud(7u));
    let mr = ud(8u);
    let dm = vec2<f32>(f32(px) + 0.5, f32(py) + 0.5) - mc;
    let dd = length(dm);
    if (dd < mr + 14.0 * scale + 3.0) {
        let edge = (hash3(f32(px) + 31.0, f32(py) + 31.0).x - 0.5) * 3.0;
        if (dd >= mr + edge) {
            let q = (dd - mr) / (5.0 * scale);
            let a = 0.2 * exp(-q * q * 0.5);
            if (a > 0.004 && acc.w < 1.0) { acc = vec4<f32>(MOON * a * MOON_DIM, a * 255.0); }
        } else {
            var col = dust(px, py, shift, true);
            let hp = hash3(f32(px) + 53.0, f32(py) + 53.0);
            if (hp.x < 0.3) { let mm = 0.5 + 0.5 * hash3(f32(px) + 9.0, f32(py) + 9.0).y; col += (HOT * 0.3 + MOON * 0.8) * mm; }
            let g = glint_at(px + 7919, py, t, 0.05);
            col = mix(col, GLINT, g);
            acc = vec4<f32>(min(col * MOON_DIM, vec3<f32>(255.0)), 255.0);
        }
    }
    let rgb = acc.xyz + base * (1.0 - acc.w / 255.0);
    return vec4<f32>(min(rgb, vec3<f32>(255.0)) / 255.0, 1.0);
}
