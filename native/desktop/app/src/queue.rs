//! The queue drawer (web `Queue.tsx`, `.drawer` / `.queue` / `.qrow`): the server's queue, current row marked, click to jump,
//! x to remove, Clear, drag a row's grip to reorder.
use crate::rune::*;
use crate::theme::*;
use crate::util::*;
use crate::widgets::*;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::model::Status;

pub const QROW: f32 = 60.;

/// What a queue row carries while it is dragged (its place in the queue and its title for the ghost).
#[derive(Clone)]
pub struct QueueDrag {
    pub index: usize,
    pub queue_id: String,
    pub title: String,
}

/// The ghost under the pointer.
pub struct DragGhost(pub String);
impl Render for DragGhost {
    fn render(&mut self, _w: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        h_flex().h(px(40.)).px(px(14.)).gap(px(10.)).items_center().rounded(px(R)).bg(panel()).border_1().border_color(wh(0.2)).text_size(px(13.5)).text_color(c(TEXT)).child(icon("grip-vertical", 14., c(TEXT3))).child(self.0.clone())
    }
}

impl Rune {
    pub fn queue_drawer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.model.player.clone();
        let queue = p.as_ref().map(|p| p.queue.len()).unwrap_or(0);
        let index = p.as_ref().map(|p| p.index).unwrap_or(-1);
        let total: f64 = p.as_ref().map(|p| p.queue.iter().map(|q| q.track.duration_ms).sum()).unwrap_or(0.);
        let remaining: f64 = p.as_ref().map(|p| p.queue.iter().skip(index.max(0) as usize).map(|q| q.track.duration_ms).sum()).unwrap_or(0.);
        let sub = if queue > 0 { format!("{} \u{b7} {} \u{b7} {} left", plural(queue, "track"), format_total_length(total), format_total_length(remaining)) } else { "Nothing queued".into() };
        let _ = window;
        let body: AnyElement = if queue == 0 {
            v_flex().flex_1().items_center().gap(px(6.)).py(px(64.)).px(px(24.)).text_color(c(TEXT2)).child(icon("list-music", 28., c(TEXT3))).child(div().text_size(px(17.)).font_weight(w(600.)).text_color(c(TEXT)).child("The queue is empty"))
                .child(div().child("Play an album, or add tracks with \u{201c}Add to queue\u{201d}.")).into_any_element()
        } else {
            uniform_list("queue-rows", queue, cx.processor(move |this: &mut Rune, range: std::ops::Range<usize>, window, cx| {
                let Some(p) = this.model.player.clone() else { return vec![] };
                let playing = p.status == Status::Playing;
                range.filter_map(|i| p.queue.get(i).map(|q| (i, q.clone()))).map(|(i, q)| {
                    let current = i as i64 == p.index;
                    let img = this.cover(&q.album.id, q.album.cover_url.as_deref(), 40., window);
                    let qid = q.queue_id.clone();
                    let qid2 = q.queue_id.clone();
                    let ids = vec![q.track.id.clone()];
                    let mut menu = this.track_menu_ids(ids, q.track.title.clone(), Some(q.album.id.clone()), q.track.artists.first().map(|a| a.id.clone()), q.track.id.starts_with("sp:"), q.track.id.clone());
                    menu.items.push(PopItem { icon: "x", label: "Remove from queue".into(), act: MenuAct::RemoveFromQueue(qid2.clone()), danger: true, chevron: false, dot: false, sub: false });
                    let group = SharedString::from(format!("q-{qid}"));
                    h_flex().id(group.clone()).group(group.clone()).h(px(QROW)).w(px(QUEUE_W - 16.)).mx(px(8.)).rounded(px(R)).items_center().cursor_pointer()
                        .when(current, |d| d.bg(ca(ACCENT, 0.14))).hover(|s| s.bg(surface2()))
                        .child(div().id(SharedString::from(format!("qg-{qid}"))).w(px(26.)).h_full().flex_none().flex().items_center().justify_center().opacity(0.5).cursor(CursorStyle::ClosedHand).hover(|s| s.opacity(1.)).child(icon("grip-vertical", 16., c(TEXT3)))
                            .on_drag(QueueDrag { index: i, queue_id: qid.clone(), title: q.track.title.clone() }, |d, _off, _w, cx| { let t = d.title.clone(); cx.new(|_| DragGhost(t)) }))
                        .child(h_flex().flex_1().min_w_0().gap(px(12.)).items_center()
                            .child(div().relative().size(px(40.)).flex_none().child(cover_el(img, &q.album.id, &q.album.title, 40., R))
                                .when(current, |d| d.child(div().absolute().inset_0().rounded(px(R)).bg(bk(0.55)).flex().items_center().justify_center().child(icon(if playing { "audio-lines" } else { "play" }, 16., c(TEXT))))))
                            .child(v_flex().flex_1().min_w_0()
                                .child(div().truncate().text_size(px(14.)).font_weight(w(500.)).text_color(if current { c(ACCENT2) } else { c(TEXT) }).child(q.track.title.clone()))
                                .child(div().truncate().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{} \u{b7} {}", q.artist_line(), q.album.title))))
                            .child(div().text_size(px(12.)).text_color(c(TEXT3)).child(format_duration(q.track.duration_ms))))
                        .child(div().id(SharedString::from(format!("qx-{qid2}"))).size(px(36.)).flex_none().flex().items_center().justify_center().rounded_full().opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)).hover(|s| s.bg(wh(0.08)))
                            .child(icon("x", 16., c(TEXT2)))
                            .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.cmd(UiCommand::Remove(qid2.clone()), cx); })))
                        .drag_over::<QueueDrag>(|st, _, _, _| st.border_t_2().border_color(c(ACCENT)))
                        .on_drop(cx.listener(move |this, d: &QueueDrag, _, cx| { if d.index != i { this.cmd(UiCommand::Move { queue_id: d.queue_id.clone(), to: i }, cx); } }))
                        .on_click(cx.listener(move |this, _, _, cx| this.cmd(UiCommand::Jump(i), cx)))
                        .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                            let mut m = menu.clone(); m.x = f32::from(ev.position.x); m.y = f32::from(ev.position.y);
                            this.open_menu(m, cx);
                        }))
                        .into_any_element()
                }).collect()
            })).flex_1().py(px(8.)).into_any_element()
        };
        v_flex().absolute().top_0().right_0().bottom(px(NPBAR_H)).w(px(QUEUE_W)).bg(c(0x11121a)).border_l_1().border_color(wh(0.14)).occlude()
            .shadow(vec![BoxShadow { inset: false, color: bk(0.4), offset: point(px(-24.), px(0.)), blur_radius: px(60.), spread_radius: px(0.) }])
            .child(h_flex().justify_between().items_start().pl(px(20.)).pr(px(16.)).pt(px(20.)).pb(px(12.)).gap(px(12.)).border_b_1().border_color(line())
                .child(v_flex().child(div().text_size(px(20.)).font_weight(w(700.)).child("Queue")).child(div().mt(px(2.)).text_size(px(12.5)).text_color(c(TEXT3)).child(sub)))
                .child(h_flex().items_center().gap(px(2.))
                    .when(queue > 0, |d| d.child(div().id("q-clear").h(px(32.)).px(px(12.)).flex().items_center().rounded_full().cursor_pointer().text_size(px(13.)).font_weight(w(600.)).text_color(c(TEXT2)).hover(|s| s.bg(wh(0.08))).child("Clear")
                        .on_click(cx.listener(|this, _, _, cx| this.cmd(UiCommand::Clear, cx)))))
                    .child(div().id("q-close").child(btn_icon("x", 20., c(TEXT2), false)).on_click(cx.listener(|this, _, _, cx| { this.queue_open = false; cx.notify(); })))))
            .child(body)
    }
}
