//! The sound: one thread that decodes (symphonia), converts (rubato) and feeds a ring buffer, and an output that drains it
//! (cpal on the default device, or a silent real-time clock for tests: RUNE_DESKTOP_AUDIO=null). It runs a song, and
//! when that song's last frame has been pushed it opens the next one of `upcoming` and goes on without a gap.
use super::pipeline::*;
use super::source::HttpSource;
use super::{AudioEvent, Engine, TrackRef};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rune_mini_core::net::Client;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

enum Cmd {
    Load { key: String, id: String, start_ms: f64, autoplay: bool, upcoming: Vec<TrackRef> },
    SetUpcoming(Vec<TrackRef>),
    Play,
    Pause,
    Seek(f64),
    Stop,
    Quit,
}

struct Shared {
    /// the position of the song being heard, f64 bits; NaN = unknown
    pos_ms: AtomicU64,
    volume: AtomicU32,
}

pub struct RealEngine {
    tx: Sender<Cmd>,
    shared: Arc<Shared>,
}

impl RealEngine {
    /// `null_output`: no sound card, a clock that eats frames at the pace of real playback (tests, headless runs).
    pub fn start(client: Client, events: Sender<AudioEvent>, null_output: bool) -> RealEngine {
        let (tx, rx) = channel();
        let shared = Arc::new(Shared { pos_ms: AtomicU64::new(f64::NAN.to_bits()), volume: AtomicU32::new(1f32.to_bits()) });
        let s2 = shared.clone();
        std::thread::Builder::new().name("rune-audio".into()).spawn(move || run(client, rx, events, s2, null_output)).ok();
        RealEngine { tx, shared }
    }
}

impl Drop for RealEngine {
    fn drop(&mut self) { let _ = self.tx.send(Cmd::Quit); }
}

impl Engine for RealEngine {
    fn load(&mut self, track: &TrackRef, start_ms: f64, autoplay: bool, upcoming: &[TrackRef]) {
        let _ = self.tx.send(Cmd::Load { key: track.key.clone(), id: track.id.clone(), start_ms, autoplay, upcoming: upcoming.to_vec() });
    }
    fn set_upcoming(&mut self, upcoming: &[TrackRef]) { let _ = self.tx.send(Cmd::SetUpcoming(upcoming.to_vec())); }
    fn play(&mut self) { let _ = self.tx.send(Cmd::Play); }
    fn pause(&mut self) { let _ = self.tx.send(Cmd::Pause); }
    fn seek(&mut self, ms: f64) { let _ = self.tx.send(Cmd::Seek(ms)); }
    fn set_volume(&mut self, v: f64) { self.shared.volume.store(((v / 100.).clamp(0., 1.) as f32).to_bits(), Ordering::Relaxed); }
    fn position(&self) -> Option<f64> { let p = f64::from_bits(self.shared.pos_ms.load(Ordering::Relaxed)); if p.is_nan() { None } else { Some(p) } }
    fn stop(&mut self) { let _ = self.tx.send(Cmd::Stop); }
}

// ------------------------------------------------------------------ the output

enum Backend {
    Cpal(cpal::Stream),
    Null(Arc<AtomicBool>),
}

struct Output {
    backend: Backend,
    prod: HeapProd<f32>,
    rate: u32,
    ch: usize,
    consumed: Arc<AtomicU64>,
    flush_gen: Arc<AtomicU64>,
    flush_ack: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
}

impl Drop for Output {
    fn drop(&mut self) { if let Backend::Null(stop) = &self.backend { stop.store(true, Ordering::Relaxed); } }
}

/// The pieces the output side shares with its callback.
struct Side {
    cons: HeapCons<f32>,
    consumed: Arc<AtomicU64>,
    flush_gen: Arc<AtomicU64>,
    flush_ack: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    volume: Arc<Shared>,
    seen_gen: u64,
    ch: usize,
}

impl Side {
    /// Fill `data` (f32, interleaved, `self.ch` wide) from the ring; silence when paused or short.
    fn fill(&mut self, data: &mut [f32]) {
        let g = self.flush_gen.load(Ordering::Acquire);
        if g != self.seen_gen {
            let n = self.cons.clear();
            self.consumed.fetch_add((n / self.ch) as u64, Ordering::Relaxed);
            self.seen_gen = g;
            self.flush_ack.store(g, Ordering::Release);
        }
        if self.paused.load(Ordering::Relaxed) { data.fill(0.); return; }
        let n = self.cons.pop_slice(data);
        let vol = f32::from_bits(self.volume.volume.load(Ordering::Relaxed));
        for s in &mut data[..n] { *s *= vol; }
        data[n..].fill(0.);
        self.consumed.fetch_add((n / self.ch) as u64, Ordering::Relaxed);
    }
}

fn build_output(shared: &Arc<Shared>, want_rate: u32, null: bool) -> Result<Output, String> {
    let (rate, ch) = if null { (want_rate, 2) } else { pick_config(want_rate)? };
    let ring = HeapRb::<f32>::new(rate as usize * ch * 2);
    let (prod, cons) = ring.split();
    let (consumed, flush_gen, flush_ack, paused) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicBool::new(true)));
    let mut side = Side { cons, consumed: consumed.clone(), flush_gen: flush_gen.clone(), flush_ack: flush_ack.clone(), paused: paused.clone(), volume: shared.clone(), seen_gen: 0, ch };
    let backend = if null {
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::Builder::new().name("rune-null-out".into()).spawn(move || {
            let step = rate as usize / 100;
            let mut buf = vec![0f32; step * ch];
            while !s2.load(Ordering::Relaxed) { side.fill(&mut buf); std::thread::sleep(Duration::from_millis(10)); }
        }).ok();
        Backend::Null(stop)
    } else {
        Backend::Cpal(build_cpal(rate, ch, side)?)
    };
    Ok(Output { backend, prod, rate, ch, consumed, flush_gen, flush_ack, paused })
}

/// The stream's rate and channel count: the song's own rate when the device offers it (nothing to resample), else its default.
fn pick_config(want_rate: u32) -> Result<(u32, usize), String> {
    let host = cpal::default_host();
    let dev = host.default_output_device().ok_or("no sound output device")?;
    let ok = |f: cpal::SampleFormat| matches!(f, cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16);
    if let Ok(cfgs) = dev.supported_output_configs() {
        let mut best: Option<(u32, usize)> = None;
        for c in cfgs {
            if !ok(c.sample_format()) || c.channels() < 2 { continue; }
            if c.min_sample_rate().0 <= want_rate && want_rate <= c.max_sample_rate().0 {
                let ch = c.channels() as usize;
                if best.is_none_or(|b| ch < b.1) { best = Some((want_rate, ch)); }
            }
        }
        if let Some(b) = best { return Ok(b); }
    }
    let d = dev.default_output_config().map_err(|e| format!("sound output: {e}"))?;
    Ok((d.sample_rate().0, d.channels() as usize))
}

fn build_cpal(rate: u32, ch: usize, side: Side) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let dev = host.default_output_device().ok_or("no sound output device")?;
    let ok = |f: cpal::SampleFormat| matches!(f, cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16);
    let cfg = dev.supported_output_configs().map_err(|e| e.to_string())?
        .filter(|c| ok(c.sample_format()) && c.channels() as usize == ch && c.min_sample_rate().0 <= rate && rate <= c.max_sample_rate().0)
        .min_by_key(|c| (c.sample_format() != cpal::SampleFormat::F32) as u8)
        .ok_or("the sound device has no usable format")?.with_sample_rate(cpal::SampleRate(rate));
    let fmt = cfg.sample_format();
    let conf: cpal::StreamConfig = cfg.into();
    let err = |e: cpal::StreamError| eprintln!("audio stream: {e}");
    let stream = match fmt {
        cpal::SampleFormat::F32 => { let mut s = side; dev.build_output_stream(&conf, move |d: &mut [f32], _| s.fill(d), err, None) }
        cpal::SampleFormat::I16 => { let mut s = side; let mut tmp: Vec<f32> = vec![]; dev.build_output_stream(&conf, move |d: &mut [i16], _| { tmp.resize(d.len(), 0.); s.fill(&mut tmp); for (o, x) in d.iter_mut().zip(&tmp) { *o = (x.clamp(-1., 1.) * 32767.) as i16; } }, err, None) }
        _ => { let mut s = side; let mut tmp: Vec<f32> = vec![]; dev.build_output_stream(&conf, move |d: &mut [u16], _| { tmp.resize(d.len(), 0.); s.fill(&mut tmp); for (o, x) in d.iter_mut().zip(&tmp) { *o = ((x.clamp(-1., 1.) * 0.5 + 0.5) * 65535.) as u16; } }, err, None) }
    }.map_err(|e| format!("cannot open the sound device ({e})"))?;
    stream.play().map_err(|e| format!("cannot start the sound device ({e})"))?;
    Ok(stream)
}

impl Output {
    /// Drop whatever is buffered (the callback does it; we wait for it to say so).
    fn flush(&mut self) {
        let g = self.flush_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let t = std::time::Instant::now();
        while self.flush_ack.load(Ordering::Acquire) != g && t.elapsed() < Duration::from_millis(400) { std::thread::sleep(Duration::from_millis(2)); }
    }
}

// ------------------------------------------------------------------ the thread

struct Active {
    dec: Decoded,
    conv: Convert,
    gain: f32,
}

/// `ACCEPT` and the stream route: the original file, as the web's engine asks for it.
pub fn stream_path(id: &str, t_ms: Option<f64>) -> String {
    let base = format!("/api/stream/{}?fmt=orig&kbps=256&accept={}", rune_mini_core::commands::encode(id), ACCEPT);
    match t_ms { Some(t) if t > 0. => format!("{base}&t={}", t.round() as u64), _ => base }
}

fn open_track(client: &Client, id: &str, start_ms: f64, out_ch: usize, out_rate: Option<u32>) -> Result<Active, String> {
    let src = HttpSource::open(client, &stream_path(id, None))?;
    let mut dec = if src.is_live() && start_ms > 0. { Decoded::open(HttpSource::open(client, &stream_path(id, Some(start_ms)))?)? } else {
        let live = src.is_live();
        let mut d = Decoded::open(src)?;
        if start_ms > 0. && !live { d.seek_ms(start_ms)?; }
        d
    };
    let rate = out_rate.unwrap_or(dec.rate);
    let conv = Convert::new(dec.rate, rate, out_ch)?;
    let gain = std::mem::replace(&mut dec.gain, 1.);
    Ok(Active { dec, conv, gain })
}

fn run(client: Client, rx: Receiver<Cmd>, events: Sender<AudioEvent>, shared: Arc<Shared>, null: bool) {
    let mut out: Option<Output> = None;
    let mut cur: Option<(String, Active)> = None;
    let mut upcoming: Vec<TrackRef> = vec![];
    let mut tl = Timeline::default();
    let mut pushed: u64 = 0;
    let mut pending: Vec<f32> = vec![];
    let mut pend_at = 0usize;
    // the song being heard: kept so a seek can re-open it
    let mut heard: Option<TrackRef> = None;
    let mut want_play = false;

    macro_rules! hard_load { ($key:expr, $id:expr, $start:expr, $autoplay:expr) => {{
        let (key, id, start): (String, String, f64) = ($key, $id, $start);
        // open first (the rate decides the output), then flush and start
        let first = HttpSource::open(&client, &stream_path(&id, None)).and_then(|src| {
            let live = src.is_live();
            let mut d = if live && start > 0. { Decoded::open(HttpSource::open(&client, &stream_path(&id, Some(start)))?)? } else { Decoded::open(src)? };
            if start > 0. && !live { d.seek_ms(start)?; }
            Ok(d)
        });
        match first {
            Err(e) => { let _ = events.send(AudioEvent::Failed(key.clone(), e)); }
            Ok(mut dec) => {
                let rate_ok = out.as_ref().is_some_and(|o| o.rate == dec.rate);
                if !rate_ok || out.is_none() {
                    out = None;
                    match build_output(&shared, dec.rate, null) { Ok(o) => out = Some(o), Err(e) => { let _ = events.send(AudioEvent::Failed(key.clone(), e)); } }
                    pushed = 0;
                }
                if let Some(o) = out.as_mut() {
                    o.paused.store(true, Ordering::Relaxed);
                    o.flush();
                    pushed = o.consumed.load(Ordering::Relaxed);
                    pending.clear(); pend_at = 0;
                    tl.clear();
                    tl.begin(&key, pushed, start);
                    let gain = std::mem::replace(&mut dec.gain, 1.);
                    match Convert::new(dec.rate, o.rate, o.ch) {
                        Ok(conv) => { cur = Some((key.clone(), Active { dec, conv, gain })); heard = Some(TrackRef { key: key.clone(), id: id.clone() }); want_play = $autoplay; o.paused.store(!$autoplay, Ordering::Relaxed); }
                        Err(e) => { let _ = events.send(AudioEvent::Failed(key.clone(), e)); }
                    }
                }
            }
        }
    }}; }

    loop {
        let busy = cur.is_some() || pend_at < pending.len();
        let cmd = match rx.recv_timeout(Duration::from_millis(if busy { 4 } else { 60 })) {
            Ok(c) => Some(c),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let mut cmds: Vec<Cmd> = cmd.into_iter().collect();
        while let Ok(c) = rx.try_recv() { cmds.push(c); }
        for c in cmds {
            match c {
                Cmd::Quit => return,
                Cmd::SetUpcoming(u) => upcoming = u,
                Cmd::Play => { want_play = true; if let Some(o) = &out { o.paused.store(false, Ordering::Relaxed); } }
                Cmd::Pause => { want_play = false; if let Some(o) = &out { o.paused.store(true, Ordering::Relaxed); } }
                Cmd::Stop => {
                    cur = None; heard = None; tl.clear(); pending.clear(); pend_at = 0; want_play = false;
                    if let Some(o) = out.as_mut() { o.paused.store(true, Ordering::Relaxed); o.flush(); pushed = o.consumed.load(Ordering::Relaxed); }
                    shared.pos_ms.store(f64::NAN.to_bits(), Ordering::Relaxed);
                }
                Cmd::Load { key, id, start_ms, autoplay, upcoming: u } => {
                    upcoming = u;
                    if tl.holds(&key) && start_ms <= 0. {
                        // the song is already being played (the gapless step got there first): only the play state follows
                        if autoplay { want_play = true; if let Some(o) = &out { o.paused.store(false, Ordering::Relaxed); } }
                        continue;
                    }
                    hard_load!(key, id, start_ms, autoplay);
                }
                Cmd::Seek(ms) => {
                    if let Some(h) = heard.clone() { let play = want_play; hard_load!(h.key.clone(), h.id.clone(), ms, play); }
                }
            }
        }

        // ---- produce: push what is waiting, decode more while the ring has room
        if let Some(o) = out.as_mut() {
            for _ in 0..48 {
                if pend_at < pending.len() {
                    let n = o.prod.push_slice(&pending[pend_at..]);
                    pend_at += n;
                    pushed += (n / o.ch) as u64;
                    if pend_at < pending.len() { break; }
                    pending.clear(); pend_at = 0;
                }
                let Some((key, act)) = cur.as_mut() else { break };
                if o.prod.vacant_len() < 8192 * o.ch { break; }
                match act.dec.next_chunk() {
                    Ok(Some(chunk)) => {
                        let mixed = mix_channels(&chunk, act.dec.channels, o.ch);
                        let mut conv_out = Vec::with_capacity(mixed.len());
                        act.conv.push(&mixed, &mut conv_out);
                        if (act.gain - 1.).abs() > 1e-4 { for s in &mut conv_out { *s *= act.gain; } }
                        pending = conv_out; pend_at = 0;
                    }
                    other => {
                        // the end of this song (or its stream broke): flush the resampler, mark where it ends, go on to the next
                        let mut tail = Vec::new();
                        act.conv.finish(&mut tail);
                        if act.gain != 1. { for s in &mut tail { *s *= act.gain; } }
                        pending = tail; pend_at = 0;
                        if let Err(e) = other { eprintln!("audio: {e}"); }
                        let end = pushed + (pending.len() / o.ch) as u64;
                        tl.finish_last(end);
                        let _ = key;
                        cur = None;
                        // gapless: the next song starts right after this one's last frame
                        while !upcoming.is_empty() && cur.is_none() {
                            let next = upcoming.remove(0);
                            match open_track(&client, &next.id, 0., o.ch, Some(o.rate)) {
                                Ok(a) => { tl.begin(&next.key, end, 0.); cur = Some((next.key.clone(), a)); }
                                Err(e) => { eprintln!("audio: the next song did not open ({e})"); upcoming.clear(); }
                            }
                        }
                    }
                }
            }
        }

        // ---- what has been heard
        if let Some(o) = out.as_ref() {
            let consumed = o.consumed.load(Ordering::Relaxed);
            for key in tl.take_ended(consumed) { let _ = events.send(AudioEvent::Ended(key)); }
            let pos = tl.position(consumed, o.rate).map(|p| p.1).unwrap_or(f64::NAN);
            shared.pos_ms.store(pos.to_bits(), Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::channel;
    use std::time::Instant;

    /// A 16-bit stereo sine WAV of `secs` seconds.
    fn wav(rate: u32, secs: f64) -> Vec<u8> {
        let frames = (rate as f64 * secs) as usize;
        let mut data = Vec::with_capacity(frames * 4);
        for i in 0..frames {
            let v = ((i as f32 * 440. * std::f32::consts::TAU / rate as f32).sin() * 12000.) as i16;
            data.extend_from_slice(&v.to_le_bytes());
            data.extend_from_slice(&v.to_le_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    /// A tiny file server with byte ranges, like the rune stream route: /api/stream/<name>.
    fn serve(files: Vec<(&'static str, Vec<u8>)>) -> (String, Arc<AtomicU64>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let ranged = Arc::new(AtomicU64::new(0));
        let r2 = ranged.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let (files, r2) = (files.clone(), r2.clone());
                std::thread::spawn(move || {
                    let mut rd = BufReader::new(s.try_clone().unwrap());
                    let mut line = String::new();
                    rd.read_line(&mut line).ok();
                    let name = line.split_whitespace().nth(1).unwrap_or("").trim_start_matches("/api/stream/").split('?').next().unwrap_or("").to_string();
                    let mut range = None;
                    loop {
                        let mut h = String::new();
                        if rd.read_line(&mut h).unwrap_or(0) <= 2 { break; }
                        if let Some(v) = h.to_lowercase().strip_prefix("range: bytes=") { range = v.trim().trim_end_matches('-').parse::<usize>().ok(); }
                    }
                    let Some((_, body)) = files.iter().find(|f| f.0 == name) else { let _ = (&s).write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return };
                    let mut w = s;
                    match range {
                        Some(from) if from > 0 => {
                            r2.fetch_add(1, Ordering::Relaxed);
                            let part = &body[from.min(body.len())..];
                            let _ = write!(w, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n", from, body.len() - 1, body.len(), part.len());
                            let _ = w.write_all(part);
                        }
                        _ => {
                            let _ = write!(w, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n", body.len());
                            let _ = w.write_all(body);
                        }
                    }
                });
            }
        });
        (base, ranged)
    }

    fn wait_for(rx: &Receiver<AudioEvent>, secs: u64) -> Option<AudioEvent> { rx.recv_timeout(Duration::from_secs(secs)).ok() }

    #[::core::prelude::v1::test]
    fn two_songs_play_in_a_row_at_real_time_even_with_different_rates() {
        let (base, _) = serve(vec![("t1", wav(44100, 1.5)), ("t2", wav(48000, 1.0))]);
        let (tx, rx) = channel();
        let mut e = RealEngine::start(Client::new(&base, ""), tx, true);
        e.set_volume(100.);
        let t0 = Instant::now();
        e.load(&TrackRef { key: "k1".into(), id: "t1".into() }, 0., true, &[TrackRef { key: "k2".into(), id: "t2".into() }]);
        std::thread::sleep(Duration::from_millis(700));
        let p = e.position().expect("a position while playing");
        assert!((400. ..1100.).contains(&p), "position {p}");
        assert_eq!(wait_for(&rx, 5), Some(AudioEvent::Ended("k1".into())));
        let first = t0.elapsed().as_secs_f64();
        assert!((1.3..2.4).contains(&first), "k1 ended after {first}");
        // gapless: the next song is already playing when the TabPlayer asks for it
        e.load(&TrackRef { key: "k2".into(), id: "t2".into() }, 0., true, &[]);
        assert_eq!(wait_for(&rx, 5), Some(AudioEvent::Ended("k2".into())));
        let second = t0.elapsed().as_secs_f64();
        assert!((2.3..3.6).contains(&second), "k2 ended after {second}");
    }

    #[::core::prelude::v1::test]
    fn pause_holds_the_position_and_seek_uses_a_range_request() {
        let (base, ranged) = serve(vec![("t1", wav(44100, 3.0))]);
        let (tx, rx) = channel();
        let mut e = RealEngine::start(Client::new(&base, ""), tx, true);
        e.set_volume(100.);
        e.load(&TrackRef { key: "k1".into(), id: "t1".into() }, 2000., true, &[]);
        std::thread::sleep(Duration::from_millis(400));
        assert!(ranged.load(Ordering::Relaxed) >= 1, "the start offset needs a ranged read");
        e.pause();
        std::thread::sleep(Duration::from_millis(150));
        let held = e.position().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert!((e.position().unwrap() - held).abs() < 30., "paused");
        assert!((2000. ..2700.).contains(&held), "held at {held}");
        e.seek(500.);
        std::thread::sleep(Duration::from_millis(300));
        let p = e.position().unwrap();
        assert!((450. ..800.).contains(&p), "after the seek {p}");
        e.play();
        assert_eq!(wait_for(&rx, 6), Some(AudioEvent::Ended("k1".into())));
    }

    #[::core::prelude::v1::test]
    fn a_song_the_server_does_not_have_fails_with_its_key() {
        let (base, _) = serve(vec![]);
        let (tx, rx) = channel();
        let mut e = RealEngine::start(Client::new(&base, ""), tx, true);
        e.load(&TrackRef { key: "kx".into(), id: "nope".into() }, 0., true, &[]);
        match wait_for(&rx, 5) { Some(AudioEvent::Failed(k, m)) => { assert_eq!(k, "kx"); assert!(!m.is_empty()); } other => panic!("{other:?}") }
    }
}
