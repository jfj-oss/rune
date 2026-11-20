import Foundation

// The wire types and the state reduction. Mirrors native/linux/core/src/model.rs; the contract is native/PROTOCOL.md.

public struct ArtistRef: Equatable {
    public var id = ""
    public var name = ""
    public init(id: String = "", name: String = "") { self.id = id; self.name = name }
}

public struct Track: Equatable {
    public var id = ""
    public var albumId = ""
    public var title = ""
    public var artists: [ArtistRef] = []
    public var durationMs: Double = 0
    public init(id: String = "", albumId: String = "", title: String = "", artists: [ArtistRef] = [], durationMs: Double = 0) {
        self.id = id; self.albumId = albumId; self.title = title; self.artists = artists; self.durationMs = durationMs
    }
}

public struct AlbumRef: Equatable {
    public var id = ""
    public var title = ""
    public var coverUrl: String?
    public init(id: String = "", title: String = "", coverUrl: String? = nil) { self.id = id; self.title = title; self.coverUrl = coverUrl }
}

public struct QueueItem: Equatable {
    public var queueId: String
    public var track: Track
    public var album: AlbumRef
    public init(queueId: String, track: Track = Track(), album: AlbumRef = AlbumRef()) { self.queueId = queueId; self.track = track; self.album = album }
    public var artistLine: String { track.artists.map { $0.name }.joined(separator: ", ") }
}

public enum Status: String { case stopped, playing, paused, loading }

public enum Repeat: String {
    case off, all, one
    public var next: Repeat { switch self { case .off: return .all; case .all: return .one; case .one: return .off } }
}

/// `PlayerState` as the server sends it. With `?slim=1` the queue is left out of an event whose queue did not change.
public struct WireState {
    public var zone = ""
    public var status = Status.stopped
    public var queue: [QueueItem]?
    public var index = 0
    public var positionMs: Double = 0
    public var volume: Double = 0
    public var shuffle = false
    public var repeatMode = Repeat.off
    public var elsewhere = false
    public init() {}
}

public struct ZoneInfo: Equatable {
    public var id: String
    public var name = ""
    public var kind = ""
    public var soloist = false
    public var spotifyDeviceId: String?
    public var spotifyZone: String?
    public init(id: String, name: String = "", kind: String = "", soloist: Bool = false, spotifyDeviceId: String? = nil, spotifyZone: String? = nil) {
        self.id = id; self.name = name; self.kind = kind; self.soloist = soloist; self.spotifyDeviceId = spotifyDeviceId; self.spotifyZone = spotifyZone
    }
}

/// A playlist chosen for the mini (GET /api/mini/playlists): a coloured dot that shuffle-plays it.
public struct MiniPlaylist: Equatable {
    public var id: String
    public var name = ""
    /// Dot colour index into the panel's eight-colour palette; the server keeps it stable and distinct.
    public var color = 0
    public init(id: String, name: String = "", color: Int = 0) { self.id = id; self.name = name; self.color = color }
}

/// The most dots (and shifted number keys) there are.
public let miniMax = 8

public enum ServerEvent {
    case hello(build: String?)
    /// The chosen playlists changed: read them again (handled by the caller, not the reducer).
    case miniPlaylists
    case player(state: WireState, queueRev: String?)
    case other
}

// MARK: decoding (JSONSerialization: every field is optional on the wire, so nothing here can throw on a missing one)

private func str(_ d: [String: Any], _ k: String) -> String { d[k] as? String ?? "" }
private func num(_ d: [String: Any], _ k: String) -> Double { (d[k] as? NSNumber)?.doubleValue ?? 0 }

func decodeTrack(_ v: Any?) -> Track {
    guard let d = v as? [String: Any] else { return Track() }
    let artists = (d["artists"] as? [[String: Any]] ?? []).map { ArtistRef(id: str($0, "id"), name: str($0, "name")) }
    return Track(id: str(d, "id"), albumId: str(d, "albumId"), title: str(d, "title"), artists: artists, durationMs: num(d, "durationMs"))
}

func decodeQueueItem(_ v: Any) -> QueueItem? {
    guard let d = v as? [String: Any], let qid = d["queueId"] as? String else { return nil }
    let a = d["album"] as? [String: Any] ?? [:]
    return QueueItem(queueId: qid, track: decodeTrack(d["track"]),
                     album: AlbumRef(id: str(a, "id"), title: str(a, "title"), coverUrl: a["coverUrl"] as? String))
}

public func decodeState(_ v: Any?) -> WireState? {
    guard let d = v as? [String: Any] else { return nil }
    var s = WireState()
    s.zone = str(d, "zone")
    s.status = Status(rawValue: str(d, "status")) ?? .stopped
    if let q = d["queue"] as? [Any] { s.queue = q.compactMap(decodeQueueItem) }
    s.index = Int(num(d, "index"))
    s.positionMs = num(d, "positionMs")
    s.volume = num(d, "volume")
    s.shuffle = (d["shuffle"] as? Bool) ?? false
    s.repeatMode = Repeat(rawValue: str(d, "repeat")) ?? .off
    s.elsewhere = (d["elsewhere"] as? Bool) ?? false
    return s
}

public func decodeEvent(_ text: String) -> ServerEvent? {
    guard let data = text.data(using: .utf8), let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    switch d["type"] as? String {
    case "hello": return .hello(build: d["build"] as? String)
    case "mini-playlists": return .miniPlaylists
    case "player":
        guard let s = decodeState(d["state"]) else { return .other }
        return .player(state: s, queueRev: d["queueRev"] as? String)
    default: return .other
    }
}

public func decodeZones(_ data: Data) -> [ZoneInfo]? {
    guard let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return nil }
    return arr.compactMap { d in
        guard let id = d["id"] as? String else { return nil }
        return ZoneInfo(id: id, name: str(d, "name"), kind: str(d, "kind"), soloist: (d["soloist"] as? Bool) ?? false,
                        spotifyDeviceId: d["spotifyDeviceId"] as? String, spotifyZone: d["spotifyZone"] as? String)
    }
}

/// GET /api/mini/playlists -> { playlists: [{ id, name, color }] }
public func decodeMinis(_ data: Data) -> [MiniPlaylist]? {
    guard let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let arr = d["playlists"] as? [[String: Any]] else { return nil }
    return arr.compactMap { p in
        guard let id = p["id"] as? String else { return nil }
        return MiniPlaylist(id: id, name: str(p, "name"), color: Int(num(p, "color")))
    }
}

/// The track ids of GET /api/playlists/:id, in order.
public func decodePlaylistTrackIds(_ data: Data) -> [String]? {
    guard let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    return (d["tracks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
}

/// The zone after `current` in `ids` (wrapping); the first one when `current` is not in the list.
public func nextZone(_ ids: [String], current: String) -> String? {
    if ids.isEmpty { return nil }
    guard let at = ids.firstIndex(of: current) else { return ids[0] }
    return ids[(at + 1) % ids.count]
}

/// The zones the picker offers: what the web offers (browser zones are not listed; the PC's own Spotify device is folded
/// into the pc zone; pc first, then Soloist, then Spotify Connect devices).
public func pickableZones(_ all: [ZoneInfo]) -> [ZoneInfo] {
    var hidden = Set<String>()
    for z in all where z.kind == "pc" {
        if let d = z.spotifyDeviceId { hidden.insert("spotify:\(d)") }
        if let s = z.spotifyZone { hidden.insert(s) }
    }
    let kept = all.filter { $0.kind != "browser" && !($0.kind == "spotify" && hidden.contains($0.id)) }
    func rank(_ z: ZoneInfo) -> Int { z.kind == "pc" ? 0 : (z.soloist ? 1 : 2) }
    // stable: sort by (rank, original index)
    return kept.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map { $0.element }
}

// MARK: the view model

public enum Conn: Equatable {
    case connecting
    case online
    case offline(attempt: Int)
}

public struct Player: Equatable {
    public var status = Status.stopped
    public var queue: [QueueItem] = []
    public var index = 0
    public var positionMs: Double = 0
    /// Local monotonic time (ms) when `positionMs` was current.
    public var atMs: Double = 0
    public var volume: Double = 0
    public var shuffle = false
    public var repeatMode = Repeat.off
    public var elsewhere = false

    public var current: QueueItem? { index >= 0 && index < queue.count ? queue[index] : nil }

    /// The position now: the reported one plus the time since, while playing, held to the song's length.
    public func position(now: Double) -> Double {
        let base = positionMs + (status == .playing ? max(0, now - atMs) : 0)
        let d = current?.track.durationMs ?? 0
        let mx = d > 0 ? d : base
        return max(0, min(base, max(0, mx)))
    }
}

public enum Msg {
    case ws(ServerEvent)
    /// A full state we asked for (or a command's answer). `rev` names the queue fingerprint it answers, if known.
    case fetched(WireState, rev: String?)
    case conn(Conn)
    case zones([ZoneInfo])
    /// The chosen playlists, in order.
    case minis([MiniPlaylist])
    /// The answer to "shuffle-play this playlist": the new state of the zone, and which playlist made the queue.
    case started(playlist: String, WireState)
}

public enum Effect: Equatable {
    case fetch(zone: String, rev: String?)
}

public struct Model {
    public var zone: String
    public var zones: [ZoneInfo] = []
    public var conn = Conn.connecting
    public var player: Player?
    private var queues: [String: (rev: String, queue: [QueueItem])] = [:]
    private var fetching: String?
    /// The playlists on the left edge, in order (at most `miniMax`).
    public var minis: [MiniPlaylist] = []
    /// The queue a playlist dot made: (zone, playlist id, first queue id, length). It stops matching as soon as the queue is
    /// replaced or edited, so the ring on a dot means "this queue came from it", not "it was clicked once".
    private var origin: (zone: String, playlist: String, first: String, count: Int)?

    /// The playlist whose shuffled play made the queue now shown, if the queue is still that one.
    public var playingPlaylist: String? {
        guard let o = origin, let p = player, o.zone == zone, p.queue.count == o.count, p.queue.first?.queueId == o.first else { return nil }
        return o.playlist
    }

    public init(zone: String) { self.zone = zone }

    public var online: Bool { conn == .online }

    /// Show another zone: its state is unknown until read.
    public mutating func setZone(_ z: String) -> [Effect] {
        if z == zone { return [] }
        zone = z
        player = nil
        fetching = z
        return [.fetch(zone: z, rev: nil)]
    }

    private mutating func apply(_ w: WireState, _ queue: [QueueItem], _ now: Double) {
        var p = Player()
        p.status = w.status; p.queue = queue; p.index = w.index; p.positionMs = w.positionMs; p.atMs = now
        p.volume = w.volume; p.shuffle = w.shuffle; p.repeatMode = w.repeatMode; p.elsewhere = w.elsewhere
        player = p
    }

    @discardableResult
    public mutating func update(_ msg: Msg, now: Double) -> [Effect] {
        switch msg {
        case .conn(let c):
            if c != .online {
                // events were missed: the next one for each zone must carry or fetch its queue
                queues.removeAll()
                fetching = nil
            }
            conn = c
            return []
        case .zones(let z):
            zones = z
            return []
        case .minis(let l):
            minis = Array(l.prefix(miniMax))
            return []
        case .started(let playlist, let state):
            if state.zone != zone { return [] }
            let q = state.queue ?? []
            origin = q.first.map { (zone: state.zone, playlist: playlist, first: $0.queueId, count: q.count) }
            fetching = nil
            apply(state, q, now)
            return []
        case .ws(.player(let state, let rev)):
            if state.zone != zone { return [] }
            if let q = state.queue {
                if let r = rev { queues[state.zone] = (r, q) }
                apply(state, q, now)
                return []
            }
            if let r = rev, let have = queues[state.zone], have.rev == r {
                apply(state, have.queue, now)
                return []
            }
            // a queue we never saw (joined mid-way or missed an event): read the full state once
            if fetching == zone { return [] }
            fetching = zone
            return [.fetch(zone: zone, rev: rev)]
        case .ws:
            return []
        case .fetched(let state, let rev):
            if state.zone != zone { return [] }
            fetching = nil
            let q = state.queue ?? []
            if let r = rev { queues[state.zone] = (r, q) }
            apply(state, q, now)
            return []
        }
    }
}
