//! Keyboard first: which key does what. Pure, so the same table can be tested here and mirrored in Swift (native/mac).
//!
//! Compact view (the queue closed): Space play/pause, Left/Right previous/next, Shift+Left/Right seek 10 s, Up/Down
//! volume 5, S shuffle, R repeat, Q or Tab opens the queue (Ctrl/Cmd+Q toggles it from anywhere; some desktops keep Tab for themselves), Esc hides.
//! Queue view: typing filters, Up/Down pick, Enter plays the pick, Backspace erases, Tab closes the queue, Esc clears
//! the filter, then closes the queue, then hides. Delete removes the pick from the queue. Ctrl/Cmd+S and Ctrl/Cmd+R still toggle shuffle/repeat. With an empty
//! filter Space, Left and Right still play/pause and skip (they are not words).

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Key {
    /// Lower-case key name: "space", "left", "right", "up", "down", "escape", "enter", "tab", "backspace", or the
    /// character itself ("s").
    pub name: String,
    pub shift: bool,
    /// Ctrl on Linux, Command on the Mac.
    pub cmd: bool,
    pub alt: bool,
    /// The text the key types, if it types any.
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Hide,
    PlayPause,
    Prev,
    Next,
    SeekBack,
    SeekForward,
    VolumeUp,
    VolumeDown,
    ToggleShuffle,
    ToggleRepeat,
    OpenQueue,
    CloseQueue,
    Type(String),
    Backspace,
    ClearFilter,
    PickUp,
    PickDown,
    PlayPicked,
    RemovePicked,
}

pub const SEEK_MS: f64 = 10_000.;
pub const VOLUME_STEP: f64 = 5.;

pub fn map_key(k: &Key, queue_open: bool, filter_empty: bool) -> Option<Action> {
    use Action::*;
    let n = k.name.as_str();
    if n == "escape" {
        return Some(if queue_open && !filter_empty { ClearFilter } else if queue_open { CloseQueue } else { Hide });
    }
    if k.cmd {
        return match n {
            "s" => Some(ToggleShuffle),
            "r" => Some(ToggleRepeat),
            "q" => Some(if queue_open { CloseQueue } else { OpenQueue }),
            "up" => Some(VolumeUp),
            "down" => Some(VolumeDown),
            _ => None,
        };
    }
    if !queue_open {
        return match (n, k.shift) {
            ("space", _) => Some(PlayPause),
            ("left", false) => Some(Prev),
            ("right", false) => Some(Next),
            ("left", true) => Some(SeekBack),
            ("right", true) => Some(SeekForward),
            ("up", _) => Some(VolumeUp),
            ("down", _) => Some(VolumeDown),
            ("s", _) => Some(ToggleShuffle),
            ("r", _) => Some(ToggleRepeat),
            ("q", _) | ("tab", _) => Some(OpenQueue),
            _ => None,
        };
    }
    match (n, k.shift) {
        ("tab", _) => Some(CloseQueue),
        ("up", _) => Some(PickUp),
        ("down", _) => Some(PickDown),
        ("enter", _) => Some(PlayPicked),
        ("delete", _) => Some(RemovePicked),
        ("backspace", _) => Some(Backspace),
        ("space", _) if filter_empty => Some(PlayPause),
        ("left", false) if filter_empty => Some(Prev),
        ("right", false) if filter_empty => Some(Next),
        ("left", true) if filter_empty => Some(SeekBack),
        ("right", true) if filter_empty => Some(SeekForward),
        _ => match &k.text {
            Some(t) if !k.alt && t.chars().all(|c| !c.is_control()) && !t.is_empty() => Some(Type(t.clone())),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Action::*;
    fn k(name: &str) -> Key {
        let text = if name.chars().count() == 1 { Some(name.to_string()) } else if name == "space" { Some(" ".into()) } else { None };
        Key { name: name.into(), text, ..Default::default() }
    }
    fn shift(name: &str) -> Key {
        Key { shift: true, ..k(name) }
    }

    #[test]
    fn compact_keys() {
        for (key, want) in [("space", PlayPause), ("left", Prev), ("right", Next), ("up", VolumeUp), ("down", VolumeDown), ("s", ToggleShuffle), ("r", ToggleRepeat), ("q", OpenQueue), ("tab", OpenQueue), ("escape", Hide)] {
            assert_eq!(map_key(&k(key), false, true), Some(want), "{key}");
        }
        assert_eq!(map_key(&shift("left"), false, true), Some(SeekBack));
        assert_eq!(map_key(&shift("right"), false, true), Some(SeekForward));
        assert_eq!(map_key(&k("x"), false, true), None);
    }

    #[test]
    fn queue_view_types_into_the_filter() {
        assert_eq!(map_key(&k("s"), true, true), Some(Type("s".into())), "S is a letter here");
        assert_eq!(map_key(&k("q"), true, true), Some(Type("q".into())));
        assert_eq!(map_key(&k("space"), true, false), Some(Type(" ".into())));
        assert_eq!(map_key(&k("space"), true, true), Some(PlayPause), "an empty filter: space is play/pause");
        assert_eq!(map_key(&k("left"), true, false), None, "mid-word, the arrows are not skips");
        assert_eq!(map_key(&k("left"), true, true), Some(Prev));
        assert_eq!(map_key(&k("down"), true, false), Some(PickDown));
        assert_eq!(map_key(&k("enter"), true, false), Some(PlayPicked));
        assert_eq!(map_key(&k("tab"), true, false), Some(CloseQueue));
        assert_eq!(map_key(&k("backspace"), true, false), Some(Backspace));
        assert_eq!(map_key(&Key { name: "s".into(), cmd: true, ..Default::default() }, true, false), Some(ToggleShuffle));
        let ctrl_q = Key { name: "q".into(), cmd: true, ..Default::default() };
        assert_eq!(map_key(&ctrl_q, true, false), Some(CloseQueue));
        assert_eq!(map_key(&ctrl_q, false, true), Some(OpenQueue));
    }

    #[test]
    fn escape_goes_back_one_step_at_a_time() {
        assert_eq!(map_key(&k("escape"), true, false), Some(ClearFilter));
        assert_eq!(map_key(&k("escape"), true, true), Some(CloseQueue));
        assert_eq!(map_key(&k("escape"), false, true), Some(Hide));
    }
}
