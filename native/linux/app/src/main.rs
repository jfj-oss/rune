//! rune mini (Linux): a Claude-Summon-style panel for the rune music server. A global shortcut shows and hides one
//! borderless overlay; there is no taskbar entry; a tray icon and the MPRIS player run while it is hidden.
mod desktop;
mod look;
mod state;
mod view;

use futures::StreamExt;
use gpui_kit::*;
use rune_mini_core::config;
use rune_mini_core::net::Net;
use state::Mini;
use std::sync::Arc;

fn usage() -> ! {
    eprintln!(
        "rune-mini [--show]            run the panel (a second run toggles the running one)\n\
         rune-mini toggle|show|hide    ask the running panel\n\
         rune-mini set-server URL [--token-file FILE | --token-stdin]\n\
                                       save the server (and token, mode 600) in {}",
        config::dir().display()
    );
    std::process::exit(2)
}

fn set_server(args: &[String]) {
    let dir = config::dir();
    let mut cfg = config::load(&dir);
    let Some(url) = args.first() else { usage() };
    cfg.url = config::normalize_url(url);
    if cfg.url.is_empty() {
        usage();
    }
    let mut token: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--token-file" => {
                let Some(f) = args.get(i + 1) else { usage() };
                token = std::fs::read_to_string(f).ok();
                i += 1;
            }
            "--token-stdin" => {
                let mut s = String::new();
                let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
                token = Some(s);
            }
            _ => usage(),
        }
        i += 1;
    }
    config::save(&dir, &cfg).expect("save config");
    if let Some(t) = token {
        config::save_token(&dir, &t).expect("save token");
    }
    println!("saved {} (token {})", cfg.url, if config::load_token(&dir).is_empty() { "none" } else { "set, file mode 600" });
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("set-server") => return set_server(&args[1..]),
        Some(m @ ("toggle" | "show" | "hide")) => {
            let method = match m { "toggle" => "Toggle", "show" => "Show", _ => "Hide" };
            if !desktop::toggle_running(method) {
                eprintln!("rune-mini is not running");
                std::process::exit(1);
            }
            return;
        }
        Some("--help" | "-h") => usage(),
        _ => {}
    }
    let show_now = args.iter().any(|a| a == "--show") || std::env::var_os("RUNE_MINI_SHOW").is_some();
    // one panel: a second start shows or hides the first
    if std::env::var_os("RUNE_MINI_NO_SINGLE").is_none() && desktop::toggle_running("Toggle") {
        return;
    }
    let dir = config::dir();
    let cfg = config::load(&dir);
    let token = config::load_token(&dir);
    let portal = std::env::var("RUNE_MINI_PORTAL").map(|v| v != "off").unwrap_or(true);

    gpui_kit::application().run(move |cx: &mut App| {
        gpui_kit::init(cx);
        // the panel lives in the background: closing its window (hiding it) must not end the app
        cx.set_quit_mode(QuitMode::Explicit);
        let _ = cx.text_system().add_fonts(vec![std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/ibm-plex-mono-latin-500-normal.ttf").as_slice())]);

        let (net_tx, mut net_rx) = futures::channel::mpsc::unbounded();
        let net_tx = std::sync::Mutex::new(net_tx);
        let net = Net::start(&cfg.url, &token, Arc::new(move |e| { let _ = net_tx.lock().map(|t| t.unbounded_send(e)); }));
        let hotkey = cfg.hotkey.clone();
        let mini = cx.new(|_| Mini::new(cfg, dir, net));
        mini.update(cx, |m, _| m.net.viewing(vec![m.model.zone.clone()]));

        let (dev_tx, mut dev_rx) = futures::channel::mpsc::unbounded();
        let ctl = desktop::spawn(dev_tx, hotkey, portal);
        mini.update(cx, |m, _| m.desktop = Some(ctl));

        let m2 = mini.clone();
        cx.spawn(async move |cx| {
            while let Some(ev) = net_rx.next().await {
                m2.update(cx, |m, cx| m.on_net(ev, cx));
            }
        }).detach();
        let m3 = mini.clone();
        cx.spawn(async move |cx| {
            while let Some(ev) = dev_rx.next().await {
                m3.update(cx, |m, cx| m.on_desktop(ev, cx));
            }
        }).detach();
        if show_now {
            mini.update(cx, |m, cx| m.show(cx));
        }
    });
}
