//! RUNE PATCH (see native/desktop/vendor/PATCH.md): a small custom-shader hook.
//!
//! An app registers a fragment shader once ([`register_shader`], one WGSL source for the wgpu renderer and one MSL source for
//! Metal) and then paints [`ShaderQuad`]s with it ([`Window::paint_shader_quad`] or the [`shader_quad`] element). The quad is
//! an ordinary scene primitive: it is ordered, clipped and batched like a quad. The renderer draws it with the app's pipeline.
//!
//! What the shader sees is one flat array of `f32` (`U`): [`SHADER_HEADER_LEN`] floats the renderer fills in (see
//! [`ShaderQuad::pack`]) followed by the app's own floats. The fragment entry point is called with the fragment's position in
//! device pixels (window origin top-left, pixel centres at .5) and returns a straight (not premultiplied) RGBA colour.

use crate::{canvas, Bounds, Canvas, ContentMask, DrawOrder, Pixels, Primitive, ScaledPixels, Window};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// Identifies a registered shader. Pick any `u32`; registering the same id again replaces the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ShaderId(pub u32);

/// The sources of a custom shader. Each backend uses its own and ignores the other.
///
/// * `wgsl`: WGSL appended after a prelude that declares `U: array<f32>` (storage buffer, binding 0 of group 1) and
///   `globals`; it must define `fn custom_fs(pos: vec2<f32>) -> vec4<f32>`. Helpers in the prelude: `ud(i)` reads user float `i`.
/// * `msl`: Metal source that is appended after a prelude declaring `float2 ...` helpers; it must define
///   `float4 custom_fs(float2 pos, constant float* U)`; user float `i` is `U[SHADER_HEADER_LEN + i]` (the prelude has `ud(U, i)`).
#[derive(Clone, Debug)]
pub struct ShaderSource {
    /// WGSL fragment body (wgpu renderer: Linux, Windows via wgpu, web).
    pub wgsl: &'static str,
    /// MSL fragment body (Metal renderer: macOS, iOS).
    pub msl: &'static str,
}

/// Where a shader stands on the renderer(s): set by the renderer the first time it tries to build the pipeline.
#[derive(Clone, Debug, PartialEq)]
pub enum ShaderStatus {
    /// Not seen by a renderer yet (or never registered).
    Pending,
    /// The pipeline was built: quads painted with it are drawn.
    Ready,
    /// The pipeline could not be built (message); quads painted with it draw nothing. The app should use its fallback.
    Failed(String),
}

#[derive(Default)]
struct Registry { sources: Vec<(ShaderId, Arc<ShaderSource>)>, status: Vec<(ShaderId, ShaderStatus)> }

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Registers (or replaces) a shader. Call once at app start; renderers build pipelines lazily.
pub fn register_shader(id: ShaderId, source: ShaderSource) {
    let mut r = registry().lock().unwrap();
    r.sources.retain(|(i, _)| *i != id);
    r.sources.push((id, Arc::new(source)));
    r.status.retain(|(i, _)| *i != id);
}

/// The source registered for `id` (renderers).
pub fn shader_source(id: ShaderId) -> Option<Arc<ShaderSource>> {
    registry().lock().unwrap().sources.iter().find(|(i, _)| *i == id).map(|(_, s)| s.clone())
}

/// What the renderer made of `id` so far (apps: decide between the shader and a fallback).
pub fn shader_status(id: ShaderId) -> ShaderStatus {
    registry().lock().unwrap().status.iter().find(|(i, _)| *i == id).map(|(_, s)| s.clone()).unwrap_or(ShaderStatus::Pending)
}

/// Records the outcome of building `id`'s pipeline (renderers).
pub fn set_shader_status(id: ShaderId, status: ShaderStatus) {
    let mut r = registry().lock().unwrap();
    r.status.retain(|(i, _)| *i != id);
    r.status.push((id, status));
}

/// Number of floats the renderer puts before the app's own data.
pub const SHADER_HEADER_LEN: usize = 12;

/// A quad drawn by a custom shader.
#[derive(Clone, Debug)]
pub struct ShaderQuad {
    #[allow(missing_docs)]
    pub order: DrawOrder,
    #[allow(missing_docs)]
    pub bounds: Bounds<ScaledPixels>,
    #[allow(missing_docs)]
    pub content_mask: ContentMask<ScaledPixels>,
    #[allow(missing_docs)]
    pub shader: ShaderId,
    /// Seconds since the first shader quad was painted in this process.
    pub time: f32,
    /// The app's floats, passed after the header.
    pub data: Arc<[f32]>,
}

impl ShaderQuad {
    /// The flat float array the shader reads (`U`): `[bounds x, y, w, h, mask x, y, w, h, time, 0, 0, 0, ..data]`, all in
    /// device pixels. Both renderers upload exactly this.
    pub fn pack(&self) -> Vec<f32> {
        let (b, m) = (&self.bounds, &self.content_mask.bounds);
        let mut out = Vec::with_capacity(SHADER_HEADER_LEN + self.data.len());
        out.extend_from_slice(&[b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0, m.origin.x.0, m.origin.y.0, m.size.width.0, m.size.height.0, self.time, 0.0, 0.0, 0.0]);
        out.extend_from_slice(&self.data);
        out
    }
}

impl From<ShaderQuad> for Primitive {
    fn from(q: ShaderQuad) -> Self { Primitive::ShaderQuad(q) }
}

/// Seconds since the first call (the clock handed to shaders).
pub fn shader_clock() -> f32 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f32()
}

impl Window {
    /// Paints a quad of `bounds` with the custom shader `shader` and the app's floats `data` (see [`ShaderQuad::pack`]).
    pub fn paint_shader_quad(&mut self, bounds: Bounds<Pixels>, shader: ShaderId, data: Arc<[f32]>) {
        self.invalidator.debug_assert_paint();
        let quad = ShaderQuad { order: 0, bounds: self.snap_bounds(bounds), content_mask: self.snapped_content_mask(), shader, time: shader_clock(), data };
        self.next_frame.scene.insert_primitive(quad);
    }
}

/// An element that fills its bounds with the custom shader `shader`. `data` runs at paint time (so it can read the clock and
/// ask for the next animation frame) and returns the app's floats.
pub fn shader_quad(shader: ShaderId, data: impl FnOnce(Bounds<Pixels>, &mut Window) -> Arc<[f32]> + 'static) -> Canvas<()> {
    canvas(|_, _, _| (), move |bounds, _, window, _| { let d = data(bounds, window); window.paint_shader_quad(bounds, shader, d); })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{point, size};

    fn quad(data: &[f32]) -> ShaderQuad {
        let b = Bounds { origin: point(ScaledPixels(10.0), ScaledPixels(20.0)), size: size(ScaledPixels(300.0), ScaledPixels(200.0)) };
        ShaderQuad { order: 0, bounds: b, content_mask: ContentMask { bounds: b }, shader: ShaderId(7), time: 1.5, data: data.into() }
    }

    #[test]
    fn uniforms_are_packed_header_then_app_floats() {
        let u = quad(&[0.25, 0.5]).pack();
        assert_eq!(u.len(), SHADER_HEADER_LEN + 2);
        assert_eq!(&u[..9], &[10.0, 20.0, 300.0, 200.0, 10.0, 20.0, 300.0, 200.0, 1.5]);
        assert_eq!(&u[SHADER_HEADER_LEN..], &[0.25, 0.5]);
    }

    #[test]
    fn registry_tracks_sources_and_status() {
        let id = ShaderId(0xBEEF);
        assert_eq!(shader_status(id), ShaderStatus::Pending);
        assert!(shader_source(id).is_none());
        register_shader(id, ShaderSource { wgsl: "a", msl: "b" });
        assert_eq!(shader_source(id).unwrap().wgsl, "a");
        set_shader_status(id, ShaderStatus::Failed("x".into()));
        assert_eq!(shader_status(id), ShaderStatus::Failed("x".into()));
        register_shader(id, ShaderSource { wgsl: "c", msl: "d" });
        assert_eq!(shader_status(id), ShaderStatus::Pending, "a new source is tried again");
        assert_eq!(shader_source(id).unwrap().msl, "d");
    }
}
