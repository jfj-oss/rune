import AppKit
import RuneMiniCore

/// The panel's one view: it draws everything itself (like Claude Summon's RootView) and keeps a list of hit regions made
/// while drawing, so what is clickable is always exactly what was drawn. Nothing animates; it redraws when the state
/// changes and once a second while visible and playing.
final class PanelView: NSView {
    static let width: CGFloat = 560
    static let compactHeight: CGFloat = 124
    static let rowH: CGFloat = 26
    /// 20 + 84 + 8 + (8 + 26 + 6 + 9 rows) + 14 = compact + this
    static let queueExtra: CGFloat = 276

    let mini: Mini
    private var hits: [(rect: NSRect, down: () -> Void)] = []
    private var barRect = NSRect.zero
    private var rowRects: [(rect: NSRect, index: Int, queueId: String)] = []
    private var dragFrom: Int?
    private var dragTo: Int?
    private var dragStart = NSPoint.zero
    private var dragged = false

    init(mini: Mini) {
        self.mini = mini
        super.init(frame: NSRect(x: 0, y: 0, width: PanelView.width, height: PanelView.compactHeight))
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    static func height(queueOpen: Bool) -> CGFloat { compactHeight + (queueOpen ? queueExtra : 0) }

    // MARK: drawing

    private func text(_ s: String, _ font: NSFont, _ color: NSColor, in r: NSRect, align: NSTextAlignment = .left) {
        let ps = NSMutableParagraphStyle(); ps.lineBreakMode = .byTruncatingTail; ps.alignment = align
        (s as NSString).draw(in: r, withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: ps])
    }

    private func width(_ s: String, _ font: NSFont) -> CGFloat { (s as NSString).size(withAttributes: [.font: font]).width }

    private func glyph(_ kind: Int, _ r: NSRect, _ color: NSColor) {
        // 0 prev, 1 next, 2 play, 3 pause: filled polygons in a unit box
        let polys: [[(CGFloat, CGFloat)]]
        switch kind {
        case 0: polys = [[(0.1, 0.14), (0.24, 0.14), (0.24, 0.86), (0.1, 0.86)], [(0.9, 0.14), (0.3, 0.5), (0.9, 0.86)]]
        case 1: polys = [[(0.76, 0.14), (0.9, 0.14), (0.9, 0.86), (0.76, 0.86)], [(0.1, 0.14), (0.7, 0.5), (0.1, 0.86)]]
        case 2: polys = [[(0.28, 0.12), (0.9, 0.5), (0.28, 0.88)]]
        default: polys = [[(0.2, 0.14), (0.4, 0.14), (0.4, 0.86), (0.2, 0.86)], [(0.6, 0.14), (0.8, 0.14), (0.8, 0.86), (0.6, 0.86)]]
        }
        color.setFill()
        for p in polys {
            let path = NSBezierPath()
            for (i, pt) in p.enumerated() {
                let q = NSPoint(x: r.minX + pt.0 * r.width, y: r.minY + pt.1 * r.height)
                i == 0 ? path.move(to: q) : path.line(to: q)
            }
            path.close(); path.fill()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        hits.removeAll(); rowRects.removeAll(); zoneRect = .zero
        let b = bounds
        let path = NSBezierPath(roundedRect: b.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        Theme.paper.setFill(); path.fill()
        Theme.rule.setStroke(); path.lineWidth = 1; path.stroke()

        let m = mini
        let p = m.model.player
        let cur = p?.current
        let online = m.model.online
        let status = p?.status ?? .stopped
        let playing = status == .playing || status == .loading
        let now = nowMs()

        // the dots on the left edge: one per chosen playlist; a click shuffle-plays it on the zone shown
        let ring = m.model.playingPlaylist
        let minis = m.model.minis
        let perCol = 6
        dotSlots = []
        if minis.isEmpty {
            // nothing chosen yet: one dim "+" says where to choose
            let r = NSRect(x: 5, y: 15, width: 14, height: 14)
            Theme.rule.setStroke(); let o = NSBezierPath(ovalIn: r.insetBy(dx: 0.5, dy: 0.5)); o.lineWidth = 1; o.stroke()
            text("+", Theme.small, Theme.dim, in: NSRect(x: 5, y: 15, width: 14, height: 14), align: .center)
            dotSlots.append((r, "choose playlists in rune \u{2192} Show in rune mini"))
        }
        for (i, pl) in minis.enumerated() {
            // more than six wrap into a second column
            let cx: CGFloat = minis.count > perCol ? 8 + CGFloat(i / perCol) * 16 : 12
            let cy: CGFloat = 21 + CGFloat(i % perCol) * 19
            let on = pl.id == ring
            let d: CGFloat = on ? 7 : 9
            if on { Theme.ink.setStroke(); let o = NSBezierPath(ovalIn: NSRect(x: cx - 7, y: cy - 7, width: 14, height: 14).insetBy(dx: 0.5, dy: 0.5)); o.lineWidth = 1; o.stroke() }
            Theme.dotColor(key: pl.color).withAlphaComponent(on ? 1 : 0.75).setFill()
            NSBezierPath(ovalIn: NSRect(x: cx - d / 2, y: cy - d / 2, width: d, height: d)).fill()
            let r = NSRect(x: cx - 8, y: cy - 8, width: 16, height: 16)
            hits.append((r, { [weak self] in self?.mini.playMini(i) }))
            dotSlots.append((r, i < 8 ? "\(pl.name) \u{b7} shift+\(i + 1)" : pl.name))
        }

        // the cover
        let coverR = NSRect(x: 24, y: 20, width: 84, height: 84)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: coverR, xRadius: 6, yRadius: 6).addClip()
        if let img = m.currentCover {
            img.draw(in: coverR, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        } else {
            Theme.box.setFill(); coverR.fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        if m.currentCover == nil {
            Theme.rule.setStroke(); NSBezierPath(roundedRect: coverR.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6).stroke()
        }

        // title and sub
        let x0: CGFloat = 120, x1 = b.width - 16
        var title = "nothing playing", sub = "zone: \(m.zoneName)"
        if !online {
            title = "offline"
            var tail = "connecting"
            if case .offline = m.model.conn { tail = "retrying" }
            sub = "\(m.cfg.url.isEmpty ? "no server set" : m.cfg.url) \u{b7} \(tail)"
        } else if let q = cur {
            title = q.track.title
            sub = [q.artistLine, q.album.title].filter { !$0.isEmpty }.joined(separator: " \u{2014} ")
        }
        text(title, Theme.title, online ? Theme.ink : Theme.error, in: NSRect(x: x0, y: 19, width: x1 - x0, height: 20))
        text(sub, Theme.sub, Theme.dim, in: NSRect(x: x0, y: 41, width: x1 - x0, height: 16))

        // transport and progress
        let cy: CGFloat = 63
        let buttons: [(Int, UiCommand)] = [(0, .prev), (playing ? 3 : 2, .playPause), (1, .next)]
        var bx = x0
        for (g, c) in buttons {
            let r = NSRect(x: bx, y: cy, width: 24, height: 24)
            glyph(g, r.insetBy(dx: 6, dy: 6), Theme.ink)
            hits.append((r, { [weak self] in self?.mini.command(c) }))
            bx += 28
        }
        let pos = p?.position(now: now) ?? 0
        let dur = cur?.track.durationMs ?? 0
        let timeS = dur > 0 ? "\(mmss(pos)) / \(mmss(dur))" : ""
        text(timeS, Theme.small, Theme.dim, in: NSRect(x: x1 - 86, y: cy + 5, width: 86, height: 14), align: .right)
        barRect = NSRect(x: bx + 4, y: cy + 10, width: x1 - 86 - 8 - bx - 4, height: 4)
        Theme.rule.setFill(); NSBezierPath(roundedRect: barRect, xRadius: 2, yRadius: 2).fill()
        if dur > 0 {
            var f = barRect; f.size.width = barRect.width * CGFloat(min(1, max(0, pos / dur)))
            Theme.accent.setFill(); NSBezierPath(roundedRect: f, xRadius: 2, yRadius: 2).fill()
        }
        let hit = barRect.insetBy(dx: 0, dy: -8)
        hits.append((hit, { [weak self] in
            guard let self = self, dur > 0, let ev = NSApp.currentEvent else { return }
            let x = self.convert(ev.locationInWindow, from: nil).x
            self.mini.command(.seekTo(Double(max(0, min(1, (x - self.barRect.minX) / self.barRect.width))) * dur))
        }))

        // footer: a typed line of small toggles
        let shuffle = p?.shuffle ?? false, rep = p?.repeatMode ?? .off, vol = p?.volume ?? 0
        let fy: CGFloat = 94
        let segs: [(String, Bool, UiCommand?)] = [("shuffle", shuffle, .toggleShuffle), ("repeat \(rep.rawValue)", rep != .off, .cycleRepeat), ("vol \(Int(vol.rounded()))", false, nil)]
        var rx = x1
        for (s, on, cmd) in segs.reversed() {
            let w = width(s, Theme.small)
            let r = NSRect(x: rx - w, y: fy, width: w, height: 14)
            text(s, Theme.small, on ? Theme.accent : Theme.dim, in: r)
            if let c = cmd { hits.append((r.insetBy(dx: -4, dy: -2), { [weak self] in self?.mini.command(c) })) }
            rx -= w + 12
        }
        if let note = m.notice ?? hoverNote {
            text(note, Theme.small, m.notice != nil ? Theme.error : Theme.dim, in: NSRect(x: x0, y: fy, width: max(0, rx - x0 - 4), height: 14))
        } else {
            // "playing · Linux PC speakers ›": the zone name cycles through the zones when there are several
            let lead = "\(status.rawValue) \u{b7} "
            let multi = m.zoneList.count > 1
            let zn = multi ? "\(m.zoneName) \u{203a}" : m.zoneName
            let lw = width(lead, Theme.small)
            text(lead, Theme.small, Theme.dim, in: NSRect(x: x0, y: fy, width: lw, height: 14))
            let zr = NSRect(x: x0 + lw, y: fy, width: max(0, min(width(zn, Theme.small), rx - x0 - lw - 4)), height: 14)
            text(zn, Theme.small, hoverZoneName ? Theme.ink : Theme.dim, in: zr)
            zoneRect = zr
            if multi { hits.append((zr.insetBy(dx: -2, dy: -2), { [weak self] in self?.mini.cycleZone() })) }
        }

        guard m.queueOpen else { return }

        // the queue: a typed filter line and a window of rows
        Theme.rule.setFill(); NSRect(x: 24, y: 112, width: b.width - 40, height: 1).fill()
        text("\u{203a}", Theme.input, Theme.accent, in: NSRect(x: 24, y: 120, width: 14, height: 22))
        if m.filter.isEmpty { text("type to filter the queue", Theme.input, Theme.dim, in: NSRect(x: 40, y: 120, width: 300, height: 22)) }
        else { text(m.filter + "\u{258f}", Theme.input, Theme.ink, in: NSRect(x: 40, y: 120, width: b.width - 140, height: 22)) }
        let matches = m.matches
        text("\(matches.count)/\(p?.queue.count ?? 0)", Theme.small, Theme.dim, in: NSRect(x: b.width - 100, y: 124, width: 84, height: 14), align: .right)
        guard let p = p else { return }
        var ry: CGFloat = 152
        for (slot, qi) in matches.enumerated() where slot >= m.top && slot < m.top + Mini.rows {
            let q = p.queue[qi]
            let r = NSRect(x: 20, y: ry, width: b.width - 36, height: PanelView.rowH)
            if slot == m.pick { Theme.box.setFill(); NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill() }
            if dragTo == qi, dragged { Theme.accent.setFill(); NSRect(x: r.minX, y: r.minY, width: r.width, height: 1).fill() }
            let isCur = qi == p.index
            let ink = isCur ? Theme.accent : Theme.ink
            let ty = ry + 6
            if isCur { text("\u{25b8}", Theme.row, Theme.accent, in: NSRect(x: r.minX + 6, y: ty, width: 14, height: 16)) }
            text(String(format: "%3d", qi + 1), Theme.row, Theme.dim, in: NSRect(x: r.minX + 22, y: ty, width: 30, height: 16))
            let tw = min(width(q.track.title, Theme.row), r.width - 220)
            text(q.track.title, Theme.row, ink, in: NSRect(x: r.minX + 56, y: ty, width: tw, height: 16))
            text(q.artistLine, Theme.row, Theme.dim, in: NSRect(x: r.minX + 56 + tw + 8, y: ty, width: max(0, r.width - 56 - tw - 8 - 70), height: 16))
            text(mmss(q.track.durationMs), Theme.row, Theme.dim, in: NSRect(x: r.maxX - 64, y: ty, width: 44, height: 16), align: .right)
            text("\u{d7}", Theme.row, Theme.dim, in: NSRect(x: r.maxX - 18, y: ty, width: 14, height: 16))
            let rm = NSRect(x: r.maxX - 22, y: ry, width: 22, height: PanelView.rowH)
            let id = q.queueId
            hits.append((rm, { [weak self] in self?.mini.command(.remove(id)) }))
            rowRects.append((r, qi, q.queueId))
            ry += PanelView.rowH
        }
    }

    // MARK: hover on dots (the playlist's name in the footer) and on the zone name

    private var dotSlots: [(rect: NSRect, label: String)] = []
    private var zoneRect = NSRect.zero
    private var hoverNote: String?
    private var hoverZoneName = false

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let note = dotSlots.first { $0.rect.contains(p) }?.label
        let onZone = mini.zoneList.count > 1 && zoneRect.insetBy(dx: -2, dy: -2).contains(p)
        if note != hoverNote || onZone != hoverZoneName { hoverNote = note; hoverZoneName = onZone; needsDisplay = true }
    }
    override func mouseExited(with event: NSEvent) { if hoverNote != nil || hoverZoneName { hoverNote = nil; hoverZoneName = false; needsDisplay = true } }

    // MARK: mouse

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let p = convert(event.locationInWindow, from: nil)
        for h in hits.reversed() where h.rect.contains(p) { h.down(); return }
        if let row = rowRects.first(where: { $0.rect.contains(p) }) {
            dragFrom = row.index; dragTo = nil; dragStart = p; dragged = false
            return
        }
        window?.performDrag(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragFrom != nil else { return }
        let p = convert(event.locationInWindow, from: nil)
        if abs(p.y - dragStart.y) > 4 { dragged = true }
        dragTo = rowRects.first(where: { $0.rect.contains(p) })?.index
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        defer { dragFrom = nil; dragTo = nil; dragged = false; needsDisplay = true }
        guard let from = dragFrom, let q = mini.model.player?.queue else { return }
        if dragged, let to = dragTo, to != from {
            mini.command(.move(queueId: q[from].queueId, to: to))
        } else if !dragged {
            mini.command(.jump(from))
        }
    }

    override func scrollWheel(with event: NSEvent) {
        guard mini.queueOpen else { return }
        let dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY / PanelView.rowH : event.scrollingDeltaY
        let rows = Int((-dy).rounded())
        if rows != 0 { mini.scroll(rows: rows) }
    }

    // MARK: keys

    private func keyOf(_ e: NSEvent) -> Key {
        let f = e.modifierFlags
        let name: String
        switch Int(e.keyCode) {
        case 49: name = "space"
        case 123: name = "left"
        case 124: name = "right"
        case 125: name = "down"
        case 126: name = "up"
        case 53: name = "escape"
        case 36, 76: name = "enter"
        case 48: name = "tab"
        case 51: name = "backspace"
        case 117: name = "delete"
        default: name = (e.charactersIgnoringModifiers ?? "").lowercased()
        }
        let cmd = f.contains(.command) || f.contains(.control)
        return Key(name, shift: f.contains(.shift), cmd: cmd, alt: f.contains(.option), text: cmd ? nil : e.characters)
    }

    override func keyDown(with event: NSEvent) {
        if let a = mapKey(keyOf(event), queueOpen: mini.queueOpen, filterEmpty: mini.filter.isEmpty) { _ = a; mini.key(keyOf(event)) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let k = keyOf(event)
        guard k.cmd, mapKey(k, queueOpen: mini.queueOpen, filterEmpty: mini.filter.isEmpty) != nil else { return false }
        mini.key(k)
        return true
    }

    override func cancelOperation(_ sender: Any?) { mini.key(Key("escape")) }
}
