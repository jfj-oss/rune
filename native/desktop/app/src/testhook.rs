//! Tests only: a line-JSON control port (RUNE_DESKTOP_TEST_PORT=<port>, 127.0.0.1) so the e2e can ask the real window to do
//! what a click does, and read back what it shows. One JSON object per line in, one per line out. Closed unless the variable is set.
//!   {"cmd":"state"}                              route, queue, status, zone, toast, covers held, frame counters
//!   {"cmd":"go","route":"/album/la%3A.."}        navigate (same parser as RUNE_DESKTOP_ROUTE)
//!   {"cmd":"play_album","id","shuffle","start"}  {"cmd":"enqueue_album","id","next"}  {"cmd":"play_playlist","id","shuffle"}
//!   {"cmd":"player","name":"next|prev|pause|resume|shuffle|repeat|clear","n":..}   {"cmd":"seek","ms"} {"cmd":"volume","v"}
//!   {"cmd":"jump","index"} {"cmd":"remove","index"} {"cmd":"move","index","to"}   queue edits by queue position
//!   {"cmd":"add_to_playlist","playlist","name","ids":[..]} {"cmd":"new_playlist","name","ids":[..]} {"cmd":"pin","id","on"}
//!   {"cmd":"click","x","y","n"}                  a real left click at window pixels (mouse move, down, up through the window's own input path); n clicks
//!   {"cmd":"size","w","h"}                       resize the window (logical px)
//!   {"cmd":"backdrop","mode":"dither-custom"}    pick the Background (the saved ids)
//!   {"cmd":"picker","well":"mid|light","do":"open|close|pick|hex","h","s","v","hex"}   the Custom colour picker: open its popover, drag to an HSV, type a hex
//!   {"cmd":"queue","open":true}  {"cmd":"scroll","dy":px}  {"cmd":"bench","steps":N,"dy":px,"ms":16}   (frame intervals while scrolling)
use crate::rune::*;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

pub struct Hook {
    rx: Mutex<Receiver<(Value, Sender<Value>)>>,
}

pub fn start() -> Option<Hook> {
    let port: u16 = std::env::var("RUNE_DESKTOP_TEST_PORT").ok()?.parse().ok()?;
    let (tx, rx) = channel::<(Value, Sender<Value>)>();
    let l = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| eprintln!("test port: {e}")).ok()?;
    std::thread::Builder::new().name("rune-test".into()).spawn(move || {
        for sock in l.incoming().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let Ok(mut w) = sock.try_clone() else { return };
                for line in BufReader::new(sock).lines().map_while(Result::ok) {
                    let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    let (rtx, rrx) = channel();
                    if tx.send((v, rtx)).is_err() { return; }
                    let r = rrx.recv_timeout(Duration::from_secs(60)).unwrap_or(json!({"error": "timeout"}));
                    let _ = writeln!(w, "{r}");
                }
            });
        }
    }).ok()?;
    Some(Hook { rx: Mutex::new(rx) })
}

impl Rune {
    /// Poll the control port every 40 ms (only exists in a test run).
    pub fn start_hook_loop(&mut self, cx: &mut Context<Self>) {
        if self.test.is_none() { return; }
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(40)).await;
            let alive = this.update(cx, |m, cx| {
                let jobs: Vec<(Value, Sender<Value>)> = m.test.as_ref().map(|h| h.rx.lock().unwrap().try_iter().collect()).unwrap_or_default();
                for (v, reply) in jobs { m.hook_cmd(v, reply, cx); }
            }).is_ok();
            if !alive { break; }
        }).detach();
    }

    fn hook_cmd(&mut self, v: Value, reply: Sender<Value>, cx: &mut Context<Self>) {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let n = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.);
        let b = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
        let ids = || -> Vec<String> { v.get("ids").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
        let qid = |i: usize| self.model.player.as_ref().and_then(|p| p.queue.get(i).map(|q| q.queue_id.clone()));
        let out = match s("cmd").as_str() {
            "state" => {
                let p = self.model.player.as_ref();
                let (held, bytes) = self.covers.held();
                json!({
                    "route": self.route().key(), "online": self.model.online(), "zone": self.model.zone,
                    "status": p.map(|p| format!("{:?}", p.status).to_lowercase()), "bar": self.bar_shown.clone(), "index": p.map(|p| p.index), "shuffle": p.map(|p| p.shuffle), "volume": p.map(|p| p.volume),
                    "queue": p.map(|p| p.queue.iter().map(|q| q.track.title.clone()).collect::<Vec<_>>()),
                    "toast": self.toast.as_ref().map(|t| t.text.clone()), "queue_open": self.queue_open, "np_open": self.np_open, "picker": self.picker.as_ref().map(|p| json!({"well": if p.0 == CWell::Mid { "mid" } else { "light" }, "hsv": p.1.hsv})), "backdrop": self.foil.mode.id(), "custom": [crate::dither::to_hex(self.foil.custom.mid), crate::dither::to_hex(self.foil.custom.light)], "mid_field": self.custom_mid_in.read(cx).value().to_string(), "light_field": self.custom_light_in.read(cx).value().to_string(), "picker_field": self.picker_hex_in.read(cx).value().to_string(), "menu": self.menu.is_some(), "dialog": self.dialog.is_some(),
                    "covers_held": held, "covers_bytes": bytes, "covers_requested": self.covers.requested, "covers_fetched": self.covers.fetched, "frames": self.frame, "window": {"w": self.win_info.0, "h": self.win_info.1, "maximized": self.win_info.2, "active": self.win_info.3, "framed": self.win_info.4, "client": self.win_info.5, "inset": self.frame_inset},
                    "own_zone": self.own_zone, "audio": self.audio.as_ref().map(|a| json!({"loaded": a.loaded(), "sounding": a.is_sounding(), "position": crate::audio::Engine::position(&a.engine)})),
                    "albums_loaded": self.data.albums.values().map(|l| l.items.len()).max(),
                })
            }
            "go" => { let r = crate::rune::parse_route(&s("route")); self.go(r, cx); json!({"ok": true}) }
            "play_album" => { self.play_album(&s("id"), b("shuffle"), n("start") as usize, cx); json!({"ok": true}) }
            "enqueue_album" => { self.enqueue_album(&s("id"), b("next"), cx); json!({"ok": true}) }
            "play_playlist" => { self.play_playlist(&s("id"), b("shuffle"), 0, cx); json!({"ok": true}) }
            "player" => {
                let c = match s("name").as_str() { "next" => UiCommand::Next, "prev" => UiCommand::Prev, "pause" => UiCommand::Pause, "resume" => UiCommand::Play, "shuffle" => UiCommand::ToggleShuffle, "repeat" => UiCommand::CycleRepeat, "clear" => UiCommand::Clear, "toggle" => UiCommand::PlayPause, _ => { let _ = reply.send(json!({"error": "unknown player command"})); return; } };
                self.cmd(c, cx); json!({"ok": true})
            }
            "seek" => { self.cmd(UiCommand::SeekTo(n("ms")), cx); json!({"ok": true}) }
            "volume" => { self.cmd(UiCommand::Volume(n("v")), cx); json!({"ok": true}) }
            "jump" => { self.cmd(UiCommand::Jump(n("index") as usize), cx); json!({"ok": true}) }
            "remove" => match qid(n("index") as usize) { Some(id) => { self.cmd(UiCommand::Remove(id), cx); json!({"ok": true}) } None => json!({"error": "no such row"}) },
            "move" => match qid(n("index") as usize) { Some(id) => { self.cmd(UiCommand::Move { queue_id: id, to: n("to") as usize }, cx); json!({"ok": true}) } None => json!({"error": "no such row"}) },
            "add_to_playlist" => { self.add_to_playlist(&s("playlist"), &s("name"), ids(), cx); json!({"ok": true}) }
            "new_playlist" => { self.create_playlist(s("name"), ids(), cx); json!({"ok": true}) }
            "rename_playlist" => { self.rename_playlist(&s("id"), s("name"), cx); json!({"ok": true}) }
            "playlist_move" => { self.move_in_playlist(&s("id"), n("from") as usize, n("to") as usize, cx); json!({"ok": true}) }
            "playlist_remove" => { let pos: Vec<usize> = v.get("positions").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|x| x as usize)).collect()).unwrap_or_default(); self.remove_positions(&s("id"), pos, cx); json!({"ok": true}) }
            "np_scroll" => { let h = self.hscrolls.entry("np-body".into()).or_default().clone(); h.set_offset(point(px(0.), px(-(v.get("y").and_then(|x| x.as_f64()).unwrap_or(0.) as f32)))); cx.notify(); json!({"ok": true}) }
            "np" => { self.np_open = b("open"); cx.notify(); json!({"ok": true}) }
            "tracks_sort" => { self.tracks_sort = match s("sort").as_str() { "artist" => "artist", "album" => "album", "duration" => "duration", "added" => "added", _ => "title" }; self.tracks_desc = v.get("desc").and_then(|x| x.as_bool()); cx.notify(); json!({"ok": true}) }
            "zone" => { let z = if s("id") == "own" { self.own_zone.clone() } else { s("id") }; self.set_zone(&z, cx); json!({"ok": true})}
            "fix_match" => { self.run_menu_act(MenuAct::FixMatch(s("id")), cx); json!({"ok": true}) }
            "preview" => {
                // the n-th score (kind "score") or quote (kind "quote") of an album's stored details, as a click on it would open
                let path = format!("/albums/{}/details", rune_mini_core::commands::encode(&s("id")));
                let d = self.data.json.get(&path).and_then(|c| c.slot.ready()).and_then(|v| serde_json::from_value::<crate::albumlogic::Details>((**v).clone()).ok());
                let i = n("n") as usize;
                self.preview = d.as_ref().and_then(|d| match s("kind").as_str() {
                    "quote" => d.quotes.get(i).map(|q| crate::preview::quote_preview(q, Some(d))),
                    "text" => d.reception.as_ref().map(|r| crate::preview::text_preview("Critical reception", "Critical reception", r)),
                    _ => d.scores.get(i).map(|sc| crate::preview::score_preview(sc, Some(d))),
                });
                cx.notify();
                json!({"ok": self.preview.is_some()})
            }
            "prose" => { let k = s("key"); if !self.prose_open.remove(&k) { self.prose_open.insert(k); } cx.notify(); json!({"ok": true}) }
            "play_items" => { let items: Vec<crate::playroute::Item> = ids().iter().map(|i| crate::playroute::Item::local(i)).collect(); let z = if s("zone").is_empty() { None } else if s("zone") == "own" { Some(self.own_zone.clone()) } else { Some(s("zone")) }; self.play_items(items, n("start") as usize, b("shuffle"), z, cx); json!({"ok": true}) }
            "dialog_close" => { self.dialog = None; cx.notify(); json!({"ok": true}) }
            "smart" => { self.dialog_smart(cx); json!({"ok": true}) }
            "export_m3u8" => { self.export_m3u8(&s("id"), &s("name"), Some(std::path::PathBuf::from(s("path"))), cx); json!({"ok": true}) }
            "import_m3u8" => { self.import_m3u8(Some(std::path::PathBuf::from(s("path"))), cx); json!({"ok": true}) }
            "hotkey" => { let (id, name) = (s("id"), s("name")); self.set_playlist_key(&id, &name, &s("key"), cx); json!({"ok": true}) }
            "press" => { let key = s("key"); if !self.hotkey_capture(&key, cx) { if let Some((id, _)) = self.playlist_keys.get(&key).cloned() { self.go(crate::route::Route::Playlist(id), cx); } } json!({"ok": true}) }
            "smart_create" => {
                let rules: Vec<crate::smart::Draft> = v.get("rules").and_then(|r| r.as_array()).map(|a| a.iter().map(|r| {
                    let g = |k: &str| r.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    let mut d = crate::smart::blank(&g("field"));
                    if let Some(o) = crate::smart::field_def(d.field).ops.iter().find(|o| o.op == g("op")) { d.op = o.op; }
                    d.a = g("a"); d.b = g("b"); d
                }).collect()).unwrap_or_default();
                let mut body = crate::smart::spec(&rules, b("all"), &s("sort"), b("desc"), None);
                body["name"] = json!(s("name"));
                self.spawn_send(cx, "POST", "/playlists/smart".into(), Some(body), |me, r, cx| { match r { Ok(v) => { me.data.playlists = None; if let Some(id) = v.get("id").and_then(|x| x.as_str()) { me.go(crate::route::Route::Playlist(id.to_string()), cx); } } Err(e) => me.say(e, cx) } });
                json!({"ok": true})
            }
            "click" => {
                let (x, y, times) = (n("x") as f32, n("y") as f32, (n("n") as usize).max(1));
                cx.spawn(async move |this, cx| {
                    let _ = cx.update(|app| { if let Some(w) = app.windows().into_iter().next() { let _ = w.update(app, |_, window, cx| {
                        let pos = point(px(x), px(y));
                        window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position: pos, pressed_button: None, modifiers: Modifiers::default() }), cx);
                        for i in 1..=times {
                            window.dispatch_event(PlatformInput::MouseDown(MouseDownEvent { button: MouseButton::Left, position: pos, modifiers: Modifiers::default(), click_count: i, first_mouse: false }), cx);
                            window.dispatch_event(PlatformInput::MouseUp(MouseUpEvent { button: MouseButton::Left, position: pos, modifiers: Modifiers::default(), click_count: i }), cx);
                        }
                    }); } });
                    let _ = this.update(cx, |_, cx| cx.notify());
                    let _ = reply.send(json!({"ok": true}));
                }).detach();
                return;
            }
            "size" => {
                let (w, h) = (n("w") as f32, n("h") as f32);
                cx.spawn(async move |this, cx| {
                    let _ = cx.update(|app| { if let Some(win) = app.windows().into_iter().next() { let _ = win.update(app, |_, window, _| window.resize(size(px(w), px(h)))); } });
                    cx.background_executor().timer(Duration::from_millis(400)).await;
                    let _ = this.update(cx, |_, cx| cx.notify());
                    let _ = reply.send(json!({"ok": true}));
                }).detach();
                return;
            }
            "backdrop" => { match crate::dither::Mode::from_id(&s("mode")) { Some(m) => { let p = self.foil; self.set_foil(crate::backdrop::Prefs { mode: m, ..p }, cx); json!({"ok": true}) } None => json!({"error": "no such backdrop"}) } }
            "picker" => {
                let k = if s("well") == "light" { CWell::Light } else { CWell::Mid };
                let (h, sat, val, hex) = (n("h") as f32, n("s") as f32, n("v") as f32, s("hex"));
                let act = s("do");
                cx.spawn(async move |this, cx| {
                    let _ = cx.update(|app| { if let Some(w) = app.windows().into_iter().next() { let _ = w.update(app, |root, window, cx| { if let Ok(r) = root.downcast::<crate::backdrop::Root>() { let me = r.read(cx).rune.clone(); me.update(cx, |m, cx| match act.as_str() {
                        "open" => { if m.picker.as_ref().map(|p| p.0) != Some(k) { m.picker_toggle(k, window, cx); } }
                        "close" => m.picker_close(cx),
                        // what a drag in the square / on the strip does: the state moves, the same change path runs
                        "pick" => { if let Some(p) = m.picker.as_mut().filter(|p| p.0 == k) { p.1.set_hue(h); p.1.set_sv(sat, val); let hsv = p.1.hsv; m.set_custom(k, crate::colour_picker::hsv_to_rgb(hsv), window, cx); } }
                        "hex" => { m.picker_hex_in.update(cx, |s, cx| s.set_value(hex.clone(), window, cx)); m.custom_typed(k, &hex, window, cx); }
                        _ => {}
                    }); } }); } });
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    let _ = this.update(cx, |_, cx| cx.notify());
                    let _ = reply.send(json!({"ok": true}));
                }).detach();
                return;
            }
            "setup" => { cx.spawn(async move |this, cx| { let _ = cx.update(|app| { if let Some(w) = app.windows().into_iter().next() { let _ = w.update(app, |root, window, cx| { if let Ok(r) = root.downcast::<crate::backdrop::Root>() { let me = r.read(cx).rune.clone(); me.update(cx, |m, cx| m.open_setup(window, cx)); } }); } }); let _ = this.update(cx, |_, _| {}); }).detach(); json!({"ok": true}) }
            "pin" => { self.set_pin(&s("id"), b("on"), false, cx); json!({"ok": true}) }
            "queue" => { self.queue_open = b("open"); cx.notify(); json!({"ok": true}) }
            "scroll" => { if let Some(l) = self.lists.get(&self.route().key()) { l.scroll_by(px(n("dy") as f32)); } cx.notify(); json!({"ok": true}) }
            "bench" => {
                let (steps, dy, ms) = (n("steps") as usize, n("dy") as f32, n("ms").max(1.) as u64);
                self.bench_times.clear(); self.last_frame = None;
                let key = self.route().key();
                cx.spawn(async move |this, cx| {
                    for _ in 0..steps {
                        cx.background_executor().timer(Duration::from_millis(ms)).await;
                        let _ = this.update(cx, |m, cx| { if let Some(l) = m.lists.get(&key) { l.scroll_by(px(dy)); } cx.notify(); });
                    }
                    cx.background_executor().timer(Duration::from_millis(300)).await;
                    let _ = this.update(cx, |m, _| {
                        let mut t = m.bench_times.clone();
                        t.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        let q = |p: f64| t.get(((t.len() as f64 - 1.) * p) as usize).copied().unwrap_or(0.);
                        let over = t.iter().filter(|x| **x > 20.).count();
                        let _ = reply.send(json!({"frames": t.len(), "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": t.last().copied().unwrap_or(0.), "over20ms": over}));
                    });
                }).detach();
                return;
            }
            other => json!({"error": format!("unknown command {other}")}),
        };
        let _ = reply.send(out);
    }
}
