//! Cover pictures: fetched and DECODED on worker threads (never the UI thread), kept in a byte-budgeted LRU keyed by
//! (album id, server size), and dropped from GPUI's sprite atlas when evicted so scrolling thousands of covers does not
//! grow the GPU's memory. Like the web's `<img srcset>` the caller picks the server size (200 or 600) from the size it draws.
//!
//! Jobs are a LIFO stack: the cover that was asked for last (what is on screen now) is fetched first, and a job whose
//! cover was not drawn in the last 30 frames (the user scrolled past it) is dropped without a request.
use futures::channel::mpsc::UnboundedSender;
use gpui_kit::*;
use rune_mini_core::library::cover_path;
use rune_mini_core::net::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

pub type Key = (String, u16);

fn failed_set() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

/// Test hook (`RUNE_DESKTOP_GEN_COVERS=1`): every album counts as having no picture, to look at the generative covers.
pub fn force_gen() -> bool { static F: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *F.get_or_init(|| std::env::var_os("RUNE_DESKTOP_GEN_COVERS").is_some()) }

/// Did the server have no picture for this album? Like the web's `onError`: it then wears a generative cover.
pub fn is_failed(id: &str) -> bool { if force_gen() { return true; } failed_set().lock().map(|f| f.contains(id)).unwrap_or(false) }

pub struct Done {
    pub key: Key,
    pub img: Option<Arc<RenderImage>>,
    pub bytes: usize,
    /// Never fetched: the cover was scrolled past while it waited.
    pub stale: bool,
}

struct Job {
    key: Key,
    path: String,
    target: u32,
    frame: u64,
}

#[derive(Default)]
struct Shared {
    jobs: Mutex<Vec<Job>>,
    cv: Condvar,
    frame: AtomicU64,
    /// Last frame each waiting cover was drawn in.
    seen: Mutex<HashMap<Key, u64>>,
}

enum State {
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
}

struct Entry {
    state: State,
    bytes: usize,
    tick: u64,
}

pub struct Covers {
    shared: Arc<Shared>,
    map: HashMap<Key, Entry>,
    bytes: usize,
    tick: u64,
    budget: usize,
    pub requested: u64,
    pub fetched: u64,
}

const WORKERS: usize = 6;
const STALE_FRAMES: u64 = 30;

impl Covers {
    pub fn new(client: Client, tx: UnboundedSender<Done>, budget_mb: usize) -> Covers {
        let shared = Arc::new(Shared::default());
        for i in 0..WORKERS {
            let (sh, c, tx) = (shared.clone(), client.clone(), tx.clone());
            std::thread::Builder::new().name(format!("rune-cover-{i}")).spawn(move || worker(sh, c, tx)).ok();
        }
        Covers { shared, map: HashMap::new(), bytes: 0, tick: 0, budget: budget_mb << 20, requested: 0, fetched: 0 }
    }

    pub fn begin_frame(&mut self) {
        self.shared.frame.fetch_add(1, Ordering::Relaxed);
    }

    /// The picture, or None while it loads (it is requested now) or when there is none.
    pub fn get(&mut self, id: &str, cover_url: Option<&str>, size: u16, target_px: u32) -> Option<Arc<RenderImage>> {
        let key = (id.to_string(), size);
        self.tick += 1;
        let frame = self.shared.frame.load(Ordering::Relaxed);
        if let Some(e) = self.map.get_mut(&key) {
            e.tick = self.tick;
            return match &e.state {
                State::Ready(i) => Some(i.clone()),
                State::Loading => {
                    if let Ok(mut s) = self.shared.seen.lock() { s.insert(key, frame); }
                    None
                }
                State::Failed => None,
            };
        }
        self.map.insert(key.clone(), Entry { state: State::Loading, bytes: 0, tick: self.tick });
        self.requested += 1;
        let path = cover_path(id, cover_url, &size.to_string());
        if let Ok(mut s) = self.shared.seen.lock() { s.insert(key.clone(), frame); }
        if let Ok(mut j) = self.shared.jobs.lock() { j.push(Job { key, path, target: target_px, frame }); }
        self.shared.cv.notify_one();
        None
    }

    /// Is a cover decoded and held (no request is made)?
    pub fn has(&self, id: &str, size: u16) -> bool {
        matches!(self.map.get(&(id.to_string(), size)), Some(Entry { state: State::Ready(_), .. }))
    }

    pub fn apply(&mut self, d: Done) {
        if d.stale {
            if let Some(e) = self.map.remove(&d.key) { self.bytes -= e.bytes; }
            return;
        }
        self.fetched += 1;
        if let Ok(mut f) = failed_set().lock() { if d.img.is_some() { f.remove(&d.key.0); } else { f.insert(d.key.0.clone()); } }
        let tick = self.tick;
        let e = self.map.entry(d.key).or_insert(Entry { state: State::Loading, bytes: 0, tick });
        self.bytes -= e.bytes;
        e.bytes = d.bytes;
        self.bytes += d.bytes;
        e.state = match d.img { Some(i) => State::Ready(i), None => State::Failed };
    }

    /// Over budget: forget the least recently drawn pictures, also from the GPU atlas.
    pub fn evict(&mut self, window: &mut Window) {
        if self.bytes <= self.budget {
            return;
        }
        let mut ready: Vec<(u64, Key)> = self.map.iter().filter(|(_, e)| matches!(e.state, State::Ready(_))).map(|(k, e)| (e.tick, k.clone())).collect();
        ready.sort();
        let target = self.budget * 3 / 4;
        for (_, k) in ready {
            if self.bytes <= target { break; }
            if let Some(e) = self.map.remove(&k) {
                self.bytes -= e.bytes;
                if let State::Ready(i) = e.state { let _ = window.drop_image(i); }
            }
        }
    }

    pub fn held(&self) -> (usize, usize) {
        (self.map.values().filter(|e| matches!(e.state, State::Ready(_))).count(), self.bytes)
    }
}

fn worker(sh: Arc<Shared>, client: Client, tx: UnboundedSender<Done>) {
    loop {
        let job = {
            let mut jobs = sh.jobs.lock().unwrap();
            loop {
                if let Some(j) = jobs.pop() { break j; }
                jobs = sh.cv.wait(jobs).unwrap();
            }
        };
        let now = sh.frame.load(Ordering::Relaxed);
        let seen = sh.seen.lock().ok().and_then(|s| s.get(&job.key).copied()).unwrap_or(job.frame);
        if now.saturating_sub(seen) > STALE_FRAMES {
            if let Ok(mut s) = sh.seen.lock() { s.remove(&job.key); }
            let _ = tx.unbounded_send(Done { key: job.key, img: None, bytes: 0, stale: true });
            continue;
        }
        let done = match client.image(&job.path).ok().and_then(|b| decode(&b, job.target)) {
            Some((img, bytes)) => Done { key: job.key.clone(), img: Some(img), bytes, stale: false },
            None => Done { key: job.key.clone(), img: None, bytes: 0, stale: false },
        };
        if let Ok(mut s) = sh.seen.lock() { s.remove(&job.key); }
        let _ = tx.unbounded_send(done);
    }
}

/// Decode and, only when the picture is much bigger than where it is drawn, shrink it. GPUI wants BGRA.
pub fn decode(bytes: &[u8], target_px: u32) -> Option<(Arc<RenderImage>, usize)> {
    let mut img = image::load_from_memory(bytes).ok()?;
    let t = target_px.max(32);
    if img.width() > t * 5 / 4 || img.height() > t * 5 / 4 {
        img = img.resize(t, t, image::imageops::FilterType::Triangle);
    }
    let mut rgba = img.to_rgba8();
    for p in rgba.pixels_mut() { p.0.swap(0, 2); }
    let n = rgba.as_raw().len();
    Some((Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)])), n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 30, 30, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    #[::core::prelude::v1::test]
    fn a_small_picture_is_kept_as_it_is_and_swapped_to_bgra() {
        let (img, n) = decode(&png(200, 200), 200).unwrap();
        assert_eq!(n, 200 * 200 * 4);
        let px = img.as_bytes(0).unwrap();
        assert_eq!(&px[0..4], &[30, 30, 200, 255]);
    }

    #[::core::prelude::v1::test]
    fn a_picture_much_bigger_than_its_slot_is_shrunk() {
        let (_, n) = decode(&png(600, 600), 200).unwrap();
        assert_eq!(n, 200 * 200 * 4);
        let (_, n) = decode(&png(600, 600), 600).unwrap();
        assert_eq!(n, 600 * 600 * 4);
    }

    #[::core::prelude::v1::test]
    fn garbage_is_none() {
        assert!(decode(b"not an image", 200).is_none());
    }
}
