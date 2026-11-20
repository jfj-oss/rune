import Foundation

/// Typing in the queue filters it: every word typed must appear in the title, an artist or the album (any case).
public func filterMatches(_ queue: [QueueItem], _ query: String) -> [Int] {
    let words = query.split(whereSeparator: { $0.isWhitespace }).map { $0.lowercased() }
    if words.isEmpty { return Array(queue.indices) }
    return queue.indices.filter { i in
        let q = queue[i]
        let hay = "\(q.track.title) \(q.artistLine) \(q.album.title)".lowercased()
        return words.allSatisfy { hay.contains($0) }
    }
}
