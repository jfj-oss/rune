import Foundation
import RuneMiniCore

/// REST: one URLSession, results on the main queue. Auth: rune has none of its own; a token, when there is one, is sent as
/// `Authorization: Bearer <token>` (for a proxy in front of it). See native/PROTOCOL.md.
final class RuneClient {
    let base: String
    private let token: String
    private let session: URLSession

    init(base: String, token: String) {
        self.base = Settings.normalizeURL(base)
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        cfg.httpAdditionalHeaders = ["User-Agent": "rune-mini"]
        session = URLSession(configuration: cfg)
    }

    func request(_ path: String, method: String = "GET", body: String? = nil) -> URLRequest? {
        guard let url = URL(string: base + path) else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        if !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let b = body { r.httpBody = Data(b.utf8); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return r
    }

    private func run(_ r: URLRequest?, _ done: @escaping (Data?, String?) -> Void) {
        guard let r = r else { return done(nil, "bad server address") }
        session.dataTask(with: r) { data, resp, err in
            DispatchQueue.main.async {
                if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    var msg = "server said \(http.statusCode)"
                    if let d = data, let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let e = j["error"] as? String { msg = e }
                    return done(nil, msg)
                }
                if err != nil { return done(nil, "cannot reach the server") }
                done(data, nil)
            }
        }.resume()
    }

    func state(zone: String, _ done: @escaping (WireState?, String?) -> Void) {
        run(request("/api/player/" + encodeSegment(zone))) { d, e in
            done(d.flatMap { decodeState(try? JSONSerialization.jsonObject(with: $0)) }, e)
        }
    }

    func zones(_ done: @escaping ([ZoneInfo]?, String?) -> Void) {
        run(request("/api/zones")) { d, e in done(d.flatMap(decodeZones), e) }
    }

    func minis(_ done: @escaping ([MiniPlaylist]?, String?) -> Void) {
        run(request("/api/mini/playlists")) { d, e in done(d.flatMap(decodeMinis), e) }
    }

    /// The track ids of a playlist, in its order (the page the web's Shuffle button plays from).
    func playlistTrackIds(_ id: String, _ done: @escaping ([String]?, String?) -> Void) {
        run(request("/api/playlists/" + encodeSegment(id))) { d, e in done(d.flatMap(decodePlaylistTrackIds), e) }
    }

    func command(_ r: Request, _ done: @escaping (WireState?, String?) -> Void) {
        run(request(r.path, method: "POST", body: r.body)) { d, e in
            done(d.flatMap { decodeState(try? JSONSerialization.jsonObject(with: $0)) }, e)
        }
    }

    /// A cover by server-relative path or absolute URL (an external one, e.g. Spotify's CDN, is fetched without the token).
    func image(_ pathOrURL: String, _ done: @escaping (Data?) -> Void) {
        var req: URLRequest?
        if pathOrURL.hasPrefix("http://") || pathOrURL.hasPrefix("https://") { req = URL(string: pathOrURL).map { URLRequest(url: $0) } }
        else { req = request(pathOrURL) }
        run(req) { d, _ in done(d) }
    }
}

/// The websocket (/api/ws?slim=1), a URLSessionWebSocketTask. Idle cost is zero: no timers while connected (the OS wakes
/// the task when a frame arrives). A reconnect timer exists only while the connection is down. After sleep or a long
/// hidden time `check()` pings it and reconnects when nothing answers.
final class RuneSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onConn: ((Conn) -> Void)?
    var viewing: [String] = [] { didSet { sendViewing() } }
    var visible = false { didSet { sendPresence() } }

    private let base: String
    private let token: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var attempt = 0
    private var retry: DispatchWorkItem?
    private var stopped = false
    private var isOpen = false

    init(base: String, token: String) {
        self.base = base
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
    }

    func start() { stopped = false; connect() }

    func stop() {
        stopped = true
        retry?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func connect() {
        retry?.cancel()
        guard !stopped, let url = URL(string: Settings.wsURL(base)) else { return }
        var r = URLRequest(url: url)
        if !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let t = session.webSocketTask(with: r)
        task = t
        isOpen = false
        onConn?(attempt == 0 ? .connecting : .offline(attempt: attempt))
        t.resume()
        sendPresence()
        sendViewing()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, t === self.task else { return }
                switch result {
                case .failure:
                    self.closed()
                case .success(let msg):
                    if !self.isOpen { self.isOpen = true; self.attempt = 0; self.onConn?(.online) }
                    if case .string(let s) = msg, let ev = decodeEvent(s) { self.onEvent?(ev) }
                    self.receive(t)
                }
            }
        }
    }

    private func closed() {
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        attempt += 1
        onConn?(.offline(attempt: attempt))
        let wait = Reconnect.jitteredMs(attempt - 1, Double.random(in: 0...1)) / 1000
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        retry = w
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: w)
    }

    /// After wake or a long hidden time: a ping that is not answered in 3 s means the connection is dead.
    func check() {
        guard let t = task, isOpen else { if task == nil { attempt = 0; connect() }; return }
        var answered = false
        t.sendPing { err in DispatchQueue.main.async { answered = (err == nil) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self, t === self.task, !answered else { return }
            self.closed()
        }
    }

    private func send(_ obj: [String: Any]) {
        guard let t = task, let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { _ in }
    }
    private func sendPresence() { send(["type": "presence", "visible": visible]) }
    private func sendViewing() { send(["type": "viewing", "zones": viewing]) }
}
