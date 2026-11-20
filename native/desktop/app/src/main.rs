//! rune desktop: the native (GPUI) frontend for the rune music server. See native/desktop/PORT-PLAN.md.
mod actions;
mod albumlogic;
mod audio;
mod charts;
mod audio_zone;
mod covers;
mod data;
mod logo;
mod hotkeys;
mod menu;
mod nowplaying;
mod pages;
mod playroute;
mod preview;
mod queue;
mod route;
mod rune;
mod setup;
mod shell;
mod smart;
mod smartdlg;
mod shortcuts;
mod testhook;
mod text;
mod theme;
mod util;
mod waveform;
mod widgets;

use gpui_kit::*;
use rune_mini_core::config;
use std::path::PathBuf;

fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("RUNE_DESKTOP_CONFIG_DIR") { return PathBuf::from(d); }
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))).unwrap_or_else(|| PathBuf::from("."));
    base.join("rune-desktop")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = config_dir();
    let mut cfg = config::load(&dir);
    let had_saved = dir.join("config.json").exists();
    // `--url http://host:port` (or RUNE_DESKTOP_URL) wins over the saved one
    let mut it = args.iter();
    while let Some(a) = it.next() { if a == "--url" { if let Some(u) = it.next() { cfg.url = config::normalize_url(u); } } }
    if let Ok(u) = std::env::var("RUNE_DESKTOP_URL") { cfg.url = config::normalize_url(&u); }
    // Tests must never reach the live rune: port 4545 is refused unless the user says so.
    if cfg.url.contains(":4545") && std::env::var_os("RUNE_DESKTOP_ALLOW_LIVE").is_none() && std::env::var_os("RUNE_DESKTOP_TEST_PORT").is_some() {
        eprintln!("rune-desktop: refusing to talk to :4545 in a test run (set RUNE_DESKTOP_ALLOW_LIVE to override)");
        std::process::exit(2);
    }
    let first_run = !had_saved && !args.iter().any(|a| a == "--url") && std::env::var_os("RUNE_DESKTOP_URL").is_none();
    let token = config::load_token(&dir);
    let (ww, wh) = std::env::var("RUNE_DESKTOP_SIZE").ok().and_then(|v| { let (a, b) = v.split_once('x')?; Some((a.parse::<f32>().ok()?, b.parse::<f32>().ok()?)) }).unwrap_or((1280., 800.));
    gpui_kit::application().with_assets(gpui_kit::assets::AllAssets).run(move |cx: &mut App| {
        gpui_kit::init(cx);
        let fonts: Vec<std::borrow::Cow<'static, [u8]>> = vec![
            std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/inter-latin-wght-normal.ttf").as_slice()),
            std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/source-serif-4-latin-wght-normal.ttf").as_slice()),
        ];
        if let Err(e) = cx.text_system().add_fonts(fonts) { eprintln!("fonts: {e}"); }
        cx.on_window_closed(|cx, _| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        let bounds = Bounds::centered(None, size(px(ww), px(wh)), cx);
        let opts = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.), px(520.))),
            titlebar: Some(TitlebarOptions { title: Some("rune".into()), ..Default::default() }),
            app_id: Some("rune-desktop".into()),
            ..Default::default()
        };
        // Opened bare (not through gpui_kit::open_window, whose Root wraps a client-decoration frame around the window).
        cx.open_window(opts, move |window, cx| {
            let v = cx.new(|cx| { let mut r = rune::Rune::new(cfg, dir, token, window, cx); r.first_run = first_run; if first_run { r.open_setup(window, cx); } r });
            let f = v.read(cx).focus.clone();
            window.focus(&f, cx);
            v
        }).expect("window");
        cx.activate(true);
    });
}
