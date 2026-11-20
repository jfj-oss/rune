//! The panel: one borderless window drawn in Claude Summon's look. Nothing animates; it draws when the state changes
//! and once a second while visible and playing.
use crate::look::{self, c, mmss};
use crate::state::{playlist_dot, status_word, Cover, Mini, ROWS, ROW_H};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::keys::Key;
use rune_mini_core::model::{Repeat, Status};
use rune_mini_core::now_ms;
use std::cell::Cell;
use std::rc::Rc;

pub struct Panel {
    mini: Entity<Mini>,
    focus: FocusHandle,
    bar: Rc<Cell<Bounds<Pixels>>>,
    /// Scroll over "vol": wheel/trackpad travel not yet turned into a step, and the volume we last asked for (ms, value),
    /// so quick notches build on each other instead of on a server echo that has not arrived yet.
    vol_acc: f32,
    vol_sent: Option<(u64, f64)>,
    _sub: Subscription,
}

#[derive(Clone)]
struct DragRow {
    queue_id: String,
    label: String,
}
struct Ghost(String);
impl Render for Ghost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().px_2().py_1().rounded(px(4.)).bg(c(look::BOX)).border_1().border_color(c(look::ACCENT)).text_color(c(look::INK)).font_family(look::MONO).text_size(px(12.)).child(self.0.clone())
    }
}

/// Opens the panel's window; the layer-shell overlay first (no taskbar entry, above everything, centred at the top),
/// an ordinary borderless window where the compositor has none.
pub fn open(mini: &Entity<Mini>, w: f32, h: f32, cx: &mut App) -> Option<AnyWindowHandle> {
    let make = |layer: bool| WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds { origin: point(px(0.), px(0.)), size: size(px(w), px(h)) })),
        titlebar: None,
        focus: true,
        show: true,
        kind: if layer {
            WindowKind::LayerShell(layer_shell::LayerShellOptions {
                namespace: "rune-mini".into(),
                layer: layer_shell::Layer::Overlay,
                anchor: layer_shell::Anchor::TOP,
                exclusive_zone: None,
                exclusive_edge: None,
                margin: Some((px(150.), px(0.), px(0.), px(0.))),
                keyboard_interactivity: layer_shell::KeyboardInteractivity::Exclusive,
            })
        } else {
            WindowKind::Floating
        },
        // Opened opaque and switched to transparent just below: gpui applies transparency only when the setting changes,
        // and a layer-shell surface never gets the decoration event that would apply it (white showed past the round corners).
        window_background: WindowBackgroundAppearance::Opaque,
        is_resizable: false,
        app_id: Some("rune-mini".into()),
        ..Default::default()
    };
    let layer = std::env::var_os("RUNE_MINI_NO_LAYER").is_none();
    for attempt in [layer, false] {
        if !attempt && layer && false {
            continue;
        }
        let m = mini.clone();
        // Opened bare, not through gpui_kit::open_window: its Root wraps every window in a client-decoration frame (a 20 px
        // shadow margin it re-asserts each frame, a border, the theme's light background), which showed around the panel.
        match cx.open_window(make(attempt), move |window, cx| {
            let v = cx.new(|cx| Panel::new(m, window, cx));
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
            let f = v.read(cx).focus.clone();
            window.focus(&f, cx);
            v
        }) {
            Ok(h) => return Some(h.into()),
            Err(e) => eprintln!("rune-mini: window ({}): {e}", if attempt { "layer shell" } else { "plain" }),
        }
        if !layer {
            break;
        }
    }
    None
}

/// Pixels of trackpad travel (or one wheel notch) per volume step.
const VOL_NOTCH: f32 = 24.;
/// How long the panel trusts its own last volume over the server's echo.
const VOL_HOLD_MS: u64 = 1500;

impl Panel {
    fn new(mini: Entity<Mini>, _window: &mut Window, cx: &mut Context<Self>) -> Panel {
        let sub = cx.observe(&mini, |_, _, cx| cx.notify());
        Panel { mini, focus: cx.focus_handle(), bar: Rc::new(Cell::new(Bounds::default())), vol_acc: 0., vol_sent: None, _sub: sub }
    }
}

#[derive(Clone, Copy)]
enum G {
    Prev,
    Next,
    Play,
    Pause,
}

/// Transport glyphs, filled polygons in a unit box (nothing is loaded from disk).
fn glyph(g: G, size_px: f32, color: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |b, _, window, _| {
            let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
            let polys: Vec<Vec<(f32, f32)>> = match g {
                G::Play => vec![vec![(0.28, 0.12), (0.9, 0.5), (0.28, 0.88)]],
                G::Pause => vec![vec![(0.2, 0.14), (0.4, 0.14), (0.4, 0.86), (0.2, 0.86)], vec![(0.6, 0.14), (0.8, 0.14), (0.8, 0.86), (0.6, 0.86)]],
                G::Prev => vec![vec![(0.1, 0.14), (0.24, 0.14), (0.24, 0.86), (0.1, 0.86)], vec![(0.9, 0.14), (0.3, 0.5), (0.9, 0.86)]],
                G::Next => vec![vec![(0.76, 0.14), (0.9, 0.14), (0.9, 0.86), (0.76, 0.86)], vec![(0.1, 0.14), (0.7, 0.5), (0.1, 0.86)]],
            };
            for poly in polys {
                let mut pb = PathBuilder::fill();
                let pts: Vec<Point<Pixels>> = poly.iter().map(|&(x, y)| point(px(ox + x * size_px), px(oy + y * size_px))).collect();
                pb.add_polygon(&pts, true);
                if let Ok(p) = pb.build() {
                    window.paint_path(p, color);
                }
            }
        },
    )
    .size(px(size_px))
}

fn key_of(ev: &KeyDownEvent) -> Key {
    let k = &ev.keystroke;
    Key { name: k.key.to_lowercase(), shift: k.modifiers.shift, cmd: k.modifiers.control || k.modifiers.platform, alt: k.modifiers.alt, text: k.key_char.clone() }
}

/// An event handler that reaches the panel through its entity, so it can be made while the state is borrowed.
fn lst<E: 'static + ?Sized>(me: &Entity<Panel>, f: impl Fn(&mut Panel, &E, &mut Window, &mut Context<Panel>) + 'static) -> impl Fn(&E, &mut Window, &mut App) + 'static {
    let me = me.clone();
    move |e, w, app| me.update(app, |p, cx| f(p, e, w, cx))
}

impl Render for Panel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let m = self.mini.read(cx);
        let now = now_ms();
        let player = m.model.player.as_ref();
        let cur = player.and_then(|p| p.current());
        let online = m.model.online();
        let status = player.map(|p| p.status.clone()).unwrap_or(Status::Stopped);
        let playing = matches!(status, Status::Playing | Status::Loading);

        // ---- the dots on the left edge: one per chosen playlist; a click shuffle-plays it on the zone shown
        let playing_pl = m.model.playing_playlist().map(str::to_string);
        let wide = m.model.minis.len() > 6;
        let mut dots = div().flex().flex_wrap().content_start().flex_none().w(px(if wide { 38. } else { 22. })).pt(px(8.)).gap(px(5.)).justify_center().items_start();
        if m.model.minis.is_empty() {
            // nothing chosen yet: one dim "+" says where to choose
            dots = dots.child(
                div().id("dot-none").w(px(14.)).h(px(14.)).flex().items_center().justify_center().rounded_full().border_1().border_color(c(look::RULE))
                    .font_family(look::MONO).text_size(px(11.)).text_color(c(look::DIM)).child("+")
                    .on_hover(lst(&me, move |this, h: &bool, _, cx| { this.mini.update(cx, |m, cx| { m.hover = if *h { Some("choose playlists in rune \u{2192} Show in rune mini".into()) } else { None }; cx.notify(); }); })),
            );
        }
        for (i, p) in m.model.minis.iter().enumerate() {
            let on = playing_pl.as_deref() == Some(p.id.as_str());
            let label = if i < 8 { format!("{} \u{b7} shift+{}", p.name, i + 1) } else { p.name.clone() };
            dots = dots.child(
                div().id(SharedString::from(format!("dot-{}", p.id))).w(px(14.)).h(px(14.)).flex().items_center().justify_center().cursor_pointer().rounded_full()
                    .when(on, |d| d.border_1().border_color(c(look::INK)))
                    .child(div().size(px(if on { 7. } else { 9. })).rounded_full().bg(playlist_dot(p.color)).opacity(if on { 1. } else { 0.75 }))
                    .hover(|s| s.opacity(1.))
                    .on_hover(lst(&me, move |this, h: &bool, _, cx| { let t = label.clone(); this.mini.update(cx, |m, cx| { m.hover = if *h { Some(t) } else { None }; cx.notify(); }); }))
                    .on_click(lst(&me, move |this, _, _, cx| { this.mini.update(cx, |m, cx| m.play_mini(i, cx)); })),
            );
        }

        // ---- cover
        let cover: AnyElement = match (cur, cur.and_then(|q| m.cover_for(&q.album.id))) {
            (_, Some(Cover::Ready(i))) => img(ImageSource::Render(i.clone())).size(px(84.)).rounded(px(6.)).object_fit(ObjectFit::Cover).into_any_element(),
            _ => div().size(px(84.)).rounded(px(6.)).bg(c(look::BOX)).border_1().border_color(c(look::RULE)).flex().items_center().justify_center().text_color(c(look::DIM)).font_family(look::MONO).text_size(px(11.)).child(if online { "\u{b7}:+:\u{b7}" } else { "" }).into_any_element(),
        };

        // ---- title lines
        let (title, sub): (String, String) = if !online {
            let n = match m.model.conn() { rune_mini_core::model::Conn::Offline { attempt } => attempt, _ => 0 };
            ("offline".into(), format!("{} \u{b7} {}", m.net.client.base, if n > 0 { "retrying" } else { "connecting" }))
        } else if let Some(q) = cur {
            (q.track.title.clone(), [q.artist_line(), q.album.title.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" \u{2014} "))
        } else {
            ("nothing playing".into(), format!("zone: {}", m.zone_name()))
        };

        // ---- progress
        let pos = player.map(|p| p.position(now)).unwrap_or(0.);
        let dur = cur.map(|q| q.track.duration_ms).unwrap_or(0.);
        let frac = if dur > 0. { (pos / dur).clamp(0., 1.) as f32 } else { 0. };
        let bar_cell = self.bar.clone();
        let bar_cell2 = self.bar.clone();
        let bar = div().id("bar").relative().flex_1().h(px(14.)).flex().items_center().cursor_pointer()
            .child(div().relative().w_full().h(px(3.)).rounded_full().bg(c(look::RULE)).child(div().absolute().left_0().top_0().h_full().w(relative(frac)).rounded_full().bg(c(look::ACCENT))))
            .child(canvas(move |b, _, _| bar_cell.set(b), |_, _, _, _| ()).absolute().size_full())
            .on_mouse_down(MouseButton::Left, lst(&me, move |this, ev: &MouseDownEvent, _, cx| {
                let b = bar_cell2.get();
                let w = f32::from(b.size.width).max(1.);
                let x = (f32::from(ev.position.x) - f32::from(b.origin.x)).clamp(0., w);
                if dur > 0. {
                    let ms = x / w * dur as f32;
                    this.mini.update(cx, |m, cx| m.command(UiCommand::SeekTo(ms as f64), cx));
                }
            }));

        let btn = |id: &'static str, g: G, cmd: UiCommand, me: &Entity<Self>| {
            div().id(id).flex_none().size(px(24.)).flex().items_center().justify_center().rounded(px(4.)).cursor_pointer().hover(|s| s.bg(c(look::BOX)))
                .child(glyph(g, 12., c(look::INK)))
                .on_click(lst(&me, move |this, _, _, cx| { let k = cmd.clone(); this.mini.update(cx, |m, cx| m.command(k, cx)); }))
        };
        let controls = h_flex().items_center().gap(px(4.))
            .child(btn("prev", G::Prev, UiCommand::Prev, &me))
            .child(btn("pp", if playing { G::Pause } else { G::Play }, UiCommand::PlayPause, &me))
            .child(btn("next", G::Next, UiCommand::Next, &me))
            .child(bar)
            .child(div().flex_none().w(px(86.)).text_right().font_family(look::MONO).text_size(px(11.)).text_color(c(look::DIM)).child(if dur > 0. { format!("{} / {}", mmss(pos), mmss(dur)) } else { String::new() }));

        // ---- footer: a typed line of small toggles
        let (shuffle, repeat, volume) = player.map(|p| (p.shuffle, p.repeat, p.volume)).unwrap_or((false, Repeat::Off, 0.));
        let tog = |id: &'static str, text: String, on: bool, cmd: UiCommand, me: &Entity<Self>| {
            div().id(id).cursor_pointer().text_color(if on { c(look::ACCENT) } else { c(look::DIM) }).hover(|s| s.text_color(c(look::INK))).child(text)
                .on_click(lst(&me, move |this, _, _, cx| { let k = cmd.clone(); this.mini.update(cx, |m, cx| m.command(k, cx)); }))
        };
        let err = m.notice.is_some();
        let note: Option<String> = m.notice.clone().or_else(|| m.hover.clone());
        let zones_n = m.zone_list().len();
        let left: AnyElement = match note {
            Some(t) => div().overflow_hidden().whitespace_nowrap().text_color(if err { c(look::ERROR) } else { c(look::DIM) }).child(t).into_any_element(),
            // "playing \u{b7} Linux PC speakers": the zone name cycles through the zones when there are several
            None => h_flex().gap(px(0.)).text_color(c(look::DIM)).whitespace_nowrap()
                .child(format!("{} \u{b7} ", status_word(&status)))
                .child(
                    div().id("zone").text_color(c(look::DIM)).when(zones_n > 1, |d| d.cursor_pointer().hover(|s| s.text_color(c(look::INK)))).child(if zones_n > 1 { format!("{} \u{203a}", m.zone_name()) } else { m.zone_name() })
                        .when(zones_n > 1, |d| d.on_click(lst(&me, move |this, _, _, cx| { this.mini.update(cx, |m, cx| m.cycle_zone(cx)); }))),
                )
                .into_any_element(),
        };
        let footer = h_flex().items_center().gap(px(12.)).font_family(look::MONO).text_size(px(11.))
            .child(div().flex_1().min_w_0().overflow_hidden().child(left))
            .child(tog("sh", "shuffle".into(), shuffle, UiCommand::ToggleShuffle, &me))
            .child(tog("rp", format!("repeat {}", repeat.as_str()), repeat != Repeat::Off, UiCommand::CycleRepeat, &me))
            .child({
                let shown = match self.vol_sent { Some((t, v)) if now_ms().saturating_sub(t) < VOL_HOLD_MS => v, _ => volume };
                div().id("vol").cursor_ns_resize().text_color(c(look::DIM)).hover(|s| s.text_color(c(look::INK))).child(format!("vol {}", shown.round() as i64))
                    .on_scroll(lst(&me, move |this, ev: &ScrollEvent, _, cx| {
                        // A wheel notch arrives as Lines(±1..3); a trackpad as pixels. One notch or ~24 px = one 5% step.
                        let up = match ev.delta { ScrollDelta::Lines(l) => if l.y == 0. { 0. } else { l.y.signum() * VOL_NOTCH }, ScrollDelta::Pixels(p) => f32::from(p.y) };
                        if up == 0. { return; }
                        if this.vol_acc != 0. && this.vol_acc.signum() != up.signum() { this.vol_acc = 0.; }
                        this.vol_acc += up;
                        let steps = (this.vol_acc / VOL_NOTCH).trunc();
                        if steps == 0. { return; }
                        this.vol_acc -= steps * VOL_NOTCH;
                        let now = now_ms();
                        let base = match this.vol_sent { Some((t, v)) if now.saturating_sub(t) < VOL_HOLD_MS => v, _ => volume };
                        let next = (base + steps as f64 * rune_mini_core::keys::VOLUME_STEP).clamp(0., 100.);
                        this.vol_sent = Some((now, next));
                        this.mini.update(cx, |m, cx| m.command(UiCommand::Volume(next), cx));
                        cx.notify();
                    }))
            });

        let info = v_flex().flex_1().min_w_0().h(px(84.)).justify_between()
            .child(v_flex().gap(px(2.))
                .child(div().overflow_hidden().whitespace_nowrap().font_family(look::MONO).text_size(px(15.)).text_color(if online { c(look::INK) } else { c(look::ERROR) }).child(title))
                .child(div().overflow_hidden().whitespace_nowrap().font_family(look::MONO).text_size(px(12.)).text_color(c(look::DIM)).child(sub)))
            .child(controls)
            .child(footer);
        let top = h_flex().gap(px(12.)).child(cover).child(info);

        // ---- the queue: a typed filter line and a window of rows
        let queue: Option<AnyElement> = m.queue_open.then(|| {
            let matches = m.matches();
            let mut rows = v_flex().gap_0();
            if let Some(p) = player {
                for (slot, &qi) in matches.iter().enumerate().skip(m.top).take(ROWS) {
                    let q = &p.queue[qi];
                    let is_cur = qi as i64 == p.index;
                    let picked = slot == m.pick;
                    let qid = q.queue_id.clone();
                    let qid_rm = q.queue_id.clone();
                    let drag = DragRow { queue_id: q.queue_id.clone(), label: q.track.title.clone() };
                    let drop_idx = qi;
                    let over = m.drag_over == Some(qi);
                    rows = rows.child(
                        h_flex().id(SharedString::from(format!("q-{qid}"))).h(px(ROW_H)).px(px(6.)).gap(px(8.)).items_center().rounded(px(4.)).cursor_pointer()
                            .font_family(look::MONO).text_size(px(12.))
                            .when(picked, |d| d.bg(c(look::BOX)))
                            .when(over, |d| d.border_t_1().border_color(c(look::ACCENT)))
                            .text_color(if is_cur { c(look::ACCENT) } else { c(look::INK) })
                            .child(div().flex_none().w(px(14.)).text_color(c(look::ACCENT)).child(if is_cur { "\u{25b8}" } else { "" }))
                            .child(div().flex_none().w(px(28.)).text_color(c(look::DIM)).child(format!("{:>3}", qi + 1)))
                            .child(h_flex().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().gap(px(8.)).child(div().flex_none().child(q.track.title.clone())).child(div().text_color(c(look::DIM)).child(q.artist_line())))
                            .child(div().flex_none().text_color(c(look::DIM)).child(mmss(q.track.duration_ms)))
                            .child(div().id(SharedString::from(format!("rm-{qid_rm}"))).flex_none().w(px(16.)).text_color(c(look::DIM)).hover(|s| s.text_color(c(look::ERROR))).child("\u{d7}")
                                .on_click(lst(&me, move |this, _, _, cx| { let id = qid_rm.clone(); cx.stop_propagation(); this.mini.update(cx, |m, cx| m.command(UiCommand::Remove(id), cx)); })))
                            .on_drag(drag, |d, _, _, cx| cx.new(|_| Ghost(d.label.clone())))
                            .on_drag_move::<DragRow>(lst(&me, move |this, ev: &DragMoveEvent<DragRow>, _, cx| {
                                let inside = ev.bounds.contains(&ev.event.position);
                                this.mini.update(cx, |m, cx| { let want = inside.then_some(drop_idx); if m.drag_over != want && (want.is_some() || m.drag_over == Some(drop_idx)) { m.drag_over = want; cx.notify(); } });
                            }))
                            .on_drop(lst(&me, move |this, d: &DragRow, _, cx| {
                                let (id, to) = (d.queue_id.clone(), drop_idx);
                                this.mini.update(cx, |m, cx| { m.drag_over = None; m.command(UiCommand::Move { queue_id: id, to }, cx); });
                            }))
                            .on_click(lst(&me, move |this, _, _, cx| { this.mini.update(cx, |m, cx| m.command(UiCommand::Jump(qi), cx)); })),
                    );
                    let _ = qid;
                }
            }
            let typed = if m.filter.is_empty() {
                div().text_color(c(look::DIM)).child("type to filter the queue")
            } else {
                div().text_color(c(look::INK)).child(format!("{}\u{258f}", m.filter))
            };
            let count = format!("{}/{}", matches.len(), player.map(|p| p.queue.len()).unwrap_or(0));
            v_flex().gap(px(6.)).pt(px(8.)).border_t_1().border_color(c(look::RULE))
                .child(h_flex().h(px(26.)).items_center().gap(px(8.)).font_family(look::MONO).text_size(px(14.)).child(div().text_color(c(look::ACCENT)).child("\u{203a}")).child(div().flex_1().child(typed)).child(div().text_size(px(11.)).text_color(c(look::DIM)).child(count)))
                .child(div().on_scroll(lst(&me, |this, ev: &ScrollEvent, _, cx| {
                    let dy = match ev.delta { ScrollDelta::Lines(l) => l.y, ScrollDelta::Pixels(p) => f32::from(p.y) / ROW_H };
                    let rows = (-dy).round() as i32;
                    if rows != 0 { this.mini.update(cx, |m, cx| m.scroll_list(rows, cx)); }
                })).child(rows))
                .into_any_element()
        });

        div().size_full().p(px(0.)).child(
            h_flex().size_full().items_start().bg(c(look::PAPER)).rounded(px(look::RADIUS)).overflow_hidden()
                .track_focus(&self.focus)
                .key_context("RuneMini")
                .on_key_down(lst(&me, move |this, ev: &KeyDownEvent, _, cx| {
                    let k = key_of(ev);
                    this.mini.update(cx, |m, cx| m.key(&k, cx));
                }))
                .child(dots)
                .child(v_flex().flex_1().min_w_0().justify_start().pt(px(20.)).pb(px(14.)).pr(px(16.)).pl(px(2.)).gap(px(8.)).child(top).children(queue)),
        )
        .on_mouse_down(MouseButton::Left, lst(&me, move |this, _, window, cx| { window.focus(&this.focus.clone(), cx); }))
    }
}
