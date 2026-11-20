import AppKit
import Carbon.HIToolbox
import RuneMiniCore

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var mini: Mini!
    private var controller: PanelController!
    private let hotKey = HotKey()
    private var hotKeyOK = true

    struct HotKeySpec: Equatable { var code: UInt32; var mods: UInt32; var label: String }
    static let presets: [HotKeySpec] = [
        HotKeySpec(code: UInt32(kVK_Space), mods: UInt32(optionKey | cmdKey), label: "\u{2325}\u{2318}Space"),
        HotKeySpec(code: UInt32(kVK_Space), mods: UInt32(controlKey | optionKey | cmdKey), label: "\u{2303}\u{2325}\u{2318}Space"),
        HotKeySpec(code: UInt32(kVK_Space), mods: UInt32(optionKey), label: "\u{2325}Space"),
        HotKeySpec(code: UInt32(kVK_Space), mods: UInt32(optionKey | shiftKey), label: "\u{21e7}\u{2325}Space"),
        HotKeySpec(code: UInt32(kVK_ANSI_Grave), mods: UInt32(optionKey), label: "\u{2325}`"),
    ]
    var hotKeySpec: HotKeySpec {
        get {
            let d = UserDefaults.standard
            guard d.object(forKey: "hotkeyCode") != nil else { return AppDelegate.presets[0] }
            let code = UInt32(d.integer(forKey: "hotkeyCode")), mods = UInt32(d.integer(forKey: "hotkeyMods"))
            return AppDelegate.presets.first { $0.code == code && $0.mods == mods } ?? AppDelegate.presets[0]
        }
        set { UserDefaults.standard.set(Int(newValue.code), forKey: "hotkeyCode"); UserDefaults.standard.set(Int(newValue.mods), forKey: "hotkeyMods") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        mini = Mini(cfg: Store.load())
        controller = PanelController(mini: mini)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = AppDelegate.menuBarImage()
        let menu = NSMenu(); menu.delegate = self
        statusItem.menu = menu

        hotKey.action = { [weak self] in self?.controller.toggle() }
        let hk = hotKeySpec
        hotKeyOK = hotKey.register(code: hk.code, mods: hk.mods)

        // media keys and Control Center work from the start, with the panel hidden
        mini.nowPlaying.arm()
        mini.connect()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)

        if !mini.configured { DispatchQueue.main.async { self.serverSettings() } }
        else if CommandLine.arguments.contains("--show") { controller.show() }
    }

    @objc private func didWake() { mini.socket?.check() }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let hk = hotKeySpec
        add(menu, "Show / hide   \(hk.label)" + (hotKeyOK ? "" : "  (hotkey unavailable)"), #selector(toggle))
        let zones = NSMenu()
        for z in mini.zoneList {
            let item = add(zones, z.name, #selector(pickZone(_:)))
            item.representedObject = z.id
            item.state = z.id == mini.model.zone ? .on : .off
        }
        let zi = NSMenuItem(title: "Zone", action: nil, keyEquivalent: ""); zi.submenu = zones; menu.addItem(zi)
        menu.addItem(.separator())
        add(menu, "Server\u{2026}", #selector(serverSettings))
        let keys = NSMenu()
        for (i, p) in AppDelegate.presets.enumerated() {
            let item = add(keys, p.label, #selector(pickHotKey(_:))); item.tag = i; item.state = p == hk ? .on : .off
        }
        let ki = NSMenuItem(title: "Hotkey", action: nil, keyEquivalent: ""); ki.submenu = keys; menu.addItem(ki)
        let silent = add(menu, "Claim media keys with silent audio", #selector(toggleSilent))
        silent.state = mini.nowPlaying.silentClaim ? .on : .off
        menu.addItem(.separator())
        add(menu, "Quit rune mini", #selector(quit))
    }

    @discardableResult
    private func add(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: ""); item.target = self; menu.addItem(item); return item
    }

    @objc private func toggle() { controller.toggle() }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func pickZone(_ s: NSMenuItem) { if let id = s.representedObject as? String { mini.setZone(id) } }
    @objc private func toggleSilent() { mini.nowPlaying.silentClaim.toggle(); mini.changed() }
    @objc private func pickHotKey(_ s: NSMenuItem) {
        let p = AppDelegate.presets[s.tag]
        hotKeySpec = p
        hotKeyOK = hotKey.register(code: p.code, mods: p.mods)
    }

    /// Server address and token (the token is kept in a file with mode 600 in the config folder, never anywhere else).
    @objc private func serverSettings() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "rune server"
        alert.informativeText = "The address of your rune server, for example http://host:4545 (on a private network or over Tailscale). "
            + "rune has no sign-in of its own; a token is only needed if something in front of it asks for one. "
            + "Saved in \(Store.dir.path); the token file is readable by you only."
        let url = NSTextField(frame: NSRect(x: 0, y: 32, width: 340, height: 22))
        url.placeholderString = "http://host:4545"
        url.stringValue = mini.cfg.url
        let tok = NSSecureTextField(frame: NSRect(x: 0, y: 2, width: 340, height: 22))
        tok.placeholderString = Store.loadToken().isEmpty ? "token (optional)" : "token saved (leave empty to keep it)"
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 56))
        box.addSubview(url); box.addSubview(tok)
        alert.accessoryView = box
        alert.addButton(withTitle: "Save"); alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = url
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        mini.cfg.url = Settings.normalizeURL(url.stringValue)
        Store.save(mini.cfg)
        let t = tok.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { Store.saveToken(t) }
        mini.notice = nil
        mini.connect()
    }

    /// Template image: the 3x2 cluster of dots, as Claude Summon's menu-bar icon.
    static func menuBarImage() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.setFill()
            let sizes: [[CGFloat]] = [[2.0, 3.2, 2.0], [3.2, 2.0, 3.2]]
            for (r, row) in sizes.enumerated() {
                for (c, d) in row.enumerated() {
                    let cx = 4.5 + CGFloat(c) * 4.5, cy = 6.5 + CGFloat(r) * 5.0
                    NSBezierPath(ovalIn: NSRect(x: cx - d / 2, y: cy - d / 2, width: d, height: d)).fill()
                }
            }
            return true
        }
        img.isTemplate = true
        return img
    }
}
