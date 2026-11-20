import Foundation

/// The reconnect policy: the web's (500 ms, doubling, at most 10 s; reset on success), plus up to a fifth of jitter.
public enum Reconnect {
    public static let baseMs = 500.0
    public static let maxMs = 10_000.0
    /// The wait before retry number `attempt` (0 = the first retry), without jitter.
    public static func delayMs(_ attempt: Int) -> Double { min(maxMs, baseMs * pow(2, Double(min(max(attempt, 0), 16)))) }
    public static func jitteredMs(_ attempt: Int, _ r: Double) -> Double { let d = delayMs(attempt); return d + d * 0.2 * min(1, max(0, r)) }
}

/// Settings helpers shared with the app: URL normalisation and the websocket URL.
public enum Settings {
    public static func normalizeURL(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        if t.isEmpty { return "" }
        return (t.hasPrefix("http://") || t.hasPrefix("https://")) ? t : "http://" + t
    }
    public static func wsURL(_ base: String) -> String {
        let b = normalizeURL(base)
        let swapped = b.hasPrefix("https://") ? "wss://" + b.dropFirst(8) : (b.hasPrefix("http://") ? "ws://" + b.dropFirst(7) : b)
        return swapped + "/api/ws?slim=1"
    }
}

/// Theme.dotColor: FNV-1a of the id picks one of eight muted dot colours (the same function as the Linux app and Claude Summon).
public func dotColorIndex(_ id: String, count: Int = 8) -> Int {
    var h: UInt32 = 2166136261
    for b in id.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return Int(h % UInt32(count))
}

public func mmss(_ ms: Double) -> String {
    let s = Int(max(0, ms) / 1000)
    return String(format: "%d:%02d", s / 60, s % 60)
}
