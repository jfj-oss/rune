// "Foil waves" backdrop for Metal: the same picture and maths as foil.wgsl (and foil.rs, the CPU fallback), per device pixel.
// Keep the three in step. Appended to the hook's prelude, which provides the vertex stage and `SHADER_HEADER_LEN`; the app's
// floats are U[SHADER_HEADER_LEN + i]. Entry point: custom_fs(pos, U).

#define UD(i) U[SHADER_HEADER_LEN + (i)]

constant float TAU = 6.2831853;
constant float T_LOOP = 25.6;
constant uint N_BANDS = 8u;
constant uint BANDS_AT = 16u;
constant uint COLS_AT = 96u;
constant float BODY_GAIN = 3.6;
constant float SEP_GAIN = 0.4;
constant float GLOW_AMP = 0.2;
constant float GLOW_R = 1.5;
constant float GLOW_K = 1.8;
constant float GLINT_SHARE = 0.05;
constant float N_DASH = 110.0;
constant float HW_MIN = 1.0;
constant float HW_MAX = 9.5;
constant float JIT_BASE = 1.0;
constant float JIT_SLOPE = 0.05;
constant float JIT_MAX = 2.0;
constant float FILL_MIN = 0.06;
constant float FILL_FULL_AT = 0.62;
constant float MOON_DIM = 0.55;
constant int DUST_CYCLE = 192;
constant float3 WAVE = float3(105.0, 125.0, 255.0);
constant float3 HOT = float3(205.0, 222.0, 255.0);
constant float3 GLINT = float3(240.0, 246.0, 255.0);
constant float3 STRAY = float3(130.0, 145.0, 255.0);
constant float3 MOON = float3(120.0, 135.0, 255.0);
constant float BAYER[16] = {0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.};

static inline float fract1(float x) { return x - floor(x); }
static inline float pmod(float x, float m) { return x - m * floor(x / m); }
static inline float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
static inline int div_e(int a, int m) { int q = a / m; if (a - q * m < 0) { q = q - 1; } return q; }
static inline int rem_e(int a, int m) { return a - div_e(a, m) * m; }

// the sin-free hash (Hoskins), three values in 0..1; the same operations as foil.rs
static float3 hash3(float x, float y) {
    float a = fract1(x * 0.1031);
    float b = fract1(y * 0.1030);
    float c = fract1(x * 0.0973);
    float d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
    a += d; b += d; c += d;
    return float3(fract1((a + b) * c), fract1((b + c) * a), fract1((c + a) * b));
}

static float fade_at(float u, float v) { return sstep(0.0, 0.85, (u - 0.5) + (0.5 - v)); }
static float base_ev(float u, float v) { return 0.75 + 0.35 * clamp((u + v - 0.6) / 1.2, 0.0, 1.0); }

// ---- the dust field: rgb in 0..255 (with the stray pixel added), `moon` selects the moon's periwinkle marks
static float3 dust(int px, int py, int shift, bool moon) {
    int xs = px - shift;
    int ys = py + shift;
    int a = xs + ys;
    int b = xs - ys;
    float3 hr = hash3(float(a), 3.0);
    int len = 2 + int(floor(hr.x * 3.0));
    int phase = int(floor(hr.y * float(len)));
    int cell = rem_e(div_e(b, 2) + phase, DUST_CYCLE) / len;
    float3 h = hash3(float(a) + 0.5, float(cell) + 17.0);
    float3 rgb;
    if (moon && h.x < 0.75) { rgb = MOON * (0.3 + 0.6 * h.y); }
    else if (h.x < 0.3) { rgb = float3(0.0); }
    else if (h.x > 0.9) { rgb = float3(10.0 + 7.0 * h.y, 15.0 + 8.0 * h.y, 33.0 + 13.0 * h.y); }
    else { rgb = float3(2.0 + 5.0 * h.y, 3.0 + 6.0 * h.y, 8.0 + 14.0 * h.y); }
    float3 hs = hash3(float(a) + 0.25, float(rem_e(b, 2 * DUST_CYCLE)) + 0.75);
    float stray = 0.0;
    if (hs.x < 0.0016) { stray = 0.4 + 0.6 * hs.y; }
    if (moon) { rgb = rgb * 1.5; }
    return rgb + STRAY * stray;
}

// ---- glints: a hashed flash that fades, a whole number of flashes per loop
static float glint_at(int x, int yr, float t, float share) {
    int block = div_e(yr, 3);
    uint hh = (as_type<uint>(x) * 0x9E3779B1u) ^ (as_type<uint>(block) * 0x85EBCA77u);
    hh = (hh ^ (hh >> 15u)) * 0x2C1B3C6Du;
    if (float((hh >> 8u) & 0xFFFFu) / 65536.0 > share * 3.0) { return 0.0; }
    float3 hg = hash3(float(x) + 0.5, float(block) + 3.0);
    int len = 1 + int(floor(hg.z * 3.0));
    int off = int(floor(fract1(hg.z * 7.3) * float(4 - len)));
    int r = rem_e(yr, 3);
    if (r < off || r >= off + len) { return 0.0; }
    float period = T_LOOP / max(rint(T_LOOP / (2.5 + 3.0 * hg.y)), 1.0);
    float dur = 0.3 + 0.7 * fract1(hg.y * 5.1);
    float phase = pmod(t + hg.y * 17.0, period);
    if (phase >= dur) { return 0.0; }
    return pow(1.0 - phase / dur, 1.5);
}

static float profile_at(thread const float* p, float y01) {
    float u = clamp(y01, 0.0, 1.0) * 4.0;
    int i = min(int(floor(u)), 3);
    float f = u - float(i);
    return p[i] + (p[i + 1] - p[i]) * f * f * (3.0 - 2.0 * f);
}
static float pq(float v) { return 0.2 + 0.8 * pow(v, 1.5); }

struct BandEval { float R; float dR; float u; float a; };

// the radius of band slot k in direction th, its slope dR/dth, the arc fraction u and the angle a from the arc's start
static BandEval band_eval(constant float* U, uint b0, float th) {
    float start = UD(b0);
    float span = UD(b0 + 1u);
    float hook = UD(b0 + 2u);
    float p = UD(b0 + 7u);
    float rscale = UD(b0 + 8u);
    float tp = TAU * p;
    float w1 = 3.0 * th + UD(b0 + 3u) + tp; float w2 = 5.0 * th + UD(b0 + 4u) - tp; float w3 = 8.0 * th + UD(b0 + 5u) + 2.0 * tp; float w4 = 14.0 * th + UD(b0 + 6u) - 3.0 * tp;
    float wob = 0.10 * sin(w1) + 0.06 * sin(w2) + 0.03 * sin(w3) + 0.012 * sin(w4);
    float dwob = 0.30 * cos(w1) + 0.30 * cos(w2) + 0.24 * cos(w3) + 0.168 * cos(w4);
    float a = pmod(th - start, TAU);
    float u = a / span;
    float ht = sstep(0.74, 1.0, u);
    float hmul = 1.0 - hook * ht * ht;
    float dht = 0.0;
    if (u > 0.74 && u < 1.0) { float q = (u - 0.74) / 0.26; dht = 6.0 * q * (1.0 - q) / (0.26 * span); }
    BandEval e;
    e.R = rscale * (1.0 + wob) * hmul;
    e.dR = rscale * (dwob * hmul + (1.0 + wob) * (-hook * 2.0 * ht * dht));
    e.u = u;
    e.a = a;
    return e;
}

// ---- one band's contribution at the pixel: premultiplied colour (0..255) and alpha (0..255), or zero
static float4 band_pixel(constant float* U, uint k, int px, int py, float t, float scale, float2 wh, uint id, bool sep) {
    uint b0 = BANDS_AT + k * 10u;
    float span = UD(b0 + 1u);
    float2 c0 = wh * 0.5;
    float hd = 0.5 * length(wh);
    float2 cp = float2(float(px) + 0.5, float(py) + 0.5);
    float2 d = cp - c0;
    float r = length(d);
    if (r < 1.0) { return float4(0.0); }
    float th = atan2(d.y, d.x);
    BandEval e0 = band_eval(U, b0, th);
    if (e0.u >= 1.5) { return float4(0.0); }
    float hw0 = scale * (HW_MIN + (HW_MAX - HW_MIN) * pow(clamp(e0.R / hd, 0.0, 1.35), 1.2));
    float reach0 = max(GLOW_R * max(GLOW_K * hw0, 3.0 * scale), hw0 + JIT_MAX) + 1.0;
    float off = r - e0.R;
    if (abs(off) > reach0 * 1.9) { return float4(0.0); }
    float norm = sqrt(1.0 + (e0.dR / r) * (e0.dR / r));
    float dist = off / norm;
    float2 nrm = (float2(cos(th), sin(th)) - (e0.dR / r) * float2(-sin(th), cos(th))) / norm;
    bool shallow = abs(nrm.y) >= abs(nrm.x);
    // the point of the line straight above/below (shallow) or beside (steep) the pixel: where the CPU painter paints this column or row
    float2 qp;
    float sd;
    int2 gk;
    if (shallow) {
        qp = float2(cp.x, cp.y - dist / nrm.y);
        sd = dist * sign(nrm.y);
        gk = int2(px + int(k) * 131, py - int(qp.y));
    } else {
        qp = float2(cp.x - dist / nrm.x, cp.y);
        sd = dist * sign(nrm.x);
        gk = int2(px - int(qp.x) + 7000 + int(k) * 131, py);
    }
    float th2 = atan2(qp.y - c0.y, qp.x - c0.x);
    BandEval e1 = band_eval(U, b0, th2);
    if (e1.u >= 1.0) { return float4(0.0); }
    float u = e1.u;
    float rn = e1.R / hd;
    float hw = scale * (HW_MIN + (HW_MAX - HW_MIN) * pow(clamp(rn, 0.0, 1.35), 1.2));
    float sig = max(GLOW_K * hw, 3.0 * scale);
    // which strips are lit
    float fill = FILL_MIN + (1.0 - FILL_MIN) * sstep(0.06, FILL_FULL_AT, rn);
    if (hash3(float(id), 20.0 + float(k)).x >= fill) { return float4(0.0); }
    // the band's own brightness here: lumps, dashed far end, the fade towards the top right
    float2 fuv = qp / wh;
    float dz = min((1.0 - u) / 0.22, 1.0);
    float dashed = 0.0;
    if (dz >= 1.0 || fract1(u * N_DASH) < 0.25 + 0.75 * dz) { dashed = 1.0; }
    float la = u * span * 60.0;
    float lump = 0.78 + 0.22 * sin(la * 0.07 + float(k) * 1.9 + TAU * t / T_LOOP + sin(la * 0.03 + float(k)) * 1.5);
    float ev = base_ev(fuv.x, fuv.y) * lump * dashed * (1.0 - fade_at(fuv.x, fuv.y));
    if (ev < 0.02) { return float4(0.0); }
    // strips stop short of the arc's ends, each at its own place
    float3 hr = hash3(float(px) + 0.5, 3.3);
    if (e1.R * e1.a < hr.x * 12.0 * scale || e1.R * (span - e1.a) < hr.y * 12.0 * scale) { return float4(0.0); }
    // the strip of this column
    float3 h7 = hash3(float(id), 7.0);
    float jit = min(JIT_BASE + JIT_SLOPE * hw, JIT_MAX);
    float top = max(hw + (h7.y * 2.0 - 1.0) * jit, 1.0);
    float bot = max(hw + (h7.z * 2.0 - 1.0) * jit, 1.0);
    float3 h11 = hash3(float(id), 11.0);
    float3 h12 = hash3(float(id), 12.0);
    float prof[5] = {pq(h11.x), pq(h11.y), pq(h11.z), pq(h12.x), pq(h11.x)};
    float sb = (0.45 + 0.55 * pow(h7.x, 1.2)) * (0.88 + 0.12 * sin(TAU * 2.0 * t / T_LOOP + h7.y * TAU));
    float travel = (1.0 + min(floor(h7.x * 3.0), 2.0)) * t / T_LOOP;
    float sepg = sep ? SEP_GAIN : 1.0;
    float gq = fabs(sd) / sig;
    float al = 0.0;
    if (gq < GLOW_R) { al = GLOW_AMP * ev * fill * exp(-gq * gq * 0.5); }
    float cov = min(sd + top, bot - sd) + 0.5;
    float m = 0.0;
    float glint = 0.0;
    if (cov > 0.0) {
        float yy = (sd + top) / (top + bot) + travel;
        float body = min(cov, 1.0) * profile_at(prof, yy - floor(yy)) * sb * ev * BODY_GAIN;
        al += min(body, 1.0) * sepg;
        m = clamp((body - 1.3) / 2.0, 0.0, 1.0);
        if (!sep && cov >= 1.0 && body > 0.25) { glint = glint_at(gk.x, gk.y, t, GLINT_SHARE) * min(body, 1.0); }
    }
    if (al < 0.012) { return float4(0.0); }
    al = min(al, 1.0);
    m = max(m, glint * 0.95);
    float3 col = mix(WAVE, HOT, m);
    if (glint > 0.0) { col = mix(col, GLINT, glint); al = max(al, glint); }
    return float4(col * al, al * 255.0);
}

float4 custom_fs(float2 pos, constant float* U) {
    float2 p = pos - float2(U[0], U[1]);
    int px = int(floor(p.x));
    int py = int(floor(p.y));
    float2 wh = float2(UD(0u), UD(1u));
    float scale = UD(2u);
    float t = UD(3u);
    int shift = int(UD(4u));
    // dust, then the fade to black over it (alpha dithered 4x4 like the CPU image)
    float3 base = min(dust(px, py, shift, false), float3(255.0));
    float f = fade_at((float(px) + 0.5) / wh.x, (float(py) + 0.5) / wh.y) * 255.0;
    float bay = (BAYER[(py & 3) * 4 + (px & 3)] + 0.5) / 16.0;
    base = base * (1.0 - min(floor(f + bay), 255.0) / 255.0);
    // wave bands: where bands meet the brighter one wins, per channel
    uint cid = uint(UD(COLS_AT + uint(clamp(px, 0, int(UD(5u)) - 1))));
    bool sep = (cid & 1u) == 1u;
    uint id = cid >> 1u;
    float4 acc = float4(0.0);
    for (uint k = 0u; k < N_BANDS; k++) { acc = max(acc, band_pixel(U, k, px, py, t, scale, wh, id, sep)); }
    // the moon: a disc of stippled marks over everything, a faint glow only where no band is
    float2 mc = float2(UD(6u), UD(7u));
    float mr = UD(8u);
    float2 dm = float2(float(px) + 0.5, float(py) + 0.5) - mc;
    float dd = length(dm);
    if (dd < mr + 14.0 * scale + 3.0) {
        float edge = (hash3(float(px) + 31.0, float(py) + 31.0).x - 0.5) * 3.0;
        if (dd >= mr + edge) {
            float q = (dd - mr) / (5.0 * scale);
            float a = 0.2 * exp(-q * q * 0.5);
            if (a > 0.004 && acc.w < 1.0) { acc = float4(MOON * a * MOON_DIM, a * 255.0); }
        } else {
            float3 col = dust(px, py, shift, true);
            float3 hp = hash3(float(px) + 53.0, float(py) + 53.0);
            if (hp.x < 0.3) { float mm = 0.5 + 0.5 * hash3(float(px) + 9.0, float(py) + 9.0).y; col += (HOT * 0.3 + MOON * 0.8) * mm; }
            float g = glint_at(px + 7919, py, t, 0.05);
            col = mix(col, GLINT, g);
            acc = float4(min(col * MOON_DIM, float3(255.0)), 255.0);
        }
    }
    float3 rgb = acc.xyz + base * (1.0 - acc.w / 255.0);
    return float4(min(rgb, float3(255.0)) / 255.0, 1.0);
}
