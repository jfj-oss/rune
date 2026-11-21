//! RUNE PATCH (see native/desktop/vendor/PATCH.md): draws gpui's `ShaderQuad` primitives with app-registered WGSL shaders.
//!
//! Each registered shader (`gpui::register_shader`) becomes one render pipeline, built the first time a quad that uses it is
//! drawn. The pipeline reuses gpui's own bind group layouts: group 0 is the globals (viewport, alpha mode), group 1 one storage
//! buffer holding the quad's packed floats (`ShaderQuad::pack`). The vertex stage (a quad covering the bounds clipped to the
//! content mask) is part of the prelude below; the app only writes `fn custom_fs(pos: vec2<f32>) -> vec4<f32>`.

use collections::FxHashMap;
use gpui::{ShaderId, ShaderQuad, ShaderStatus};

/// WGSL put in front of the app's fragment source.
pub(crate) const PRELUDE: &str = r#"
struct GlobalParams {
    viewport_size: vec2<f32>,
    premultiplied_alpha: u32,
    pad: u32,
}
@group(0) @binding(0) var<uniform> globals: GlobalParams;
@group(1) @binding(0) var<storage, read> U: array<f32>;

// the app's own floats start after the 12-float header (bounds, content mask, time)
fn ud(i: u32) -> f32 { return U[12u + i]; }

struct CustomVarying {
    @builtin(position) position: vec4<f32>,
}

@vertex
fn vs_custom(@builtin(vertex_index) vertex_id: u32) -> CustomVarying {
    let unit_vertex = vec2<f32>(f32(vertex_id & 1u), 0.5 * f32(vertex_id & 2u));
    let origin = vec2<f32>(U[0], U[1]);
    let size = vec2<f32>(U[2], U[3]);
    let mask_origin = vec2<f32>(U[4], U[5]);
    let mask_size = vec2<f32>(U[6], U[7]);
    let lo = max(origin, mask_origin);
    let hi = min(origin + size, mask_origin + mask_size);
    let position = mix(lo, hi, unit_vertex);
    var out = CustomVarying();
    out.position = vec4<f32>(position / globals.viewport_size * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    return out;
}

// RUNE PATCH: coverage of the rounded rect of the quad's bounds (radius U[9] in device px, corner bits U[10]); 1 for radius 0
fn rune_round_cover(p: vec2<f32>) -> f32 {
    let r = U[9];
    if (r <= 0.0) { return 1.0; }
    let k = u32(U[10] + 0.5);
    let lo = vec2<f32>(U[0], U[1]);
    let hi = lo + vec2<f32>(U[2], U[3]);
    var cov = 1.0;
    let left = p.x < lo.x + r;
    let right = p.x > hi.x - r;
    let top = p.y < lo.y + r;
    let bottom = p.y > hi.y - r;
    var centre = vec2<f32>(0.0, 0.0);
    var hit = false;
    if (top && left && (k & 1u) != 0u) { centre = lo + vec2<f32>(r, r); hit = true; }
    if (top && right && (k & 2u) != 0u) { centre = vec2<f32>(hi.x - r, lo.y + r); hit = true; }
    if (bottom && right && (k & 4u) != 0u) { centre = hi - vec2<f32>(r, r); hit = true; }
    if (bottom && left && (k & 8u) != 0u) { centre = vec2<f32>(lo.x + r, hi.y - r); hit = true; }
    if (hit) { cov = clamp(0.5 - (length(p - centre) - r), 0.0, 1.0); }
    return cov;
}

@fragment
fn fs_custom(input: CustomVarying) -> @location(0) vec4<f32> {
    var c = custom_fs(input.position.xy);
    c.a = c.a * rune_round_cover(input.position.xy);
    let m = select(1.0, c.a, globals.premultiplied_alpha != 0u);
    return vec4<f32>(c.rgb * m, c.a);
}
"#;

/// Pipelines of the app's shaders and the buffers the quads' floats are uploaded to.
#[derive(Default)]
pub(crate) struct CustomShaders {
    /// `None`: this shader failed to build (reported through `gpui::set_shader_status`; its quads draw nothing).
    pipelines: FxHashMap<(ShaderId, bool), Option<wgpu::RenderPipeline>>,
    buffers: Vec<(wgpu::Buffer, u64)>,
}

impl CustomShaders {
    pub(crate) fn pipeline_ref(&self, id: ShaderId, premultiplied: bool) -> Option<&Option<wgpu::RenderPipeline>> {
        self.pipelines.get(&(id, premultiplied))
    }

    pub(crate) fn forget_pipelines(&mut self) {
        self.pipelines.clear();
    }

    /// The pipeline for `id` (built on first use), or `None` when it is unknown or failed.
    pub(crate) fn pipeline(
        &mut self,
        device: &wgpu::Device,
        instances_layout: &wgpu::BindGroupLayout,
        globals_layout: &wgpu::BindGroupLayout,
        target: wgpu::ColorTargetState,
        premultiplied: bool,
        id: ShaderId,
    ) -> Option<&wgpu::RenderPipeline> {
        self.pipelines
            .entry((id, premultiplied))
            .or_insert_with(|| match build(device, instances_layout, globals_layout, target, id) {
                Ok(p) => {
                    gpui::set_shader_status(id, ShaderStatus::Ready);
                    Some(p)
                }
                Err(e) => {
                    log::error!("custom shader {id:?}: {e}");
                    gpui::set_shader_status(id, ShaderStatus::Failed(e));
                    None
                }
            })
            .as_ref()
    }

    /// Uploads the packed floats of `quad` into the `index`-th buffer of this frame and returns it.
    pub(crate) fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, index: usize, quad: &ShaderQuad) -> &wgpu::Buffer {
        let floats = quad.pack();
        let bytes: &[u8] = bytemuck::cast_slice(&floats);
        let need = (bytes.len() as u64).next_power_of_two().max(256);
        if index >= self.buffers.len() || self.buffers[index].1 < need {
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("custom_shader_data"),
                size: need,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            if index >= self.buffers.len() {
                self.buffers.push((buffer, need));
            } else {
                self.buffers[index] = (buffer, need);
            }
        }
        queue.write_buffer(&self.buffers[index].0, 0, bytes);
        &self.buffers[index].0
    }
}

fn build(
    device: &wgpu::Device,
    instances_layout: &wgpu::BindGroupLayout,
    globals_layout: &wgpu::BindGroupLayout,
    target: wgpu::ColorTargetState,
    id: ShaderId,
) -> Result<wgpu::RenderPipeline, String> {
    let source = gpui::shader_source(id).ok_or_else(|| "shader not registered".to_string())?;
    let wgsl = format!("{PRELUDE}\n{}", source.wgsl);
    // validate first: a broken shader must be an error for the app, not a device panic
    let module = wgpu::naga::front::wgsl::parse_str(&wgsl).map_err(|e| e.emit_to_string(&wgsl))?;
    wgpu::naga::valid::Validator::new(wgpu::naga::valid::ValidationFlags::all(), wgpu::naga::valid::Capabilities::empty())
        .validate(&module)
        .map_err(|e| format!("{e:?}"))?;
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("custom_shader"), source: wgpu::ShaderSource::Wgsl(wgsl.into()) });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("custom_shader_layout"),
        bind_group_layouts: &[Some(globals_layout), Some(instances_layout)],
        immediate_size: 0,
    });
    Ok(device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("custom_shader"),
        layout: Some(&layout),
        vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_custom"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_custom"), targets: &[Some(target)], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prelude plus a minimal fragment function is valid WGSL (what an app's shader is checked against at build time).
    #[test]
    fn prelude_with_a_trivial_shader_is_valid_wgsl() {
        let wgsl = format!("{PRELUDE}\nfn custom_fs(pos: vec2<f32>) -> vec4<f32> {{ return vec4<f32>(ud(0u), pos.x * 0.0, 0.0, 1.0); }}");
        let module = wgpu::naga::front::wgsl::parse_str(&wgsl).expect("parses");
        wgpu::naga::valid::Validator::new(wgpu::naga::valid::ValidationFlags::all(), wgpu::naga::valid::Capabilities::empty()).validate(&module).expect("validates");
    }
}
