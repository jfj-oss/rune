import AppKit
import RuneMiniCore

/// The one piece of state: what the server last said (RuneMiniCore.Model), what the panel is doing (queue open, filter,
/// pick), and the glue to the network and to Now Playing. The panel only draws it.
final class Mini {
    var cfg: Store.Config
    var model: Model
    var client: RuneClient?
    var socket: RuneSocket?
    var queueOpen = false
    var filter = ""
    var pick = 0
    var top = 0
    var notice: String?
    var hover: String?
    var visible = false { didSet { socket?.visible = visible } }
    /// Cover of the current album; only this and the one before are kept.
    private(set) var covers: [(key: String, image: NSImage?)] = []

    var onChange: (() -> Void)?
    var onQueueToggled: (() -> Void)?
    var onHide: (() -> Void)?
    let nowPlaying = NowPlaying()

    init(cfg: Store.Config) {
        self.cfg = cfg
        model = Model(zone: cfg.zone)
        nowPlaying.onCommand = { [weak self] c in self?.command(c) }
    }

    var configured: Bool { !cfg.url.isEmpty }

    func connect() {
        socket?.stop()
        client = nil
        guard configured else { notice = "no server yet: use the menu bar icon, Server..."; changed(); return }
        let token = Store.loadToken()
        client = RuneClient(base: cfg.url, token: token)
        let s = RuneSocket(base: cfg.url, token: token)
        s.viewing = [model.zone]
        s.visible = visible
        s.onEvent = { [weak self] e in
            // the playlists on the left edge were changed in big rune: read them again
            if case .miniPlaylists = e { self?.client?.minis { l, _ in if let l = l { self?.apply(.minis(l)) } } }
            self?.apply(.ws(e))
        }
        s.onConn = { [weak self] c in
            guard let self = self else { return }
            self.apply(.conn(c))
            if c == .online { self.refresh() }
        }
        socket = s
        s.start()
    }

    /// Read the zones and this zone's state fresh (after connecting, waking, or being shown after a long time).
    func refresh() {
        client?.zones { [weak self] z, _ in if let z = z { self?.apply(.zones(z)) } }
        client?.minis { [weak self] l, _ in if let l = l { self?.apply(.minis(l)) } }
        fetch(zone: model.zone, rev: nil)
    }

    private func fetch(zone: String, rev: String?) {
        client?.state(zone: zone) { [weak self] st, err in
            if let st = st { self?.apply(.fetched(st, rev: rev)) } else if let e = err { self?.notice = e; self?.onChange?() }
        }
    }

    func apply(_ msg: Msg) {
        if case .conn(.online) = msg { notice = nil }
        let fx = model.update(msg, now: nowMs())
        for e in fx { if case .fetch(let z, let r) = e { fetch(zone: z, rev: r) } }
        changed()
    }

    func changed() {
        ensureCover()
        let n = matches.count
        if pick >= n { pick = max(0, n - 1) }
        keepPickVisible()
        nowPlaying.update(model: model, cover: currentCover, base: cfg.url)
        onChange?()
    }

    // MARK: derived

    var matches: [Int] { filterMatches(model.player?.queue ?? [], filter) }
    var zoneName: String { model.zones.first { $0.id == model.zone }?.name ?? (model.zone == "pc" ? "PC" : model.zone) }
    var zoneList: [(id: String, name: String)] {
        var z = pickableZones(model.zones).map { (id: $0.id, name: $0.name) }
        if z.isEmpty { z.append((id: "pc", name: "PC")) }
        if !z.contains(where: { $0.id == model.zone }) { z.append((id: model.zone, name: zoneName)) }
        return z
    }
    var currentCover: NSImage? {
        guard let a = model.player?.current?.album.id else { return nil }
        return covers.first { $0.key == a }?.image ?? nil
    }

    // MARK: covers

    private func ensureCover() {
        guard let item = model.player?.current else { return }
        let id = item.album.id
        if id.isEmpty || covers.contains(where: { $0.key == id }) { return }
        covers.append((key: id, image: nil))
        while covers.count > 2 { covers.removeFirst() }
        let path = (item.album.coverUrl?.isEmpty == false) ? item.album.coverUrl! : "/api/cover/\(encodeSegment(id))?size=200"
        client?.image(path) { [weak self] data in
            guard let self = self, let data = data else { return }
            // decoded at twice the drawn size: a small bitmap, not the full file
            DispatchQueue.global(qos: .utility).async {
                let img = Mini.thumbnail(data, maxPixels: 192)
                DispatchQueue.main.async {
                    if let i = self.covers.firstIndex(where: { $0.key == id }) { self.covers[i].image = img; self.changed() }
                }
            }
        }
    }

    static func thumbnail(_ data: Data, maxPixels: Int) -> NSImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width / 2, height: cg.height / 2))
    }

    // MARK: commands

    func command(_ c: UiCommand) {
        guard let r = requestFor(model, c, now: nowMs()) else { return }
        client?.command(r) { [weak self] st, err in
            if let st = st { self?.apply(.fetched(st, rev: nil)) } else if let e = err { self?.notice = e; self?.onChange?() }
        }
    }

    /// A playlist dot (or Shift+N): shuffle-play playlist `i` on the zone shown.
    func playMini(_ i: Int) {
        guard i >= 0, i < model.minis.count else { return }
        let id = model.minis[i].id, zone = model.zone
        notice = nil
        client?.playlistTrackIds(id) { [weak self] ids, err in
            guard let self = self else { return }
            guard let ids = ids else { self.notice = err ?? "could not read that playlist"; self.onChange?(); return }
            if ids.isEmpty { self.notice = "that playlist is empty"; self.onChange?(); return }
            self.client?.command(Request(zone: zone, body: playPlaylistBody(ids))) { st, err in
                if let st = st { self.apply(.started(playlist: id, st)) } else if let e = err { self.notice = e; self.onChange?() }
            }
        }
    }

    /// The zone name in the footer: the next zone, wrapping.
    func cycleZone() {
        if let z = nextZone(zoneList.map { $0.id }, current: model.zone) { setZone(z) }
    }

    func setZone(_ z: String) {
        let fx = model.setZone(z)
        if fx.isEmpty { return }
        for e in fx { if case .fetch(let zz, let r) = e { fetch(zone: zz, rev: r) } }
        socket?.viewing = [z]
        cfg.zone = z
        Store.save(cfg)
        filter = ""; pick = 0; top = 0
        changed()
    }

    // MARK: keys

    func key(_ k: Key) {
        guard let a = mapKey(k, queueOpen: queueOpen, filterEmpty: filter.isEmpty) else { return }
        notice = nil
        switch a {
        case .hide: onHide?()
        case .playPause: command(.playPause)
        case .prev: command(.prev)
        case .next: command(.next)
        case .prevSong: command(.prevSong)
        case .restart: command(.restart)
        case .skipFifth: command(.skipFraction(skipFraction))
        case .playPlaylist(let i): playMini(i)
        case .seekBack: command(.seekBy(-seekMs))
        case .seekForward: command(.seekBy(seekMs))
        case .volumeUp: command(.volumeBy(volumeStep))
        case .volumeDown: command(.volumeBy(-volumeStep))
        case .toggleShuffle: command(.toggleShuffle)
        case .toggleRepeat: command(.cycleRepeat)
        case .openQueue: setQueueOpen(true)
        case .closeQueue: setQueueOpen(false)
        case .type(let t): filter += t; pick = 0; top = 0; changed()
        case .backspace: if !filter.isEmpty { filter.removeLast() }; pick = 0; top = 0; changed()
        case .clearFilter: filter = ""; pick = 0; top = 0; changed()
        case .pickUp: pick = max(0, pick - 1); keepPickVisible(); onChange?()
        case .pickDown: pick = min(max(0, matches.count - 1), pick + 1); keepPickVisible(); onChange?()
        case .playPicked: if pick < matches.count { command(.jump(matches[pick])) }
        case .removePicked:
            if pick < matches.count, let q = model.player?.queue[matches[pick]] { command(.remove(q.queueId)) }
        }
    }

    static let rows = 9

    func keepPickVisible() {
        if pick < top { top = pick } else if pick >= top + Mini.rows { top = pick + 1 - Mini.rows }
        top = max(0, min(top, matches.count - Mini.rows))
    }

    func scroll(rows d: Int) {
        top = max(0, min(top + d, max(0, matches.count - Mini.rows)))
        onChange?()
    }

    func setQueueOpen(_ open: Bool) {
        if queueOpen == open { return }
        queueOpen = open
        filter = ""
        pick = model.player.map { max(0, $0.index) } ?? 0
        top = 0
        keepPickVisible()
        onQueueToggled?()
        onChange?()
    }

    func shown() {
        visible = true
        socket?.check()
        refresh()
    }

    func hidden() {
        visible = false
        queueOpen = false; filter = ""; pick = 0; top = 0
    }
}

/// Milliseconds on a monotonic clock (positions are extrapolated against this, never against the server's wall clock).
func nowMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
