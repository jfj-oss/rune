//! Charts drawn as GPUI paths (the web draws SVG): the sparkline of "Your plays" and Stats, bar charts, and the five glass stars.
use crate::theme::*;
use gpui_kit::*;

/// Days since 1970-01-01 of a `YYYY-MM-DD` date.
pub fn day_number(iso: &str) -> Option<i64> {
    let p: Vec<&str> = iso.get(..10)?.split('-').collect();
    let (y, m, d): (i64, i64, i64) = (p.first()?.parse().ok()?, p.get(1)?.parse().ok()?, p.get(2)?.parse().ok()?);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// `dailySeries`: one value per day from `from` (or the first day) to `to`, empty days as 0, merged into at most `max_points`.
pub fn daily_series(by_day: &[(String, f64)], from_ms: Option<f64>, to_ms: f64, max_points: usize) -> Vec<f64> {
    let mut known: Vec<(i64, f64)> = by_day.iter().filter_map(|(d, ms)| day_number(d).map(|n| (n, ms.max(0.)))).collect();
    if known.is_empty() { return vec![]; }
    known.sort_by_key(|k| k.0);
    let start = from_ms.map(|f| (f / 86_400_000.).floor() as i64).unwrap_or(known[0].0);
    let end = (to_ms / 86_400_000.).floor() as i64;
    if start > end || end - start > 4000 { return vec![]; }
    let mut filled: Vec<f64> = (start..=end).map(|d| known.iter().filter(|k| k.0 == d).map(|k| k.1).sum()).collect();
    if filled.len() > max_points {
        let bucket = filled.len().div_ceil(max_points);
        filled = filled.chunks(bucket).map(|c| c.iter().sum()).collect();
    }
    filled
}

/// The sparkline's points inside a `w` x `h` box (the web's `sparklinePath`): x spread evenly, y scaled to the tallest.
pub fn spark_points(v: &[f64], w: f32, h: f32, pad: f32) -> Vec<(f32, f32)> {
    if v.is_empty() { return vec![]; }
    if v.len() == 1 { return vec![(pad, h - pad), (w - pad, h - pad)]; }
    let max = v.iter().cloned().fold(1., f64::max);
    v.iter().enumerate().map(|(i, x)| (pad + (w - 2. * pad) * i as f32 / (v.len() - 1) as f32, h - pad - (h - 2. * pad) * (*x / max) as f32)).collect()
}

/// An area + line sparkline filling its box (`height` px tall).
pub fn sparkline(values: Vec<f64>, height: f32) -> impl IntoElement {
    canvas(|_, _, _| (), move |b, _, window, _| {
        let (ox, oy, w_, h_) = (f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height));
        let pts = spark_points(&values, w_, h_, 4.);
        if pts.is_empty() { return; }
        let p = |(x, y): (f32, f32)| point(px(ox + x), px(oy + y));
        // the baseline
        window.paint_quad(fill(Bounds::new(point(px(ox + 4.), px(oy + h_ - 4.)), size(px(w_ - 8.), px(1.))), wh(0.10)));
        let mut area = PathBuilder::fill();
        area.move_to(p((pts[0].0, h_ - 4.)));
        for q in &pts { area.line_to(p(*q)); }
        area.line_to(p((pts[pts.len() - 1].0, h_ - 4.)));
        area.close();
        if let Ok(path) = area.build() { window.paint_path(path, linear_gradient(180., linear_color_stop(ca(ACCENT, 0.4), 0.), linear_color_stop(ca(ACCENT, 0.02), 1.))); }
        let mut line = PathBuilder::stroke(px(2.));
        line.move_to(p(pts[0]));
        for q in pts.iter().skip(1) { line.line_to(p(*q)); }
        if let Ok(path) = line.build() { window.paint_path(path, c(ACCENT)); }
    }).w_full().h(px(height))
}

/// Vertical bars scaled to the tallest value (`Bars` in the web's Charts.tsx), `height` px tall.
pub fn bars(values: Vec<f64>, height: f32, color: Hsla) -> impl IntoElement {
    canvas(|_, _, _| (), move |b, _, window, _| {
        let (ox, oy, w_, h_) = (f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height));
        let n = values.len().max(1);
        let max = values.iter().cloned().fold(0., f64::max);
        let slot = w_ / n as f32;
        let bw = (slot - 3.).max(1.);
        for (i, v) in values.iter().enumerate() {
            let frac = if max > 0. && *v > 0. { (*v / max).max(0.03) as f32 } else { 0.015 };
            let bh = h_ * frac;
            let mut q = fill(Bounds::new(point(px(ox + i as f32 * slot + (slot - bw) / 2.), px(oy + h_ - bh)), size(px(bw), px(bh))), color);
            q.corner_radii = Corners::all(px(2.));
            window.paint_quad(q);
        }
    }).w_full().h(px(height))
}

/// The star's outline in a 24-unit box (the web's `STAR` path).
const STAR: [(f32, f32); 10] = [(12., 1.6), (15.09, 7.86), (22., 8.86), (17., 13.73), (18.18, 20.61), (12., 17.36), (5.82, 20.61), (7., 13.73), (2., 8.86), (8.91, 7.86)];

/// Five dark glass stars lit to `value` (0..5, fractional).
pub fn glass_stars(value: f64, size_px: f32) -> impl IntoElement {
    let total_w = size_px * 5. + 4. * 3.;
    canvas(|_, _, _| (), move |b, _, window, _| {
        let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
        let k = size_px / 24.;
        let step = size_px + 3.;
        let v = value.clamp(0., 5.);
        let lit_w = { let whole = v.floor() as f32; let frac = v as f32 - whole; whole * step + if frac > 0. { (2. + frac * 20.) * k } else { 0. } };
        for i in 0..5 {
            let ix = ox + i as f32 * step;
            let pts: Vec<Point<Pixels>> = STAR.iter().map(|(x, y)| point(px(ix + x * k), px(oy + y * k))).collect();
            let mut empty = PathBuilder::fill();
            empty.add_polygon(&pts, true);
            if let Ok(p) = empty.build() { window.paint_path(p, wh(0.06)); }
            let mut rim = PathBuilder::stroke(px(0.8));
            rim.add_polygon(&pts, true);
            if let Ok(p) = rim.build() { window.paint_path(p, wh(0.22)); }
        }
        let mask = ContentMask { bounds: Bounds::new(point(px(ox), px(oy - 2.)), size(px(lit_w), px(size_px + 4.))) };
        window.with_content_mask(Some(mask), |window| {
            for i in 0..5 {
                let ix = ox + i as f32 * step;
                let pts: Vec<Point<Pixels>> = STAR.iter().map(|(x, y)| point(px(ix + x * k), px(oy + y * k))).collect();
                let mut lit = PathBuilder::fill();
                lit.add_polygon(&pts, true);
                if let Ok(p) = lit.build() { window.paint_path(p, wh(0.62)); }
                let mut rim = PathBuilder::stroke(px(0.9));
                rim.add_polygon(&pts, true);
                if let Ok(p) = rim.build() { window.paint_path(p, wh(0.9)); }
            }
        });
    }).w(px(total_w)).h(px(size_px)).flex_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn day_numbers_count_from_the_epoch() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("1970-01-02"), Some(1));
        assert_eq!(day_number("2026-11-20"), Some(20_777));
        assert_eq!(day_number("nope"), None);
    }
    #[::core::prelude::v1::test]
    fn a_daily_series_fills_gaps_and_merges_long_ranges() {
        let by = vec![("1970-01-01".to_string(), 10.), ("1970-01-04".to_string(), 30.)];
        assert_eq!(daily_series(&by, None, 3. * 86_400_000., 60), vec![10., 0., 0., 30.]);
        let long: Vec<(String, f64)> = vec![("1970-01-01".into(), 1.), ("1970-05-01".into(), 1.)];
        let s = daily_series(&long, None, 120. * 86_400_000., 60);
        assert!(s.len() <= 60 && s.iter().sum::<f64>() == 2.);
        assert!(daily_series(&[], None, 0., 60).is_empty());
    }
    #[::core::prelude::v1::test]
    fn the_sparkline_spreads_points_and_scales_to_the_max() {
        let p = spark_points(&[0., 5., 10.], 108., 44., 4.);
        assert_eq!(p[0], (4., 40.));
        assert_eq!(p[2], (104., 4.));
        assert_eq!(spark_points(&[3.], 100., 40., 4.).len(), 2);
    }
}
