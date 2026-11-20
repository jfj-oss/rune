//! Settings: `config.json` (server URL, last zone, preferred hotkey) and `token` (mode 600) in the OS config folder:
//! ~/.config/rune-mini on Linux (XDG_CONFIG_HOME respected), ~/Library/Application Support/rune-mini on a Mac.
//! RUNE_MINI_CONFIG_DIR overrides the folder (tests). No host and no token is ever built in.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_URL: &str = "http://localhost:4545";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub url: String,
    pub zone: String,
    /// Preferred global shortcut as the portal writes it ("LOGO+ALT+space"); the desktop's dialog has the last word.
    pub hotkey: String,
}

impl Default for Config {
    fn default() -> Config {
        Config { url: DEFAULT_URL.into(), zone: "pc".into(), hotkey: "LOGO+ALT+space".into() }
    }
}

pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("RUNE_MINI_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))).unwrap_or_else(|| PathBuf::from("."));
    base.join("rune-mini")
}

/// "host:4545" or "http://host/" -> "http://host:4545" / "http://host". Empty stays empty.
pub fn normalize_url(s: &str) -> String {
    let t = s.trim().trim_end_matches('/');
    if t.is_empty() {
        return String::new();
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("http://{t}")
    }
}

/// http(s)://h/... -> ws(s)://h/api/ws?slim=1 (the queue is left out of events whose queue did not change).
pub fn ws_url(base: &str) -> String {
    let b = normalize_url(base);
    let swapped = if let Some(r) = b.strip_prefix("https://") { format!("wss://{r}") } else if let Some(r) = b.strip_prefix("http://") { format!("ws://{r}") } else { b };
    format!("{swapped}/api/ws?slim=1")
}

pub fn load(dir: &Path) -> Config {
    fs::read_to_string(dir.join("config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, c: &Config) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join("config.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(c).unwrap_or_default())?;
    fs::rename(tmp, dir.join("config.json"))
}

/// The token, or "" when there is none. A token file readable by others is tightened to 600 on the way.
pub fn load_token(dir: &Path) -> String {
    let p = dir.join("token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = fs::metadata(&p) {
            if m.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
            }
        }
    }
    fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Writes the token with mode 600 from the first byte (never world-readable, not even for an instant).
pub fn save_token(dir: &Path, token: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let p = dir.join("token");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let _ = fs::remove_file(&p);
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p)?;
        f.write_all(token.trim().as_bytes())?;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    fs::write(p, token.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rune-mini-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn urls() {
        assert_eq!(normalize_url(" box:4545/ "), "http://box:4545");
        assert_eq!(normalize_url("https://h.example/"), "https://h.example");
        assert_eq!(normalize_url(""), "");
        assert_eq!(ws_url("http://localhost:4545"), "ws://localhost:4545/api/ws?slim=1");
        assert_eq!(ws_url("https://h.example"), "wss://h.example/api/ws?slim=1");
        assert_eq!(ws_url("h:1"), "ws://h:1/api/ws?slim=1");
    }

    #[test]
    fn config_round_trip_and_defaults() {
        let d = tmp("cfg");
        assert_eq!(load(&d), Config::default(), "a missing file is the defaults");
        assert_eq!(Config::default().url, "http://localhost:4545");
        let c = Config { url: "http://x:1".into(), zone: "spotify:abc".into(), hotkey: "CTRL+F1".into() };
        save(&d, &c).unwrap();
        assert_eq!(load(&d), c);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_mode_600() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("tok");
        save_token(&d, " secret \n").unwrap();
        let mode = fs::metadata(d.join("token")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(load_token(&d), "secret");
        // a loose file is tightened when read
        fs::set_permissions(d.join("token"), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_token(&d), "secret");
        assert_eq!(fs::metadata(d.join("token")).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&d);
    }
}
