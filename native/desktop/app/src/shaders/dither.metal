// The web's "Dither" backdrop for Metal: the same maths as dither.wgsl (keep the two in step). Appended to the hook's prelude, which
// provides the vertex stage and `SHADER_HEADER_LEN`; the app's floats are U[SHADER_HEADER_LEN + i] (see dither.wgsl for the list).
// The blue-noise table (quantised to bytes, as the web's texture is) is spliced in at start-up (`//NOISE//`, see dither.rs).

#define UD(i) U[SHADER_HEADER_LEN + (i)]

//NOISE//

static inline float hash2(float2 p) {
    float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
static float vnoise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + float2(1.0, 0.0)), u.x), mix(hash2(i + float2(0.0, 1.0)), hash2(i + float2(1.0, 1.0)), u.x), u.y);
}
static inline float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

float4 custom_fs(float2 pos, constant float* U) {
    float2 p0 = pos - float2(U[0], U[1]);
    float cw = UD(0);
    float ch = UD(1);
    float dot_px = max(1.0, UD(2));
    float aspect = UD(3);
    float rs = UD(4);
    float t = UD(5);
    float wave = UD(6);
    float wexp = UD(7);
    float calm = UD(8);
    float3 mid = float3(UD(9), UD(10), UD(11));
    float3 light = float3(UD(12), UD(13), UD(14));
    float3 mx = float3(UD(15), UD(16), UD(17));
    float3 md = float3(UD(18), UD(19), UD(20));
    float4 cu = float4(UD(21), UD(22), UD(23), UD(24));
    // the web draws into a canvas of (w x h) dots and scales it up pixelated: this pixel's dot
    float cx = min(floor(p0.x / dot_px), cw - 1.0);
    float cy = min(floor(p0.y / dot_px), ch - 1.0);
    float2 uv = float2((cx + 0.5) / cw, (cy + 0.5) / ch);
    float2 q = float2(uv.x * aspect, uv.y);
    float2 w = q + 0.09 * (float2(
        vnoise(float2(q.x * 2.3 + t * 0.02, q.y * 2.3)),
        vnoise(float2(q.x * 2.3 + 7.1, q.y * 2.3 - t * 0.016))) - 0.5);
    float f2 = 0.0;
    // the other characters share a rotated, zoomed frame around the screen centre, a stronger version of the
    // same slow warp, and one travelling current
    float tt = md.z;
    float2 c = float2(0.5 * aspect, 0.5);
    float ca = cos(md.x);
    float sa = sin(md.x);
    float2 r0 = (q + 2.2 * (w - q) - c) / (rs * md.y);
    float2 p = float2(ca * r0.x - sa * r0.y, sa * r0.x + ca * r0.y);
    float cd = dot(q - c, cu.xy) - cu.z;
    float cur = cu.w * exp(-cd * cd / 0.03);
    if (mx.x > 0.0) { // tide: two layers of broad horizontal swells, warped by a little noise
        float s1 = 0.5 + 0.5 * sin(p.y * 13.0 + tt * 0.11 + 1.1 * sin(p.x * 1.3 + tt * 0.04) + 2.0 * vnoise(float2(p.x * 0.9, tt * 0.02)));
        float s2 = 0.5 + 0.5 * sin(p.y * 8.5 - tt * 0.07 + 0.9 * sin(p.x * 0.8 - tt * 0.03 + 2.0));
        float ft = 1.2 * sstep(0.36, 0.96, 0.6 * s1 + 0.4 * s2) + cur;
        f2 = f2 + mx.x * ft * ft;
    }
    if (mx.y > 0.0) { // ripple: rings from two slowly wandering centres, fading with distance, interfering
        float2 c1 = float2(0.15 * sin(tt * 0.013), 0.1 + 0.12 * cos(tt * 0.017));
        float2 c2 = float2(0.55 * sin(tt * 0.011 + 2.0) - 0.2, 0.2 * cos(tt * 0.014 + 1.0));
        float r1 = length(p - c1);
        float r2 = length(p - c2);
        float a1 = sstep(0.4, 1.0, 0.5 + 0.5 * sin(r1 * 21.0 - tt * 0.42));
        float a2 = sstep(0.4, 1.0, 0.5 + 0.5 * sin(r2 * 16.8 - tt * 0.34 + 1.7));
        float v = (a1 * exp(-r1 * r1 * 1.6) + 0.8 * a2 * exp(-r2 * r2 * 2.4)) * 1.0;
        float fr = 1.15 * sstep(0.1, 0.8, v) + cur;
        f2 = f2 + mx.y * fr * fr;
    }
    if (mx.z > 0.0) { // aurora: tall curtains that sway, brighter near the top
        float sway = 0.7 * sin(p.y * 2.1 + tt * 0.06) + 0.35 * sin(p.y * 4.3 - tt * 0.05 + 1.0) + 1.2 * vnoise(float2(p.x * 0.7, p.y * 0.8 + tt * 0.015));
        float c1 = 0.5 + 0.5 * sin(p.x * 11.0 + sway + tt * 0.045);
        float c2 = 0.5 + 0.5 * sin(p.x * 17.0 - sway * 0.7 - tt * 0.035 + 2.0);
        float shimmer = 0.82 + 0.18 * vnoise(float2(p.x * 9.0, p.y * 1.4 - tt * 0.07));
        float top = 0.15 + (1.0 - 0.15) * (1.0 - sstep(-0.55, 0.65, p.y));
        float fa = 1.3 * sstep(0.2, 0.72, 0.6 * c1 + 0.4 * c2) * shimmer * top + cur;
        f2 = f2 + mx.z * fa * fa;
    }
    float f = sqrt(f2);
    // new-song wave: the shapes already on screen swell outwards and draw back in
    if (wave != 0.0) {
        float grown = pow(max(f, 0.0), pow(wexp, wave));
        float edge = sstep(0.05, 0.3, grown) * (1.0 - sstep(0.6, 0.95, grown));
        f = grown + wave * 0.035 * edge * sin(grown * 9.0 - wave * 6.0);
    }
    float mot = 0.66 + 0.4 * vnoise(float2(q.x * 7.0 + t * 0.03, q.y * 7.0));

    float tau = pow(sstep(0.42, 0.88, f), 1.0);
    float dl = pow(tau, 1.6) * 0.26 * min(1.0, mot) * calm;
    float dm = min(1.0 - dl, pow(tau, 0.6) * 0.74 * calm);

    // gl_FragCoord.y of the web's canvas counts from the bottom: the noise row is (h - 1 - cy)
    uint nx = uint(cx) % 64u;
    uint ny = uint(ch - 1.0 - cy) % 64u;
    float th = NOISE[ny * 64u + nx];
    float3 col = float3(0.0);
    if (th < dl) { col = light; } else if (th < dl + dm) { col = mid; }
    return float4(col / 255.0, 1.0);
}
