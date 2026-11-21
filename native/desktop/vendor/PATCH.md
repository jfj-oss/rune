# GPUI shader hook: what is patched

`gpui-kit =0.9.1` pins `gpui-pre =0.3.12` (Zed's gpui) and its platform crates. Three of them are vendored here, byte for byte
from crates.io except for the changes below, and wired in `native/desktop/Cargo.toml` with `[patch.crates-io]` (same versions, so
`Cargo.lock` only drops their registry source). Every change is marked `RUNE PATCH` in the code. To carry the patch to another
gpui-pre version: copy the new crates, re-apply these changes (about 400 lines), run
`cargo test -p rune-desktop` and the pixel comparison in `native/desktop/tools`.

The hook: an app registers a fragment shader once (one WGSL source, one MSL source), then paints `ShaderQuad`s with it. A quad is
an ordinary scene primitive (ordered by draw order, clipped by the content mask, batched like quads). The renderer draws it with
the app's pipeline, handing the shader the fragment position in device pixels and one flat `f32` array: 12 header floats (bounds,
content mask, time) followed by the app's own floats.

## gpui-pre-0.3.12 (platform independent)
- `src/custom_shader.rs` (new): `ShaderId`, `ShaderSource { wgsl, msl }`, `register_shader`, `shader_source`, `shader_status` /
  `set_shader_status` (the renderer reports Ready or Failed, the app picks its fallback from it), `ShaderQuad` (+ `pack()`, the
  one place the uniform layout lives), `shader_clock`, `Window::paint_shader_quad`, the `shader_quad(id, data_fn)` element.
  Unit tests: uniform packing, registry and status.
- `src/scene.rs`: `Scene::shader_quads`, `Primitive::ShaderQuad`, `PrimitiveKind::ShaderQuad`, `PrimitiveBatch::ShaderQuads`, one
  arm each in insert/finish/batches/bounds/content_mask/label.
- `src/gpui.rs`: `mod custom_shader; pub use custom_shader::*;`
- `src/window.rs`: `snap_bounds` and `snapped_content_mask` are `pub(crate)` (used by `paint_shader_quad`).
- `Cargo.toml`: the `[[example]]` entries and the `examples/` directory are removed (5 MB, unused).

- Rounded corners (added for the app's own window frame): `ShaderQuad::round` = [radius in device px, corner bits 1 TL / 2 TR /
  4 BR / 8 BL], packed into header slots 9 and 10 (slot 11 stays free), `Window::paint_shader_quad_round`, `shader_quad_round`. Both
  renderers multiply the app shader's alpha by the coverage of the rounded rect of the quad's bounds (radius 0 = untouched).

## gpui-pre-wgpu-0.3.12 (Linux; also what a Windows or web build would use)
- `src/custom_shader.rs` (new): the WGSL prelude (globals, `U`, `ud(i)`, a vertex stage covering the bounds clipped to the content
  mask, `fs_custom` that converts the app's straight RGBA to the surface's alpha mode), `CustomShaders` (pipelines built on first
  use after validating with naga, so a broken shader is a `Failed` status and not a device panic; one storage buffer per quad
  per frame), a test that the prelude is valid WGSL.
- `src/wgpu_renderer.rs`: `WgpuResources::custom` / `custom_target`, `draw_shader_quad`, one match arm in `record_frame`, the
  colour target and alpha mode noted in `render_frame`. Reuses gpui's own bind group layouts (globals at group 0, one storage
  buffer at group 1).
- `src/gpui_wgpu.rs`: `mod custom_shader;`

## gpui-pre-apple-0.3.12 (macOS, iOS: the Metal renderer)
- `src/metal_renderer.rs`: `CUSTOM_SHADER_PRELUDE` / `_SUFFIX` (vertex stage, `rune_round_cover`, `fs_custom` calling the app's
  `float4 custom_fs(float2 pos, constant float* U)`), `custom_pipelines`, `custom_pipeline` (compiles the MSL at runtime with
  `newLibraryWithSource`, so no Metal toolchain is needed at build time), `draw_shader_quad`, one match arm.

## Not patched
- `gpui-pre-windows` (DirectX) matches `PrimitiveBatch` exhaustively, so a Windows build needs one `ShaderQuads(_) => {}` arm (or a
  HLSL port) first. The app falls back to the CPU backdrop whenever a renderer never reports its shader Ready (1.5 s).
- mega (`~/wt/mega-int/app/gpui`) pins the same gpui-kit 0.9.1 and could share this patch: copy `vendor/` and the three
  `[patch.crates-io]` lines.

## Known limits
- One float array per quad, uploaded every frame (the foil sends ~1.3 KB plus a 4 byte per device column table).
- The shader returns straight RGBA; blending is gpui's usual alpha blending.
- Fragment shaders only; no textures, no custom vertex data.
