// The web's "Dither" backdrop (web/src/components/DitherBackdrop.tsx FRAG + lib/dither.ts): slow evolving light forms,
// ordered-dithered with blue-noise thresholds into black + a dark mid tone + one strong colour. A line-by-line port of the web's
// fragment shader (the pure "drift" field is left out: its weight in `mixAt` is always 0). Appended to the hook's prelude
// (`U`, `ud(i)`). The blue-noise table (quantised to bytes, as the web's texture is) is spliced in at start-up (`//NOISE//`,
// see dither.rs). Keep dither.metal in step.
//
// App floats (ud): 0 canvas w (dots), 1 canvas h (dots), 2 dot (device px), 3 aspect, 4 radiusScale, 5 t (s), 6 wave amt,
// 7 wave peak exponent, 8 calm, 9..11 mid rgb (0..255), 12..14 light rgb, 15..17 mix (tide, ripple, aurora weights),
// 18..20 modulators (flow angle, zoom, warped clock), 21..24 current (dir x, dir y, position, strength).
//NOISE//

fn hash2(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

fn custom_fs(pos: vec2<f32>) -> vec4<f32> {
    let p0 = pos - vec2<f32>(U[0], U[1]);
    let cw = ud(0u);
    let ch = ud(1u);
    let dot_px = max(1.0, ud(2u));
    let aspect = ud(3u);
    let rs = ud(4u);
    let t = ud(5u);
    let wave = ud(6u);
    let wexp = ud(7u);
    let calm = ud(8u);
    let mid = vec3<f32>(ud(9u), ud(10u), ud(11u));
    let light = vec3<f32>(ud(12u), ud(13u), ud(14u));
    let mx = vec3<f32>(ud(15u), ud(16u), ud(17u));
    let md = vec3<f32>(ud(18u), ud(19u), ud(20u));
    let cu = vec4<f32>(ud(21u), ud(22u), ud(23u), ud(24u));

    // the web draws into a canvas of (w x h) dots and scales it up pixelated: this pixel's dot
    let cx = min(floor(p0.x / dot_px), cw - 1.0);
    let cy = min(floor(p0.y / dot_px), ch - 1.0);
    let uv = vec2<f32>((cx + 0.5) / cw, (cy + 0.5) / ch);
    let q = vec2<f32>(uv.x * aspect, uv.y);
    let w = q + 0.09 * (vec2<f32>(
        vnoise(vec2<f32>(q.x * 2.3 + t * 0.02, q.y * 2.3)),
        vnoise(vec2<f32>(q.x * 2.3 + 7.1, q.y * 2.3 - t * 0.016))) - 0.5);
    var f2 = 0.0;
    // the other characters share a rotated, zoomed frame around the screen centre, a stronger version of the
    // same slow warp, and one travelling current
    let tt = md.z;
    let c = vec2<f32>(0.5 * aspect, 0.5);
    let ca = cos(md.x);
    let sa = sin(md.x);
    let r0 = (q + 2.2 * (w - q) - c) / (rs * md.y);
    let p = vec2<f32>(ca * r0.x - sa * r0.y, sa * r0.x + ca * r0.y);
    let cd = dot(q - c, cu.xy) - cu.z;
    let cur = cu.w * exp(-cd * cd / 0.03);
    if (mx.x > 0.0) { // tide: two layers of broad horizontal swells, warped by a little noise
        let s1 = 0.5 + 0.5 * sin(p.y * 13.0 + tt * 0.11 + 1.1 * sin(p.x * 1.3 + tt * 0.04) + 2.0 * vnoise(vec2<f32>(p.x * 0.9, tt * 0.02)));
        let s2 = 0.5 + 0.5 * sin(p.y * 8.5 - tt * 0.07 + 0.9 * sin(p.x * 0.8 - tt * 0.03 + 2.0));
        let ft = 1.2 * sstep(0.36, 0.96, 0.6 * s1 + 0.4 * s2) + cur;
        f2 = f2 + mx.x * ft * ft;
    }
    if (mx.y > 0.0) { // ripple: rings from two slowly wandering centres, fading with distance, interfering
        let c1 = vec2<f32>(0.15 * sin(tt * 0.013), 0.1 + 0.12 * cos(tt * 0.017));
        let c2 = vec2<f32>(0.55 * sin(tt * 0.011 + 2.0) - 0.2, 0.2 * cos(tt * 0.014 + 1.0));
        let r1 = length(p - c1);
        let r2 = length(p - c2);
        let a1 = sstep(0.4, 1.0, 0.5 + 0.5 * sin(r1 * 21.0 - tt * 0.42));
        let a2 = sstep(0.4, 1.0, 0.5 + 0.5 * sin(r2 * 16.8 - tt * 0.34 + 1.7));
        let v = (a1 * exp(-r1 * r1 * 1.6) + 0.8 * a2 * exp(-r2 * r2 * 2.4)) * 1.0;
        let fr = 1.15 * sstep(0.1, 0.8, v) + cur;
        f2 = f2 + mx.y * fr * fr;
    }
    if (mx.z > 0.0) { // aurora: tall curtains that sway, brighter near the top
        let sway = 0.7 * sin(p.y * 2.1 + tt * 0.06) + 0.35 * sin(p.y * 4.3 - tt * 0.05 + 1.0) + 1.2 * vnoise(vec2<f32>(p.x * 0.7, p.y * 0.8 + tt * 0.015));
        let c1 = 0.5 + 0.5 * sin(p.x * 11.0 + sway + tt * 0.045);
        let c2 = 0.5 + 0.5 * sin(p.x * 17.0 - sway * 0.7 - tt * 0.035 + 2.0);
        let shimmer = 0.82 + 0.18 * vnoise(vec2<f32>(p.x * 9.0, p.y * 1.4 - tt * 0.07));
        let top = 0.15 + (1.0 - 0.15) * (1.0 - sstep(-0.55, 0.65, p.y));
        let fa = 1.3 * sstep(0.2, 0.72, 0.6 * c1 + 0.4 * c2) * shimmer * top + cur;
        f2 = f2 + mx.z * fa * fa;
    }
    var f = sqrt(f2);
    // new-song wave: the shapes already on screen swell outwards and draw back in
    if (wave != 0.0) {
        let grown = pow(max(f, 0.0), pow(wexp, wave));
        let edge = sstep(0.05, 0.3, grown) * (1.0 - sstep(0.6, 0.95, grown));
        f = grown + wave * 0.035 * edge * sin(grown * 9.0 - wave * 6.0);
    }
    let mot = 0.66 + 0.4 * vnoise(vec2<f32>(q.x * 7.0 + t * 0.03, q.y * 7.0));

    let tau = pow(sstep(0.42, 0.88, f), 1.0);
    let dl = pow(tau, 1.6) * 0.26 * min(1.0, mot) * calm;
    let dm = min(1.0 - dl, pow(tau, 0.6) * 0.74 * calm);

    // gl_FragCoord.y of the web's canvas counts from the bottom: the noise row is (h - 1 - cy)
    let nx = u32(cx) % 64u;
    let ny = u32(ch - 1.0 - cy) % 64u;
    let th = NOISE[ny * 64u + nx];
    var col = vec3<f32>(0.0);
    if (th < dl) { col = light; } else if (th < dl + dm) { col = mid; }
    return vec4<f32>(col / 255.0, 1.0);
}
