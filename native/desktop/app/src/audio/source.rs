//! An HTTP audio stream as a seekable byte source for symphonia: sequential reads, and a seek re-opens the request with a
//! `Range` header (the server sends the original file with byte ranges; a live transcode has no length and cannot seek).
use rune_mini_core::net::Client;
use std::io::{self, Read, Seek, SeekFrom};
use symphonia::core::io::MediaSource;

pub struct HttpSource {
    client: Client,
    path: String,
    pos: u64,
    total: Option<u64>,
    live: bool,
    reader: Option<Box<dyn Read + Send + Sync>>,
    pub gain_db: Option<f64>,
}

impl HttpSource {
    pub fn open(client: &Client, path: &str) -> Result<HttpSource, String> {
        let r = client.open_stream(path, 0)?;
        Ok(HttpSource { client: client.clone(), path: path.to_string(), pos: r.start, total: r.total, live: r.live, reader: Some(r.reader), gain_db: r.gain_db })
    }
    pub fn is_live(&self) -> bool { self.live || self.total.is_none() }
}

impl Read for HttpSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.reader.is_none() {
            let r = self.client.open_stream(&self.path, self.pos).map_err(io::Error::other)?;
            // a server that ignored Range sent the file from its start: skip forward to where we are
            let mut reader = r.reader;
            if r.start < self.pos { io::copy(&mut (&mut reader).take(self.pos - r.start), &mut io::sink())?; }
            self.reader = Some(reader);
        }
        let n = self.reader.as_mut().map(|r| r.read(buf)).unwrap_or(Ok(0))?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpSource {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => match self.total { Some(t) => t as i128 + d as i128, None => return Err(io::Error::new(io::ErrorKind::Unsupported, "stream length unknown")) },
        };
        if target < 0 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before the start")); }
        let target = target as u64;
        if target != self.pos {
            if self.live { return Err(io::Error::new(io::ErrorKind::Unsupported, "a live stream cannot seek")); }
            self.reader = None;
            self.pos = target;
        }
        Ok(self.pos)
    }
}

impl MediaSource for HttpSource {
    fn is_seekable(&self) -> bool { !self.is_live() }
    fn byte_len(&self) -> Option<u64> { self.total }
}
