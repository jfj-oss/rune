//! Small pure helpers ported from `web/src/lib/format.ts` and `lib/color.ts`.

pub fn hash_string(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for u in s.encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

/// m:ss, or h:mm:ss from an hour up.
pub fn format_duration(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0. {
        return "0:00".into();
    }
    let total = (ms / 1000.).floor() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// "41 min", "1 hr 12 min".
pub fn format_total_length(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0. {
        return "0 min".into();
    }
    let mins = ((ms / 60000.).round() as u64).max(1);
    if mins < 60 {
        return format!("{mins} min");
    }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 { format!("{h} hr") } else { format!("{h} hr {m} min") }
}

/// 1234 -> "1,234".
pub fn group(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 { out.push(','); }
        out.push(ch);
    }
    out
}

/// 1,234 albums / 1 album.
pub fn plural(n: usize, one: &str) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{out} {one}{}", if n == 1 { "" } else { "s" })
}

pub fn initials(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' }).collect();
    let all: Vec<&str> = cleaned.split_whitespace().collect();
    let skip = |w: &&str| matches!(w.to_lowercase().as_str(), "the" | "a" | "an" | "and" | "of");
    let mut pick: Vec<&str> = all.iter().copied().filter(|w| !skip(w)).collect();
    if pick.is_empty() {
        pick = name.split_whitespace().collect();
    }
    let out: String = pick.iter().take(2).filter_map(|w| w.chars().next()).collect();
    if out.is_empty() { "?".into() } else { out.to_uppercase() }
}

/// Lower-case, accents stripped: "Cafe" finds "cafe" (the web's `fold`).
pub fn fold(s: &str) -> String {
    s.chars().filter_map(|c| {
        let c = match c {
            'à'..='å' | 'À'..='Å' => 'a', 'è'..='ë' | 'È'..='Ë' => 'e', 'ì'..='ï' | 'Ì'..='Ï' => 'i', 'ò'..='ö' | 'Ò'..='Ö' => 'o', 'ù'..='ü' | 'Ù'..='Ü' => 'u', 'ç' | 'Ç' => 'c', 'ñ' | 'Ñ' => 'n', c => c,
        };
        Some(c.to_lowercase().next().unwrap_or(c))
    }).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn durations_and_lengths_match_the_web() {
        assert_eq!(format_duration(0.), "0:00");
        assert_eq!(format_duration(61_999.), "1:01");
        assert_eq!(format_duration(3_725_000.), "1:02:05");
        assert_eq!(format_total_length(41. * 60_000.), "41 min");
        assert_eq!(format_total_length(72. * 60_000.), "1 hr 12 min");
        assert_eq!(format_total_length(60. * 60_000.), "1 hr");
    }
    #[::core::prelude::v1::test]
    fn plural_groups_thousands() {
        assert_eq!(plural(1, "album"), "1 album");
        assert_eq!(plural(1234, "album"), "1,234 albums");
        assert_eq!(plural(0, "track"), "0 tracks");
    }
    #[::core::prelude::v1::test]
    fn initials_skip_articles() {
        assert_eq!(initials("The Lanterns"), "L");
        assert_eq!(initials("Mira Okonkwo"), "MO");
        assert_eq!(initials("Halden & Rowe"), "HR");
        assert_eq!(initials(""), "?");
    }
    #[::core::prelude::v1::test]
    fn the_hash_is_fnv1a_like_the_web() {
        assert_eq!(hash_string(""), 2166136261);
        assert_eq!(hash_string("a"), 0xe40c292c);
    }
    #[::core::prelude::v1::test]
    fn fold_strips_accents() {
        assert_eq!(fold("  Café  "), "cafe");
    }
}

/// Writes `bytes` to `path` so that a crash or a full disk leaves either the old file or the new one, never half of one: a
/// temporary file next to it, flushed to disk, then renamed over it (and the folder flushed, where that is possible).
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), std::process::id()));
    let r = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if r.is_err() { let _ = std::fs::remove_file(&tmp); return r; }
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }
    Ok(())
}

#[cfg(test)]
mod atomic_tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn writes_replaces_and_leaves_no_temp_files() {
        let d = std::env::temp_dir().join(format!("rune-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("state.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "only state.json is left");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[::core::prelude::v1::test]
    fn a_failed_write_keeps_the_old_file() {
        let d = std::env::temp_dir().join(format!("rune-atomic2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("state.json");
        write_atomic(&p, b"keep").unwrap();
        // the target is now a directory: the rename fails, the temp file is cleaned up
        let q = d.join("sub");
        std::fs::create_dir_all(&q).unwrap();
        assert!(write_atomic(&q, b"x").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"keep");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 2, "state.json and sub, no stray temp file");
        let _ = std::fs::remove_dir_all(&d);
    }
}
