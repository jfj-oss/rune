//! The web's design tokens (`web/src/styles/tokens.css`, shell.css, ambient.css), as numbers.
use gpui_kit::*;

/// 0xRRGGBB -> colour.
pub fn c(v: u32) -> Hsla { rgb(v).into() }
/// 0xRRGGBB with an alpha 0..1.
pub fn ca(v: u32, a: f32) -> Hsla { let mut h: Hsla = rgb(v).into(); h.a = a; h }
/// White at this alpha (the web's `rgba(255,255,255,a)` / `color-mix(in srgb, #fff a%, transparent)`).
pub fn wh(a: f32) -> Hsla { ca(0xffffff, a) }
pub fn bk(a: f32) -> Hsla { ca(0x000000, a) }

pub const BG: u32 = 0x0f1013;
pub const TEXT: u32 = 0xececf1;
pub const TEXT2: u32 = 0xc4c5d0;
pub const TEXT3: u32 = 0xa9aab9;
/// On glass (sidebar, player bar) the web raises the two secondary text colours.
pub const TEXT2_GLASS: u32 = 0xd3d4de;
pub const TEXT3_GLASS: u32 = 0xc2c3d1;
pub const ACCENT: u32 = 0xb3a7ff;
pub const ACCENT2: u32 = 0xcfc8ff;
pub const ON: u32 = 0xa66bff;
pub const OK: u32 = 0x4fd18b;
pub const WARN: u32 = 0xe8b04a;
pub const BAD: u32 = 0xe5736f;
pub const SPOTIFY: u32 = 0x1db954;

/// A Dither backdrop is showing: panels turn into dark glass. The web gets this from its backdrop blur + brightness filter, which
/// GPUI does not have, and a plain 5 % white panel over bright dots is unreadable.
static DITHER_UI: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn set_dither_ui(on: bool) { DITHER_UI.store(on, std::sync::atomic::Ordering::Relaxed); }
fn dither_ui() -> bool { DITHER_UI.load(std::sync::atomic::Ordering::Relaxed) }
pub fn surface() -> Hsla { if dither_ui() { ca(0x07070b, 0.80) } else { wh(0.055) } }
pub fn surface2() -> Hsla { if dither_ui() { ca(0x0d0d13, 0.84) } else { wh(0.085) } }
pub fn surface3() -> Hsla { if dither_ui() { ca(0x15151d, 0.88) } else { wh(0.13) } }
pub fn line() -> Hsla { wh(0.10) }
pub fn panel() -> Hsla { ca(0x1b1c24, 0.9) }

pub const R: f32 = 8.;
pub const R_SM: f32 = 4.;

pub const SIDE_W: f32 = 184.;
pub const SIDE_W_COLLAPSED: f32 = 64.;
pub const NPBAR_H: f32 = 88.;
pub const TOPBAR_H: f32 = 56.;
pub const QUEUE_W: f32 = 380.;
pub const PAD: f32 = 40.;
/// The web's scrollbar is an overlay in headless Chromium and takes no layout space; ours is drawn over the page too.
pub const SCROLLBAR: f32 = 0.;

pub const SANS: &str = "Inter";
pub const SERIF: &str = "Source Serif 4";

/// A weight as the web writes it (400, 500, 600, 700).
pub fn w(n: f32) -> FontWeight { FontWeight(n) }

/// The web's `tileGradient(id)` (lib/color.ts): FNV-1a to a hue, `hsl(h 46% 34%)` -> `hsl(h+48 52% 22%)`, 135deg.
pub fn tile_gradient(id: &str) -> (Hsla, Hsla) {
    let h = crate::util::hash_string(id) % 360;
    (hsla(h as f32 / 360., 0.46, 0.34, 1.), hsla(((h + 48) % 360) as f32 / 360., 0.52, 0.22, 1.))
}
