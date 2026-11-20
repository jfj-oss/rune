import Foundation

// What a key or a button asks for, and the REST request that carries it. The server owns the queue: the panel never
// edits a queue itself, it sends POST /api/player/:zone with one PlayerCommand. Mirrors commands.rs.

public enum UiCommand: Equatable {
    case playPause, play, pause, next, prev
    case prevSong                // always the previous song: the server's prev with force
    case restart                 // the song again (seek to 0)
    case skipFraction(Double)    // forward by this fraction of the song's length; past the end, the next song
    case seekTo(Double)          // ms
    case seekBy(Double)          // ms, relative to the position now
    case volume(Double)          // 0...100
    case volumeBy(Double)
    case toggleShuffle
    case setShuffle(Bool)
    case cycleRepeat
    case setRepeat(Repeat)
    case jump(Int)
    case remove(String)
    case move(queueId: String, to: Int)
    case clear
}

public struct Request: Equatable {
    public var zone: String
    /// The JSON body, keys sorted (so it compares and prints the same everywhere).
    public var body: String
    public var path: String { "/api/player/" + encodeSegment(zone) }
    public init(zone: String, body: String) { self.zone = zone; self.body = body }
}

/// Percent-encode one path segment (zone ids contain ':').
public func encodeSegment(_ s: String) -> String {
    var out = ""
    for b in s.utf8 {
        let ch = Character(UnicodeScalar(b))
        if (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || "-_.~".contains(ch) {
            out.append(ch)
        } else {
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

private func json(_ d: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
}

/// The body of "shuffle-play this playlist": what the web's Shuffle button sends: the whole list, shuffle on.
public func playPlaylistBody(_ trackIds: [String]) -> String {
    json(["type": "play", "trackIds": trackIds, "startIndex": 0, "shuffle": true])
}

/// The request for `cmd` given what is shown now, or nil when there is nothing sensible to send.
public func requestFor(_ model: Model, _ cmd: UiCommand, now: Double) -> Request? {
    let p = model.player
    func req(_ d: [String: Any]) -> Request { Request(zone: model.zone, body: json(d)) }
    switch cmd {
    case .playPause:
        guard let p = p else { return nil }
        switch p.status {
        case .playing, .loading: return req(["type": "pause"])
        case .paused: return req(["type": "resume"])
        case .stopped:
            if p.queue.isEmpty { return nil }
            return req(["type": "jump", "index": max(0, p.index)])
        }
    case .play: return req(["type": "resume"])
    case .pause: return req(["type": "pause"])
    case .next: return req(["type": "next"])
    case .prev: return req(["type": "prev"])
    case .prevSong: return req(["type": "prev", "force": true])
    case .restart: return req(["type": "seek", "positionMs": 0])
    case .skipFraction(let f):
        guard let p = p, let cur = p.current, cur.track.durationMs > 0 else { return nil }
        let to = p.position(now: now) + f * cur.track.durationMs
        return to >= cur.track.durationMs ? req(["type": "next"]) : req(["type": "seek", "positionMs": to.rounded()])
    case .seekTo(let ms): return req(["type": "seek", "positionMs": max(0, ms).rounded()])
    case .seekBy(let d):
        guard let p = p, let cur = p.current else { return nil }
        var to = max(0, p.position(now: now) + d)
        if cur.track.durationMs > 0 { to = min(to, max(0, cur.track.durationMs - 500)) }
        return req(["type": "seek", "positionMs": to.rounded()])
    case .volume(let v): return req(["type": "volume", "volume": min(100, max(0, v)).rounded()])
    case .volumeBy(let d):
        guard let p = p else { return nil }
        return req(["type": "volume", "volume": min(100, max(0, p.volume + d)).rounded()])
    case .toggleShuffle:
        guard let p = p else { return nil }
        return req(["type": "shuffle", "on": !p.shuffle])
    case .setShuffle(let on): return req(["type": "shuffle", "on": on])
    case .cycleRepeat:
        guard let p = p else { return nil }
        return req(["type": "repeat", "mode": p.repeatMode.next.rawValue])
    case .setRepeat(let r): return req(["type": "repeat", "mode": r.rawValue])
    case .jump(let i): return req(["type": "jump", "index": i])
    case .remove(let id): return req(["type": "remove", "queueId": id])
    case .move(let id, let to): return req(["type": "move", "queueId": id, "toIndex": to])
    case .clear: return req(["type": "clear"])
    }
}
