//! The tinted header of a playlist page (web `.ahero__bg img` + `.ahero__wash`, and `.ahero__bg--liked`): the first song's cover, blown up
//! and very soft (the web blurs it 72 px and saturates it 1.4), faded out towards the bottom, under the dark wash. GPUI has no blur,
//! so the picture is made here once per size, as a small premultiplied BGRA image (about 64 px wide) that the GPU stretches smoothly.
//! Liked Songs has two soft colour glows instead of a picture.

/// Alpha of the header's mask (`linear-gradient(180deg, #000 35%, .6 62%, .2 86%, 0)`), v = 0 at the top.
pub fn mask(v: f32) -> f32 {
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t.clamp(0., 1.);
    if v < 0.35 { 1. } else if v < 0.62 { lerp(1., 0.6, (v - 0.35) / 0.27) } else if v < 0.86 { lerp(0.6, 0.2, (v - 0.62) / 0.24) } else { lerp(0.2, 0., (v - 0.86) / 0.14) }
}

/// Alpha of the wash (`rgba(8,8,14, .3 -> .45 at 60% -> 0)`).
pub fn wash(v: f32) -> f32 { if v < 0.6 { 0.3 + 0.15 * v / 0.6 } else { 0.45 * (1. - ((v - 0.6) / 0.4).clamp(0., 1.)) } }

/// A source picture as BGRA bytes.
pub struct Src<'a> { pub bgra: &'a [u8], pub w: usize, pub h: usize }

/// Mean colour of an `n` x `n` grid over the picture (the "blur"), RGB 0..255.
fn tiny(src: &Src, n: usize) -> Vec<[f32; 3]> {
    let mut out = vec![[0f32; 3]; n * n];
    for gy in 0..n {
        for gx in 0..n {
            let (x0, x1) = (gx * src.w / n, ((gx + 1) * src.w / n).max(gx * src.w / n + 1).min(src.w));
            let (y0, y1) = (gy * src.h / n, ((gy + 1) * src.h / n).max(gy * src.h / n + 1).min(src.h));
            let (mut s, mut cnt) = ([0f32; 3], 0f32);
            for y in y0..y1 { for x in x0..x1 { let p = (y * src.w + x) * 4; s[0] += src.bgra[p + 2] as f32; s[1] += src.bgra[p + 1] as f32; s[2] += src.bgra[p] as f32; cnt += 1.; } }
            if cnt > 0. { out[gy * n + gx] = [s[0] / cnt, s[1] / cnt, s[2] / cnt]; }
        }
    }
    out
}

fn bilinear(t: &[[f32; 3]], n: usize, u: f32, v: f32) -> [f32; 3] {
    let (x, y) = ((u * n as f32 - 0.5).clamp(0., n as f32 - 1.), (v * n as f32 - 0.5).clamp(0., n as f32 - 1.));
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(n - 1), (y0 + 1).min(n - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let mut o = [0f32; 3];
    for c in 0..3 { o[c] = (t[y0 * n + x0][c] * (1. - fx) + t[y0 * n + x1][c] * fx) * (1. - fy) + (t[y1 * n + x0][c] * (1. - fx) + t[y1 * n + x1][c] * fx) * fy; }
    o
}

/// The header image for a box of `box_w` x `box_h` CSS px, as `ow` x `oh` premultiplied BGRA. `src` None and `liked` false: just the wash.
pub fn render(src: Option<&Src>, liked: bool, box_w: f32, box_h: f32, ow: usize, oh: usize) -> Vec<u8> {
    let tiny_img = src.map(|s| tiny(s, 8));
    let mut out = vec![0u8; ow * oh * 4];
    for y in 0..oh {
        for x in 0..ow {
            let (u, v) = ((x as f32 + 0.5) / ow as f32, (y as f32 + 0.5) / oh as f32);
            let m = mask(v);
            // (premultiplied colour 0..1, alpha) of the layer under the wash
            let (mut col, mut a) = ([0f32; 3], 0f32);
            if liked {
                let glow = |cx: f32, cy: f32, rx: f32, ry: f32, rgb: [f32; 3], al: f32| {
                    let d = (((u - cx) / rx).powi(2) + ((v - cy) / ry).powi(2)).sqrt();
                    let k = (1. - d / 0.6).clamp(0., 1.) * al;
                    ([rgb[0] * k, rgb[1] * k, rgb[2] * k], k)
                };
                let (c1, a1) = glow(0.15, 0.2, 1.2, 1.4, [111. / 255., 92. / 255., 1.], 0.7);
                let (c2, a2) = glow(0.85, 0.1, 0.9, 1.2, [127. / 255., 228. / 255., 196. / 255.], 0.38);
                for i in 0..3 { col[i] = c2[i] + c1[i] * (1. - a2); }
                a = a2 + a1 * (1. - a2);
                let k = (1. - ((v - 0.6) / 0.4).clamp(0., 1.)).min(1.);
                for c in col.iter_mut() { *c *= k; }
                a *= k;
            } else if let (Some(t), Some(s)) = (&tiny_img, src) {
                // the picture covers a box 80 px larger on every side, scaled 1.1 about its centre
                let (bw, bh) = (box_w + 160., box_h + 160.);
                let (px, py) = (u * box_w + 80., v * box_h + 80.);
                let (px, py) = ((px - bw / 2.) / 1.1 + bw / 2., (py - bh / 2.) / 1.1 + bh / 2.);
                let sc = (bw / s.w as f32).max(bh / s.h as f32);
                let (su, sv) = ((px - bw / 2.) / (sc * s.w as f32) + 0.5, (py - bh / 2.) / (sc * s.h as f32) + 0.5);
                let mut rgb = bilinear(t, 8, su, sv);
                let lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                for c in rgb.iter_mut() { *c = (lum + (*c - lum) * 1.4).clamp(0., 255.) / 255.; }
                a = 0.62 * m;
                col = [rgb[0] * a, rgb[1] * a, rgb[2] * a];
            }
            let wa = wash(v) * m;
            let wc = [8. / 255., 8. / 255., 14. / 255.];
            let p = [wc[0] * wa + col[0] * (1. - wa), wc[1] * wa + col[1] * (1. - wa), wc[2] * wa + col[2] * (1. - wa)];
            let al = wa + a * (1. - wa);
            let i = (y * ow + x) * 4;
            out[i] = (p[2] * 255.).round() as u8; out[i + 1] = (p[1] * 255.).round() as u8; out[i + 2] = (p[0] * 255.).round() as u8; out[i + 3] = (al * 255.).round() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn the_mask_and_wash_follow_the_css_stops() {
        assert_eq!(mask(0.0), 1.0);
        assert!((mask(0.62) - 0.6).abs() < 1e-4 && (mask(0.86) - 0.2).abs() < 1e-4 && mask(1.0).abs() < 1e-4);
        assert!((wash(0.0) - 0.3).abs() < 1e-4 && (wash(0.6) - 0.45).abs() < 1e-4 && wash(1.0).abs() < 1e-4);
    }

    #[::core::prelude::v1::test]
    fn a_red_cover_makes_a_red_header_that_fades_to_nothing() {
        let (w, h) = (16, 16);
        let bgra: Vec<u8> = (0..w * h).flat_map(|_| [30u8, 30, 200, 255]).collect();
        let img = render(Some(&Src { bgra: &bgra, w, h }), false, 1000., 300., 32, 10);
        let px = |x: usize, y: usize| { let i = (y * 32 + x) * 4; [img[i], img[i + 1], img[i + 2], img[i + 3]] };
        let top = px(16, 0);
        assert!(top[2] > top[0] && top[3] > 150, "red and visible at the top: {top:?}");
        assert!(px(16, 9)[3] < 20, "gone at the bottom: {:?}", px(16, 9));
    }

    #[::core::prelude::v1::test]
    fn liked_songs_is_a_purple_glow_top_left() {
        let img = render(None, true, 1000., 300., 32, 10);
        let i = (0 * 32 + 4) * 4;
        assert!(img[i] > img[i + 1] && img[i + 3] > 100, "{:?}", &img[i..i + 4]);
    }
}
