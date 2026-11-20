import Foundation

// Keyboard first: which key does what. Mirrors keys.rs (number keys: 1 previous song, 2 restart, 3 next, 4 skip 20 %, Shift+1-8 playlists) (the table is documented in native/PROTOCOL.md).

public struct Key: Equatable {
    /// Lower-case key name: "space", "left", "right", "up", "down", "escape", "enter", "tab", "backspace", "delete", or the character.
    public var name: String
    public var shift = false
    /// Command on the Mac (Control on Linux).
    public var cmd = false
    public var alt = false
    /// The text the key types, if it types any.
    public var text: String?
    public init(_ name: String, shift: Bool = false, cmd: Bool = false, alt: Bool = false, text: String? = nil) {
        self.name = name; self.shift = shift; self.cmd = cmd; self.alt = alt; self.text = text
    }
}

public enum Action: Equatable {
    case hide, playPause, prev, next, seekBack, seekForward, volumeUp, volumeDown
    case toggleShuffle, toggleRepeat, openQueue, closeQueue
    case type(String)
    case backspace, clearFilter, pickUp, pickDown, playPicked, removePicked
    /// Key 1: the previous song, always. Key 2: this song again. Key 4: skip forward 20 % of the song.
    case prevSong, restart, skipFifth
    /// Shuffle-play playlist N (0-based: Shift+1 is 0).
    case playPlaylist(Int)
}

/// Key 4 skips this fraction of the song's length.
public let skipFraction: Double = 0.2

public let seekMs: Double = 10_000
public let volumeStep: Double = 5

public func mapKey(_ k: Key, queueOpen: Bool, filterEmpty: Bool) -> Action? {
    let n = k.name
    if n == "escape" { return queueOpen ? (filterEmpty ? .closeQueue : .clearFilter) : .hide }
    // Number keys. 1 previous song, 2 restart, 3 next, 4 skip forward 20 %; Shift+1..8 shuffle-play playlist N (a US layout reports
    // Shift+1 as "!", so the shifted symbols count too). Cmd/Ctrl+digit works from anywhere; a bare digit or Shift+digit only
    // while the queue is closed (open, they type into the filter).
    let digit = "12345678".firstIndex(of: Character(n.count == 1 ? n : "x")).map { "12345678".distance(from: "12345678".startIndex, to: $0) }
    let symbol = "!@#$%^&*".firstIndex(of: Character(n.count == 1 ? n : "x")).map { "!@#$%^&*".distance(from: "!@#$%^&*".startIndex, to: $0) }
    if digit != nil || symbol != nil, k.cmd || (!queueOpen && !k.alt) {
        if k.shift || symbol != nil {
            if let i = digit ?? symbol { return .playPlaylist(i) }
        } else if let i = digit {
            switch i {
            case 0: return .prevSong
            case 1: return .restart
            case 2: return .next
            case 3: return .skipFifth
            default: break
            }
        }
    }
    if k.cmd {
        switch n {
        case "s": return .toggleShuffle
        case "r": return .toggleRepeat
        case "q": return queueOpen ? .closeQueue : .openQueue
        case "up": return .volumeUp
        case "down": return .volumeDown
        default: return nil
        }
    }
    if !queueOpen {
        switch (n, k.shift) {
        case ("space", _): return .playPause
        case ("left", false): return .prev
        case ("right", false): return .next
        case ("left", true): return .seekBack
        case ("right", true): return .seekForward
        case ("up", _): return .volumeUp
        case ("down", _): return .volumeDown
        case ("s", _): return .toggleShuffle
        case ("r", _): return .toggleRepeat
        case ("q", _), ("tab", _): return .openQueue
        default: return nil
        }
    }
    switch (n, k.shift) {
    case ("tab", _): return .closeQueue
    case ("up", _): return .pickUp
    case ("down", _): return .pickDown
    case ("enter", _): return .playPicked
    case ("delete", _): return .removePicked
    case ("backspace", _): return .backspace
    case ("space", _) where filterEmpty: return .playPause
    case ("left", false) where filterEmpty: return .prev
    case ("right", false) where filterEmpty: return .next
    case ("left", true) where filterEmpty: return .seekBack
    case ("right", true) where filterEmpty: return .seekForward
    default:
        if let t = k.text, !k.alt, !t.isEmpty, !t.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { return .type(t) }
        return nil
    }
}
