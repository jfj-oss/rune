import AppKit
import RuneMiniCore

/// Claude Summon's Theme.swift: dynamic colours (light and dark resolve at draw time), monospaced type.
enum Theme {
    static func rgb(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: a)
    }
    static func dyn(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { ap in ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light) }
    }
    static let paper = dyn(0xF3EEE2, 0x1C1B18)
    static let ink = dyn(0x2B2823, 0xD8D1C2)
    static let dim = dyn(0x8F8777, 0x7A7468)
    static let accent = dyn(0xA24E28, 0xD9905F)
    static let box = dyn(0xE8E1D0, 0x262420)
    static let rule = dyn(0xD6CDBA, 0x35322C)
    static let error = dyn(0xA83232, 0xE07A6E)

    static let title = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
    static let sub = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    static let small = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    static let row = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    static let input = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)

    static let dots: [NSColor] = [0xC9785A, 0xC9A45A, 0x8FAE6B, 0x5FA89A, 0x6B93C0, 0x9483C4, 0xC07BA8, 0x9A9488].map { rgb($0) }
    /// The dot colour for a playlist's colour key (the server hands out 0...7 and keeps one per playlist).
    static func dotColor(key: Int) -> NSColor { dots[((key % dots.count) + dots.count) % dots.count] }
}
