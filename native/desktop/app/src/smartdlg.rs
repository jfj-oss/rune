//! The smart-playlist rule builder (web `PlaylistDialogs.tsx` SmartPlaylistDialog): name, match all/any, rules (field,
//! operator, values), sort, limit, and a live count of the tracks that match from the server's preview route.
use crate::menu::{item, pop};
use crate::route::Route;
use crate::rune::*;
use crate::smart::*;
use crate::theme::*;
use crate::theme::surface; // (macOS gpui also exports a `surface`)
use crate::widgets::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{json, Value};
use std::time::Duration;

pub struct RuleRow {
    pub field: &'static str,
    pub op: &'static str,
    pub a: Entity<InputState>,
    pub b: Entity<InputState>,
}

pub struct SmartState {
    pub name: Entity<InputState>,
    pub rules: Vec<RuleRow>,
    pub match_all: bool,
    pub sort: &'static str,
    pub desc: bool,
    pub limit: Entity<InputState>,
}

#[derive(Clone, Debug)]
pub enum SmartAct {
    Field(usize, &'static str),
    Op(usize, &'static str),
    Enum(usize, String),
    Match(bool),
    Sort(&'static str),
    Dir(bool),
}

impl Rune {
    fn smart_input(&mut self, ph: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let st = cx.new(|cx| InputState::new(window, cx).placeholder(ph.to_string()));
        self.dlg_subs.push(cx.subscribe_in(&st, window, |_: &mut Rune, _, ev: &InputEvent, _w, cx| { if let InputEvent::Change = ev { cx.notify(); } }));
        st
    }

    pub fn open_smart(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dlg_subs.clear();
        let name = self.smart_input("Jazz I haven\u{2019}t played lately", window, cx);
        let f = name.read(cx).focus_handle(cx);
        window.focus(&f, cx);
        let (a, b) = (self.smart_input("", window, cx), self.smart_input("", window, cx));
        let limit = self.smart_input("no limit", window, cx);
        self.smart_prev = None;
        self.dialog = Some(Dialog::Smart(Box::new(SmartState { name, rules: vec![RuleRow { field: "genre", op: "contains", a, b }], match_all: true, sort: "artist", desc: false, limit })));
        cx.notify();
    }

    pub fn dialog_smart(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let _ = cx.update(|app| { if let Some(w) = app.active_window() { let _ = w.update(app, |root, window, cx| { if let Ok(me) = root.downcast::<Rune>() { me.update(cx, |m, cx| m.open_smart(window, cx)); } }); } });
            let _ = this.update(cx, |_, _| {});
        }).detach();
    }

    pub fn smart_act(&mut self, act: SmartAct, window: &mut Window, cx: &mut Context<Self>) {
        let (a_new, b_new) = (self.smart_input("", window, cx), self.smart_input("", window, cx));
        let Some(Dialog::Smart(s)) = self.dialog.as_mut() else { return };
        match act {
            SmartAct::Field(i, f) => { if let Some(r) = s.rules.get_mut(i) { let d = blank(f); r.field = d.field; r.op = d.op; r.a = a_new; r.b = b_new; if !d.a.is_empty() { r.a.update(cx, |st, cx| st.set_value(d.a.clone(), window, cx)); } } }
            SmartAct::Op(i, o) => { if let Some(r) = s.rules.get_mut(i) { r.op = o; } }
            SmartAct::Enum(i, v) => { if let Some(r) = s.rules.get_mut(i) { r.a.update(cx, |st, cx| st.set_value(v, window, cx)); } }
            SmartAct::Match(m) => s.match_all = m,
            SmartAct::Sort(f) => s.sort = f,
            SmartAct::Dir(d) => s.desc = d,
        }
        cx.notify();
    }

    fn smart_spec(&self, cx: &App) -> Option<(Value, bool, bool)> {
        let Some(Dialog::Smart(s)) = self.dialog.as_ref() else { return None };
        let drafts: Vec<Draft> = s.rules.iter().map(|r| Draft { field: r.field, op: r.op, a: r.a.read(cx).value().to_string(), b: r.b.read(cx).value().to_string() }).collect();
        let lim = s.limit.read(cx).value().trim().parse::<f64>().ok().map(|l| l.round().clamp(1., 10_000.) as u32);
        Some((spec(&drafts, s.match_all, s.sort, s.desc, lim), spec_complete(&drafts), !s.name.read(cx).value().trim().is_empty()))
    }

    /// Ask the server how many tracks match (debounced), once per distinct spec.
    fn smart_count(&mut self, spec: Value, cx: &mut Context<Self>) {
        let key = spec.to_string();
        if self.smart_prev.as_ref().is_some_and(|p| p.0 == key) { return; }
        self.smart_prev = Some((key.clone(), None, true));
        let client = self.client.clone();
        self.smart_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(350)).await;
            let k2 = key.clone();
            let r = cx.background_spawn(async move { client.send_json("POST", "/playlists/smart/preview", Some(&spec)) }).await;
            let _ = this.update(cx, move |me, cx| {
                if me.smart_prev.as_ref().is_some_and(|p| p.0 == k2) {
                    me.smart_prev = Some((k2, r.ok().and_then(|v| Some((v.get("count")?.as_u64()? as usize, v.get("sample").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()))), false));
                    cx.notify();
                }
            });
        }));
    }

    pub fn create_smart(&mut self, cx: &mut Context<Self>) {
        let Some(Dialog::Smart(s)) = self.dialog.as_ref() else { return };
        let name = s.name.read(cx).value().trim().to_string();
        let Some((mut body, complete, _)) = self.smart_spec(cx) else { return };
        if name.is_empty() || !complete { return; }
        body["name"] = json!(name);
        self.dialog = None;
        self.spawn_send(cx, "POST", "/playlists/smart".into(), Some(body), |me, r, cx| match r {
            Ok(v) => { me.data.playlists = None; if let Some(id) = v.get("id").and_then(|x| x.as_str()) { me.go(Route::Playlist(id.to_string()), cx); } }
            Err(e) => me.say(format!("Could not create the smart playlist: {e}"), cx),
        });
    }

    pub fn smart_overlay(&mut self, scrim: Div, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let _ = window;
        let spec_now = self.smart_spec(cx);
        if let Some((sp, complete, _)) = &spec_now { if *complete { self.smart_count(sp.clone(), cx); } else if self.smart_prev.is_some() { self.smart_prev = None; } }
        let Some(Dialog::Smart(s)) = self.dialog.as_ref() else { return scrim };
        let (complete, named) = spec_now.as_ref().map(|x| (x.1, x.2)).unwrap_or((false, false));
        let count_txt = match (&self.smart_prev, complete) {
            (Some((_, Some((n, _)), _)), _) => format!("{n} {} right now", if *n == 1 { "track matches" } else { "tracks match" }),
            (Some((_, None, true)), _) => "Counting\u{2026}".to_string(),
            (Some((_, None, false)), _) => "It fills itself from your library once created".to_string(),
            (None, false) => "Fill in every rule to see how many tracks match".to_string(),
            _ => String::new(),
        };
        let sample = self.smart_prev.as_ref().and_then(|p| p.1.as_ref()).map(|p| p.1.clone()).unwrap_or_default();
        let sel = |id: &'static str, label: String, cx: &mut Context<Self>, items: Box<dyn Fn() -> Vec<crate::rune::PopItem>>| {
            h_flex().id(id).h(px(34.)).px(px(12.)).gap(px(8.)).items_center().rounded_full().cursor_pointer().bg(surface()).border_1().border_color(line()).text_size(px(13.)).child(div().child(label)).child(icon("chevron-down", 12., c(TEXT2)))
                .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| { let p = ev.position(); this.open_menu(pop(f32::from(p.x) - 20., f32::from(p.y) + 20., items()), cx); }))
        };
        let box_ = |st: &Entity<InputState>, w_: f32| div().h(px(34.)).w(px(w_)).px(px(12.)).flex().items_center().rounded_full().bg(surface()).border_1().border_color(line()).text_size(px(13.)).child(div().flex_1().min_w_0().child(Input::new(st).appearance(false).cleanable(false)));
        let mut rules = v_flex().gap(px(10.));
        let n_rules = s.rules.len();
        for (i, r) in s.rules.iter().enumerate() {
            let f = field_def(r.field);
            let opd = f.ops.iter().find(|o| o.op == r.op).unwrap_or(&f.ops[0]);
            let (fid, kind, options) = (r.field, f.kind, f.options);
            let ops_labels: Vec<(&'static str, &'static str)> = f.ops.iter().map(|o| (o.op, o.label)).collect();
            let cur_op = opd.op;
            let a_val = r.a.read(cx).value().to_string();
            let mut row = h_flex().gap(px(8.)).items_center().flex_wrap()
                .child(sel(Box::leak(format!("sf{i}").into_boxed_str()), f.label.to_string(), cx, Box::new(move || fields().into_iter().map(|x| PopItem { icon: if x.id == fid { "check" } else { "tag" }, label: x.label.to_string(), act: MenuAct::Smart(SmartAct::Field(i, x.id)), danger: false, chevron: false, dot: false, sub: false }).collect())))
                .child(sel(Box::leak(format!("so{i}").into_boxed_str()), opd.label.to_string(), cx, Box::new(move || ops_labels.iter().map(|(o, l)| item(if *o == cur_op { "check" } else { "chevron-right" }, *l, MenuAct::Smart(SmartAct::Op(i, o)))).collect())));
            if !opd.no_value {
                if kind == Kind::Enum { row = row.child(sel(Box::leak(format!("sv{i}").into_boxed_str()), a_val.clone(), cx, Box::new(move || options.iter().map(|o| item(if *o == a_val { "check" } else { "chevron-right" }, *o, MenuAct::Smart(SmartAct::Enum(i, o.to_string())))).collect()))); }
                else { row = row.child(box_(&r.a, 150.)); }
                if opd.op == "between" { row = row.child(div().text_size(px(13.)).text_color(c(TEXT3)).child("and")).child(box_(&r.b, 110.)); }
            }
            row = row.child(div().id(SharedString::from(format!("sx{i}"))).child(btn_icon("x", 16., c(TEXT2), false)).when(n_rules == 1, |d| d.opacity(0.35)).on_click(cx.listener(move |this, _, _, cx| { if let Some(Dialog::Smart(s)) = this.dialog.as_mut() { if s.rules.len() > 1 { s.rules.remove(i); cx.notify(); } } })));
            rules = rules.child(row);
        }
        rules = rules.child(h_flex().id("smart-add").gap(px(6.)).items_center().text_size(px(13.)).font_weight(w(600.)).text_color(c(ACCENT2)).cursor_pointer().child(icon("plus", 14., c(ACCENT2))).child("Add rule")
            .on_click(cx.listener(|this, _, window, cx| {
                let (a, b) = (this.smart_input("", window, cx), this.smart_input("", window, cx));
                if let Some(Dialog::Smart(s)) = this.dialog.as_mut() { s.rules.push(RuleRow { field: "year", op: "eq", a, b }); cx.notify(); }
            })));
        let sort_label = SORTS.iter().find(|x| x.0 == s.sort).map(|x| x.1).unwrap_or("Artist").to_string();
        let (cur_sort, desc, match_all) = (s.sort, s.desc, s.match_all);
        let name_in = s.name.clone();
        let limit_in = s.limit.clone();
        let ok = named && complete;
        scrim.child(v_flex().id("smart-dlg").w(px(600.)).max_h(px(700.)).overflow_y_scroll().p(px(24.)).gap(px(16.)).bg(crate::menu::panel_solid()).border_1().border_color(wh(0.14)).rounded(px(16.)).on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().text_size(px(20.)).font_weight(w(700.)).child("New smart playlist"))
            .child(v_flex().gap(px(6.)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child("Name")).child(box_(&name_in, 540.)))
            .child(h_flex().gap(px(10.)).items_center().text_size(px(13.5)).child("Include tracks that match").child(sel("smart-match", if match_all { "all of these rules".into() } else { "any of these rules".into() }, cx, Box::new(move || vec![item(if match_all { "check" } else { "chevron-right" }, "all of these rules", MenuAct::Smart(SmartAct::Match(true))), item(if !match_all { "check" } else { "chevron-right" }, "any of these rules", MenuAct::Smart(SmartAct::Match(false)))]))))
            .child(rules)
            .child(h_flex().gap(px(14.)).items_center().flex_wrap().text_size(px(13.))
                .child(h_flex().gap(px(8.)).items_center().child("Sort by").child(sel("smart-sort", sort_label, cx, Box::new(move || SORTS.iter().map(|x| item(if x.0 == cur_sort { "check" } else { "chevron-right" }, x.1, MenuAct::Smart(SmartAct::Sort(x.0)))).collect()))))
                .child(h_flex().gap(px(8.)).items_center().child("Order").child(sel("smart-dir", if desc { "Z \u{2192} A / newest first".into() } else { "A \u{2192} Z / oldest first".into() }, cx, Box::new(move || vec![item(if !desc { "check" } else { "chevron-right" }, "A \u{2192} Z / oldest first", MenuAct::Smart(SmartAct::Dir(false))), item(if desc { "check" } else { "chevron-right" }, "Z \u{2192} A / newest first", MenuAct::Smart(SmartAct::Dir(true)))]))))
                .child(h_flex().gap(px(8.)).items_center().child("Limit").child(box_(&limit_in, 110.))))
            .children((!sample.is_empty()).then(|| div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("e.g. {}", sample.join(" \u{b7} ")))))
            .child(h_flex().gap(px(10.)).items_center().justify_end()
                .child(div().flex_1().text_size(px(13.)).text_color(c(TEXT2)).child(count_txt))
                .child(div().id("dlg-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.dialog = None; cx.notify(); })))
                .child(div().id("dlg-create").child(btn("Create", None, true)).when(!ok, |d| d.opacity(0.4)).on_click(cx.listener(|this, _, _, cx| this.create_smart(cx))))))
    }
}
