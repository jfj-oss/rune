import XCTest
@testable import RuneMiniCore

final class ModelTests: XCTestCase {
    func ev(_ s: String) -> Msg { .ws(decodeEvent(s)!) }

    func testFullEventBecomesTheView() {
        var m = Model(zone: "pc")
        let fx = m.update(ev(#"{"type":"player","queueRev":"r1","state":{"zone":"pc","status":"playing","queue":[{"queueId":"a","track":{"id":"t","title":"One","durationMs":1000},"album":{"id":"x","title":"X"}}],"index":0,"positionMs":250,"volume":30,"shuffle":true,"repeat":"all"}}"#), now: 500)
        XCTAssertTrue(fx.isEmpty)
        let p = m.player!
        XCTAssertEqual(p.status, .playing); XCTAssertEqual(p.volume, 30); XCTAssertTrue(p.shuffle); XCTAssertEqual(p.repeatMode, .all)
        XCTAssertEqual(p.current?.track.title, "One")
        XCTAssertEqual(p.position(now: 700), 450, "extrapolated 200 ms while playing")
        XCTAssertEqual(p.position(now: 1_000_000), 1000, "held to the song's length")
    }

    func testSlimEventReusesTheQueueOrAsksOnce() {
        var m = Model(zone: "pc")
        let slim = #"{"type":"player","queueRev":"r1","state":{"zone":"pc","status":"paused","index":0,"positionMs":0,"volume":1,"shuffle":false,"repeat":"off"}}"#
        XCTAssertEqual(m.update(ev(slim), now: 0), [.fetch(zone: "pc", rev: "r1")])
        XCTAssertTrue(m.update(ev(slim), now: 0).isEmpty, "not asked twice while the fetch is out")
        var full = WireState(); full.zone = "pc"; full.queue = [QueueItem(queueId: "a", track: Track(title: "One"))]
        m.update(.fetched(full, rev: "r1"), now: 0)
        XCTAssertEqual(m.player?.queue.count, 1)
        XCTAssertTrue(m.update(ev(slim), now: 5).isEmpty)
        XCTAssertEqual(m.player?.queue[0].track.title, "One")
        XCTAssertEqual(m.player?.status, .paused)
        XCTAssertEqual(m.update(ev(slim.replacingOccurrences(of: "r1", with: "r2")), now: 5).count, 1)
    }

    func testOtherZonesAndUnknownEventsAreIgnored() {
        var m = Model(zone: "pc")
        m.update(ev(#"{"type":"player","state":{"zone":"spotify:x","status":"playing","queue":[]}}"#), now: 0)
        XCTAssertNil(m.player)
        for s in [#"{"type":"scan","progress":{}}"#, #"{"type":"library-changed"}"#, #"{"type":"hello","build":"abc"}"#] { m.update(ev(s), now: 0) }
        XCTAssertNil(m.player)
        XCTAssertNil(decodeEvent("not json"))
    }

    func testOfflineForgetsCachedQueuesAndSwitchingZonesRefetches() {
        var m = Model(zone: "pc")
        m.update(.conn(.online), now: 0)
        XCTAssertTrue(m.online)
        var st = WireState(); st.zone = "pc"; st.queue = []
        m.update(.fetched(st, rev: "r"), now: 0)
        m.update(.conn(.offline(attempt: 1)), now: 0)
        XCTAssertFalse(m.online)
        XCTAssertEqual(m.update(ev(#"{"type":"player","queueRev":"r","state":{"zone":"pc"}}"#), now: 0).count, 1)
        XCTAssertEqual(m.setZone("spotify:d"), [.fetch(zone: "spotify:d", rev: nil)])
        XCTAssertNil(m.player)
        XCTAssertTrue(m.setZone("spotify:d").isEmpty)
    }

    func testZoneListMatchesTheWeb() {
        var pc = ZoneInfo(id: "pc", kind: "pc"); pc.spotifyDeviceId = "dev"
        let list = [ZoneInfo(id: "spotify:phone", kind: "spotify"), ZoneInfo(id: "spotify:dev", kind: "spotify"), ZoneInfo(id: "browser:x", kind: "browser"),
                    ZoneInfo(id: "soloist", kind: "spotify", soloist: true), pc]
        XCTAssertEqual(pickableZones(list).map { $0.id }, ["pc", "soloist", "spotify:phone"])
    }

    func testZonesDecode() {
        let z = decodeZones(Data(#"[{"id":"pc","name":"Linux PC speakers","kind":"pc","spotifyDeviceId":"d"},{"id":"soloist","name":"S","kind":"spotify","soloist":true}]"#.utf8))
        XCTAssertEqual(z?.count, 2); XCTAssertEqual(z?[0].spotifyDeviceId, "d"); XCTAssertEqual(z?[1].soloist, true)
    }
}

final class CommandTests: XCTestCase {
    func model(_ status: Status, volume: Double = 50, shuffle: Bool = false, rep: Repeat = .off) -> Model {
        var m = Model(zone: "pc")
        var st = WireState()
        st.zone = "pc"; st.status = status; st.index = 0; st.positionMs = 10_000; st.volume = volume; st.shuffle = shuffle; st.repeatMode = rep
        st.queue = [QueueItem(queueId: "q1", track: Track(title: "A", durationMs: 200_000)), QueueItem(queueId: "q2", track: Track(title: "B", durationMs: 100_000))]
        m.update(.fetched(st, rev: nil), now: 1000)
        return m
    }
    func body(_ m: Model, _ c: UiCommand, now: Double = 0) -> String? { requestFor(m, c, now: now)?.body }

    func testPlayPauseFollowsTheStatus() {
        XCTAssertEqual(body(model(.playing), .playPause), #"{"type":"pause"}"#)
        XCTAssertEqual(body(model(.paused), .playPause), #"{"type":"resume"}"#)
        XCTAssertEqual(body(model(.stopped), .playPause), #"{"index":0,"type":"jump"}"#)
        XCTAssertNil(body(Model(zone: "pc"), .playPause))
    }

    func testTransportAndToggles() {
        let m = model(.playing, shuffle: true, rep: .all)
        XCTAssertEqual(body(m, .next), #"{"type":"next"}"#)
        XCTAssertEqual(body(m, .prev), #"{"type":"prev"}"#)
        XCTAssertEqual(body(m, .toggleShuffle), #"{"on":false,"type":"shuffle"}"#)
        XCTAssertEqual(body(m, .cycleRepeat), #"{"mode":"one","type":"repeat"}"#)
        XCTAssertEqual(body(model(.playing, rep: .one), .cycleRepeat), #"{"mode":"off","type":"repeat"}"#)
    }

    func testVolumeIsClampedAndWhole() {
        let m = model(.playing, volume: 98)
        XCTAssertEqual(body(m, .volumeBy(5)), #"{"type":"volume","volume":100}"#)
        XCTAssertEqual(body(m, .volume(-4)), #"{"type":"volume","volume":0}"#)
    }

    func testSeekByUsesTheExtrapolatedPositionAndStaysInsideTheSong() {
        let m = model(.playing)
        XCTAssertEqual(body(m, .seekBy(10_000), now: 3000), #"{"positionMs":22000,"type":"seek"}"#)
        XCTAssertEqual(body(m, .seekBy(-60_000), now: 3000), #"{"positionMs":0,"type":"seek"}"#)
        XCTAssertEqual(body(m, .seekBy(1e9), now: 3000), #"{"positionMs":199500,"type":"seek"}"#)
        XCTAssertEqual(body(model(.paused), .seekBy(5000), now: 9000), #"{"positionMs":15000,"type":"seek"}"#, "a paused song does not advance")
    }

    func testQueueEditsUseTheServersNames() {
        let m = model(.playing)
        XCTAssertEqual(body(m, .jump(3)), #"{"index":3,"type":"jump"}"#)
        XCTAssertEqual(body(m, .remove("q2")), #"{"queueId":"q2","type":"remove"}"#)
        XCTAssertEqual(body(m, .move(queueId: "q2", to: 0)), #"{"queueId":"q2","toIndex":0,"type":"move"}"#)
    }

    func testPathEncodesTheZone() {
        XCTAssertEqual(requestFor(model(.playing), .next, now: 0)?.path, "/api/player/pc")
        XCTAssertEqual(Request(zone: "spotify:ab/c d", body: "{}").path, "/api/player/spotify%3Aab%2Fc%20d")
    }
}

final class KeyTests: XCTestCase {
    func k(_ n: String, shift: Bool = false, cmd: Bool = false) -> Key {
        Key(n, shift: shift, cmd: cmd, text: n.count == 1 ? n : (n == "space" ? " " : nil))
    }
    func testCompactKeys() {
        let cases: [(String, Action)] = [("space", .playPause), ("left", .prev), ("right", .next), ("up", .volumeUp), ("down", .volumeDown),
                                          ("s", .toggleShuffle), ("r", .toggleRepeat), ("q", .openQueue), ("tab", .openQueue), ("escape", .hide)]
        for (n, a) in cases { XCTAssertEqual(mapKey(k(n), queueOpen: false, filterEmpty: true), a, n) }
        XCTAssertEqual(mapKey(k("left", shift: true), queueOpen: false, filterEmpty: true), .seekBack)
        XCTAssertEqual(mapKey(k("right", shift: true), queueOpen: false, filterEmpty: true), .seekForward)
        XCTAssertNil(mapKey(k("x"), queueOpen: false, filterEmpty: true))
    }
    func testQueueViewTypesIntoTheFilter() {
        XCTAssertEqual(mapKey(k("s"), queueOpen: true, filterEmpty: true), .type("s"))
        XCTAssertEqual(mapKey(k("space"), queueOpen: true, filterEmpty: false), .type(" "))
        XCTAssertEqual(mapKey(k("space"), queueOpen: true, filterEmpty: true), .playPause)
        XCTAssertNil(mapKey(k("left"), queueOpen: true, filterEmpty: false))
        XCTAssertEqual(mapKey(k("left"), queueOpen: true, filterEmpty: true), .prev)
        XCTAssertEqual(mapKey(k("down"), queueOpen: true, filterEmpty: false), .pickDown)
        XCTAssertEqual(mapKey(k("enter"), queueOpen: true, filterEmpty: false), .playPicked)
        XCTAssertEqual(mapKey(k("tab"), queueOpen: true, filterEmpty: false), .closeQueue)
        XCTAssertEqual(mapKey(k("delete"), queueOpen: true, filterEmpty: false), .removePicked)
        XCTAssertEqual(mapKey(k("s", cmd: true), queueOpen: true, filterEmpty: false), .toggleShuffle)
        XCTAssertEqual(mapKey(k("q", cmd: true), queueOpen: true, filterEmpty: false), .closeQueue)
        XCTAssertEqual(mapKey(k("q", cmd: true), queueOpen: false, filterEmpty: true), .openQueue)
    }
    func testEscapeGoesBackOneStepAtATime() {
        XCTAssertEqual(mapKey(k("escape"), queueOpen: true, filterEmpty: false), .clearFilter)
        XCTAssertEqual(mapKey(k("escape"), queueOpen: true, filterEmpty: true), .closeQueue)
        XCTAssertEqual(mapKey(k("escape"), queueOpen: false, filterEmpty: true), .hide)
    }
}

final class MiscTests: XCTestCase {
    func item(_ id: String, _ title: String, _ artist: String, _ album: String) -> QueueItem {
        QueueItem(queueId: id, track: Track(title: title, artists: [ArtistRef(id: "a", name: artist)]), album: AlbumRef(title: album))
    }
    func testFilter() {
        let q = [item("1", "Blue Monday", "New Order", "Power"), item("2", "Bizarre Love", "New Order", "Brotherhood"), item("3", "Blue", "Joni", "Blue")]
        XCTAssertEqual(filterMatches(q, ""), [0, 1, 2])
        XCTAssertEqual(filterMatches(q, "BLUE"), [0, 2])
        XCTAssertEqual(filterMatches(q, "new order bro"), [1])
        XCTAssertEqual(filterMatches(q, "zzz"), [])
    }
    func testReconnectPolicy() {
        XCTAssertEqual((0..<7).map { Reconnect.delayMs($0) }, [500, 1000, 2000, 4000, 8000, 10_000, 10_000])
        XCTAssertEqual(Reconnect.delayMs(Int.max), 10_000)
        XCTAssertEqual(Reconnect.jitteredMs(0, 0), 500); XCTAssertEqual(Reconnect.jitteredMs(0, 1), 600); XCTAssertEqual(Reconnect.jitteredMs(9, 7), 12_000)
    }
    func testURLs() {
        XCTAssertEqual(Settings.normalizeURL(" box:4545/ "), "http://box:4545")
        XCTAssertEqual(Settings.normalizeURL("https://h.example/"), "https://h.example")
        XCTAssertEqual(Settings.normalizeURL(""), "")
        XCTAssertEqual(Settings.wsURL("http://localhost:4545"), "ws://localhost:4545/api/ws?slim=1")
        XCTAssertEqual(Settings.wsURL("https://h.example"), "wss://h.example/api/ws?slim=1")
    }
    func testTimesAndDots() {
        XCTAssertEqual(mmss(61_999), "1:01"); XCTAssertEqual(mmss(-5), "0:00")
        XCTAssertEqual(dotColorIndex("pc"), dotColorIndex("pc"))
        XCTAssertTrue((0..<8).contains(dotColorIndex("spotify:abc")))
    }
}
