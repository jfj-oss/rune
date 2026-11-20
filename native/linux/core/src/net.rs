//! The network side: one websocket thread (reconnect with backoff, keepalive ping, near-zero idle cost) and one worker
//! thread that runs REST jobs in order. Everything the app learns comes back through one callback, `NetEvent`.
//!
//! Auth: rune has no authentication of its own (it is reached over a private network, or behind a proxy that adds it),
//! so the token is optional. When there is one it is sent as `Authorization: Bearer <token>` on every request and on
//! the websocket handshake, for such a proxy. Nothing else is sent.
use crate::commands::{encode, Request};
use crate::config::{normalize_url, ws_url};
use crate::commands::play_playlist_body;
use crate::model::{Conn, MiniPlaylist, ServerEvent, WireState, ZoneInfo};
use crate::reconnect;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::{client::IntoClientRequest, Message};

#[derive(Debug)]
pub enum NetEvent {
    Conn(Conn),
    Ws(ServerEvent),
    Fetched { state: WireState, rev: Option<String> },
    Zones(Vec<ZoneInfo>),
    /// A command or a read failed (HTTP error or no answer); the text is for a one-line notice.
    Failed(String),
    Cover { key: String, bytes: Vec<u8> },
    Minis(Vec<MiniPlaylist>),
    /// A playlist dot was used: the zone's new state, and which playlist made it.
    Started { playlist: String, state: WireState },
}

pub type Sink = Arc<dyn Fn(NetEvent) + Send + Sync>;

enum Job {
    Command(Request),
    State { zone: String, rev: Option<String> },
    Zones,
    Minis,
    /// Shuffle-play this playlist on this zone.
    Playlist { zone: String, id: String },
    Stop,
}

enum Ctl {
    Viewing(Vec<String>),
    Visible(bool),
    Stop,
}

#[derive(Clone)]
pub struct Client {
    pub base: String,
    token: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: &str, token: &str) -> Client {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(4)).timeout(Duration::from_secs(10)).user_agent("rune-mini").build();
        Client { base: normalize_url(base), token: token.to_string(), agent }
    }
    fn req(&self, method: &str, path: &str) -> ureq::Request {
        let r = self.agent.request(method, &format!("{}{}", self.base, path));
        if self.token.is_empty() {
            r
        } else {
            r.set("Authorization", &format!("Bearer {}", self.token))
        }
    }
    fn describe(e: ureq::Error) -> String {
        match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from)).unwrap_or_default();
                if msg.is_empty() { format!("server said {code}") } else { msg }
            }
            e => format!("cannot reach the server ({})", e.kind()),
        }
    }
    pub fn get_state(&self, zone: &str) -> Result<WireState, String> {
        self.req("GET", &format!("/api/player/{}", encode(zone))).call().map_err(Self::describe)?.into_json().map_err(|e| e.to_string())
    }
    pub fn zones(&self) -> Result<Vec<ZoneInfo>, String> {
        self.req("GET", "/api/zones").call().map_err(Self::describe)?.into_json().map_err(|e| e.to_string())
    }
    pub fn minis(&self) -> Result<Vec<MiniPlaylist>, String> {
        #[derive(serde::Deserialize)]
        struct Reply {
            playlists: Vec<MiniPlaylist>,
        }
        Ok(self.req("GET", "/api/mini/playlists").call().map_err(Self::describe)?.into_json::<Reply>().map_err(|e| e.to_string())?.playlists)
    }
    /// The track ids of a playlist, in its order (GET /api/playlists/:id, the page the web's Shuffle button plays from).
    pub fn playlist_track_ids(&self, id: &str) -> Result<Vec<String>, String> {
        #[derive(serde::Deserialize)]
        struct T {
            id: String,
        }
        #[derive(serde::Deserialize)]
        struct Detail {
            #[serde(default)]
            tracks: Vec<T>,
        }
        let d: Detail = self.req("GET", &format!("/api/playlists/{}", encode(id))).call().map_err(Self::describe)?.into_json().map_err(|e| e.to_string())?;
        Ok(d.tracks.into_iter().map(|t| t.id).collect())
    }
    pub fn command(&self, r: &Request) -> Result<WireState, String> {
        self.req("POST", &r.path()).send_json(r.body.clone()).map_err(Self::describe)?.into_json().map_err(|e| e.to_string())
    }
    /// A cover (or any image) by server-relative path or absolute URL. Capped at 8 MB.
    pub fn image(&self, path_or_url: &str) -> Result<Vec<u8>, String> {
        let r = if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
            // an external image (Spotify's CDN): no token, it is not ours
            self.agent.get(path_or_url).call().map_err(Self::describe)?
        } else {
            self.req("GET", path_or_url).call().map_err(Self::describe)?
        };
        let mut buf = Vec::new();
        r.into_reader().take(8 << 20).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

pub struct Net {
    pub client: Client,
    jobs: Sender<Job>,
    ctl: Sender<Ctl>,
    pub visible: Arc<AtomicBool>,
    sink: Sink,
}

impl Net {
    pub fn start(base: &str, token: &str, sink: Sink) -> Net {
        let client = Client::new(base, token);
        let (jobs_tx, jobs_rx) = channel::<Job>();
        let (ctl_tx, ctl_rx) = channel::<Ctl>();
        let visible = Arc::new(AtomicBool::new(false));
        {
            let (c, s) = (client.clone(), sink.clone());
            std::thread::Builder::new().name("rune-rest".into()).spawn(move || worker(c, jobs_rx, s)).ok();
        }
        {
            let (c, s, v) = (client.clone(), sink.clone(), visible.clone());
            std::thread::Builder::new().name("rune-ws".into()).spawn(move || ws_loop(c, ctl_rx, s, v)).ok();
        }
        Net { client, jobs: jobs_tx, ctl: ctl_tx, visible, sink }
    }
    pub fn send(&self, r: Request) {
        let _ = self.jobs.send(Job::Command(r));
    }
    pub fn fetch_state(&self, zone: &str, rev: Option<String>) {
        let _ = self.jobs.send(Job::State { zone: zone.to_string(), rev });
    }
    pub fn fetch_zones(&self) {
        let _ = self.jobs.send(Job::Zones);
    }
    pub fn fetch_minis(&self) {
        let _ = self.jobs.send(Job::Minis);
    }
    /// A playlist dot: read the playlist, then start it shuffled on `zone` (the web's Shuffle button: `play` with the
    /// track ids and `shuffle: true`). Comes back as `NetEvent::Started`.
    pub fn shuffle_playlist(&self, zone: &str, id: &str) {
        let _ = self.jobs.send(Job::Playlist { zone: zone.to_string(), id: id.to_string() });
    }
    /// Tell the server which zone is looked at (Spotify Connect zones nobody views are not polled).
    pub fn viewing(&self, zones: Vec<String>) {
        let _ = self.ctl.send(Ctl::Viewing(zones));
    }
    /// The panel is on screen or not: a hidden panel is not "watching" for the server and wakes less often.
    pub fn set_visible(&self, v: bool) {
        self.visible.store(v, Ordering::Relaxed);
        let _ = self.ctl.send(Ctl::Visible(v));
    }
    /// A cover on its own thread, so a slow image never holds up a command. Comes back as `NetEvent::Cover{key}`.
    pub fn fetch_cover(&self, key: String, path: String) {
        let (c, s) = (self.client.clone(), self.sink.clone());
        std::thread::Builder::new().name("rune-cover".into()).spawn(move || {
            if let Ok(bytes) = c.image(&path) {
                s(NetEvent::Cover { key, bytes });
            }
        }).ok();
    }
}

impl Drop for Net {
    fn drop(&mut self) {
        let _ = self.jobs.send(Job::Stop);
        let _ = self.ctl.send(Ctl::Stop);
    }
}

fn worker(c: Client, rx: Receiver<Job>, sink: Sink) {
    while let Ok(job) = rx.recv() {
        match job {
            Job::Stop => return,
            Job::Command(r) => match c.command(&r) {
                Ok(state) => sink(NetEvent::Fetched { state, rev: None }),
                Err(e) => sink(NetEvent::Failed(e)),
            },
            Job::State { zone, rev } => match c.get_state(&zone) {
                Ok(state) => sink(NetEvent::Fetched { state, rev }),
                Err(e) => sink(NetEvent::Failed(e)),
            },
            Job::Minis => match c.minis() {
                Ok(l) => sink(NetEvent::Minis(l)),
                Err(e) => sink(NetEvent::Failed(e)),
            },
            Job::Playlist { zone, id } => match c.playlist_track_ids(&id) {
                Ok(ids) if ids.is_empty() => sink(NetEvent::Failed("that playlist is empty".into())),
                Ok(ids) => match c.command(&Request { zone, body: play_playlist_body(&ids) }) {
                    Ok(state) => sink(NetEvent::Started { playlist: id, state }),
                    Err(e) => sink(NetEvent::Failed(e)),
                },
                Err(e) => sink(NetEvent::Failed(e)),
            },
            Job::Zones => match c.zones() {
                Ok(z) => sink(NetEvent::Zones(z)),
                Err(e) => sink(NetEvent::Failed(e)),
            },
        }
    }
}

trait Stream: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> Stream for T {}

fn tls_config() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().expect("tls versions").with_root_certificates(roots).with_no_client_auth())
}

type Socket = tungstenite::WebSocket<Box<dyn Stream>>;

fn connect(c: &Client) -> Result<(Socket, TcpStream), String> {
    let url = ws_url(&c.base);
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    if !c.token.is_empty() {
        req.headers_mut().insert("Authorization", format!("Bearer {}", c.token).parse().map_err(|_| "bad token".to_string())?);
    }
    let uri = req.uri().clone();
    let tls = uri.scheme_str() == Some("wss");
    let host = uri.host().ok_or("no host")?.to_string();
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    tcp.set_read_timeout(Some(Duration::from_secs(5))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let handle = tcp.try_clone().map_err(|e| e.to_string())?;
    let stream: Box<dyn Stream> = if tls {
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(tls_config(), name).map_err(|e| e.to_string())?;
        Box::new(rustls::StreamOwned::new(conn, tcp))
    } else {
        Box::new(tcp)
    };
    let (ws, _) = tungstenite::client(req, stream).map_err(|e| e.to_string())?;
    Ok((ws, handle))
}

fn send_json(ws: &mut Socket, v: serde_json::Value) -> bool {
    ws.send(Message::text(v.to_string())).is_ok()
}

/// How long one blocking read waits: while the panel is shown, a change of what is looked at is picked up quickly; hidden,
/// the thread wakes only to keep the connection alive.
fn read_timeout(visible: bool) -> Duration {
    Duration::from_secs(if visible { 3 } else { 15 })
}

fn ws_loop(c: Client, ctl: Receiver<Ctl>, sink: Sink, visible: Arc<AtomicBool>) {
    let mut attempt: u32 = 0;
    let mut viewing: Vec<String> = Vec::new();
    let mut vis = visible.load(Ordering::Relaxed);
    let seed = AtomicU64::new(std::process::id() as u64 ^ 0x9E37_79B9);
    sink(NetEvent::Conn(Conn::Connecting));
    loop {
        match connect(&c) {
            Ok((mut ws, tcp)) => {
                attempt = 0;
                sink(NetEvent::Conn(Conn::Online));
                send_json(&mut ws, serde_json::json!({"type": "presence", "visible": vis}));
                send_json(&mut ws, serde_json::json!({"type": "viewing", "zones": viewing}));
                let mut last_rx = Instant::now();
                let mut last_ping = Instant::now();
                'read: loop {
                    // control messages first
                    loop {
                        match ctl.try_recv() {
                            Ok(Ctl::Viewing(z)) => {
                                viewing = z;
                                if !send_json(&mut ws, serde_json::json!({"type": "viewing", "zones": viewing})) { break 'read; }
                            }
                            Ok(Ctl::Visible(v)) => {
                                vis = v;
                                if !send_json(&mut ws, serde_json::json!({"type": "presence", "visible": vis})) { break 'read; }
                            }
                            Ok(Ctl::Stop) => {
                                let _ = ws.close(None);
                                return;
                            }
                            Err(std::sync::mpsc::TryRecvError::Empty) => break,
                            Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                        }
                    }
                    let _ = tcp.set_read_timeout(Some(read_timeout(visible.load(Ordering::Relaxed))));
                    match ws.read() {
                        Ok(Message::Text(t)) => {
                            last_rx = Instant::now();
                            if let Ok(ev) = serde_json::from_str::<ServerEvent>(t.as_str()) {
                                sink(NetEvent::Ws(ev));
                            }
                        }
                        Ok(Message::Close(_)) => break 'read,
                        Ok(_) => last_rx = Instant::now(),
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                            // a quiet connection: one ping per 15 s keeps proxies from dropping it; no answer for 40 s means it is dead
                            if last_rx.elapsed() > Duration::from_secs(40) { break 'read; }
                            if last_ping.elapsed() >= Duration::from_secs(14) {
                                last_ping = Instant::now();
                                if ws.send(Message::Ping(Default::default())).is_err() { break 'read; }
                            }
                        }
                        Err(_) => break 'read,
                    }
                }
                let _ = tcp.shutdown(std::net::Shutdown::Both);
                // fall through to the retry below
                sink(NetEvent::Conn(Conn::Offline { attempt: 1 }));
            }
            Err(_) => {
                attempt = attempt.saturating_add(1);
                sink(NetEvent::Conn(Conn::Offline { attempt }));
            }
        }
        let s = seed.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
        let r = ((s >> 11) % 1000) as f64 / 1000.;
        let wait = Duration::from_millis(reconnect::jittered_ms(attempt.saturating_sub(1), r));
        // sleep in the control channel so a Stop ends it at once and other messages are kept
        let end = Instant::now() + wait;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() { break; }
            match ctl.recv_timeout(left) {
                Ok(Ctl::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Ctl::Viewing(z)) => viewing = z,
                Ok(Ctl::Visible(v)) => vis = v,
                Err(RecvTimeoutError::Timeout) => break,
            }
        }
        sink(NetEvent::Conn(Conn::Connecting));
    }
}
