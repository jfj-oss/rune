//! The window frame the app draws itself (client-side decorations, Linux): a soft shadow, a faint light edge, a dark band, and the app
//! inside it with ROUNDED INNER CORNERS, plus the glossy traffic lights at the left end of the app's top row, drag / double-click /
//! right-click on empty top-row space, and resizing from every edge and corner. macOS keeps its own traffic lights (the row only
//! leaves room for them); maximized or tiled windows get no band, edge, shadow or round corners.
use crate::theme::*;
use gpui_kit::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// Transparent margin around the frame that holds the shadow (also the client inset reported to the compositor).
pub const SHADOW: f32 = 20.;
/// The dark band around the content.
pub const BAND: f32 = 4.;
/// Radius of the content's (inner) corners; the band's outer corners are `INNER_R + BAND`.
pub const INNER_R: f32 = 20.;
/// The faint light edge just outside the band.
pub const EDGE: f32 = 1.;
const HIT: f32 = 5.;
/// Ball size, and the space between balls (logical px).
pub const BALL: f32 = 14.;
pub const BALL_GAP: f32 = 5.;
/// The image box is a little bigger than the ball (the art leaves a margin: ball = 22.8 / 24 of the box).
const BOX: f32 = BALL * 24. / 22.8;
pub const LIGHTS_LEFT: f32 = 14.;

pub const BAND_FOCUSED: u32 = 0x151515;
pub const BAND_UNFOCUSED: u32 = 0x121212;

/// Is the app framed right now (client-decorated and not maximized, fullscreen or tiled)?
pub fn framed(window: &Window) -> bool {
    match window.window_decorations() {
        Decorations::Client { tiling } => !(window.is_maximized() || window.is_fullscreen() || tiling.top || tiling.bottom || tiling.left || tiling.right),
        Decorations::Server => false,
    }
}

/// Is the window client-decorated at all (so it draws the traffic lights itself)?
pub fn client(window: &Window) -> bool { matches!(window.window_decorations(), Decorations::Client { .. }) }

/// Space between the window's edge and the content: shadow + edge + band while framed, nothing otherwise.
pub fn inset(window: &Window) -> f32 { if framed(window) { SHADOW + BAND } else { 0. } }

/// The content area's size (the window's size minus the frame). Pages lay themselves out in this.
pub fn content_size(window: &Window) -> Size<Pixels> {
    let v = window.viewport_size();
    let i = px(inset(window) * 2.);
    size((v.width - i).max(px(0.)), (v.height - i).max(px(0.)))
}

static ROUND: AtomicU32 = AtomicU32::new(0);
/// The current inner corner radius of the content (0 when square); set by [`Root`] each frame, read by whatever touches a corner.
pub fn round() -> f32 { f32::from_bits(ROUND.load(Ordering::Relaxed)) }
fn set_round(r: f32) -> bool { let old = ROUND.swap(r.to_bits(), Ordering::Relaxed); old != r.to_bits() }

/// A rounded-corner helper for things that touch the content's corners: the corners (bits as the shader hook: 1 TL, 2 TR, 4 BR, 8 BL).
pub fn corner_bits(tl: bool, tr: bool, br: bool, bl: bool) -> u32 { (tl as u32) | ((tr as u32) << 1) | ((br as u32) << 2) | ((bl as u32) << 3) }

// ---------------------------------------------------------------------------------------------------------- traffic lights

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind { Close, Minimize, Maximize }
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Look { Normal, Hover, Pressed, Backdrop }

fn svg_source(k: Kind, l: Look) -> &'static str {
    match (k, l) {
        (Kind::Close, Look::Normal) => include_str!("../assets/titlebar/close-normal.svg"),
        (Kind::Close, Look::Hover) => include_str!("../assets/titlebar/close-hover.svg"),
        (Kind::Close, Look::Pressed) => include_str!("../assets/titlebar/close-pressed.svg"),
        (Kind::Close, Look::Backdrop) => include_str!("../assets/titlebar/close-backdrop.svg"),
        (Kind::Minimize, Look::Normal) => include_str!("../assets/titlebar/minimize-normal.svg"),
        (Kind::Minimize, Look::Hover) => include_str!("../assets/titlebar/minimize-hover.svg"),
        (Kind::Minimize, Look::Pressed) => include_str!("../assets/titlebar/minimize-pressed.svg"),
        (Kind::Minimize, Look::Backdrop) => include_str!("../assets/titlebar/minimize-backdrop.svg"),
        (Kind::Maximize, Look::Normal) => include_str!("../assets/titlebar/maximize-normal.svg"),
        (Kind::Maximize, Look::Hover) => include_str!("../assets/titlebar/maximize-hover.svg"),
        (Kind::Maximize, Look::Pressed) => include_str!("../assets/titlebar/maximize-pressed.svg"),
        (Kind::Maximize, Look::Backdrop) => include_str!("../assets/titlebar/maximize-backdrop.svg"),
    }
}

/// Rasterizes one SVG at an exact device size (so it is crisp at any scale); BGRA, premultiplied, as GPUI wants it.
pub fn rasterize(svg: &str, device_px: u32) -> Option<Arc<RenderImage>> {
    let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).ok()?;
    let mut pm = resvg::tiny_skia::Pixmap::new(device_px, device_px)?;
    let s = device_px as f32 / tree.size().width();
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(s, s), &mut pm.as_mut());
    let mut data = pm.take();
    for p in data.chunks_exact_mut(4) { p.swap(0, 2); }
    let img = image::RgbaImage::from_raw(device_px, device_px, data)?;
    Some(Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(img)])))
}

thread_local! { static BALLS: RefCell<HashMap<(Kind, Look, u32), Option<Arc<RenderImage>>>> = RefCell::new(HashMap::new()); }

fn ball(k: Kind, l: Look, device_px: u32) -> Option<Arc<RenderImage>> {
    BALLS.with(|m| m.borrow_mut().entry((k, l, device_px)).or_insert_with(|| rasterize(svg_source(k, l), device_px)).clone())
}

fn ball_img(k: Kind, l: Look, scale: f32) -> impl IntoElement {
    let dev = (BOX * scale).round().max(1.) as u32;
    // sized to a whole number of device pixels, so the picture is never resampled
    let logical = dev as f32 / scale;
    match ball(k, l, dev) {
        Some(i) => img(i).absolute().top_0().left_0().w(px(logical)).h(px(logical)).into_any_element(),
        None => div().into_any_element(),
    }
}

/// One traffic light: the ball in its four looks, stacked; hover and pressed show on top.
fn light(k: Kind, id: &'static str, focused: bool, scale: f32, on_click: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let g: SharedString = format!("tl-{id}").into();
    let base = if focused { Look::Normal } else { Look::Backdrop };
    div().id(id).group(g.clone()).relative().flex_none().size(px(BOX)).cursor_pointer()
        .role(Role::Button).aria_label(match k { Kind::Close => "Close", Kind::Minimize => "Minimize", Kind::Maximize => "Maximize" })
        .child(ball_img(k, base, scale))
        .child(div().absolute().top_0().left_0().size_full().opacity(0.).group_hover(g.clone(), |s| s.opacity(1.)).child(ball_img(k, Look::Hover, scale)))
        .child(div().id(SharedString::from(format!("{id}-down"))).absolute().top_0().left_0().size_full().opacity(0.).group_active(g.clone(), |s| s.opacity(1.)).child(ball_img(k, Look::Pressed, scale)))
        // the bar's drag must not start from a ball
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| { cx.stop_propagation(); on_click(window, cx) })
}

/// The three glossy lights, close, minimize, maximize. `close` runs the app's own close path (it remembers the window first).
pub fn traffic_lights(window: &Window, close: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let focused = window.is_window_active();
    let scale = window.scale_factor();
    div().flex().flex_row().items_center().gap(px(BALL_GAP - (BOX - BALL) + 0.)).flex_none()
        .child(light(Kind::Close, "tl-close", focused, scale, close))
        .child(light(Kind::Minimize, "tl-min", focused, scale, |window, _| window.minimize_window()))
        .child(light(Kind::Maximize, "tl-max", focused, scale, |window, _| window.zoom_window()))
}

/// Width the lights take at the left of the row (so the row can leave room on macOS, where the system draws them).
pub fn lights_width() -> f32 { LIGHTS_LEFT + 3. * BOX + 2. * (BALL_GAP - (BOX - BALL)) }

// ---------------------------------------------------------------------------------------------------------- the bar's behaviour

/// Makes `d` (a top-row element) a window-drag handle: drag moves the window, double click maximizes / restores, right click opens the
/// window menu. Interactive children must stop the mouse-down (the lights and buttons do) so they are not drag handles.
pub fn bar_behaviour(d: Stateful<Div>, key: &'static str, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    let state = window.use_keyed_state(key, cx, |_, _| false);
    let (s1, s2, s3) = (state.clone(), state.clone(), state.clone());
    d.on_mouse_down(MouseButton::Left, move |_, _, cx| { s1.update(cx, |v, _| *v = true); })
        .on_mouse_up(MouseButton::Left, move |_, _, cx| { s2.update(cx, |v, _| *v = false); })
        .on_mouse_move(move |_, window, cx| {
            if s3.update(cx, |v, _| std::mem::replace(v, false)) { window.start_window_move(); }
        })
        .on_click(|ev, window, _| { if ev.click_count() == 2 { window.zoom_window(); } })
        .on_mouse_down(MouseButton::Right, |ev, window, _| { if client(window) { window.show_window_menu(ev.position); } })
}

// ---------------------------------------------------------------------------------------------------------- the frame

fn cursor_for(edge: ResizeEdge) -> CursorStyle {
    match edge {
        ResizeEdge::Top | ResizeEdge::Bottom => CursorStyle::ResizeUpDown,
        ResizeEdge::Left | ResizeEdge::Right => CursorStyle::ResizeLeftRight,
        ResizeEdge::TopLeft | ResizeEdge::BottomRight => CursorStyle::ResizeUpLeftDownRight,
        ResizeEdge::TopRight | ResizeEdge::BottomLeft => CursorStyle::ResizeUpRightDownLeft,
    }
}

/// Which resize edge (if any) a window position is on: a band of `HIT` px to each side of the frame's outer edge.
pub fn resize_edge(pos: Point<Pixels>, win: Size<Pixels>, framed: bool) -> Option<ResizeEdge> {
    // the grab band runs along the visible frame; unframed windows (never client-decorated resizing) have none
    if !framed { return None; }
    let (x, y, w, h) = (f32::from(pos.x), f32::from(pos.y), f32::from(win.width), f32::from(win.height));
    let (l, t, r, b) = (SHADOW, SHADOW, w - SHADOW, h - SHADOW);
    let on_l = (x - l).abs() <= HIT && y >= t - HIT && y <= b + HIT;
    let on_r = (x - r).abs() <= HIT && y >= t - HIT && y <= b + HIT;
    let on_t = (y - t).abs() <= HIT && x >= l - HIT && x <= r + HIT;
    let on_b = (y - b).abs() <= HIT && x >= l - HIT && x <= r + HIT;
    // the corner zones are bigger (a rounded corner is hard to hit)
    let c = 16.;
    let near_l = x >= l - HIT && x <= l + c;
    let near_r = x <= r + HIT && x >= r - c;
    let near_t = y >= t - HIT && y <= t + c;
    let near_b = y <= b + HIT && y >= b - c;
    if (on_t || on_l) && near_t && near_l { return Some(ResizeEdge::TopLeft); }
    if (on_t || on_r) && near_t && near_r { return Some(ResizeEdge::TopRight); }
    if (on_b || on_l) && near_b && near_l { return Some(ResizeEdge::BottomLeft); }
    if (on_b || on_r) && near_b && near_r { return Some(ResizeEdge::BottomRight); }
    if on_t { Some(ResizeEdge::Top) } else if on_b { Some(ResizeEdge::Bottom) } else if on_l { Some(ResizeEdge::Left) } else if on_r { Some(ResizeEdge::Right) } else { None }
}

fn zones(win: Size<Pixels>) -> Vec<AnyElement> {
    let (w, h) = (f32::from(win.width), f32::from(win.height));
    let (l, t, r, b) = (SHADOW, SHADOW, w - SHADOW, h - SHADOW);
    let c = 16.;
    let z = |edge: ResizeEdge, x: f32, y: f32, zw: f32, zh: f32| div().absolute().left(px(x)).top(px(y)).w(px(zw)).h(px(zh)).cursor(cursor_for(edge)).into_any_element();
    vec![
        z(ResizeEdge::Top, l - HIT, t - HIT, r - l + 2. * HIT, 2. * HIT),
        z(ResizeEdge::Bottom, l - HIT, b - HIT, r - l + 2. * HIT, 2. * HIT),
        z(ResizeEdge::Left, l - HIT, t - HIT, 2. * HIT, b - t + 2. * HIT),
        z(ResizeEdge::Right, r - HIT, t - HIT, 2. * HIT, b - t + 2. * HIT),
        z(ResizeEdge::TopLeft, l - HIT, t - HIT, c + HIT, c + HIT),
        z(ResizeEdge::TopRight, r - c, t - HIT, c + HIT, c + HIT),
        z(ResizeEdge::BottomLeft, l - HIT, b - c, c + HIT, c + HIT),
        z(ResizeEdge::BottomRight, r - c, b - c, c + HIT, c + HIT),
    ]
}

/// The window's root view: the page colour, the backdrop, and the app on top, inside the frame. The app view is CACHED, so a frame of the
/// animated backdrop does not rebuild the whole app (GPUI replays the app's last frame unless the app itself changed).
pub fn frame(window: &mut Window, cx: &mut App, rune: &Entity<crate::rune::Rune>, backdrop: &Entity<crate::backdrop::Backdrop>) -> AnyElement {
    let mut full = StyleRefinement::default();
    full.size.width = Some(relative(1.).into());
    full.size.height = Some(relative(1.).into());
    let app = AnyView::from(rune.clone()).cached(full).into_any_element();
    let bare = crate::backdrop::bare();
    let content = |bd: AnyElement, app: AnyElement| -> Div {
        if bare { div().relative().size_full().bg(c(BG)).rounded(px(round())).child(bd).child(div().absolute().top_0().left_0().size(px(0.)).overflow_hidden().child(app)) }
        else { div().relative().size_full().bg(c(BG)).rounded(px(round())).child(bd).child(app) }
    };
    let framed = framed(window);
    // the radius things at the corners round to; the app re-renders when it changes (a maximize, a restore)
    let want = if framed { INNER_R } else { 0. };
    if set_round(want) { rune.update(cx, |_, cx| cx.notify()); }
    if !client(window) || !framed {
        if client(window) {
            // maximized / tiled: keep the platform inset stable like gpui-component does, draw nothing around the content
            window.set_client_inset(px(SHADOW));
            window.set_client_corner_radii(Corners::default());
        }
        return content(backdrop.clone().into_any_element(), app).into_any_element();
    }
    window.set_client_inset(px(SHADOW));
    window.set_client_corner_radii(Corners::all(px(INNER_R + BAND)));
    let active = window.is_window_active();
    let band = c(if active { BAND_FOCUSED } else { BAND_UNFOCUSED });
    let edge = wh(if active { 0.15 } else { 0.10 });
    let win = window.window_bounds().get_bounds().size;
    let ro = INNER_R + BAND;
    let shadow_a = if active { 1.0 } else { 0.7 };
    let shadow = |blur: f32, a: f32, dy: f32| BoxShadow { color: Hsla { h: 0., s: 0., l: 0., a: a * shadow_a }, blur_radius: px(blur), spread_radius: px(0.), offset: point(px(0.), px(dy)), inset: false };
    div().id("rune-frame").relative().size_full().bg(gpui_kit::transparent_black())
        .on_mouse_down(MouseButton::Left, move |_, window, _| {
            if !window.is_resizable() { return; }
            let size = window.window_bounds().get_bounds().size;
            if let Some(edge) = resize_edge(window.mouse_position(), size, framed) { window.start_window_resize(edge); }
        })
        // the soft shadow + the band (outer rounded rect)
        .child(div().absolute().left(px(SHADOW)).top(px(SHADOW)).right(px(SHADOW)).bottom(px(SHADOW)).rounded(px(if std::env::var_os("RUNE_FRAME_SQUARE").is_some() { 0. } else { ro })).bg(if std::env::var_os("RUNE_FRAME_NOBAND").is_some() { gpui_kit::transparent_black() } else { band })
            .shadow(if std::env::var_os("RUNE_FRAME_NOSHADOW").is_some() { vec![] } else { vec![shadow(10., 0.22, 2.), shadow(3., 0.18, 1.)] }))
        // the faint light edge, just outside the band
        .children((std::env::var_os("RUNE_FRAME_NOEDGE").is_none()).then(|| div().absolute().left(px(SHADOW - EDGE)).top(px(SHADOW - EDGE)).right(px(SHADOW - EDGE)).bottom(px(SHADOW - EDGE)).rounded(px(ro + EDGE)).border(px(EDGE)).border_color(edge)))
        // the content, inside the band, its corners rounded (the backdrop and whatever touches a corner round themselves)
        .child(div().absolute().left(px(SHADOW + BAND)).top(px(SHADOW + BAND)).right(px(SHADOW + BAND)).bottom(px(SHADOW + BAND)).cursor(CursorStyle::default())
            .child(content(backdrop.clone().into_any_element(), app)))
        .child(div().absolute().size_full().children(zones(win)))
        .into_any_element()
}
