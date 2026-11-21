//! Tests of the GPUI shader hook (vendor/PATCH.md): uniform packing, scene ordering and clearing, the registry.
#![cfg(test)]
use gpui_kit::{point, register_shader, set_shader_status, shader_source, shader_status, size, Bounds, ContentMask, PrimitiveBatch, Quad, ScaledPixels, Scene, ShaderId, ShaderQuad, ShaderSource, ShaderStatus, SHADER_HEADER_LEN};
use std::sync::Arc;

fn rect(x: f32, w: f32) -> Bounds<ScaledPixels> { Bounds { origin: point(ScaledPixels(x), ScaledPixels(0.0)), size: size(ScaledPixels(w), ScaledPixels(50.0)) } }
fn shader_quad_at(b: Bounds<ScaledPixels>, mask: Bounds<ScaledPixels>, data: &[f32]) -> ShaderQuad {
    ShaderQuad { order: 0, bounds: b, content_mask: ContentMask { bounds: mask }, shader: ShaderId(7), time: 1.5, round: [0.0, 0.0], data: Arc::from(data.to_vec()) }
}

#[test]
fn uniforms_are_packed_header_then_app_floats() {
    let b = Bounds { origin: point(ScaledPixels(10.0), ScaledPixels(20.0)), size: size(ScaledPixels(300.0), ScaledPixels(200.0)) };
    let u = shader_quad_at(b, b, &[0.25, 0.5]).pack();
    assert_eq!(u.len(), SHADER_HEADER_LEN + 2);
    assert_eq!(&u[..9], &[10.0, 20.0, 300.0, 200.0, 10.0, 20.0, 300.0, 200.0, 1.5]);
    assert_eq!(&u[9..SHADER_HEADER_LEN], &[0.0, 0.0, 0.0], "square: no rounding in the header");
    assert_eq!(&u[SHADER_HEADER_LEN..], &[0.25, 0.5]);
}

#[test]
fn shader_quads_are_ordered_with_the_other_primitives_and_cleared_with_the_scene() {
    let b = rect(0.0, 50.0);
    let plain = || Quad { bounds: b, content_mask: ContentMask { bounds: b }, ..Default::default() };
    let mut scene = Scene::default();
    scene.insert_primitive(plain());
    scene.insert_primitive(shader_quad_at(b, b, &[1.0]));
    scene.insert_primitive(plain());
    scene.finish();
    let kinds: Vec<String> = scene.batches().map(|b| match b { PrimitiveBatch::Quads(r) => format!("quads {}", r.len()), PrimitiveBatch::ShaderQuads(r) => format!("shader {}", r.len()), _ => "other".into() }).collect();
    assert_eq!(kinds, ["quads 1", "shader 1", "quads 1"], "painted in order and overlapping: the shader quad sits between the two quads");
    assert_eq!(scene.shader_quads[0].data[0], 1.0);
    // a quad clipped away entirely is not recorded
    let mut empty = Scene::default();
    empty.insert_primitive(shader_quad_at(b, rect(900.0, 5.0), &[]));
    assert!(empty.shader_quads.is_empty());
    // the scene is reused every frame: clearing it must clear the shader quads too (they once piled up, one more per frame)
    scene.clear();
    assert!(scene.shader_quads.is_empty() && scene.quads.is_empty());
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

#[test]
fn rounded_corners_ride_in_the_header() {
    let b = rect(0.0, 100.0);
    let mut q = shader_quad_at(b, b, &[]);
    q.round = [20.0, 15.0];
    let u = q.pack();
    assert_eq!(&u[9..12], &[20.0, 15.0, 0.0]);
}
