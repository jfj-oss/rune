//! The "Video loop" backdrop: a short video file played on repeat behind the app.
//!
//! The file is `<data dir>/backdrop.mp4` (or `RUNE_DESKTOP_VIDEO=<path>`). It is never bundled: each person puts their own there.
//! `ffmpeg` decodes it on a worker thread, already scaled to cover the window (at most 1920 px wide, the GPU stretches the rest),
//! as BGRA frames. The worker paces them at the video's own speed and only while the backdrop is live; paused, it simply stops
//! reading, which holds ffmpeg still on its pipe. No ffmpeg or no file: the backdrop falls back to Foil waves.
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Frames per second the video is shown at.
pub const FPS: f64 = 30.0;
/// The widest frame decoded; a bigger window stretches it on the GPU.
pub const MAX_W: u32 = 1920;

pub fn path() -> PathBuf {
    std::env::var_os("RUNE_DESKTOP_VIDEO").map(PathBuf::from).unwrap_or_else(|| crate::crashlog::data_dir().join("backdrop.mp4"))
}

fn ffmpeg() -> &'static Option<PathBuf> {
    static F: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        // (a Mac app does not get Homebrew's folders on its PATH)
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
        dirs.into_iter().map(|d| d.join("ffmpeg")).find(|f| f.is_file())
    })
}

/// Can the video backdrop be drawn (the file is there and ffmpeg is installed)?
pub fn available() -> bool { ffmpeg().is_some() && path().is_file() }

/// The decoded size for a window of `pw` x `ph` device pixels: same shape, at most [`MAX_W`] wide, even numbers.
pub fn decode_size(pw: u32, ph: u32) -> (u32, u32) {
    let k = (MAX_W as f64 / pw.max(1) as f64).min(1.0);
    let even = |v: f64| ((v.round() as u32).max(2) + 1) & !1;
    (even(pw as f64 * k), even(ph as f64 * k))
}

pub enum Ctl { Size(u32, u32), Live(bool), Stop }
pub struct Frame { pub w: u32, pub h: u32, pub bgra: Vec<u8> }

/// The worker: `ctl` says the size and whether frames are wanted; `out` gets them.
pub fn spawn(ctl: Receiver<Ctl>, out: futures::channel::mpsc::UnboundedSender<Frame>) {
    std::thread::Builder::new().name("rune-video".into()).spawn(move || run(ctl, out)).expect("video thread");
}

fn start(w: u32, h: u32) -> Option<Child> {
    let bin = ffmpeg().as_ref()?;
    let vf = format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={FPS}");
    Command::new(bin)
        .args(["-v", "error", "-nostdin", "-stream_loop", "-1", "-i"]).arg(path())
        .args(["-an", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "bgra", "-"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| eprintln!("rune: could not start ffmpeg for the video backdrop: {e}")).ok()
}

fn stop(child: &mut Option<Child>) {
    if let Some(mut c) = child.take() { let _ = c.kill(); let _ = c.wait(); }
}

fn run(ctl: Receiver<Ctl>, out: futures::channel::mpsc::UnboundedSender<Frame>) {
    let (mut size, mut live, mut child): (Option<(u32, u32)>, bool, Option<Child>) = (None, false, None);
    let step = Duration::from_secs_f64(1.0 / FPS);
    let mut next = Instant::now();
    let mut failures = 0u32;
    loop {
        // wait for a command; while frames are wanted, only until the next frame is due
        let msg = if live && size.is_some() {
            match ctl.recv_timeout(next.saturating_duration_since(Instant::now())) { Ok(m) => Some(m), Err(RecvTimeoutError::Timeout) => None, Err(_) => break }
        } else {
            match ctl.recv() { Ok(m) => Some(m), Err(_) => break }
        };
        match msg {
            Some(Ctl::Stop) => { stop(&mut child); size = None; continue }
            Some(Ctl::Size(w, h)) => { if size != Some((w, h)) { stop(&mut child); size = Some((w, h)); failures = 0; } continue }
            Some(Ctl::Live(l)) => { if l && !live { next = Instant::now(); } live = l; continue }
            None => {}
        }
        let Some((w, h)) = size else { continue };
        if child.is_none() {
            if failures > 3 { live = false; continue } // (a broken file: give up until the size or mode changes)
            child = start(w, h);
            if child.is_none() { failures += 1; continue }
        }
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let ok = child.as_mut().and_then(|c| c.stdout.as_mut()).map(|s| s.read_exact(&mut buf).is_ok()).unwrap_or(false);
        if !ok { stop(&mut child); failures += 1; continue }
        failures = 0;
        if out.unbounded_send(Frame { w, h, bgra: buf }).is_err() { break }
        next += step;
        if next < Instant::now() { next = Instant::now() + step; } // (fell behind: don't rush to catch up)
    }
    stop(&mut child);
}

#[cfg(test)]
mod tests {
    use super::decode_size;
    #[test]
    fn decodes_at_most_1920_wide_and_even() {
        assert_eq!(decode_size(1280, 800), (1280, 800));
        assert_eq!(decode_size(3840, 2160), (1920, 1080));
        let (w, h) = decode_size(2561, 1441);
        assert!(w <= 1920 && w % 2 == 0 && h % 2 == 0);
    }
}
