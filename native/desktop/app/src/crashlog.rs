//! A panic leaves a note: `panic.log` in the data folder (`~/.local/share/rune-desktop/` on Linux, `~/Library/Application Support/rune-desktop/`
//! on macOS, `RUNE_DESKTOP_DATA_DIR` overrides). Each entry has the time, the thread, where and what, and a backtrace. The file is
//! kept small (the older half is dropped past 256 KB), and writing it can never panic again.
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 256 * 1024;

pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("RUNE_DESKTOP_DATA_DIR") { return PathBuf::from(d); }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "macos") { return home.join("Library/Application Support/rune-desktop"); }
    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("rune-desktop")
}

/// One entry of the log.
pub fn entry(version: &str, when_unix: u64, thread: &str, location: &str, message: &str, backtrace: &str) -> String {
    format!("---- panic ({version}) at unix time {when_unix}\nthread: {thread}\nat: {location}\n{message}\n{backtrace}\n\n")
}

/// Appends `text` to `dir/panic.log`, first cutting the file down when it has grown past the limit.
pub fn append(dir: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("panic.log");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Ok(old) = std::fs::read(&path) {
            let keep = &old[old.len() / 2..];
            // start at an entry boundary when there is one
            let at = keep.windows(10).position(|w| w == b"---- panic").unwrap_or(0);
            let _ = std::fs::write(&path, &keep[at..]);
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()
}

/// Installs the hook (the default one still prints to stderr first).
pub fn install(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let _ = std::panic::catch_unwind(|| {});
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_else(|| "?".into());
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() { s.to_string() } else if let Some(s) = info.payload().downcast_ref::<String>() { s.clone() } else { "(no message)".into() };
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let _ = append(&dir, &entry(env!("CARGO_PKG_VERSION"), when, &thread, &location, &message, &bt));
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn entries_are_appended_and_the_file_stays_small() {
        let d = std::env::temp_dir().join(format!("rune-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        append(&d, &entry("0.1", 1, "main", "a.rs:1:1", "boom", "bt")).unwrap();
        append(&d, &entry("0.1", 2, "main", "b.rs:2:2", "bang", "bt")).unwrap();
        let s = std::fs::read_to_string(d.join("panic.log")).unwrap();
        assert!(s.contains("boom") && s.contains("bang") && s.matches("---- panic").count() == 2);
        let big = entry("0.1", 3, "t", "c.rs:3:3", &"x".repeat(1000), "bt");
        for _ in 0..400 { append(&d, &big).unwrap(); }
        let len = std::fs::metadata(d.join("panic.log")).unwrap().len();
        assert!(len < MAX_BYTES + 2 * big.len() as u64 && len > 1000, "{len}");
        assert!(std::fs::read_to_string(d.join("panic.log")).unwrap().starts_with("---- panic"), "cut at an entry boundary");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[::core::prelude::v1::test]
    fn a_real_panic_in_a_thread_is_logged() {
        let d = std::env::temp_dir().join(format!("rune-panic2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        install(d.clone());
        let r = std::thread::Builder::new().name("victim".into()).spawn(|| { panic!("deliberate"); }).unwrap().join();
        assert!(r.is_err());
        let s = std::fs::read_to_string(d.join("panic.log")).unwrap();
        assert!(s.contains("deliberate") && s.contains("thread: victim"), "{s}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
