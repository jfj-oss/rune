//! Keyboard shortcuts (web `Shortcuts.tsx` + `lib/keys.ts`): anywhere in the window, never while typing.
use crate::rune::*;
use crate::route::*;
use gpui_kit::*;
use rune_mini_core::commands::UiCommand;
use rune_mini_core::model::Status;
use rune_mini_core::now_ms;
use std::time::Instant;

pub const VOLUME_STEP: f64 = 5.;

/// Key 4: where 20% further into the song is, or None when that passes the end (go to the next song).
pub fn skip_ahead_ms(position_ms: f64, duration_ms: f64) -> Option<f64> {
    let next = position_ms + duration_ms * 0.2;
    if next >= duration_ms - 1000. { None } else { Some(next.round()) }
}

/// The next multiple of the step in a direction (62 up is 65, 62 down is 60).
pub fn volume_target(base: f64, up: bool) -> f64 {
    let n = if up { (base / VOLUME_STEP).floor() * VOLUME_STEP + VOLUME_STEP } else { (base / VOLUME_STEP).ceil() * VOLUME_STEP - VOLUME_STEP };
    n.clamp(0., 100.)
}

impl Rune {
    fn typing(&self, window: &Window, cx: &App) -> bool {
        self.search_input.read(cx).focus_handle(cx).is_focused(window)
            || self.albums_find.read(cx).focus_handle(cx).is_focused(window)
            || self.playlists_find.read(cx).focus_handle(cx).is_focused(window)
            || self.tracks_find.read(cx).focus_handle(cx).is_focused(window)
            || self.genres_find.read(cx).focus_handle(cx).is_focused(window)
            || self.pl_rename.is_some()
            || self.people_find.read(cx).focus_handle(cx).is_focused(window)
            || self.radio_find.read(cx).focus_handle(cx).is_focused(window)
            || self.dialog.is_some()
    }

    pub fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let key = k.key.to_lowercase();
        if self.hotkey_listen.is_some() && !k.modifiers.control && !k.modifiers.platform && !k.modifiers.alt { if !ev.is_held { self.hotkey_capture(&key, cx); } return; }
        if key == "escape" {
            if self.preview.is_some() { self.preview = None; cx.notify(); return; }
            if self.song_radio.is_some() { self.song_radio = None; cx.notify(); return; }
            if self.pl_rename.is_some() { self.pl_rename = None; self.pl_rename_sub = None; window.focus(&self.focus.clone(), cx); cx.notify(); return; }
            if self.dialog.is_some() { self.dialog = None; cx.notify(); return; }
            if self.menu.is_some() || self.zone_open || self.signal_open { self.menu = None; self.zone_open = false; self.signal_open = false; cx.notify(); return; }
            if self.search_input.read(cx).focus_handle(cx).is_focused(window) {
                self.search_input.update(cx, |s, cx| s.set_value("", window, cx));
                window.focus(&self.focus.clone(), cx);
                return;
            }
            if self.queue_open { self.queue_open = false; cx.notify(); return; }
            if self.np_open { self.np_open = false; cx.notify(); return; }
            if !self.pl_sel.is_empty() { self.pl_sel.clear(); self.pl_anchor = None; self.pl_select_mode = false; cx.notify(); }
            return;
        }
        if self.typing(window, cx) {
            // arrows + Enter walk the search results while the search box has the keyboard (TopBar.tsx onKey)
            if self.search_input.read(cx).focus_handle(cx).is_focused(window) && matches!(self.route(), Route::Search(_)) {
                match key.as_str() { "down" => { self.search_pick = Some(self.search_pick.map_or(0, |p| p + 1)); cx.notify(); cx.stop_propagation(); } "up" => { self.search_pick = Some(self.search_pick.unwrap_or(0).saturating_sub(1)); cx.notify(); cx.stop_propagation(); } _ => {} }
            }
            return;
        }
        let m = &k.modifiers;
        if m.control || m.platform || m.alt { return; }
        let held = ev.is_held;
        let has_queue = self.model.player.as_ref().is_some_and(|p| !p.queue.is_empty());
        match key.as_str() {
            "space" | " " => {
                if held || !has_queue { return; }
                let playing = self.model.player.as_ref().is_some_and(|p| matches!(p.status, Status::Playing | Status::Loading));
                self.cmd(if playing { UiCommand::Pause } else { UiCommand::Play }, cx);
            }
            "e" | "r" => {
                let up = key == "r";
                let base = match self.vol_hold { Some((t, v)) if t.elapsed().as_millis() < 1500 => v, _ => self.model.player.as_ref().map(|p| p.volume).unwrap_or(0.) };
                let to = volume_target(base, up);
                self.vol_hold = Some((Instant::now(), to));
                if self.vol_sent.elapsed().as_millis() >= 150 { self.vol_sent = Instant::now(); self.cmd(UiCommand::Volume(to), cx); } else { cx.notify(); }
            }
            "1" | "2" | "3" if !held => {
                let Some(p) = self.model.player.clone() else { return };
                if p.queue.is_empty() { return; }
                if key == "3" { self.cmd(UiCommand::Next, cx); }
                else if key == "1" && p.index > 0 { self.cmd(UiCommand::Jump(p.index as usize - 1), cx); }
                else { self.cmd(UiCommand::SeekTo(0.), cx); if p.status != Status::Playing { self.cmd(UiCommand::Play, cx); } }
            }
            "4" if !held => {
                let Some(p) = self.model.player.clone() else { return };
                let Some(cur) = p.current() else { return };
                let dur = cur.track.duration_ms;
                if dur <= 0. { return; }
                match skip_ahead_ms(p.position(now_ms()), dur) { Some(to) => self.cmd(UiCommand::SeekTo(to), cx), None => self.cmd(UiCommand::Next, cx) }
            }
            "delete" | "backspace" if !held => {
                if let Route::Playlist(id) = self.route().clone() { if !self.pl_sel.is_empty() { let pos: Vec<usize> = self.pl_sel.iter().copied().collect(); self.remove_positions(&id, pos, cx); } }
            }
            "q" if !held => self.back(cx),
            "z" if !held => self.go(Route::Home, cx),
            "x" if !held => self.go(Route::Playlists(String::new()), cx),
            "g" if !held => { if has_queue { self.cmd(UiCommand::ToggleShuffle, cx); } }
            kk if !held && !self.album_key.is_empty() && kk == self.album_key => {
                if let Some(id) = self.model.player.as_ref().and_then(|p| p.current()).map(|c| c.album.id.clone()) { if id != "sp:unknown" && !id.is_empty() { self.go(Route::Album(id), cx); } }
            }
            "f" if !held => { if let Route::Playlist(id) = self.route().clone() { self.play_playlist(&id, true, 0, cx); } }
            kk if !held && self.playlist_keys.contains_key(kk) => { if let Some((id, _)) = self.playlist_keys.get(kk).cloned() { self.go(Route::Playlist(id), cx); } }
            "/" => { let f = self.search_input.read(cx).focus_handle(cx); window.focus(&f, cx); cx.stop_propagation(); }
            _ => {}
        }
    }

    pub fn activate_search_pick(&mut self, cx: &mut Context<Self>) {
        crate::pages::search::activate(self, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn volume_steps_land_on_multiples_of_five() {
        assert_eq!(volume_target(62., true), 65.);
        assert_eq!(volume_target(62., false), 60.);
        assert_eq!(volume_target(60., true), 65.);
        assert_eq!(volume_target(60., false), 55.);
        assert_eq!(volume_target(98., true), 100.);
        assert_eq!(volume_target(2., false), 0.);
    }
    #[::core::prelude::v1::test]
    fn key_four_skips_a_fifth_or_goes_next() {
        assert_eq!(skip_ahead_ms(0., 100_000.), Some(20_000.));
        assert_eq!(skip_ahead_ms(85_000., 100_000.), None);
    }
}
