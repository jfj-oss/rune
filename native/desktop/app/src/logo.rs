//! The mark (web `Logo.tsx`): four balls on a square. Phase 1 draws one still frame of its dots; the animation is phase 6.
use crate::theme::*;
use gpui_kit::*;

pub fn logo(size: f32) -> impl IntoElement {
    canvas(|_, _, _| (), move |b, _, window, _| {
        let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
        // the four resting balls at centre +- 0.17 of the width, radius 0.15
        for (dx, dy, col) in [(-1., -1., 0xd4584f_u32), (1., -1., 0xb94a44), (-1., 1., 0xb94a44), (1., 1., 0xd4584f)] {
            let r = 0.15 * size;
            let (cx, cy) = (ox + size * (0.5 + 0.17 * dx), oy + size * (0.5 + 0.17 * dy));
            let mut pb = PathBuilder::fill();
            let n = 24;
            let pts: Vec<Point<Pixels>> = (0..n).map(|i| { let a = i as f32 / n as f32 * std::f32::consts::TAU; point(px(cx + r * a.cos()), px(cy + r * a.sin())) }).collect();
            pb.add_polygon(&pts, true);
            if let Ok(p) = pb.build() { window.paint_path(p, c(col)); }
        }
    }).size(px(size)).flex_none()
}
