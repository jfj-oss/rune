// The generative art of the web for Metal: the same maths as gen.wgsl (keep the two in step). Appended to the hook's prelude, which
// provides the vertex stage and `SHADER_HEADER_LEN`; the app's floats are U[SHADER_HEADER_LEN + i]. The blue-noise table is spliced
// in at start-up (`//NOISE//`, see gen.rs).

#define UD(i) U[SHADER_HEADER_LEN + (i)]

constant float TAU = 6.2831853;
//NOISE//

static inline float fract1(float x) { return x - floor(x); }
static inline float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
static inline float noise_at(int x, int y) { return NOISE[(((y % 64) + 64) % 64) * 64 + (((x % 64) + 64) % 64)]; }

static float surface_at(float x, float t, float phase) {
    return 0.2 + 0.065 * sin(TAU * 1.05 * x + 1.2 * t + phase) + 0.03 * sin(TAU * 2.4 * x - 0.85 * t + 1.0 + phase);
}

static float wave_field(float u, float v, float t, float phase) {
    float s = surface_at(u, t, phase);
    float d = v - s;
    if (d < -0.02) { return 0.0; }
    float edge = clamp((d + 0.02) / 0.05, 0.0, 1.0);
    float q = (d - 0.035) / 0.04;
    float crest = exp(-q * q);
    float swell = 0.5 + 0.5 * sin(TAU * (1.7 * v - 0.6 * u) - 0.9 * t + phase);
    float deep = 1.0 - 0.35 * min(1.0, d / 0.8);
    return min(1.0, edge * (0.55 + 0.3 * swell) * deep + 0.55 * crest);
}

static float cover_field(int kind, float u, float v, float t, float seed) {
    if (kind == 0) { return wave_field(u, v, t, seed); }
    float cx = 0.5 + 0.12 * sin(0.21 * t + seed);
    float cy = 0.52 + 0.1 * cos(0.17 * t + seed);
    float f = 0.0;
    if (kind == 1) {
        float r = length(float2(u - cx, v - cy));
        float ring = 0.5 + 0.5 * sin(TAU * r * 5.0 - 1.6 * t + seed);
        f = sstep(0.3, 1.0, ring) * (1.0 - sstep(0.5, 0.8, r)) + 0.35 * (1.0 - sstep(0.0, 0.12, r));
    } else if (kind == 2) {
        float sway = 0.07 * sin(TAU * 1.3 * v + 0.5 * t + seed) + 0.04 * sin(TAU * 2.7 * v - 0.3 * t);
        float c = 0.5 + 0.5 * sin(TAU * (2.1 * u + sway) + 0.35 * t + seed);
        f = sstep(0.25, 1.0, c) * (1.0 - 0.55 * v) + 0.12 * (1.0 - v);
    } else {
        float s = 0.5 + 0.5 * sin(TAU * 1.5 * (u + 0.6 * v) - 0.7 * t + 0.5 * sin(TAU * u + 0.3 * t + seed));
        f = sstep(0.2, 0.95, s) * (0.65 + 0.35 * v);
    }
    return min(1.0, f);
}

static float line_f(float d, float w) { float q = d / w; return exp(-q * q); }

static float ascii_at(int kind, float x, float y, float t) {
    if (kind == 0) {
        float f = 0.0;
        for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float base = 0.25 + fi * 0.25;
            float c = base + 0.09 * sin(TAU * (0.8 + fi * 0.35) * x + (0.55 - fi * 0.12) * t + fi * 2.1) + 0.04 * sin(TAU * 2.1 * x - 0.4 * t + fi);
            float d = (y - c) / (0.07 + 0.02 * fi);
            f = max(f, exp(-d * d));
        }
        return f;
    }
    if (kind == 1) {
        float r = length(float2((x - 0.62) * 2.6, y - 0.5));
        return line_f(fract1(r * 2.6 - 0.3 * t) - 0.5, 0.26) * (1.0 - sstep(1.3, 2.6, r));
    }
    if (kind == 2) { return line_f(fract1(2.4 * x + 0.12 * sin(TAU * y + 0.4 * t) + 0.04 * t) - 0.5, 0.28) * (1.0 - 0.2 * y); }
    return line_f(fract1(1.7 * x + 0.9 * y - 0.11 * t) - 0.5, 0.25);
}

static float seg(float2 q, float2 a, float2 b) {
    float2 pa = q - a; float2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}
static float cov(float d, float hw, float aa) { return clamp((hw - d) / aa + 0.5, 0.0, 1.0); }

static float glyph(int kind, bool crest, float2 q, float aa) {
    float hw = 0.68;
    if (crest) {
        if (kind == 0 || kind == 1) { return cov(abs(length(q - float2(3.0, 4.6)) - 1.55), hw, aa); }
        if (kind == 2) { return cov(seg(q, float2(3.0, 1.2), float2(3.0, 7.2)), hw, aa); }
        float x = clamp(q.x, 0.8, 5.2);
        float ys = 4.4 + 0.9 * sin((x - 0.8) / 4.4 * TAU);
        float sl = 0.9 * TAU / 4.4 * cos((x - 0.8) / 4.4 * TAU);
        float d = abs(q.y - ys) / sqrt(1.0 + sl * sl);
        return cov(d, hw, aa) * ((q.x > 0.4 && q.x < 5.6) ? 1.0 : 0.0);
    }
    if (kind == 0) { return max(cov(seg(q, float2(1.1, 2.7), float2(4.9, 6.5)), hw, aa), cov(seg(q, float2(4.9, 2.7), float2(1.1, 6.5)), hw, aa)); }
    if (kind == 1) { return cov(length(q - float2(3.0, 4.5)), 0.65, aa); }
    if (kind == 2) { return max(cov(length(q - float2(3.0, 3.4)), 0.6, aa), cov(length(q - float2(3.0, 5.8)), 0.6, aa)); }
    return cov(seg(q, float2(1.0, 4.4), float2(5.0, 4.4)), hw, aa);
}

float4 custom_fs(float2 pos, constant float* U) {
    float2 p = pos - float2(U[0], U[1]);
    float2 size = float2(U[2], U[3]);
    int mode = int(UD(0));
    int kind = int(UD(1));
    float seed = UD(2);
    float t = UD(3);
    float scale = UD(4);
    float3 light = float3(UD(5), UD(6), UD(7)) / 255.0;
    float3 mid = float3(UD(8), UD(9), UD(10)) / 255.0;
    if (mode == 0) {
        float dot_px = max(1.0, UD(11));
        int gx = int(floor(p.x / dot_px));
        int gy = int(floor(p.y / dot_px));
        float w = max(8.0, round(size.x / dot_px));
        float h = max(8.0, round(size.y / dot_px));
        float f = cover_field(kind, (float(gx) + 0.5) / w, (float(gy) + 0.5) / h, t, seed);
        float tt = clamp(f, 0.0, 1.0);
        float dl = pow(tt, 1.6) * 0.26;
        float dm = min(1.0 - dl, pow(tt, 0.6) * 0.74);
        float th = noise_at(gx + int(UD(12)), gy + int(UD(13)));
        float3 col = float3(0.0);
        if (th < dl) { col = light; } else if (th < dl + dm) { col = mid; }
        float r = UD(14);
        float a = 1.0;
        if (r > 0.0) {
            float2 q = abs(p - size * 0.5) - (size * 0.5 - float2(r));
            float d = length(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - r;
            a = clamp(0.5 - d, 0.0, 1.0);
        }
        return float4(col, a);
    }
    float cw = 6.0 * scale;
    float ch = 8.0 * scale;
    float cols = ceil(size.x / cw);
    float rows = ceil(size.y / ch);
    float c = floor(p.x / cw);
    float r = floor(p.y / ch);
    float v = p.y / size.y;
    float m = mix(0.2, 0.0, clamp((v - 0.86) / 0.14, 0.0, 1.0));
    if (v < 0.86) { m = mix(0.6, 0.2, clamp((v - 0.62) / 0.24, 0.0, 1.0)); }
    if (v < 0.62) { m = mix(1.0, 0.6, clamp((v - 0.35) / 0.27, 0.0, 1.0)); }
    float wa = mix(0.45, 0.0, clamp((v - 0.6) / 0.4, 0.0, 1.0));
    if (v < 0.6) { wa = mix(0.3, 0.45, v / 0.6); }
    float washa = wa * m;
    float ga = 0.0;
    float3 gcol = light;
    float f = ascii_at(kind, (c + 0.5) / cols, (r + 0.5) / rows, t);
    if (f >= 0.08) {
        float th = noise_at(int(c), int(r));
        if (th < f * 0.34) {
            bool crest = f > 0.62;
            float2 q = float2(p.x - c * cw, p.y - r * ch) / scale;
            ga = glyph(kind, crest, q, 1.0 / scale);
            if (!crest) { gcol = mid; ga = ga * 0.95; }
            ga = ga * m;
        }
    }
    float a = ga + washa * (1.0 - ga);
    if (a <= 0.0) { return float4(0.0); }
    float3 rgb = (gcol * ga + float3(8.0, 8.0, 14.0) / 255.0 * washa * (1.0 - ga)) / a;
    return float4(rgb, a);
}
