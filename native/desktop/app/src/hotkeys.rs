//! User-chosen keys (web `lib/keys.ts`, `PlaylistHotkey.tsx`): the key that goes to the playing album, and one key per playlist
//! that opens it from anywhere. Kept on the server (`/api/settings/hotkeys`), so every rune client shares them.
use crate::rune::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const FIXED: [(&str, &str); 13] = [(" ", "Play / pause"), ("e", "Volume down"), ("r", "Volume up"), ("1", "Previous song"), ("2", "Restart this song"), ("3", "Next song"), ("4", "Skip 20% of the song"), ("q", "Back"), ("z", "Home"), ("x", "Playlists"), ("f", "Shuffle-play the open playlist"), ("g", "Shuffle on / off"), ("/", "Search")];

pub fn is_key_choice(k: &str) -> bool { k.len() == 1 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) }

/// Who already has key `k` (None = free): a built-in shortcut, the album key, or another playlist.
pub fn key_owner(k: &str, album_key: &str, playlists: &BTreeMap<String, (String, String)>, for_id: Option<&str>) -> Option<String> {
    if let Some(f) = FIXED.iter().find(|f| f.0 == k) { return Some(f.1.to_string()); }
    if !album_key.is_empty() && k == album_key { return Some("Go to the playing album".into()); }
    match playlists.get(k) { Some((id, name)) if Some(id.as_str()) != for_id => Some(format!("the playlist \u{201c}{name}\u{201d}")), _ => None }
}

/// Parse the server's `{hotkeys: {albumKey, playlistKeys}}`; None when the server has none stored.
pub fn parse(v: &Value) -> Option<(String, BTreeMap<String, (String, String)>)> {
    let h = v.get("hotkeys")?;
    if h.is_null() { return None; }
    let album = match h.get("albumKey").and_then(|k| k.as_str()) { Some("") => String::new(), Some(k) if is_key_choice(k) && !FIXED.iter().any(|f| f.0 == k) => k.to_string(), _ => "a".into() };
    let keys = h.get("playlistKeys").and_then(|p| p.as_object()).map(|m| m.iter().filter(|(k, _)| is_key_choice(k)).filter_map(|(k, p)| Some((k.clone(), (p.get("id")?.as_str()?.to_string(), p.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string())))).collect()).unwrap_or_default();
    Some((album, keys))
}

impl Rune {
    pub fn load_hotkeys(&mut self, cx: &mut Context<Self>) {
        self.spawn_json::<Value>(cx, "/settings/hotkeys".into(), |me, r, cx| {
            if let Ok(v) = r { if let Some((a, k)) = parse(&v) { me.album_key = a; me.playlist_keys = k; cx.notify(); } }
        });
    }

    fn save_hotkeys(&mut self, cx: &mut Context<Self>) {
        let keys: serde_json::Map<String, Value> = self.playlist_keys.iter().map(|(k, (id, name))| (k.clone(), json!({"id": id, "name": name}))).collect();
        let body = json!({"hotkeys": {"albumKey": self.album_key, "playlistKeys": keys}});
        self.spawn_send(cx, "POST", "/settings/hotkeys".into(), Some(body), |me, r, cx| { if r.is_err() { me.say("Could not save the hotkey", cx); } });
    }

    /// The key a playlist has, if any.
    pub fn playlist_key_of(&self, id: &str) -> Option<String> { self.playlist_keys.iter().find(|(_, (pid, _))| pid == id).map(|(k, _)| k.clone()) }

    pub fn set_playlist_key(&mut self, id: &str, name: &str, key: &str, cx: &mut Context<Self>) {
        self.playlist_keys.retain(|_, (pid, _)| pid != id);
        if !key.is_empty() { self.playlist_keys.insert(key.to_string(), (id.to_string(), name.to_string())); }
        self.save_hotkeys(cx);
        cx.notify();
    }

    /// A key pressed while a playlist's Hotkey button listens. Returns true when the key was taken by it.
    pub fn hotkey_capture(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let Some((id, name)) = self.hotkey_listen.clone() else { return false };
        match key {
            "escape" => self.hotkey_listen = None,
            "backspace" | "delete" => { self.hotkey_listen = None; self.set_playlist_key(&id, &name, "", cx); }
            k if !is_key_choice(k) => self.say("Use a letter or a number", cx),
            k => match key_owner(k, &self.album_key, &self.playlist_keys, Some(&id)) {
                Some(who) => self.say(format!("{} is already used for {who}", k.to_uppercase()), cx),
                None => { self.hotkey_listen = None; self.set_playlist_key(&id, &name, k, cx); }
            },
        }
        cx.notify();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn keys_know_who_owns_them() {
        let mut p = BTreeMap::new();
        p.insert("k".to_string(), ("pl:1".to_string(), "Road trip".to_string()));
        assert_eq!(key_owner("e", "a", &p, None).as_deref(), Some("Volume down"));
        assert_eq!(key_owner("a", "a", &p, None).as_deref(), Some("Go to the playing album"));
        assert_eq!(key_owner("k", "a", &p, None).as_deref(), Some("the playlist \u{201c}Road trip\u{201d}"));
        assert_eq!(key_owner("k", "a", &p, Some("pl:1")), None);
        assert_eq!(key_owner("m", "a", &p, None), None);
        assert!(is_key_choice("m") && is_key_choice("7") && !is_key_choice("M") && !is_key_choice("ab"));
    }
    #[::core::prelude::v1::test]
    fn the_servers_value_is_cleaned_like_the_web_does() {
        let v = json!({"hotkeys": {"albumKey": "q", "playlistKeys": {"k": {"id": "pl:1", "name": "Road"}, "K": {"id": "x", "name": "y"}}}});
        let (a, k) = parse(&v).unwrap();
        assert_eq!(a, "a");
        assert_eq!(k.len(), 1);
        assert_eq!(parse(&json!({"hotkeys": {"albumKey": "", "playlistKeys": {}}})).unwrap().0, "");
        assert!(parse(&json!({"hotkeys": null})).is_none());
    }
}
