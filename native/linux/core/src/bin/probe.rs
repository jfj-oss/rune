//! A headless client built from the same core as the app, for the end-to-end test (server/tests/e2e/mini.test.ts).
//! `rune-mini-probe <url> [zone]` connects, then reads one command per line on stdin:
//!   {"cmd": <UiCommand name>, ...}  e.g. {"cmd":"next"}  {"cmd":"seek_to","ms":5000}  {"cmd":"jump","index":2}
//!   {"cmd":"move","queue_id":"..","to":0}  {"cmd":"zone","zone":"pc"}  {"cmd":"quit"}
//! and prints one JSON line per change of what the panel would show, plus `{"sent":..}` for each request it made.
use rune_mini_core::commands::{map, UiCommand};
use rune_mini_core::model::{Effect, Model, Msg, Repeat, ServerEvent};
use rune_mini_core::net::{Net, NetEvent};
use rune_mini_core::now_ms;
use serde_json::{json, Value};
use std::io::BufRead;
use std::sync::mpsc::channel;
use std::sync::Arc;

fn view(m: &Model) -> Value {
    let conn = format!("{:?}", m.conn());
    match &m.player {
        None => json!({"view": {"conn": conn, "player": null}}),
        Some(p) => json!({"view": {
            "conn": conn,
            "status": format!("{:?}", p.status).to_lowercase(),
            "index": p.index,
            "title": p.current().map(|c| c.track.title.clone()),
            "queue": p.queue.iter().map(|q| q.track.title.clone()).collect::<Vec<_>>(),
            "queue_ids": p.queue.iter().map(|q| q.queue_id.clone()).collect::<Vec<_>>(),
            "position_ms": p.position(now_ms()),
            "volume": p.volume, "shuffle": p.shuffle, "repeat": p.repeat.as_str(),
            "playing_playlist": m.playing_playlist(),
        }}),
    }
}

fn main() {
    let url = std::env::args().nth(1).expect("usage: rune-mini-probe <url> [zone]");
    let zone = std::env::args().nth(2).unwrap_or_else(|| "pc".into());
    let (tx, rx) = channel::<NetEvent>();
    let tx = std::sync::Mutex::new(tx);
    let net = Net::start(&url, "", Arc::new(move |e| { let _ = tx.lock().unwrap().send(e); }));
    let mut model = Model::new(&zone);
    net.viewing(vec![zone.clone()]);
    net.fetch_zones();
    net.fetch_minis();
    net.fetch_state(&zone, None);
    let (cmd_tx, cmd_rx) = channel::<String>();
    std::thread::spawn(move || {
        for l in std::io::stdin().lock().lines().map_while(Result::ok) {
            if cmd_tx.send(l).is_err() { break; }
        }
    });
    let mut last = String::new();
    let mut emit = |m: &Model| {
        let v = view(m).to_string();
        // the position changes every call: compare without it
        let key = v.split("\"position_ms\"").next().unwrap_or("").to_string() + v.split("\"queue_ids\"").nth(1).unwrap_or("");
        if key != last {
            last = key;
            println!("{v}");
        }
    };
    println!("{}", json!({"ready": true}));
    loop {
        let mut idle = true;
        while let Ok(ev) = rx.try_recv() {
            idle = false;
            let now = now_ms();
            let effects = match ev {
                NetEvent::Conn(c) => model.update(Msg::Conn(c), now),
                NetEvent::Ws(e) => { if matches!(e, ServerEvent::MiniPlaylists) { net.fetch_minis(); } model.update(Msg::Ws(e), now) }
                NetEvent::Fetched { state, rev } => model.update(Msg::Fetched { state, rev }, now),
                NetEvent::Zones(z) => { println!("{}", json!({"zones": z.iter().map(|z| z.id.clone()).collect::<Vec<_>>()})); model.update(Msg::Zones(z), now) }
                NetEvent::Failed(e) => { println!("{}", json!({"failed": e})); vec![] }
                NetEvent::Cover { .. } => vec![],
                NetEvent::Minis(l) => { println!("{}", json!({"minis": l.iter().map(|p| json!({"id": p.id, "name": p.name, "color": p.color})).collect::<Vec<_>>()})); model.update(Msg::Minis(l), now) }
                NetEvent::Started { playlist, state } => { println!("{}", json!({"started": playlist})); model.update(Msg::Started { playlist, state }, now) }
            };
            for e in effects { let Effect::Fetch { zone, rev } = e; net.fetch_state(&zone, rev); }
            emit(&model);
        }
        while let Ok(line) = cmd_rx.try_recv() {
            idle = false;
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.);
            let cmd = match s("cmd").as_str() {
                "play_pause" => UiCommand::PlayPause,
                "next" => UiCommand::Next,
                "prev" => UiCommand::Prev,
                "seek_to" => UiCommand::SeekTo(f("ms")),
                "seek_by" => UiCommand::SeekBy(f("ms")),
                "volume" => UiCommand::Volume(f("v")),
                "shuffle" => UiCommand::ToggleShuffle,
                "repeat" => UiCommand::CycleRepeat,
                "set_repeat" => UiCommand::SetRepeat(match s("mode").as_str() { "all" => Repeat::All, "one" => Repeat::One, _ => Repeat::Off }),
                "jump" => UiCommand::Jump(f("index") as usize),
                "remove" => UiCommand::Remove(s("queue_id")),
                "move" => UiCommand::Move { queue_id: s("queue_id"), to: f("to") as usize },
                "zone" => {
                    for e in model.set_zone(&s("zone")) { let Effect::Fetch { zone, rev } = e; net.fetch_state(&zone, rev); }
                    net.viewing(vec![model.zone.clone()]);
                    emit(&model);
                    continue;
                }
                "key" => {
                    // a key as the panel gets it: {"cmd":"key","name":"2","shift":true}: the mapped action, run as the panel runs it
                    use rune_mini_core::keys::{map_key, Action, Key, SKIP_FRACTION};
                    let k = Key { name: s("name"), shift: v.get("shift").and_then(|x| x.as_bool()).unwrap_or(false), text: Some(s("name")), ..Default::default() };
                    let ui = match map_key(&k, false, true) {
                        Some(Action::PrevSong) => Some(UiCommand::PrevSong),
                        Some(Action::Restart) => Some(UiCommand::SeekTo(0.)),
                        Some(Action::Next) => Some(UiCommand::Next),
                        Some(Action::SkipFifth) => Some(UiCommand::SkipFraction(SKIP_FRACTION)),
                        Some(Action::PlayPlaylist(i)) => {
                            match model.minis.get(i) {
                                Some(p) => { println!("{}", json!({"sent": {"playlist": p.id}})); net.shuffle_playlist(&model.zone, &p.id); }
                                None => println!("{}", json!({"sent": null})),
                            }
                            continue;
                        }
                        _ => None,
                    };
                    match ui.and_then(|c| map(&model, &c, now_ms())) {
                        Some(r) => { println!("{}", json!({"sent": r.body})); net.send(r); }
                        None => println!("{}", json!({"sent": null})),
                    }
                    continue;
                }
                "playlist" => {
                    // a click on dot N (0-based)
                    match model.minis.get(f("index") as usize) {
                        Some(p) => { println!("{}", json!({"sent": {"playlist": p.id}})); net.shuffle_playlist(&model.zone, &p.id); }
                        None => println!("{}", json!({"sent": null})),
                    }
                    continue;
                }
                "view" => { println!("{}", view(&model)); continue; }
                "quit" => return,
                other => { println!("{}", json!({"failed": format!("unknown cmd {other}")})); continue; }
            };
            match map(&model, &cmd, now_ms()) {
                Some(r) => { println!("{}", json!({"sent": r.body})); net.send(r); }
                None => println!("{}", json!({"sent": null})),
            }
        }
        if idle { std::thread::sleep(std::time::Duration::from_millis(15)); }
    }
}
