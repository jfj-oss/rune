// The generative art of the web (WaveCover.tsx + AsciiWaves.tsx + lib/waveCover.ts): dithered wave / ripple / aurora / dunes
// covers, and the sparse ASCII sea behind an album hero. Appended to the hook's prelude (`U`, `ud(i)`). The blue-noise table is
// spliced in at start-up (`//NOISE//`, see gen.rs). Keep gen.metal in step.
//
// App floats (ud): 0 mode (0 cover, 1 ascii), 1 kind (0 wave, 1 ripple, 2 aurora, 3 dunes), 2 seed, 3 t (s), 4 scale,
// 5..7 light rgb (0..255), 8..10 mid rgb, 11 dot (device px, cover), 12 noise ox, 13 noise oy, 14 corner radius (device px).

const TAU: f32 = 6.2831853;
//NOISE//

fn fract1(x: f32) -> f32 { return x - floor(x); }
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn noise_at(x: i32, y: i32) -> f32 { return NOISE[u32(((y % 64) + 64) % 64) * 64u + u32(((x % 64) + 64) % 64)]; }

fn surface_at(x: f32, t: f32, phase: f32) -> f32 {
    return 0.2 + 0.065 * sin(TAU * 1.05 * x + 1.2 * t + phase) + 0.03 * sin(TAU * 2.4 * x - 0.85 * t + 1.0 + phase);
}

fn wave_field(u: f32, v: f32, t: f32, phase: f32) -> f32 {
    let s = surface_at(u, t, phase);
    let d = v - s;
    if (d < -0.02) { return 0.0; }
    let edge = clamp((d + 0.02) / 0.05, 0.0, 1.0);
    let q = (d - 0.035) / 0.04;
    let crest = exp(-q * q);
    let swell = 0.5 + 0.5 * sin(TAU * (1.7 * v - 0.6 * u) - 0.9 * t + phase);
    let deep = 1.0 - 0.35 * min(1.0, d / 0.8);
    return min(1.0, edge * (0.55 + 0.3 * swell) * deep + 0.55 * crest);
}

fn cover_field(kind: i32, u: f32, v: f32, t: f32, seed: f32) -> f32 {
    if (kind == 0) { return wave_field(u, v, t, seed); }
    let cx = 0.5 + 0.12 * sin(0.21 * t + seed);
    let cy = 0.52 + 0.1 * cos(0.17 * t + seed);
    var f = 0.0;
    if (kind == 1) {
        let r = length(vec2<f32>(u - cx, v - cy));
        let ring = 0.5 + 0.5 * sin(TAU * r * 5.0 - 1.6 * t + seed);
        f = sstep(0.3, 1.0, ring) * (1.0 - sstep(0.5, 0.8, r)) + 0.35 * (1.0 - sstep(0.0, 0.12, r));
    } else if (kind == 2) {
        let sway = 0.07 * sin(TAU * 1.3 * v + 0.5 * t + seed) + 0.04 * sin(TAU * 2.7 * v - 0.3 * t);
        let c = 0.5 + 0.5 * sin(TAU * (2.1 * u + sway) + 0.35 * t + seed);
        f = sstep(0.25, 1.0, c) * (1.0 - 0.55 * v) + 0.12 * (1.0 - v);
    } else {
        let s = 0.5 + 0.5 * sin(TAU * 1.5 * (u + 0.6 * v) - 0.7 * t + 0.5 * sin(TAU * u + 0.3 * t + seed));
        f = sstep(0.2, 0.95, s) * (0.65 + 0.35 * v);
    }
    return min(1.0, f);
}

fn line_f(d: f32, w: f32) -> f32 { let q = d / w; return exp(-q * q); }

fn ascii_at(kind: i32, x: f32, y: f32, t: f32) -> f32 {
    if (kind == 0) {
        var f = 0.0;
        for (var i = 0; i < 3; i++) {
            let fi = f32(i);
            let base = 0.25 + fi * 0.25;
            let c = base + 0.09 * sin(TAU * (0.8 + fi * 0.35) * x + (0.55 - fi * 0.12) * t + fi * 2.1) + 0.04 * sin(TAU * 2.1 * x - 0.4 * t + fi);
            let d = (y - c) / (0.07 + 0.02 * fi);
            f = max(f, exp(-d * d));
        }
        return f;
    }
    if (kind == 1) {
        let r = length(vec2<f32>((x - 0.62) * 2.6, y - 0.5));
        return line_f(fract1(r * 2.6 - 0.3 * t) - 0.5, 0.26) * (1.0 - sstep(1.3, 2.6, r));
    }
    if (kind == 2) { return line_f(fract1(2.4 * x + 0.12 * sin(TAU * y + 0.4 * t) + 0.04 * t) - 0.5, 0.28) * (1.0 - 0.2 * y); }
    return line_f(fract1(1.7 * x + 0.9 * y - 0.11 * t) - 0.5, 0.25);
}

// ---- glyphs in a 6 x 8 CSS px cell (a 600-weight 8 px monospace), coverage 0..1; q in CSS px, aa = CSS px per device px
fn seg(q: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = q - a; let ba = b - a;
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}
fn cov(d: f32, hw: f32, aa: f32) -> f32 { return clamp((hw - d) / aa + 0.5, 0.0, 1.0); }

fn glyph(kind: i32, crest: bool, q: vec2<f32>, aa: f32) -> f32 {
    let hw = 0.68;
    // kind 0: x o   1: . o   2: : |   3: - ~
    if (crest) {
        if (kind == 0 || kind == 1) { return cov(abs(length(q - vec2<f32>(3.0, 4.6)) - 1.55), hw, aa); }
        if (kind == 2) { return cov(seg(q, vec2<f32>(3.0, 1.2), vec2<f32>(3.0, 7.2)), hw, aa); }
        let x = clamp(q.x, 0.8, 5.2);
        let ys = 4.4 + 0.9 * sin((x - 0.8) / 4.4 * TAU);
        let sl = 0.9 * TAU / 4.4 * cos((x - 0.8) / 4.4 * TAU);
        let d = abs(q.y - ys) / sqrt(1.0 + sl * sl);
        return cov(d, hw, aa) * select(0.0, 1.0, q.x > 0.4 && q.x < 5.6);
    }
    if (kind == 0) { return max(cov(seg(q, vec2<f32>(1.1, 2.7), vec2<f32>(4.9, 6.5)), hw, aa), cov(seg(q, vec2<f32>(4.9, 2.7), vec2<f32>(1.1, 6.5)), hw, aa)); }
    if (kind == 1) { return cov(length(q - vec2<f32>(3.0, 4.5)), 0.65, aa); }
    if (kind == 2) { return max(cov(length(q - vec2<f32>(3.0, 3.4)), 0.6, aa), cov(length(q - vec2<f32>(3.0, 5.8)), 0.6, aa)); }
    return cov(seg(q, vec2<f32>(1.0, 4.4), vec2<f32>(5.0, 4.4)), hw, aa);
}

fn custom_fs(pos: vec2<f32>) -> vec4<f32> {
    let p = pos - vec2<f32>(U[0], U[1]);
    let size = vec2<f32>(U[2], U[3]);
    let mode = i32(ud(0u));
    let kind = i32(ud(1u));
    let seed = ud(2u);
    let t = ud(3u);
    let scale = ud(4u);
    let light = vec3<f32>(ud(5u), ud(6u), ud(7u)) / 255.0;
    let mid = vec3<f32>(ud(8u), ud(9u), ud(10u)) / 255.0;
    if (mode == 0) {
        let dot_px = max(1.0, ud(11u));
        let gx = i32(floor(p.x / dot_px));
        let gy = i32(floor(p.y / dot_px));
        let w = max(8.0, round(size.x / dot_px));
        let h = max(8.0, round(size.y / dot_px));
        let f = cover_field(kind, (f32(gx) + 0.5) / w, (f32(gy) + 0.5) / h, t, seed);
        let tt = clamp(f, 0.0, 1.0);
        let dl = pow(tt, 1.6) * 0.26;
        let dm = min(1.0 - dl, pow(tt, 0.6) * 0.74);
        let th = noise_at(gx + i32(ud(12u)), gy + i32(ud(13u)));
        var col = vec3<f32>(0.0);
        if (th < dl) { col = light; } else if (th < dl + dm) { col = mid; }
        // rounded corners
        let r = ud(14u);
        var a = 1.0;
        if (r > 0.0) {
            let q = abs(p - size * 0.5) - (size * 0.5 - vec2<f32>(r));
            let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
            a = clamp(0.5 - d, 0.0, 1.0);
        }
        return vec4<f32>(col, a);
    }
    // ascii hero
    let cw = 6.0 * scale;
    let ch = 8.0 * scale;
    let cols = ceil(size.x / cw);
    let rows = ceil(size.y / ch);
    let c = floor(p.x / cw);
    let r = floor(p.y / ch);
    let v = p.y / size.y;
    // the header's fade (mask) and wash, as in the web's .ahero__bg / .ahero__wash
    var m = mix(0.2, 0.0, clamp((v - 0.86) / 0.14, 0.0, 1.0));
    if (v < 0.86) { m = mix(0.6, 0.2, clamp((v - 0.62) / 0.24, 0.0, 1.0)); }
    if (v < 0.62) { m = mix(1.0, 0.6, clamp((v - 0.35) / 0.27, 0.0, 1.0)); }
    var wa = mix(0.45, 0.0, clamp((v - 0.6) / 0.4, 0.0, 1.0));
    if (v < 0.6) { wa = mix(0.3, 0.45, v / 0.6); }
    let washa = wa * m;
    var ga = 0.0;
    var gcol = light;
    let f = ascii_at(kind, (c + 0.5) / cols, (r + 0.5) / rows, t);
    if (f >= 0.08) {
        let th = noise_at(i32(c), i32(r));
        if (th < f * 0.34) {
            let crest = f > 0.62;
            let q = vec2<f32>(p.x - c * cw, p.y - r * ch) / scale;
            ga = glyph(kind, crest, q, 1.0 / scale);
            if (!crest) { gcol = mid; ga = ga * 0.95; }
            ga = ga * m;
        }
    }
    let a = ga + washa * (1.0 - ga);
    if (a <= 0.0) { return vec4<f32>(0.0); }
    let rgb = (gcol * ga + vec3<f32>(8.0, 8.0, 14.0) / 255.0 * washa * (1.0 - ga)) / a;
    return vec4<f32>(rgb, a);
}
