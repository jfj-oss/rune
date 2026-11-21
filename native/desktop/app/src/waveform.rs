//! The waveform seek bar (web `Waveform.tsx`, `lib/waveform.ts`, `hooks/usePeaks.ts`): mirrored peak bars, played ones in the
//! accent colour, click or drag to seek. Local tracks read `/api/peaks/:id`; Spotify tracks get the web's song-shaped stand-in.
use crate::rune::*;
use crate::theme::*;
use gpui_kit::*;
use std::sync::Arc;

/// Merge peaks down to at most `bars` values (the loudest of each group).
pub fn fit_peaks(data: &[f32], bars: f32) -> Vec<f32> {
    let n = data.len();
    let m = bars.floor().max(1.) as usize;
    if n <= m { return data.to_vec(); }
    (0..m).map(|i| {
        let from = i * n / m;
        let to = (((i + 1) * n) / m).max(from + 1);
        data[from..to.min(n)].iter().copied().fold(0., f32::max)
    }).collect()
}

/// How many leading bars count as played.
pub fn played_bars(count: usize, pos_ms: f64, dur_ms: f64) -> usize {
    if count == 0 || !dur_ms.is_finite() || dur_ms <= 0. { return 0; }
    ((pos_ms / dur_ms).clamp(0., 1.) * count as f64).round() as usize
}

fn hash_seed(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for u in s.encode_utf16() { h ^= u as u32; h = h.wrapping_mul(0x01000193); }
    h
}

/// mulberry32, like the web's, so the stand-in looks the same.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64 / 4294967296.) as f32
    }
}

/// `generatedPeaks`: a song-shaped stand-in (0..1) for songs whose audio rune cannot read; always the same for the same id.
pub fn generated_peaks(id: &str, buckets: usize, duration_ms: f64) -> Vec<f32> {
    let n = buckets.max(1);
    let mut rng = Rng(hash_seed(id));
    let secs = (duration_ms / 1000.).max(30.) as f32;
    let mut levels = vec![0f32; n];
    let mut i = 0;
    while i < n {
        let len = (((12. + rng.next() * 16.) / secs) * n as f32).round().max(1.) as usize;
        let level = 0.3 + rng.next() * 0.6;
        let mut k = 0;
        while k < len && i < n { levels[i] = level; k += 1; i += 1; }
    }
    let fade = ((4. / secs) * n as f32).round().max(1.);
    let beat = 2 + (rng.next() * 3.).floor() as usize;
    let mut smooth = levels[0];
    let mut wobble = 0.7f32;
    (0..n).map(|j| {
        smooth += (levels[j] - smooth) * 0.25;
        wobble += (rng.next() - wobble) * 0.35;
        let edge = 1f32.min((j as f32 + 1.) / fade).min((n - j) as f32 / fade);
        let hit = if j % beat == 0 { 1.15 } else { 1. };
        let texture = (0.25 + 0.55 * wobble + 0.35 * rng.next()) * hit;
        (1000. * 1f32.min(smooth * texture * (0.25 + 0.75 * edge))).round() / 1000.
    }).collect()
}

impl Rune {
    /// The peaks to draw for the playing track, once known: (bars 0..1, is_stand_in).
    pub fn peaks_for(&mut self, track_id: &str, duration_ms: f64, cx: &mut Context<Self>) -> Option<(Arc<Vec<f32>>, bool)> {
        if track_id.is_empty() || duration_ms <= 0. { return None; }
        if let Some((k, v, g)) = &self.peak_cache { if k == track_id { return Some((v.clone(), *g)); } }
        let spotify = track_id.starts_with("sp:");
        if spotify {
            let v = Arc::new(generated_peaks(track_id, 400, duration_ms));
            self.peak_cache = Some((track_id.to_string(), v.clone(), true));
            return Some((v, true));
        }
        let slot = self.ensure_json(&format!("/peaks/{}?buckets=400", rune_mini_core::commands::encode(track_id)), cx);
        let data = slot.ready().and_then(|v| v.get("data")).and_then(|d| d.as_array()).map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.) as f32 / 255.).collect::<Vec<_>>())?;
        if data.is_empty() { return None; }
        let v = Arc::new(data);
        self.peak_cache = Some((track_id.to_string(), v.clone(), false));
        Some((v, false))
    }

    /// The bar itself: `height` px, painted as quads; the pointer handling is the seek slider's (`Drag::Seek`).
    pub fn waveform(&self, id: &'static str, peaks: Arc<Vec<f32>>, approx: bool, frac: f32, height: f32, cx: &mut Context<Self>) -> Stateful<Div> {
        let bounds = self.seek_bounds.clone();
        let b2 = bounds.clone();
        div().id(id).relative().w_full().h(px(height)).rounded(px(6.)).cursor_pointer().hover(|s| s.bg(wh(0.04)))
            .child(canvas(move |bb, _, _| b2.set(bb), move |b, _, window, _| {
                let (ox, oy, w_, h_) = (f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height));
                if w_ < 4. { return; }
                let bars = fit_peaks(&peaks, w_ / 3.);
                let n = bars.len();
                let slot = w_ / n as f32;
                let bw = (slot - 1.).max(0.5);
                let played = played_bars(n, frac as f64, 1.);
                let accent = if approx { ca(ACCENT, 0.9) } else { c(ACCENT) };
                for (i, p) in bars.iter().enumerate() {
                    let h = (p.clamp(0., 1.) * h_).max(2.);
                    let x = ox + i as f32 * slot + (slot - bw) / 2.;
                    window.paint_quad(fill(Bounds::new(point(px(x), px(oy + (h_ - h) / 2.)), size(px(bw), px(h))), if i < played { accent } else { wh(0.42) }));
                }
            }).absolute().size_full())
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, _w, cx| { this.start_seek_drag(f32::from(ev.position.x), cx); }))
            // a quick click ends here: the window-level release listener only exists from the next frame on
            .on_mouse_up(MouseButton::Left, cx.listener(|this, ev: &MouseUpEvent, _w, cx| { if this.drag.is_some() { this.on_drag_up(ev, cx); cx.notify(); } }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn peaks_fit_to_the_loudest_of_each_group() {
        assert_eq!(fit_peaks(&[0.1, 0.9, 0.2, 0.3], 2.), vec![0.9, 0.3]);
        assert_eq!(fit_peaks(&[0.5], 10.), vec![0.5]);
    }
    #[::core::prelude::v1::test]
    fn played_bars_follow_the_position() {
        assert_eq!(played_bars(100, 50., 100.), 50);
        assert_eq!(played_bars(100, 500., 100.), 100);
        assert_eq!(played_bars(100, 5., 0.), 0);
    }
    #[::core::prelude::v1::test]
    fn the_stand_in_is_stable_and_in_range() {
        let a = generated_peaks("sp:abc", 200, 180_000.);
        assert_eq!(a, generated_peaks("sp:abc", 200, 180_000.));
        assert_ne!(a, generated_peaks("sp:abd", 200, 180_000.));
        assert!(a.iter().all(|v| (0. ..=1.).contains(v)));
    }
}
