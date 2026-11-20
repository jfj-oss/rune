//! Claude Summon's look (Sources/ClaudeSummon/Theme.swift), dark variant: a warm near-black paper, parchment ink, one
//! copper accent, monospace type, small coloured dots on the edge.
use gpui_kit::*;

pub const PAPER: u32 = 0x1C1B18;
pub const INK: u32 = 0xD8D1C2;
pub const DIM: u32 = 0x7A7468;
pub const ACCENT: u32 = 0xD9905F;
pub const BOX: u32 = 0x262420;
pub const RULE: u32 = 0x35322C;
pub const ERROR: u32 = 0xE07A6E;
pub const DOTS: [u32; 8] = [0xC9785A, 0xC9A45A, 0x8FAE6B, 0x5FA89A, 0x6B93C0, 0x9483C4, 0xC07BA8, 0x9A9488];
pub const MONO: &str = "IBM Plex Mono Medium";

pub fn c(v: u32) -> Hsla { rgb(v).into() }

/// Theme.dotColor: FNV-1a of the id picks one of the eight muted dot colours (the same function as the Mac app).
pub fn dot_color(id: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in id.bytes() { h = (h ^ b as u32).wrapping_mul(16777619); }
    DOTS[(h % DOTS.len() as u32) as usize]
}

pub fn mmss(ms: f64) -> String {
    let s = (ms.max(0.) / 1000.).floor() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dot_colours_are_stable() {
        assert_eq!(dot_color("pc"), dot_color("pc"));
        assert!(DOTS.contains(&dot_color("spotify:abc")));
    }
    #[test]
    fn times() {
        assert_eq!(mmss(0.), "0:00");
        assert_eq!(mmss(61_999.), "1:01");
        assert_eq!(mmss(-5.), "0:00");
    }
}
