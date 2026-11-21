//! Settings (web `pages/Settings.tsx`): setup, keyboard (the album key and the playlist keys), the rune mini's playlists (reorder,
//! remove), playback (volume levelling, auto-radio) and the server's status (library, database, playback, background jobs).
//! Background: the picker (Foil waves, the web's Dither colours, Off; Custom has two hex fields), Reduce effects and Battery saver; the server's self-update card is not part of the native app (it updates by release).
use super::*;
use crate::albumlogic::{format_listening, format_stamp};
use crate::menu::{item, pop};
use gpui_kit::component::input::{Input, InputState};
use serde_json::{json, Value};

fn card(title: &str, ic: &'static str) -> Div {
    v_flex().p(px(20.)).gap(px(10.)).rounded(px(16.)).bg(surface()).border_1().border_color(line()).min_w_0()
        .child(h_flex().gap(px(9.)).items_center().text_size(px(16.)).font_weight(w(700.)).child(icon(ic, 17., c(TEXT))).child(title.to_string()))
}

fn rgb_u32(c: crate::dither::Rgb) -> u32 { ((c[0].round() as u32) << 16) | ((c[1].round() as u32) << 8) | c[2].round() as u32 }

fn muted(t: &str) -> Div { div().text_size(px(13.5)).text_color(c(TEXT3)).child(t.to_string()) }

fn status_row(k: &str, v: impl IntoElement, tone: Option<Hsla>) -> Div {
    h_flex().justify_between().items_baseline().gap(px(12.)).text_size(px(13.5)).child(div().text_color(c(TEXT3)).child(k.to_string())).child(div().text_color(tone.unwrap_or(c(TEXT))).child(v))
}

pub fn format_bytes(b: f64) -> String {
    if !b.is_finite() || b <= 0. { return "0 B".into(); }
    let units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = ((b.ln() / 1024f64.ln()).floor() as usize).min(units.len() - 1);
    let v = b / 1024f64.powi(i as i32);
    if v >= 100. || i == 0 { format!("{} {}", v.round() as i64, units[i]) } else { format!("{:.1} {}", v, units[i]) }
}

/// Move one entry of a list (the rune mini's playlists) to a new place.
pub fn move_item<T: Clone>(list: &[T], from: usize, to: usize) -> Vec<T> {
    let mut v = list.to_vec();
    if from >= v.len() || to >= v.len() || from == to { return v; }
    let x = v.remove(from);
    v.insert(to, x);
    v
}

#[derive(Clone)]
pub struct MiniDrag { pub from: usize, pub name: String }

pub const MINI_COLORS: [u32; 8] = [0xe5736f, 0xe8b04a, 0x4fd18b, 0x5fb3e8, 0xb3a7ff, 0xd97fd9, 0xe8e06a, 0x7fd9c8];
pub const MINI_MAX: usize = 9;

impl Rune {
    fn set_mini(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        self.spawn_send(cx, "PUT", "/mini/playlists".into(), Some(json!({"ids": ids})), |me, r, cx| { me.forget_json("/mini/playlists"); if r.is_err() { me.say("Could not change the rune mini", cx); } cx.notify(); });
    }

    pub fn settings_page(&mut self, cw: f32, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let _ = window;
        let health = self.ensure_json("/health", cx);
        let norm = self.ensure_json("/settings/normalize", cx).ready().and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(String::from)).unwrap_or_else(|| "off".into());
        let auto = self.ensure_json("/settings/autoRadio", cx).ready().and_then(|v| v.get("enabled").and_then(|m| m.as_bool())).unwrap_or(false);
        let mini: Vec<(String, String, usize)> = self.ensure_json("/mini/playlists", cx).ready().and_then(|v| v.get("playlists").and_then(|p| p.as_array()).cloned()).unwrap_or_default().iter().map(|p| (p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(), p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(), p.get("color").and_then(|x| x.as_u64()).unwrap_or(0) as usize)).collect();
        let h = health.ready().cloned();
        let err = matches!(health, crate::data::Slot::Err(_));
        let album_key = self.album_key.clone();
        let keys: Vec<(String, String, String)> = self.playlist_keys.iter().map(|(k, (id, n))| (k.clone(), id.clone(), n.clone())).collect();
        let body_w = cw.min(1240.);
        let two = body_w >= 760.;

        // ---- set up
        let setup = card("Set up rune", "wrench").child(muted("Music folders, Spotify, Soloist and phone access are set up once on the server, in a browser."))
            .child(h_flex().gap(px(10.)).child(div().id("st-addr").self_start().child(btn("Server address", Some("server"), false)).on_click(cx.listener(|this, _, window, cx| this.open_setup(window, cx)))).child(div().id("st-open").self_start().child(btn("Open server setup", Some("external-link"), false)).on_click(cx.listener(|this, _, _, _| { let u = this.cfg.url.trim_end_matches('/').to_string(); crate::text::open_url(&format!("{u}/setup")); }))));
        // ---- keyboard
        let sel_key = |this: &Rune, cx: &mut Context<Rune>| {
            let cur = this.album_key.clone();
            h_flex().id("st-albumkey").h(px(34.)).px(px(14.)).gap(px(8.)).items_center().rounded_full().bg(surface2()).border_1().border_color(line()).cursor_pointer().text_size(px(13.))
                .child(div().text_color(c(TEXT3)).child("Key")).child(div().font_weight(w(500.)).child(if cur.is_empty() { "Off".to_string() } else { cur.to_uppercase() })).child(icon("chevron-down", 12., c(TEXT2)))
                .on_click(cx.listener(|this, ev: &ClickEvent, _, cx| {
                    let p = ev.position();
                    let mut items = vec![item(if this.album_key.is_empty() { "check" } else { "x" }, "Off", MenuAct::AlbumKey(String::new()))];
                    for k in "abcdefghijklmnopqrstuvwxyz0123456789".chars().map(|c_| c_.to_string()).filter(|k| !crate::hotkeys::FIXED.iter().any(|f| f.0 == k) && !this.playlist_keys.contains_key(k)) {
                        items.push(item(if this.album_key == k { "check" } else { "keyboard" }, k.to_uppercase(), MenuAct::AlbumKey(k)));
                    }
                    this.open_menu(pop(f32::from(p.x) - 20., f32::from(p.y) + 22., items), cx);
                }))
        };
        let mut klist = v_flex().gap(px(6.));
        for (k, label) in crate::hotkeys::FIXED.iter().map(|f| (if f.0 == " " { "Space".to_string() } else { f.0.to_uppercase() }, f.1)) {
            klist = klist.child(h_flex().gap(px(12.)).items_center().text_size(px(13.5)).child(div().min_w(px(44.)).px(px(8.)).py(px(1.)).rounded(px(5.)).border_1().border_color(line()).text_size(px(12.)).text_color(c(TEXT2)).child(k)).child(div().text_color(c(TEXT2)).child(label.to_string())));
        }
        for (k, id, name) in &keys {
            let (id1, id2, nm) = (id.clone(), id.clone(), name.clone());
            klist = klist.child(h_flex().gap(px(12.)).items_center().text_size(px(13.5)).child(div().min_w(px(44.)).px(px(8.)).py(px(1.)).rounded(px(5.)).border_1().border_color(line()).text_size(px(12.)).text_color(c(TEXT2)).child(k.to_uppercase()))
                .child(div().id(SharedString::from(format!("kp-{k}"))).text_color(c(ACCENT2)).cursor_pointer().hover(|s| s.underline()).child(name.clone()).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Playlist(id1.clone()), cx))))
                .child(div().id(SharedString::from(format!("kx-{k}"))).role(Role::Button).aria_label("Remove").child(btn_icon("x", 14., c(TEXT2), false)).on_click(cx.listener(move |this, _, _, cx| this.set_playlist_key(&id2, &nm, "", cx)))));
        }
        let keyboard = card("Keyboard", "keyboard").child(muted("Work anywhere in rune, except while typing. The album and playlist keys are shared by all your devices."))
            .child(h_flex().justify_between().items_center().child(v_flex().child(div().text_size(px(14.)).font_weight(w(600.)).child("Go to the playing album")).child(muted("Keys rune already uses are left out"))).child(sel_key(self, cx)))
            .child(klist).child(muted("Give a playlist its own key with the Hotkey button on the playlist\u{2019}s page."));
        let _ = album_key;
        // ---- rune mini
        let mut minilist = v_flex().gap(px(4.));
        let ids_all: Vec<String> = mini.iter().map(|m| m.0.clone()).collect();
        for (i, (id, name, color)) in mini.iter().enumerate() {
            let (ids1, ids2, ids3, ids4, idc) = (ids_all.clone(), ids_all.clone(), ids_all.clone(), ids_all.clone(), id.clone());
            let nm = name.clone();
            let n = mini.len();
            minilist = minilist.child(h_flex().id(SharedString::from(format!("mini-{i}"))).h(px(40.)).px(px(8.)).gap(px(10.)).items_center().rounded(px(8.)).hover(|s| s.bg(wh(0.05)))
                .drag_over::<MiniDrag>(|s, _, _, _| s.border_t_2().border_color(c(ACCENT)))
                .on_drop(cx.listener(move |this, d: &MiniDrag, _, cx| this.set_mini(move_item(&ids4, d.from, i), cx)))
                .child(div().id(SharedString::from(format!("mg-{i}"))).cursor(CursorStyle::ClosedHand).child(icon("grip-vertical", 16., c(TEXT3))).on_drag(MiniDrag { from: i, name: name.clone() }, |d, _o, _w, cx| { let t = d.name.clone(); cx.new(|_| crate::queue::DragGhost(t)) }))
                .child(div().size(px(10.)).rounded_full().bg(c(MINI_COLORS[*color % MINI_COLORS.len()])))
                .child(div().id(SharedString::from(format!("mn-{i}"))).flex_1().min_w_0().truncate().text_size(px(14.)).text_color(c(ACCENT2)).cursor_pointer().hover(|s| s.underline()).child(nm).on_click(cx.listener(move |this, _, _, cx| this.go(Route::Playlist(idc.clone()), cx))))
                .child(div().id(SharedString::from(format!("mu-{i}"))).role(Role::Button).aria_label("Move up").child(btn_icon("chevron-up", 14., c(TEXT2), false)).when(i == 0, |d| d.opacity(0.3)).on_click(cx.listener(move |this, _, _, cx| if i > 0 { this.set_mini(move_item(&ids1, i, i - 1), cx) })))
                .child(div().id(SharedString::from(format!("md-{i}"))).role(Role::Button).aria_label("Move down").child(btn_icon("chevron-down", 14., c(TEXT2), false)).when(i + 1 == n, |d| d.opacity(0.3)).on_click(cx.listener(move |this, _, _, cx| if i + 1 < n { this.set_mini(move_item(&ids2, i, i + 1), cx) })))
                .child(div().id(SharedString::from(format!("mx-{i}"))).role(Role::Button).aria_label("Remove").child(btn_icon("x", 14., c(TEXT2), false)).on_click(cx.listener(move |this, _, _, cx| this.set_mini(ids3.iter().filter(|x| **x != idc2(&ids3, i)).cloned().collect(), cx)))));
        }
        let mini_card = card("rune mini", "panel-top").child(muted("Each playlist here is a coloured dot on the left of the rune mini. Click it to shuffle-play the playlist."))
            .child(if mini.is_empty() { muted("None yet. Open a playlist and choose \u{201c}Show in rune mini\u{201d}.").into_any_element() } else { minilist.into_any_element() })
            .child(muted(&format!("Up to {MINI_MAX}. Drag to reorder; in the mini, Shift+1\u{2013}{MINI_MAX} play them in this order.")));
        // ---- playback
        let norm2 = norm.clone();
        let playback = card("Playback", "sliders-horizontal")
            .child(h_flex().justify_between().items_center().child(v_flex().child(div().text_size(px(14.)).font_weight(w(600.)).child("Volume levelling")).child(muted("Plays quiet and loud songs at the same level"))).child(
                h_flex().id("st-norm").h(px(34.)).px(px(14.)).gap(px(8.)).items_center().rounded_full().bg(surface2()).border_1().border_color(line()).cursor_pointer().text_size(px(13.)).child(match norm2.as_str() { "track" => "Per track", "album" => "Per album", _ => "Off" }).child(icon("chevron-down", 12., c(TEXT2)))
                    .on_click(cx.listener(|this, ev: &ClickEvent, _, cx| { let p = ev.position(); this.open_menu(pop(f32::from(p.x) - 60., f32::from(p.y) + 22., vec![item("x", "Off", MenuAct::Normalize("off")), item("audio-lines", "Per track", MenuAct::Normalize("track")), item("disc-3", "Per album", MenuAct::Normalize("album"))]), cx); }))))
            .child(h_flex().justify_between().items_center().child(v_flex().child(div().text_size(px(14.)).font_weight(w(600.)).child("Auto-radio")).child(muted("When the queue ends, keep playing similar songs from your library"))).child(
                div().id("st-auto").role(Role::Switch).aria_label("Auto-radio").aria_toggled(if auto { Toggled::True } else { Toggled::False }).w(px(44.)).h(px(24.)).rounded_full().p(px(3.)).cursor_pointer().bg(if auto { c(ACCENT) } else { wh(0.18) }).flex().items_center().when(auto, |d| d.justify_end()).child(div().size(px(18.)).rounded_full().bg(c(0xffffff)))
                    .on_click(cx.listener(move |this, _, _, cx| this.run_menu_act(MenuAct::AutoRadio(!auto), cx)))));
        // ---- server status
        let status: AnyElement = match (&h, err) {
            (_, true) => empty("Could not reach the rune server", "The app is running, but the server did not answer /api/health.").into_any_element(),
            (None, _) => div().h(px(120.)).into_any_element(),
            (Some(h), _) => {
                let ok = h.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let g = |p: &str| h.pointer(p).cloned().unwrap_or(Value::Null);
                let roots: Vec<Value> = g("/library/roots").as_array().cloned().unwrap_or_default();
                let mut lib = card("Library", "hard-drive");
                if roots.is_empty() { lib = lib.child(muted("No library roots configured.")); }
                for r in &roots {
                    let (mounted, ro) = (r.get("mounted").and_then(|x| x.as_bool()).unwrap_or(false), r.get("readOnly").and_then(|x| x.as_bool()).unwrap_or(false));
                    lib = lib.child(v_flex().gap(px(4.)).child(div().text_size(px(12.5)).text_color(c(TEXT2)).child(r.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string()))
                        .child(h_flex().gap(px(8.)).items_center().child(badge(if mounted { "Mounted" } else { "Missing" }, false).text_color(if mounted { c(OK) } else { c(BAD) })).child(badge(if ro { "Read-only" } else { "Writable" }, false)).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("{} free", format_bytes(r.get("free").and_then(|x| x.as_f64()).unwrap_or(0.)))))));
                }
                lib = lib.child(status_row("Last scan", g("/library/lastScanAt").as_f64().map(format_stamp).unwrap_or_else(|| "\u{2014}".into()), None));
                let db = card("Database", "database").child(status_row("Albums", crate::util::group(g("/db/albums").as_u64().unwrap_or(0) as usize), None)).child(status_row("Tracks", crate::util::group(g("/db/tracks").as_u64().unwrap_or(0) as usize), None)).child(status_row("Library index", format!("{:.1} MB", g("/db/sizeMB").as_f64().unwrap_or(0.)), None));
                let alive = g("/mpv/alive").as_bool().unwrap_or(false);
                let sp = g("/spotify/connected").as_bool().unwrap_or(false);
                let play = card("Playback", "plug").child(status_row("mpv", if alive { format!("Running{}", g("/mpv/pid").as_u64().map(|p| format!(" \u{b7} PID {p}")).unwrap_or_default()) } else { "Not running".into() }, Some(if alive { c(OK) } else { c(BAD) })))
                    .child(status_row("Spotify", if sp { "Connected" } else { "Not connected" }, Some(if sp { c(OK) } else { c(WARN) })));
                let jobs: Vec<(String, bool)> = g("/jobs").as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_bool().unwrap_or(false))).collect()).unwrap_or_default();
                let mut jc = card("Background jobs", "activity");
                for (j, running) in &jobs { jc = jc.child(status_row(match j.as_str() { "matching" => "Metadata matching", "details" => "Album details", "loudness" => "Loudness analysis", o => o }, if *running { "Running" } else { "Idle" }, if *running { Some(c(OK)) } else { Some(c(TEXT3)) })); }
                let grid = |a: Div, b: Div| if two { h_flex().gap(px(16.)).items_start().child(div().flex_1().min_w_0().child(a)).child(div().flex_1().min_w_0().child(b)).into_any_element() } else { v_flex().gap(px(16.)).child(a).child(b).into_any_element() };
                v_flex().gap(px(16.))
                    .child(h_flex().gap(px(12.)).items_center().child(div().size(px(10.)).rounded_full().bg(if ok { c(OK) } else { c(BAD) })).child(v_flex().child(div().font_weight(w(700.)).child(if ok { "All systems running" } else { "The server reported a problem" })).child(div().text_size(px(12.5)).text_color(c(TEXT3)).child(format!("rune {} \u{b7} up {}", g("/version").as_str().unwrap_or(""), format_listening(g("/uptimeS").as_f64().unwrap_or(0.) * 1000.))))))
                    .child(grid(lib, db)).child(grid(play, jc)).into_any_element()
            }
        };
        // ---- background (web: the Background picker, Reduce effects, Battery saver)
        let fp = self.foil;
        let switch = |id: &'static str, on: bool| div().id(id).role(Role::Switch).aria_label(match id { "st-reduce" => "Reduce effects", "st-saver" => "Battery saver", "st-notify" => "Notify on song change", other => other }).aria_toggled(if on { Toggled::True } else { Toggled::False }).w(px(44.)).h(px(24.)).flex_none().rounded_full().p(px(3.)).cursor_pointer().bg(if on { c(ACCENT) } else { wh(0.18) }).flex().items_center().when(on, |d| d.justify_end()).child(div().size(px(18.)).rounded_full().bg(c(0xffffff)));
        let row = |title: &str, sub: &str, sw: Stateful<Div>| h_flex().justify_between().items_center().gap(px(16.)).child(v_flex().min_w_0().child(div().text_size(px(14.)).font_weight(w(600.)).child(title.to_string())).child(muted(sub))).child(sw);
        let current = fp.mode;
        let mut modes = h_flex().flex_wrap().gap(px(6.));
        for m in crate::dither::Mode::all() {
            let on = m == current;
            let dot = match m {
                crate::dither::Mode::Foil => 0x697dff,
                crate::dither::Mode::Off => 0x0f1013,
                crate::dither::Mode::Hue(h) => rgb_u32(h.palette().light),
                crate::dither::Mode::Cycle | crate::dither::Mode::Album => rgb_u32(crate::dither::Hue::Red.palette().light),
                crate::dither::Mode::Custom => rgb_u32(fp.custom.light),
            };
            let label = m.label();
            modes = modes.child(
                h_flex().id(SharedString::from(format!("st-bg-{}", m.id()))).role(Role::RadioButton).aria_label(label.clone()).aria_toggled(if on { Toggled::True } else { Toggled::False })
                    .w(px(168.)).h(px(40.)).px(px(12.)).gap(px(10.)).items_center().flex_none().rounded(px(10.)).border_1().border_color(if on { c(ACCENT) } else { line() }).cursor_pointer()
                    .text_size(px(13.5)).text_color(if on { c(TEXT) } else { c(TEXT2) }).hover(|d| d.bg(wh(0.06)))
                    .child(div().size(px(14.)).flex_none().rounded_full().border_1().border_color(wh(0.25)).bg(c(dot)))
                    .child(div().flex_1().min_w_0().truncate().child(label))
                    .when(on, |d| d.child(icon("check", 15., c(ACCENT))))
                    .on_click(cx.listener(move |this, _, _, cx| { let p = this.foil; this.set_foil(crate::backdrop::Prefs { mode: m, ..p }, cx); })),
            );
        }
        let mut background = card("Background", "palette").child(muted("Foil waves are the default. The Dither backgrounds are the web's: black and one colour, in fine dots.")).child(modes);
        if current == crate::dither::Mode::Custom {
            let hexbox = |input: &Entity<InputState>, name: &str, sub: &str, col: crate::dither::Rgb| {
                h_flex().gap(px(10.)).items_center()
                    .child(div().size(px(26.)).flex_none().rounded(px(6.)).border_1().border_color(wh(0.25)).bg(c(rgb_u32(col))))
                    .child(v_flex().w(px(150.)).child(div().text_size(px(14.)).font_weight(w(600.)).child(name.to_string())).child(muted(sub)))
                    .child(div().h(px(36.)).w(px(130.)).px(px(12.)).flex().items_center().rounded_full().bg(surface2()).border_1().border_color(line()).child(div().flex_1().child(Input::new(input).appearance(false).cleanable(false))))
            };
            let mut presets = h_flex().gap(px(8.)).items_center();
            for (i, (name, mid, light)) in crate::dither::CUSTOM_PRESETS.iter().enumerate() {
                let (m, l) = (crate::dither::parse_hex(mid).unwrap(), crate::dither::parse_hex(light).unwrap());
                let (ms, ls) = ((*mid).to_string(), (*light).to_string());
                presets = presets.child(div().id(SharedString::from(format!("st-duo-{i}"))).role(Role::Button).aria_label(name.to_string()).size(px(28.)).rounded_full().border_1().border_color(wh(0.25)).cursor_pointer()
                    .bg(linear_gradient(135., linear_color_stop(c(rgb_u32(m)), 0.55), linear_color_stop(c(rgb_u32(l)), 0.55)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let mut p = this.foil; p.custom = crate::dither::Palette { mid: m, light: l };
                        let (a, b) = (ms.clone(), ls.clone());
                        this.custom_mid_in.update(cx, |s, cx| s.set_value(a, window, cx));
                        this.custom_light_in.update(cx, |s, cx| s.set_value(b, window, cx));
                        this.set_foil(p, cx);
                    })));
            }
            background = background.child(v_flex().gap(px(10.)).pt(px(6.))
                .child(hexbox(&self.custom_mid_in, "Base", "Most of the dots (#rrggbb)", fp.custom.mid))
                .child(hexbox(&self.custom_light_in, "Highlights", "The brightest parts (#rrggbb)", fp.custom.light))
                .child(presets));
        }
        let background = background
            .child(row("Reduce effects", "No moving decorations: one still frame. This device only.", switch("st-reduce", fp.reduce).on_click(cx.listener(move |this, _, _, cx| { let p = this.foil; this.set_foil(crate::backdrop::Prefs { reduce: !p.reduce, ..p }, cx); }))))
            .child(row("Battery saver", "The backdrop holds still while another window has focus, or this one is minimised. This device only.", switch("st-saver", fp.saver).on_click(cx.listener(move |this, _, _, cx| { let p = this.foil; this.set_foil(crate::backdrop::Prefs { saver: !p.saver, ..p }, cx); }))));
        let playback = playback.child(row("Notify on song change", "A desktop notification when the song changes while rune is in the background. This device only.", switch("st-notify", self.notify_track).on_click(cx.listener(move |this, _, _, cx| { this.notify_track = !this.notify_track; this.save_state(); cx.notify(); }))));
        let top = if two { h_flex().gap(px(16.)).items_start().child(div().flex_1().min_w_0().child(keyboard)).child(v_flex().flex_1().min_w_0().gap(px(16.)).child(mini_card).child(playback).child(background)).into_any_element() } else { v_flex().gap(px(16.)).child(keyboard).child(mini_card).child(playback).child(background).into_any_element() };
        let page = v_flex().pb(px(40.)).gap(px(16.)).child(setup).child(top).child(status);
        div().id("settings-scroll").size_full().overflow_y_scroll()
            .child(padded(page_head("Settings", "Keyboard, rune mini, playback and server status", None)))
            .child(div().w_full().pl(px(PAD)).pr(px(PAD)).child(div().w(px(body_w)).max_w_full().mx_auto().child(page)))
            .child(bottom_space()).into_any_element()
    }
}

fn idc2(ids: &[String], i: usize) -> String { ids.get(i).cloned().unwrap_or_default() }

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn bytes_read_like_the_web() {
        assert_eq!(format_bytes(0.), "0 B");
        assert_eq!(format_bytes(860. * 1024. * 1024. * 1024.), "860 GB");
        assert_eq!(format_bytes(1.4 * 1024f64.powi(4)), "1.4 TB");
    }
    #[::core::prelude::v1::test]
    fn the_mini_list_reorders() {
        let l = vec!["a", "b", "c"];
        assert_eq!(move_item(&l, 0, 2), vec!["b", "c", "a"]);
        assert_eq!(move_item(&l, 2, 1), vec!["a", "c", "b"]);
        assert_eq!(move_item(&l, 5, 0), l);
    }
}
