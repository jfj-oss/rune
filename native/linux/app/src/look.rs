//! Claude Summon's look (Sources/ClaudeSummon/Theme.swift), dark variant: a warm near-black paper, parchment ink, one
//! copper accent, monospace type, small coloured dots on the edge (one per chosen playlist).
use gpui_kit::*;

pub const PAPER: u32 = 0x1C1B18;
pub const INK: u32 = 0xD8D1C2;
pub const DIM: u32 = 0x7A7468;
pub const ACCENT: u32 = 0xD9905F;
pub const BOX: u32 = 0x262420;
/// Corner radius of the panel (the window itself is transparent outside it).
pub const RADIUS: f32 = 14.;
pub const RULE: u32 = 0x35322C;
pub const ERROR: u32 = 0xE07A6E;
pub const DOTS: [u32; 8] = [0xC9785A, 0xC9A45A, 0x8FAE6B, 0x5FA89A, 0x6B93C0, 0x9483C4, 0xC07BA8, 0x9A9488];
pub const MONO: &str = "IBM Plex Mono Medium";

pub fn c(v: u32) -> Hsla { rgb(v).into() }

/// The dot colour for a playlist's colour key (the server hands out 0..7 and keeps one per playlist; the Mac app has
/// the same eight in Theme.swift). Any number is accepted and wraps.
pub fn dot_color(key: u8) -> u32 { DOTS[key as usize % DOTS.len()] }

pub fn mmss(ms: f64) -> String {
    let s = (ms.max(0.) / 1000.).floor() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn dot_colours_are_stable() {
        assert_eq!(dot_color(0), DOTS[0]);
        assert_eq!(dot_color(7), DOTS[7]);
        assert_eq!(dot_color(8), DOTS[0], "wraps");
        let mut seen = DOTS.to_vec();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 8, "eight distinct colours");
    }
    #[::core::prelude::v1::test]
    fn times() {
        assert_eq!(mmss(0.), "0:00");
        assert_eq!(mmss(61_999.), "1:01");
        assert_eq!(mmss(-5.), "0:00");
    }
}
