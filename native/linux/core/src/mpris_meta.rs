//! What the MPRIS player (org.mpris.MediaPlayer2.rune) says about what plays, as plain data. The D-Bus side
//! (app/src/desktop.rs) turns it into variants; here it is only decided what the values are.
//!
//! The rune server does not publish an MPRIS player of its own for the pc zone: server/src/spotify/mpris.ts only READS
//! the Spotify app's name (org.mpris.MediaPlayer2.spotify), and mpv runs without an MPRIS script. So this app is the one
//! player named "rune" and nothing fights it.
use crate::model::{Model, Repeat, Status};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MprisMeta {
    pub playback_status: &'static str,
    pub loop_status: &'static str,
    pub shuffle: bool,
    /// 0.0..1.0
    pub volume: f64,
    pub track_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub art_url: Option<String>,
    pub length_us: i64,
    pub position_us: i64,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_seek: bool,
}

/// An object path: only [A-Za-z0-9_] are allowed in a segment.
pub fn track_path(queue_id: &str) -> String {
    let s: String = queue_id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    format!("/org/rune/mini/track/{}", if s.is_empty() { "none".to_string() } else { s })
}

pub fn from_model(m: &Model, base: &str, now: u64) -> MprisMeta {
    let mut out = MprisMeta { playback_status: "Stopped", loop_status: "None", track_id: "/org/mpris/MediaPlayer2/TrackList/NoTrack".into(), ..Default::default() };
    let Some(p) = &m.player else { return out };
    out.playback_status = match p.status {
        Status::Playing | Status::Loading => "Playing",
        Status::Paused => "Paused",
        Status::Stopped => "Stopped",
    };
    out.loop_status = match p.repeat {
        Repeat::Off => "None",
        Repeat::All => "Playlist",
        Repeat::One => "Track",
    };
    out.shuffle = p.shuffle;
    out.volume = (p.volume / 100.).clamp(0., 1.);
    let n = p.queue.len() as i64;
    out.can_play = n > 0;
    out.can_pause = n > 0;
    out.can_next = n > 0 && (p.index + 1 < n || p.repeat == Repeat::All || p.shuffle);
    out.can_prev = n > 0;
    if let Some(c) = p.current() {
        out.can_seek = c.track.duration_ms > 0.;
        out.track_id = track_path(&c.queue_id);
        out.title = c.track.title.clone();
        out.artists = c.track.artists.iter().map(|a| a.name.clone()).filter(|a| !a.is_empty()).collect();
        out.album = c.album.title.clone();
        out.length_us = (c.track.duration_ms * 1000.) as i64;
        out.position_us = (p.position(now) * 1000.) as i64;
        out.art_url = match c.album.cover_url.as_deref() {
            Some(u) if u.starts_with("http://") || u.starts_with("https://") => Some(u.to_string()),
            _ if !c.album.id.is_empty() => Some(format!("{}/api/cover/{}?size=600", base.trim_end_matches('/'), crate::commands::encode(&c.album.id))),
            _ => None,
        };
    }
    out
}

/// Did the position jump (a seek, a new song) rather than just advance? Then MPRIS wants a `Seeked` signal.
/// `elapsed_ms` is the time between the two readings; playing, the position is expected to advance by it.
pub fn seek_jump(old: &MprisMeta, new: &MprisMeta, elapsed_ms: u64) -> bool {
    if old.track_id != new.track_id {
        return false; // a new song is announced by its metadata
    }
    let expected = old.position_us + if old.playback_status == "Playing" { elapsed_ms as i64 * 1000 } else { 0 };
    (new.position_us - expected).abs() > 1_500_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn playing() -> Model {
        let mut m = Model::new("pc");
        let st = WireState {
            zone: "pc".into(),
            status: Status::Playing,
            queue: Some(vec![QueueItem {
                queue_id: "q-1:x".into(),
                track: Track { title: "Song".into(), artists: vec![ArtistRef { id: "1".into(), name: "Ann".into() }, ArtistRef { id: "2".into(), name: "Bo".into() }], duration_ms: 180_000., ..Default::default() },
                album: AlbumRef { id: "la:ab".into(), title: "Rec".into(), cover_url: Some("/api/cover/la:ab?size=200".into()) },
            }]),
            index: 0,
            position_ms: 5000.,
            volume: 40.,
            shuffle: true,
            repeat: Repeat::All,
            elsewhere: false,
            tab: None,
        };
        m.update(Msg::Fetched { state: st, rev: None }, 0);
        m
    }

    #[test]
    fn metadata_mapping() {
        let t = from_model(&playing(), "http://localhost:4545/", 2000);
        assert_eq!(t.playback_status, "Playing");
        assert_eq!(t.loop_status, "Playlist");
        assert!(t.shuffle);
        assert_eq!(t.volume, 0.4);
        assert_eq!(t.title, "Song");
        assert_eq!(t.artists, vec!["Ann", "Bo"]);
        assert_eq!(t.album, "Rec");
        assert_eq!(t.length_us, 180_000_000);
        assert_eq!(t.position_us, 7_000_000, "5 s reported plus 2 s since");
        assert_eq!(t.track_id, "/org/rune/mini/track/q_1_x");
        assert_eq!(t.art_url.as_deref(), Some("http://localhost:4545/api/cover/la%3Aab?size=600"), "a relative cover becomes an absolute URL");
        assert!(t.can_play && t.can_seek && t.can_next);
    }

    #[test]
    fn nothing_known_is_stopped_with_no_track() {
        let t = from_model(&Model::new("pc"), "http://x", 0);
        assert_eq!(t.playback_status, "Stopped");
        assert_eq!(t.track_id, "/org/mpris/MediaPlayer2/TrackList/NoTrack");
        assert!(!t.can_play && t.title.is_empty() && t.art_url.is_none());
    }

    #[test]
    fn seeked_only_for_real_jumps() {
        let a = from_model(&playing(), "http://x", 1000);
        let mut b = a.clone();
        b.position_us += 1_000_000; // one second later while playing: normal
        assert!(!seek_jump(&a, &b, 1000));
        b.position_us = a.position_us + 60_000_000;
        assert!(seek_jump(&a, &b, 1000));
        let mut other = b.clone();
        other.track_id = "/x".into();
        assert!(!seek_jump(&a, &other, 1000), "a new song is not a seek");
    }

    #[test]
    fn external_art_is_kept() {
        let mut m = playing();
        m.player.as_mut().unwrap().queue[0].album.cover_url = Some("https://i.scdn.co/image/abc".into());
        assert_eq!(from_model(&m, "http://x", 0).art_url.as_deref(), Some("https://i.scdn.co/image/abc"));
    }
}
