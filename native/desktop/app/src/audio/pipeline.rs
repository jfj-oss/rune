//! The pure parts of the audio engine: decoding one stream with symphonia, mixing to the output's channels, resampling with
//! rubato, and the timeline that turns "frames the device has consumed" into "which song, how far in".
use super::source::HttpSource;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use std::collections::VecDeque;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// The source kinds symphonia decodes here; the server transcodes anything else (opus, wma) to AAC.
pub const ACCEPT: &str = "flac,mp3,aac,m4a,wav,aiff,vorbis";

/// One opened stream, ready to give interleaved f32 chunks.
pub struct Decoded {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    pub rate: u32,
    pub channels: usize,
    buf: Option<SampleBuffer<f32>>,
    /// frames still to throw away after an accurate seek landed before the wanted time
    skip: u64,
    pub gain: f32,
}

impl Decoded {
    pub fn open(src: HttpSource) -> Result<Decoded, String> {
        let gain = src.gain_db.map(|db| 10f64.powf(db / 20.).clamp(0.05, 4.) as f32).unwrap_or(1.);
        let mss = MediaSourceStream::new(Box::new(src), Default::default());
        let probed = symphonia::default::get_probe().format(&Hint::new(), mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default()).map_err(|e| format!("cannot read this file ({e})"))?;
        let reader = probed.format;
        let track = reader.tracks().iter().find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL).ok_or("no audio in this file")?;
        let track_id = track.id;
        let rate = track.codec_params.sample_rate.ok_or("unknown sample rate")?;
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2).max(1);
        let decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| format!("cannot play this format ({e})"))?;
        Ok(Decoded { reader, decoder, track_id, rate, channels, buf: None, skip: 0, gain })
    }

    pub fn seek_ms(&mut self, ms: f64) -> Result<(), String> {
        let secs = (ms / 1000.).max(0.);
        let to = SeekTo::Time { time: Time::new(secs.trunc() as u64, secs.fract()), track_id: Some(self.track_id) };
        let seeked = self.reader.seek(SeekMode::Accurate, to).map_err(|e| format!("cannot seek ({e})"))?;
        self.decoder.reset();
        self.skip = seeked.required_ts.saturating_sub(seeked.actual_ts);
        Ok(())
    }

    /// The next decoded chunk (interleaved, `channels` wide), or None at the end of the stream.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(SymError::ResetRequired) => return Ok(None),
                Err(e) => return Err(format!("the stream broke ({e})")),
            };
            if packet.track_id() != self.track_id { continue; }
            match self.decoder.decode(&packet) {
                Ok(audio) => {
                    let spec = *audio.spec();
                    let need = audio.capacity() as u64;
                    if self.buf.as_ref().is_none_or(|b| (b.capacity() as u64) < need * spec.channels.count() as u64) { self.buf = Some(SampleBuffer::new(need, spec)); }
                    let b = self.buf.as_mut().unwrap();
                    b.copy_interleaved_ref(audio);
                    let ch = spec.channels.count().max(1);
                    self.channels = ch;
                    let mut s = b.samples().to_vec();
                    if self.skip > 0 {
                        let frames = (s.len() / ch) as u64;
                        let drop = self.skip.min(frames);
                        s.drain(..(drop as usize) * ch);
                        self.skip -= drop;
                        if s.is_empty() { continue; }
                    }
                    if s.is_empty() { continue; }
                    return Ok(Some(s));
                }
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(format!("cannot decode ({e})")),
            }
        }
    }
}

/// Source channels -> `out_ch` interleaved: mono is copied to every channel, stereo kept, more than two folded onto the front two.
pub fn mix_channels(inp: &[f32], src_ch: usize, out_ch: usize) -> Vec<f32> {
    if src_ch == out_ch { return inp.to_vec(); }
    let frames = inp.len() / src_ch.max(1);
    let mut out = vec![0f32; frames * out_ch];
    for f in 0..frames {
        let s = &inp[f * src_ch..(f + 1) * src_ch];
        let (l, r) = match src_ch {
            1 => (s[0], s[0]),
            2 => (s[0], s[1]),
            _ => {
                // front pair plus the centre and surround folded in (-3 dB), a plain stereo downmix
                let c = s.get(2).copied().unwrap_or(0.) * 0.707;
                let (sl, sr) = (s.get(4).copied().unwrap_or(0.) * 0.707, s.get(5).copied().unwrap_or(0.) * 0.707);
                ((s[0] + c + sl) * 0.6, (s[1] + c + sr) * 0.6)
            }
        };
        match out_ch {
            1 => out[f] = (l + r) * 0.5,
            _ => { out[f * out_ch] = l; out[f * out_ch + 1] = r; }
        }
    }
    out
}

/// Sample-rate conversion of interleaved audio, streaming: feed any amount, take what is ready.
pub struct Convert {
    ch: usize,
    rs: Option<SincFixedIn<f32>>,
    ratio: f64,
    pend: Vec<Vec<f32>>,
}

impl Convert {
    pub fn new(src_rate: u32, out_rate: u32, ch: usize) -> Result<Convert, String> {
        let rs = if src_rate == out_rate { None } else {
            let p = SincInterpolationParameters { sinc_len: 128, f_cutoff: 0.95, interpolation: SincInterpolationType::Linear, oversampling_factor: 128, window: WindowFunction::BlackmanHarris2 };
            Some(SincFixedIn::<f32>::new(out_rate as f64 / src_rate as f64, 1.0, p, 1024, ch).map_err(|e| format!("resampler: {e}"))?)
        };
        Ok(Convert { ch, rs, ratio: out_rate as f64 / src_rate as f64, pend: vec![Vec::new(); ch] })
    }

    pub fn is_passthrough(&self) -> bool { self.rs.is_none() }

    /// Feed interleaved frames; appends converted interleaved frames to `out`.
    pub fn push(&mut self, inp: &[f32], out: &mut Vec<f32>) {
        let Some(rs) = self.rs.as_mut() else { out.extend_from_slice(inp); return };
        for (i, s) in inp.iter().enumerate() { self.pend[i % self.ch].push(*s); }
        loop {
            let need = rs.input_frames_next();
            if self.pend[0].len() < need { break; }
            let chunk: Vec<Vec<f32>> = self.pend.iter_mut().map(|p| p.drain(..need).collect()).collect();
            if let Ok(res) = rs.process(&chunk, None) { interleave(&res, out); }
        }
    }

    /// The end of a song: the frames still waiting, padded with silence to a full chunk (then trimmed to their share).
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        let Some(rs) = self.rs.as_mut() else { return };
        let left = self.pend[0].len();
        if left == 0 { return; }
        let need = rs.input_frames_next();
        let chunk: Vec<Vec<f32>> = self.pend.iter_mut().map(|p| { let mut v: Vec<f32> = p.drain(..).collect(); v.resize(need, 0.); v }).collect();
        if let Ok(res) = rs.process(&chunk, None) {
            let keep = ((left as f64) * self.ratio).round() as usize;
            let mut tmp = Vec::new();
            interleave(&res, &mut tmp);
            tmp.truncate(keep.min(tmp.len() / self.ch) * self.ch);
            out.extend(tmp);
        }
    }
}

fn interleave(res: &[Vec<f32>], out: &mut Vec<f32>) {
    let n = res.first().map(|c| c.len()).unwrap_or(0);
    out.reserve(n * res.len());
    for i in 0..n { for c in res { out.push(c[i]); } }
}

// ------------------------------------------------------------------ the timeline

/// One song's span in the stream of frames pushed to the device: where it starts (frames pushed before it), where in the
/// song that is, and where it ends once the whole song is pushed.
#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub key: String,
    pub start_total: u64,
    pub start_ms: f64,
    pub end_total: Option<u64>,
}

#[derive(Default, Debug)]
pub struct Timeline {
    marks: VecDeque<Mark>,
}

impl Timeline {
    pub fn clear(&mut self) { self.marks.clear(); }
    pub fn begin(&mut self, key: &str, start_total: u64, start_ms: f64) { self.marks.push_back(Mark { key: key.to_string(), start_total, start_ms, end_total: None }); }
    /// The newest song is fully pushed: it ends at `end_total`.
    pub fn finish_last(&mut self, end_total: u64) { if let Some(m) = self.marks.back_mut() { if m.end_total.is_none() { m.end_total = Some(end_total); } } }
    pub fn holds(&self, key: &str) -> bool { self.marks.iter().any(|m| m.key == key) }
    /// The song being heard when the device has consumed `consumed` frames, and how far in (ms).
    pub fn position(&self, consumed: u64, rate: u32) -> Option<(String, f64)> {
        let m = self.marks.front()?;
        let frames = consumed.saturating_sub(m.start_total) as f64;
        Some((m.key.clone(), m.start_ms + frames / rate.max(1) as f64 * 1000.))
    }
    /// Songs whose last frame has been consumed (oldest first); they leave the timeline.
    pub fn take_ended(&mut self, consumed: u64) -> Vec<String> {
        let mut out = vec![];
        while self.marks.front().is_some_and(|m| m.end_total.is_some_and(|e| e <= consumed)) { if let Some(m) = self.marks.pop_front() { out.push(m.key); } }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn mono_is_copied_and_surround_is_folded_to_stereo() {
        assert_eq!(mix_channels(&[0.5, 0.25], 1, 2), vec![0.5, 0.5, 0.25, 0.25]);
        assert_eq!(mix_channels(&[0.1, 0.2], 2, 2), vec![0.1, 0.2]);
        let six = mix_channels(&[1., 0., 0., 0., 0., 0.], 6, 2);
        assert!(six[0] > 0.5 && six[1] == 0.);
    }

    #[::core::prelude::v1::test]
    fn the_timeline_tracks_song_boundaries_by_consumed_frames() {
        let mut t = Timeline::default();
        t.begin("a", 0, 5000.);
        t.finish_last(44100);
        t.begin("b", 44100, 0.);
        assert_eq!(t.position(22050, 44100), Some(("a".into(), 5500.)));
        assert!(t.take_ended(44099).is_empty());
        assert_eq!(t.take_ended(44100), vec!["a".to_string()]);
        assert_eq!(t.position(44100 + 44100, 44100), Some(("b".into(), 1000.)));
        assert!(t.holds("b") && !t.holds("a"));
    }

    #[::core::prelude::v1::test]
    fn the_resampler_makes_about_the_right_number_of_frames() {
        let mut c = Convert::new(44100, 48000, 2).unwrap();
        let mut out = vec![];
        let inp: Vec<f32> = (0..44100 * 2).map(|i| ((i / 2) as f32 * 0.05).sin() * 0.5).collect();
        c.push(&inp, &mut out);
        c.finish(&mut out);
        let frames = out.len() / 2;
        assert!((frames as i64 - 48000).abs() < 600, "got {frames}");
        assert!(Convert::new(48000, 48000, 2).unwrap().is_passthrough());
    }
}
