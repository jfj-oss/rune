//! The setup screen: the app only needs the address of the rune server. Everything else (music folders, MusicBrainz, Spotify
//! login, Soloist, phone access) is set up once on the server in a browser (PORT-PLAN "deliberately not ported"), and the
//! screen says so with a button that opens it. The address is checked against `/api/health` before it is saved.
use crate::rune::*;
use crate::text::open_url;
use crate::theme::*;
use crate::theme::surface; // (macOS gpui also exports a `surface`)
use crate::widgets::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rune_mini_core::config;

pub struct Setup {
    pub input: Entity<InputState>,
    pub status: Option<(bool, String)>,
    pub busy: bool,
}

/// What to tell about an address typed in the box (before asking the network).
pub fn address_problem(s: &str) -> Option<&'static str> {
    let t = s.trim();
    if t.is_empty() { return Some("Type the address of your rune server, for example http://192.168.1.20:4545"); }
    if t.contains(' ') { return Some("An address has no spaces"); }
    None
}

impl Rune {
    pub fn open_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = self.cfg.url.clone();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("http://192.168.1.20:4545"));
        input.update(cx, |s, cx| s.set_value(url, window, cx));
        let f = input.read(cx).focus_handle(cx);
        window.focus(&f, cx);
        self.setup = Some(Setup { input, status: None, busy: false });
        cx.notify();
    }

    fn setup_connect(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.setup.as_mut() else { return };
        let raw = s.input.read(cx).value().to_string();
        if let Some(p) = address_problem(&raw) { s.status = Some((false, p.into())); cx.notify(); return; }
        let url = config::normalize_url(&raw);
        s.busy = true;
        s.status = Some((true, "Checking\u{2026}".into()));
        cx.notify();
        let (dir, token) = (self.dir.clone(), config::load_token(&self.dir));
        cx.spawn(async move |this, cx| {
            let u2 = url.clone();
            let r = cx.background_spawn(async move { rune_mini_core::net::Client::new(&u2, &token).get_json::<serde_json::Value>("/health") }).await;
            let _ = this.update(cx, move |me, cx| {
                let Some(s) = me.setup.as_mut() else { return };
                s.busy = false;
                match r {
                    Ok(v) if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true) => {
                        let mut c = me.cfg.clone();
                        c.url = url;
                        match config::save(&dir, &c) {
                            Ok(_) => {
                                s.status = Some((true, "Connected. Restarting rune\u{2026}".into()));
                                cx.notify();
                                if std::env::var_os("RUNE_DESKTOP_TEST_PORT").is_none() { if let Ok(exe) = std::env::current_exe() { let _ = std::process::Command::new(exe).spawn(); } cx.quit(); }
                            }
                            Err(e) => { s.status = Some((false, format!("Could not save the address: {e}"))); cx.notify(); }
                        }
                    }
                    Ok(_) => { s.status = Some((false, "That server answered, but it says it is not well.".into())); cx.notify(); }
                    Err(e) => { s.status = Some((false, format!("Could not connect: {e}"))); cx.notify(); }
                }
            });
        }).detach();
    }

    pub fn setup_overlay(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let s = self.setup.as_ref().unwrap();
        let input = s.input.clone();
        let (ok, msg) = s.status.clone().map(|(o, m)| (o, Some(m))).unwrap_or((true, None));
        let first = self.first_run;
        let url = self.cfg.url.clone();
        div().absolute().top_0().left_0().size_full().bg(c(BG)).flex().items_center().justify_center().occlude()
            .child(v_flex().w(px(520.)).gap(px(18.)).p(px(32.)).rounded(px(20.)).bg(surface()).border_1().border_color(line())
                .child(h_flex().gap(px(12.)).items_center().child(crate::logo::logo(40.)).child(div().text_size(px(26.)).font_weight(w(600.)).child("rune")))
                .child(div().text_size(px(20.)).font_weight(w(700.)).child(if first { "Welcome" } else { "Server address" }))
                .child(div().text_size(px(14.)).text_color(c(TEXT2)).child("rune plays your music from a server on your network. Type its address; this app then shows and controls it, and can play on this computer."))
                .child(div().h(px(44.)).px(px(16.)).flex().items_center().rounded_full().bg(surface2()).border_1().border_color(line()).child(div().flex_1().child(Input::new(&input).appearance(false).cleanable(false))))
                .children(msg.map(|m| div().text_size(px(13.)).text_color(if ok { c(TEXT2) } else { c(BAD) }).child(m)))
                .child(h_flex().gap(px(10.)).justify_between().items_center()
                    .child(div().id("setup-web").text_size(px(13.)).text_color(c(ACCENT2)).cursor_pointer().hover(|s| s.underline()).child("Open the server\u{2019}s own setup (folders, Spotify)").on_click(cx.listener(move |_, _, _, _| open_url(&format!("{}/setup", url.trim_end_matches('/'))))))
                    .child(h_flex().gap(px(10.))
                        .when(!first, |d| d.child(div().id("setup-cancel").child(btn("Cancel", None, false)).on_click(cx.listener(|this, _, _, cx| { this.setup = None; cx.notify(); }))))
                        .child(div().id("setup-go").child(btn("Connect", None, true)).on_click(cx.listener(|this, _, _, cx| this.setup_connect(cx)))))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn addresses_are_checked_before_the_network_is() {
        assert!(address_problem("").is_some() && address_problem("  ").is_some());
        assert!(address_problem("http://a b").is_some());
        assert!(address_problem("192.168.1.20:4545").is_none());
    }
}
