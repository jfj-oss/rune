//! The pure helpers behind the album page, ported from the web (`lib/scores.ts`, `lib/credits.ts`, `lib/reviewContext.ts`,
//! `lib/discover.ts` formatters), with the same rules and tests.
use rune_mini_core::library::{Credit, LibTrack};
use rune_mini_core::model::ArtistRef;
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    #[serde(default)]
    pub outlet: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub scale: f64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub review_count: Option<u64>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Quote {
    #[serde(default)]
    pub outlet: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Sourced {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub s: Sourced,
    #[serde(default)]
    pub verified_artist: bool,
    #[serde(default)]
    pub track_id: Option<String>,
}

/// `AlbumDetails` (shared/src/index.ts).
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    #[serde(default)]
    pub reception: Option<Sourced>,
    #[serde(default)]
    pub scores: Vec<Score>,
    #[serde(default)]
    pub quotes: Vec<Quote>,
    #[serde(default)]
    pub background: Option<Sourced>,
    #[serde(default)]
    pub artist_notes: Vec<Note>,
}

pub fn normalize_score(s: &Score) -> f64 {
    if !s.score.is_finite() || !s.scale.is_finite() || s.scale <= 0. { return 0.; }
    ((s.score / s.scale * 100.).clamp(0., 100.) * 10.).round() / 10.
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tone { High, Mid, Low }

pub fn score_tone(n: f64) -> Tone { if n >= 75. { Tone::High } else if n >= 55. { Tone::Mid } else { Tone::Low } }

/// The value as the outlet prints it: 84, 8.1, 4.5.
pub fn format_score_value(s: &Score) -> String {
    if s.scale >= 100. { return format!("{}", s.score.round() as i64); }
    if s.score.fract() == 0. { format!("{:.1}", s.score) } else { format!("{}", (s.score * 10.).round() / 10.) }
}

pub fn score_suffix(s: &Score) -> String { if s.scale >= 100. { String::new() } else { format!("/{}", s.scale) } }

fn outlet_key(o: &str) -> String { o.to_lowercase().trim_start_matches("the ").trim().to_string() }

/// The overall rating: the mean of the normalised scores (each outlet once), as 0..5 stars.
pub fn aggregate_score(scores: &[Score]) -> Option<(f64, u32, usize)> {
    let mut seen = std::collections::HashSet::new();
    let mut vals = vec![];
    for s in scores {
        if !seen.insert(outlet_key(&s.outlet)) || !s.score.is_finite() || s.scale <= 0. { continue; }
        vals.push(normalize_score(s));
    }
    if vals.is_empty() { return None; }
    let mean = vals.iter().sum::<f64>() / vals.len() as f64;
    Some(((mean / 2.).round() / 10., mean.round() as u32, vals.len()))
}

// ------------------------------------------------------------------ credits

#[derive(Clone, Debug, PartialEq)]
pub struct CreditRole { pub role: String, pub track_ids: Option<Vec<String>> }
#[derive(Clone, Debug, PartialEq)]
pub struct CreditPerson { pub artist: ArtistRef, pub roles: Vec<CreditRole> }
#[derive(Clone, Debug, PartialEq)]
pub struct CreditGroup { pub name: &'static str, pub people: Vec<CreditPerson> }

pub fn classify_role(role: &str) -> &'static str {
    let r = role.to_lowercase();
    const WRITING: [&str; 10] = ["compos", "lyric", "writ", "songwrit", "arrang", "orchestrat", "translat", "libretto", "words", "music by"];
    const PRODUCTION: [&str; 16] = ["produc", "engineer", "mix", "master", "record", "programm", "executive", "a&r", "assistant", "editor", "tracking", "overdub", "co-ordinat", "coordinat", "remix", "recording"];
    if WRITING.iter().any(|w| r.contains(w)) { "Writing" } else if PRODUCTION.iter().any(|w| r.contains(w)) { "Production" } else { "Performers" }
}

/// Performers / Production / Writing, the same person merged within a group (roles unioned, track ids merged).
pub fn group_credits(credits: &[Credit]) -> Vec<CreditGroup> {
    let mut out: Vec<CreditGroup> = ["Performers", "Production", "Writing"].iter().map(|n| CreditGroup { name: n, people: vec![] }).collect();
    for c in credits {
        let g = out.iter_mut().find(|g| g.name == classify_role(&c.role)).unwrap();
        let p = match g.people.iter().position(|p| p.artist.id == c.artist.id) { Some(i) => i, None => { g.people.push(CreditPerson { artist: c.artist.clone(), roles: vec![] }); g.people.len() - 1 } };
        let person = &mut g.people[p];
        match person.roles.iter_mut().find(|r| r.role.to_lowercase() == c.role.to_lowercase()) {
            None => person.roles.push(CreditRole { role: c.role.clone(), track_ids: c.track_ids.clone() }),
            Some(r) => match (&mut r.track_ids, &c.track_ids) {
                (Some(a), Some(b)) => { for x in b { if !a.contains(x) { a.push(x.clone()); } } }
                _ => r.track_ids = None,
            },
        }
    }
    out.retain(|g| !g.people.is_empty());
    out
}

/// "track 3", "tracks 2, 5", "tracks 2\u{2013}4, 7": positions in the album order.
pub fn format_track_refs(ids: &[String], tracks: &[LibTrack]) -> String {
    let mut nums: Vec<usize> = ids.iter().filter_map(|id| tracks.iter().position(|t| &t.id == id).map(|i| i + 1)).collect();
    nums.sort_unstable();
    nums.dedup();
    if nums.is_empty() { return String::new(); }
    let mut parts: Vec<String> = vec![];
    let (mut start, mut prev) = (nums[0], nums[0]);
    for &n in nums.iter().skip(1).chain(std::iter::once(&usize::MAX)) {
        if n != usize::MAX && n == prev + 1 { prev = n; continue; }
        parts.push(if start == prev { start.to_string() } else if prev == start + 1 { format!("{start}, {prev}") } else { format!("{start}\u{2013}{prev}") });
        start = n; prev = n;
    }
    format!("{} {}", if nums.len() == 1 { "track" } else { "tracks" }, parts.join(", "))
}

// ------------------------------------------------------------------ the review preview

pub fn split_sentences(text: &str) -> Vec<String> {
    let mut out = vec![];
    for para in text.split("\n\n") {
        let chars: Vec<char> = para.chars().collect();
        let mut cur = String::new();
        for (i, ch) in chars.iter().enumerate() {
            cur.push(*ch);
            let end = matches!(ch, '.' | '!' | '?') && chars.get(i + 1).is_some_and(|c| c.is_whitespace()) && chars.get(i + 2).is_some_and(|c| c.is_uppercase() || c.is_ascii_digit() || matches!(c, '"' | '\u{201c}' | '\'' | '(' | '['));
            if end { out.push(cur.trim().to_string()); cur.clear(); }
        }
        if !cur.trim().is_empty() { out.push(cur.trim().to_string()); }
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Search terms for an outlet / author: the name, a few aliases and the author's surname.
pub fn terms_for(outlet: &str, author: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let o = outlet.trim().trim_start_matches("The ").trim_start_matches("the ").trim().to_string();
    if o.chars().count() >= 3 { out.push(o); }
    match outlet.to_lowercase().as_str() { "album of the year" => { out.push("aoty".into()); out.push("albumoftheyear".into()); } "metacritic" => out.push("metascore".into()), _ => {} }
    if let Some(a) = author {
        let last: String = a.trim().split_whitespace().last().unwrap_or("").chars().filter(|c| *c != '.' && *c != ',').collect();
        if last.chars().count() >= 4 && !out.contains(&last) { out.push(last); }
    }
    out
}

/// Whole-word, case-insensitive match ranges (byte offsets) of any term in `text`.
pub fn match_ranges(text: &str, terms: &[String]) -> Vec<std::ops::Range<usize>> {
    let lower = text.to_lowercase();
    if lower.len() != text.len() { return vec![]; }
    let mut out: Vec<std::ops::Range<usize>> = vec![];
    for t in terms {
        let t = t.to_lowercase();
        if t.is_empty() { continue; }
        let mut from = 0;
        while let Some(i) = lower[from..].find(&t) {
            let (s, e) = (from + i, from + i + t.len());
            let before_ok = lower[..s].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
            let after_ok = lower[e..].chars().next().is_none_or(|c| !c.is_alphanumeric());
            if before_ok && after_ok { out.push(s..e); }
            from = e;
        }
    }
    out.sort_by_key(|r| r.start);
    out.dedup_by(|b, a| b.start < a.end);
    out
}

pub fn sentences_mentioning(text: &str, terms: &[String], max: usize) -> Vec<String> {
    split_sentences(text).into_iter().filter(|s| !match_ranges(s, terms).is_empty()).take(max).collect()
}

fn flat(t: &str) -> String {
    t.to_lowercase().replace('\u{2026}', " ").replace("...", " ").chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Quotes whose words are not already printed in the reception text.
pub fn quotes_not_in_reception(quotes: &[Quote], reception: Option<&str>) -> Vec<Quote> {
    let Some(r) = reception else { return quotes.to_vec() };
    let text = format!(" {} ", flat(r));
    quotes.iter().filter(|q| { let k = flat(&q.quote); k.len() < 12 || !text.contains(&format!(" {k} ")) }).cloned().collect()
}

// ------------------------------------------------------------------ formatters

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "4 Mar 1977"; tolerates partial dates ("1977", "1977-03").
pub fn format_short_date(iso: &str) -> String {
    let p: Vec<&str> = iso.trim().split('-').collect();
    let Some(y) = p.first().filter(|y| y.len() == 4 && y.chars().all(|c| c.is_ascii_digit())) else { return iso.to_string() };
    let m = p.get(1).and_then(|m| m.get(..2)).and_then(|m| m.parse::<usize>().ok()).filter(|m| (1..=12).contains(m));
    let d = p.get(2).and_then(|d| d.get(..2)).and_then(|d| d.parse::<u32>().ok());
    match (m, d) { (None, _) => y.to_string(), (Some(m), None) => format!("{} {y}", MONTHS[m - 1]), (Some(m), Some(d)) => format!("{d} {} {y}", MONTHS[m - 1]) }
}

/// Epoch ms -> "12 Mar 2026" (UTC; the web shows the local zone, the difference is at most a day).
pub fn format_stamp(ms: f64) -> String {
    if !ms.is_finite() { return "\u{2014}".into(); }
    let days = (ms / 86_400_000.).floor() as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{d} {} {y}", MONTHS[(m - 1) as usize])
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn format_listening(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0. { return "0 min".into(); }
    let total = (ms / 1000.).round() as u64;
    if total < 60 { return format!("{total} s"); }
    let mins = (total as f64 / 60.).round() as u64;
    if mins < 60 { return format!("{mins} min"); }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 { format!("{h} hr") } else { format!("{h} hr {m} min") }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sc(outlet: &str, score: f64, scale: f64) -> Score { Score { outlet: outlet.into(), score, scale, ..Default::default() } }

    #[::core::prelude::v1::test]
    fn scores_are_scaled_toned_and_printed_like_the_web() {
        assert_eq!(normalize_score(&sc("a", 8.1, 10.)), 81.);
        assert_eq!(score_tone(81.), Tone::High);
        assert_eq!(score_tone(60.), Tone::Mid);
        assert_eq!(score_tone(40.), Tone::Low);
        assert_eq!(format_score_value(&sc("a", 84., 100.)), "84");
        assert_eq!(format_score_value(&sc("a", 8., 10.)), "8.0");
        assert_eq!(format_score_value(&sc("a", 8.1, 10.)), "8.1");
        assert_eq!(score_suffix(&sc("a", 4., 5.)), "/5");
        assert_eq!(score_suffix(&sc("a", 84., 100.)), "");
    }

    #[::core::prelude::v1::test]
    fn the_aggregate_counts_each_outlet_once() {
        let (stars, mean, n) = aggregate_score(&[sc("Pitchfork", 8., 10.), sc("The Pitchfork", 2., 10.), sc("Metacritic", 80., 100.), sc("NME", 6., 10.)]).unwrap();
        assert_eq!((n, mean), (3, 73));
        assert_eq!(stars, 3.7);
        assert!(aggregate_score(&[]).is_none());
    }

    #[::core::prelude::v1::test]
    fn credits_group_merge_and_name_their_tracks() {
        let a = |id: &str| ArtistRef { id: id.into(), name: id.into() };
        let c = |id: &str, role: &str, t: Option<&[&str]>| Credit { artist: a(id), role: role.into(), track_ids: t.map(|t| t.iter().map(|s| s.to_string()).collect()) };
        let g = group_credits(&[c("x", "guitar", Some(&["t1"])), c("x", "Guitar", Some(&["t2"])), c("y", "producer", None), c("z", "composer", None), c("x", "composer", None)]);
        assert_eq!(g.iter().map(|g| g.name).collect::<Vec<_>>(), ["Performers", "Production", "Writing"]);
        assert_eq!(g[0].people[0].roles[0].track_ids, Some(vec!["t1".to_string(), "t2".to_string()]));
        assert_eq!(g[2].people.len(), 2);
        let tr = |id: &str| LibTrack { id: id.into(), ..Default::default() };
        let tracks = [tr("t1"), tr("t2"), tr("t3"), tr("t4"), tr("t5")];
        assert_eq!(format_track_refs(&["t3".into()], &tracks), "track 3");
        assert_eq!(format_track_refs(&["t2".into(), "t5".into()], &tracks), "tracks 2, 5");
        assert_eq!(format_track_refs(&["t1".into(), "t2".into(), "t3".into(), "t5".into()], &tracks), "tracks 1\u{2013}3, 5");
    }

    #[::core::prelude::v1::test]
    fn sentences_and_terms_find_where_a_critic_is_mentioned() {
        let text = "On release it did well. Pitchfork called it patient. The Guardian praised its restraint.";
        let terms = terms_for("Pitchfork", None);
        assert_eq!(sentences_mentioning(text, &terms, 3), vec!["Pitchfork called it patient."]);
        assert_eq!(terms_for("The Guardian", Some("Alex Petridis")), vec!["Guardian".to_string(), "Petridis".to_string()]);
        let r = match_ranges("Pitchfork and pitchforks", &["Pitchfork".to_string()]);
        assert_eq!(r, vec![0..9]);
        let q = Quote { quote: "Pitchfork called it patient".into(), ..Default::default() };
        assert!(quotes_not_in_reception(&[q], Some(text)).is_empty());
    }

    #[::core::prelude::v1::test]
    fn dates_and_durations_read_like_the_web() {
        assert_eq!(format_short_date("1977-03-04"), "4 Mar 1977");
        assert_eq!(format_short_date("1977-03"), "Mar 1977");
        assert_eq!(format_short_date("1977"), "1977");
        assert_eq!(format_stamp(1_795_170_289_358.), "20 Nov 2026");
        assert_eq!(format_listening(59_000.), "59 s");
        assert_eq!(format_listening(1_965_000.), "33 min");
        assert_eq!(format_listening(4_500_000.), "1 hr 15 min");
    }
}
