//! macOS: the media keys, headphone buttons and Control Centre through `MPRemoteCommandCenter`, and what plays through
//! `MPNowPlayingInfoCenter`; a track-change note through `osascript` (no entitlements needed). All of it runs on the main thread
//! (the app starts it from GPUI's `run` closure and updates it from the UI thread), as the frameworks like.
use super::{Events, OsEvent};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist, MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle,
    MPNowPlayingInfoCenter, MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};
use rune_mini_core::commands::UiCommand;
use rune_mini_core::mpris_meta::MprisMeta;
use std::ptr::NonNull;

/// Holds the registered blocks alive for the life of the app.
pub struct Now {
    _blocks: Vec<RcBlock<dyn Fn(NonNull<MPRemoteCommandEvent>) -> MPRemoteCommandHandlerStatus>>,
}

fn hook(cmd: &MPRemoteCommand, events: &Events, make: impl Fn(NonNull<MPRemoteCommandEvent>) -> Option<UiCommand> + 'static) -> RcBlock<dyn Fn(NonNull<MPRemoteCommandEvent>) -> MPRemoteCommandHandlerStatus> {
    let ev = events.clone();
    let block: RcBlock<dyn Fn(NonNull<MPRemoteCommandEvent>) -> MPRemoteCommandHandlerStatus> = RcBlock::new(move |e: NonNull<MPRemoteCommandEvent>| {
        match make(e) {
            Some(c) => { let _ = ev.unbounded_send(OsEvent::Cmd(c)); MPRemoteCommandHandlerStatus::Success }
            None => MPRemoteCommandHandlerStatus::CommandFailed,
        }
    });
    unsafe {
        cmd.setEnabled(true);
        let _ = cmd.addTargetWithHandler(&block);
    }
    block
}

pub fn start(events: &Events) -> Now {
    let mut blocks = vec![];
    unsafe {
        let cc = MPRemoteCommandCenter::sharedCommandCenter();
        blocks.push(hook(&cc.playCommand(), events, |_| Some(UiCommand::Play)));
        blocks.push(hook(&cc.pauseCommand(), events, |_| Some(UiCommand::Pause)));
        blocks.push(hook(&cc.stopCommand(), events, |_| Some(UiCommand::Pause)));
        blocks.push(hook(&cc.togglePlayPauseCommand(), events, |_| Some(UiCommand::PlayPause)));
        blocks.push(hook(&cc.nextTrackCommand(), events, |_| Some(UiCommand::Next)));
        blocks.push(hook(&cc.previousTrackCommand(), events, |_| Some(UiCommand::Prev)));
        blocks.push(hook(&cc.changePlaybackPositionCommand(), events, |e| {
            let ev = e.cast::<MPChangePlaybackPositionCommandEvent>();
            Some(UiCommand::SeekTo(ev.as_ref().positionTime() * 1000.))
        }));
    }
    Now { _blocks: blocks }
}

fn num(v: f64) -> Retained<AnyObject> { unsafe { Retained::cast_unchecked(NSNumber::numberWithDouble(v)) } }
fn text(s: &str) -> Retained<AnyObject> { unsafe { Retained::cast_unchecked(NSString::from_str(s)) } }

impl Now {
    /// Publish what plays (title, artists, album, length, position, rate) and the state.
    pub fn meta(&self, m: &MprisMeta) {
        unsafe {
            let center = MPNowPlayingInfoCenter::defaultCenter();
            if m.title.is_empty() {
                center.setNowPlayingInfo(None);
                center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
                return;
            }
            let keys: [&NSString; 6] = [
                MPMediaItemPropertyTitle, MPMediaItemPropertyArtist, MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyPlaybackDuration,
                MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
            ];
            let vals = [
                text(&m.title), text(&m.artists.join(", ")), text(&m.album), num(m.length_us as f64 / 1e6), num(m.position_us as f64 / 1e6),
                num(if m.playback_status == "Playing" { 1.0 } else { 0.0 }),
            ];
            let dict: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(&keys, &vals);
            center.setNowPlayingInfo(Some(&dict));
            center.setPlaybackState(match m.playback_status {
                "Playing" => MPNowPlayingPlaybackState::Playing,
                "Paused" => MPNowPlayingPlaybackState::Paused,
                _ => MPNowPlayingPlaybackState::Stopped,
            });
        }
    }
}

/// A banner for a song change, through `osascript` (which needs nothing from the app bundle).
pub fn notify(title: &str, body: &str) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display notification \"{}\" with title \"{}\"", esc(body), esc(title));
    let _ = std::process::Command::new("osascript").arg("-e").arg(script).spawn().map(|mut c| { std::thread::spawn(move || { let _ = c.wait(); }); });
}
