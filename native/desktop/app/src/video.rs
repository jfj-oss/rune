//! The "Video loop" backdrop: a short video file played on repeat behind the app.
//!
//! The file is `<data dir>/backdrop.mp4` (or `RUNE_DESKTOP_VIDEO=<path>`). It is never bundled: each person puts their own there.
//! `ffmpeg` decodes it on a worker thread as BGRA frames AT THE CLIP'S OWN SIZE (no per-frame scaling: the GPU fits the picture
//! to the window), on one thread, at most [`MAX_FPS`] frames a second. A clip wider than [`MAX_W`] is the one case that is
//! scaled. The worker paces the frames and only while the backdrop is live; paused, it stops reading, which holds ffmpeg still
//! on its pipe. No ffmpeg or no file: the backdrop falls back to Foil waves.
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The most frames a second shown (a faster clip has frames dropped by ffmpeg; the slow-moving loops this is for look the same).
pub const MAX_FPS: f64 = 20.0;
/// The widest frame decoded; a wider clip is scaled down once per frame by ffmpeg (better: cut the clip to this size).
pub const MAX_W: u32 = 1920;
/// How often one ffmpeg plays the clip before it ends by itself (the worker then starts another). Never endless: an ffmpeg left
/// behind by a crash was once found reading an endless loop at two full cores with nobody taking its frames.
const LOOPS: &str = "720";

pub fn path() -> PathBuf {
    std::env::var_os("RUNE_DESKTOP_VIDEO").map(PathBuf::from).unwrap_or_else(|| crate::crashlog::data_dir().join("backdrop.mp4"))
}

fn ffmpeg() -> &'static Option<PathBuf> {
    static F: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        // (a Mac app does not get Homebrew's folders on its PATH)
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
        // (and a copy the person put in their own folder, no admin rights needed)
        if let Some(h) = std::env::var_os("HOME") { dirs.push(PathBuf::from(h).join(".local/bin")); }
        dirs.into_iter().map(|d| d.join("ffmpeg")).find(|f| f.is_file())
    })
}

/// Can the video backdrop be drawn (the file is there and ffmpeg is installed)?
pub fn available() -> bool { ffmpeg().is_some() && path().is_file() }

/// What ffmpeg says about the clip's picture: (width, height, frames a second), from the "Video:" line of `ffmpeg -i`.
pub fn parse_probe(text: &str) -> Option<(u32, u32, f64)> {
    let line = text.lines().find(|l| l.contains("Video:"))?;
    let size = line.split([',', ' ']).find_map(|t| {
        let (a, b) = t.split_once('x')?;
        Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?))
    })?;
    let fps = line.split(',').find_map(|t| t.trim().strip_suffix(" fps")?.trim().parse::<f64>().ok()).unwrap_or(30.0);
    Some((size.0, size.1, fps))
}

fn probe() -> Option<(u32, u32, f64)> {
    let bin = ffmpeg().as_ref()?;
    let out = Command::new(bin).args(["-hide_banner", "-nostdin", "-i"]).arg(path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output().ok()?;
    parse_probe(&String::from_utf8_lossy(&out.stderr))
}

/// The decoded frame size and rate for a clip of `w` x `h` at `fps`: its own size (at most [`MAX_W`] wide, even numbers) and
/// at most [`MAX_FPS`].
pub fn plan(w: u32, h: u32, fps: f64) -> (u32, u32, f64) {
    let k = (MAX_W as f64 / w.max(1) as f64).min(1.0);
    let even = |v: f64| ((v.round() as u32).max(2) + 1) & !1;
    let (dw, dh) = if k < 1.0 { (even(w as f64 * k), even(h as f64 * k)) } else { (w, h) };
    (dw, dh, if fps.is_finite() && fps > 0.0 { fps.min(MAX_FPS) } else { MAX_FPS })
}

pub enum Ctl { Start, Live(bool), Stop }
pub struct Frame { pub w: u32, pub h: u32, pub bgra: Vec<u8> }

/// The worker: `ctl` says when to run and whether frames are wanted; `out` gets them.
pub fn spawn(ctl: Receiver<Ctl>, out: futures::channel::mpsc::UnboundedSender<Frame>) {
    std::thread::Builder::new().name("rune-video".into()).spawn(move || run(ctl, out)).expect("video thread");
}

fn start(src: (u32, u32, f64), dst: (u32, u32, f64)) -> Option<Child> {
    let bin = ffmpeg().as_ref()?;
    let mut filters = vec![];
    if (dst.0, dst.1) != (src.0, src.1) { filters.push(format!("scale={}:{}", dst.0, dst.1)); }
    if dst.2 + 0.01 < src.2 { filters.push(format!("fps={}", dst.2)); }
    let mut cmd = Command::new(bin);
    // one decoding thread and one filter thread: a few small frames a second need no more, and each extra thread holds frames
    cmd.args(["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-stream_loop", LOOPS, "-i"]).arg(path()).arg("-an");
    if !filters.is_empty() { cmd.args(["-vf", &filters.join(",")]); }
    die_with_us(&mut cmd);
    cmd.args(["-f", "rawvideo", "-pix_fmt", "bgra", "-"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| eprintln!("rune: could not start ffmpeg for the video backdrop: {e}")).ok()
}

/// Linux: ffmpeg is killed when the worker thread that started it ends, however rune ends (quit, crash, kill).
#[cfg(target_os = "linux")]
fn die_with_us(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl and getppid only make system calls, which is allowed between fork and exec
    let parent = std::process::id() as libc::pid_t;
    unsafe {
        cmd.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 { return Err(std::io::Error::last_os_error()); }
            if libc::getppid() != parent { return Err(std::io::Error::other("rune is gone")); }
            Ok(())
        });
    }
}
#[cfg(not(target_os = "linux"))]
fn die_with_us(_: &mut Command) {}

fn stop(child: &mut Option<Child>) {
    if let Some(mut c) = child.take() { let _ = c.kill(); let _ = c.wait(); }
}

fn run(ctl: Receiver<Ctl>, out: futures::channel::mpsc::UnboundedSender<Frame>) {
    let (mut on, mut live, mut child): (bool, bool, Option<Child>) = (false, false, None);
    let mut clip: Option<((u32, u32, f64), (u32, u32, f64))> = None;
    let mut next = Instant::now();
    let mut failures = 0u32;
    loop {
        // wait for a command; while frames are wanted, only until the next frame is due
        let msg = if live && on {
            match ctl.recv_timeout(next.saturating_duration_since(Instant::now())) { Ok(m) => Some(m), Err(RecvTimeoutError::Timeout) => None, Err(_) => break }
        } else {
            match ctl.recv() { Ok(m) => Some(m), Err(_) => break }
        };
        match msg {
            Some(Ctl::Stop) => { stop(&mut child); on = false; clip = None; continue }
            Some(Ctl::Start) => { if !on { on = true; failures = 0; } continue }
            Some(Ctl::Live(l)) => { if l && !live { next = Instant::now(); } live = l; continue }
            None => {}
        }
        if failures > 3 { live = false; continue } // (a broken file: give up until the mode changes)
        let (src, dst) = match clip {
            Some(c) => c,
            None => match probe() { Some(s) => { let c = (s, plan(s.0, s.1, s.2)); clip = Some(c); c } None => { failures += 1; continue } },
        };
        if child.is_none() {
            child = start(src, dst);
            if child.is_none() { failures += 1; continue }
        }
        let (w, h) = (dst.0, dst.1);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let ok = child.as_mut().and_then(|c| c.stdout.as_mut()).map(|s| s.read_exact(&mut buf).is_ok()).unwrap_or(false);
        if !ok { stop(&mut child); failures += 1; continue }
        failures = 0;
        if out.unbounded_send(Frame { w, h, bgra: buf }).is_err() { break }
        next += Duration::from_secs_f64(1.0 / dst.2);
        if next < Instant::now() { next = Instant::now() + Duration::from_secs_f64(1.0 / dst.2); } // (fell behind: don't rush)
    }
    stop(&mut child);
}

/// Where a `iw` x `ih` picture goes to cover `bw` x `bh` (centred, cropped, never stretched out of shape): (x, y, w, h).
pub fn cover(iw: f32, ih: f32, bw: f32, bh: f32) -> (f32, f32, f32, f32) {
    let k = (bw / iw.max(1.)).max(bh / ih.max(1.));
    let (w, h) = (iw * k, ih * k);
    ((bw - w) / 2., (bh - h) / 2., w, h)
}

#[cfg(test)]
mod tests {
    use super::{cover, parse_probe, plan};
    #[test]
    fn plays_the_clip_at_its_own_size_and_at_most_20_fps() {
        assert_eq!(plan(1920, 1080, 20.0), (1920, 1080, 20.0));
        assert_eq!(plan(1920, 1080, 60.0), (1920, 1080, 20.0));
        assert_eq!(plan(1280, 720, 15.0), (1280, 720, 15.0));
        let (w, h, _) = plan(3840, 2160, 30.0);
        assert_eq!((w, h), (1920, 1080));
    }
    #[test]
    fn reads_ffmpegs_video_line() {
        let t = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 10976 kb/s, 20 fps, 20 tbr, 10240 tbn (default)";
        assert_eq!(parse_probe(t), Some((1920, 1080, 20.0)));
        assert_eq!(parse_probe("Video: vp9, yuv420p, 640x360, 29.97 fps"), Some((640, 360, 29.97)));
        assert_eq!(parse_probe("nothing here"), None);
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn the_child_dies_with_the_thread_that_started_it() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let mut child = std::thread::spawn(|| {
            let mut c = Command::new("sleep");
            c.arg("60").stdin(Stdio::null()).stdout(Stdio::null());
            super::die_with_us(&mut c);
            c.spawn().unwrap()
        }).join().unwrap();
        let t = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() { break }
            if t.elapsed() > Duration::from_secs(10) { let _ = child.kill(); panic!("still running"); }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    #[test]
    fn covers_without_stretching() {
        let (x, y, w, h) = cover(1920., 1080., 1000., 1000.);
        assert!((h - 1000.).abs() < 0.01 && (w - 1777.78).abs() < 0.1 && x < 0. && y.abs() < 0.01);
    }
}
