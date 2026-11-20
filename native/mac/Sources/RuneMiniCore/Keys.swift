import Foundation

// Keyboard first: which key does what. Mirrors keys.rs (the table is documented in native/PROTOCOL.md).

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
}

public let seekMs: Double = 10_000
public let volumeStep: Double = 5

public func mapKey(_ k: Key, queueOpen: Bool, filterEmpty: Bool) -> Action? {
    let n = k.name
    if n == "escape" { return queueOpen ? (filterEmpty ? .closeQueue : .clearFilter) : .hide }
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
