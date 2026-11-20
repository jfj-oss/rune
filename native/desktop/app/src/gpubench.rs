//! Not part of the app: an ignored test that runs the foil WGSL shader on the GPU headless (no window), saves the frame and
//! times it. Used to measure the GPU time per frame and to compare the GPU picture with the CPU one without a compositor.
//!
//!   RUNE_FOIL_DATA=/tmp/d.bin RUNE_FOIL_W=3840 RUNE_FOIL_H=2160 RUNE_FOIL_SCALE=2 RUNE_FOIL_T=4 cargo test dump_gpu_data -- --ignored
//!   RUNE_SHADER_DATA=/tmp/d.bin RUNE_SHADER_W=3840 RUNE_SHADER_H=2160 [RUNE_SHADER_OUT=/tmp/o.png] cargo test --release gpu_frame_time -- --ignored --nocapture
#![cfg(all(test, target_os = "linux"))]

/// The hook's WGSL prelude as the renderer builds it (kept in step with vendor/gpui-pre-wgpu-0.3.12/src/custom_shader.rs, but the
/// vertex stage here is a plain full-target quad).
const PRELUDE: &str = r#"
struct GlobalParams { viewport_size: vec2<f32>, premultiplied_alpha: u32, pad: u32, }
@group(0) @binding(0) var<uniform> globals: GlobalParams;
@group(1) @binding(0) var<storage, read> U: array<f32>;
fn ud(i: u32) -> f32 { return U[12u + i]; }
struct CustomVarying { @builtin(position) position: vec4<f32>, }
@vertex fn vs_custom(@builtin(vertex_index) vid: u32) -> CustomVarying {
    let unit_vertex = vec2<f32>(f32(vid & 1u), 0.5 * f32(vid & 2u));
    var out = CustomVarying();
    out.position = vec4<f32>(mix(vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), unit_vertex), 0.0, 1.0);
    return out;
}
@fragment fn fs_custom(input: CustomVarying) -> @location(0) vec4<f32> { return custom_fs(input.position.xy); }
"#;

#[test]
#[ignore]
fn gpu_frame_time() {
    use wgpu::util::DeviceExt;
    let Some(data_path) = std::env::var_os("RUNE_SHADER_DATA") else { return };
    let e = |k: &str| std::env::var(k).unwrap().parse::<u32>().unwrap();
    let (w, h) = (e("RUNE_SHADER_W"), e("RUNE_SHADER_H"));
    let floats: Vec<f32> = std::fs::read(data_path).unwrap().chunks(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut u = vec![0.0f32; 12];
    u[2] = w as f32; u[3] = h as f32; u[6] = w as f32; u[7] = h as f32;
    u.extend(floats);
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).expect("adapter");
    println!("adapter: {}", adapter.get_info().name);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let wgsl = format!("{PRELUDE}\n{}", include_str!("shaders/foil.wgsl"));
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(wgsl.into()) });
    let storage_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None }] });
    let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }] });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&globals_layout), Some(&storage_layout)], immediate_size: 0 });
    let format = wgpu::TextureFormat::Bgra8Unorm;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None, layout: Some(&layout),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_custom"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_custom"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
        depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let globals = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck_cast(&[w as f32, h as f32, 0.0, 0.0]), usage: wgpu::BufferUsages::UNIFORM });
    let storage = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck_cast(&u), usage: wgpu::BufferUsages::STORAGE });
    let g_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &globals_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() }] });
    let s_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &storage_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: storage.as_entire_binding() }] });
    let tex = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let view = tex.create_view(&Default::default());
    let frame = |n: usize| {
        let mut enc = device.create_command_encoder(&Default::default());
        for _ in 0..n {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, ..Default::default() });
            pass.set_pipeline(&pipeline); pass.set_bind_group(0, &g_bg, &[]); pass.set_bind_group(1, &s_bg, &[]); pass.draw(0..4, 0..1);
        }
        queue.submit([enc.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    };
    frame(3);
    let n = 60;
    let t0 = std::time::Instant::now();
    frame(n);
    println!("{w}x{h}: {:?} GPU time per frame of the foil shader ({n} frames in one submission)", t0.elapsed() / n as u32);
    if let Some(out) = std::env::var_os("RUNE_SHADER_OUT") {
        let bpr = (w * 4).next_multiple_of(256);
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (bpr * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(tex.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: None } }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        queue.submit([enc.finish()]);
        buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let m = buf.slice(..).get_mapped_range().unwrap();
        let mut img = image::RgbaImage::new(w, h);
        for y in 0..h { for x in 0..w { let i = (y * bpr + x * 4) as usize; img.put_pixel(x, y, image::Rgba([m[i + 2], m[i + 1], m[i], 255])); } }
        img.save(out).unwrap();
    }
}

fn bytemuck_cast(v: &[f32]) -> &[u8] { unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) } }
