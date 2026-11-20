import AppKit
import RuneMiniCore

final class SummonPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// One borderless floating NSPanel, shown and hidden by the hotkey (Claude Summon's PanelController, much reduced).
/// While hidden nothing runs: the panel is just ordered out. While shown and playing, one 1 s timer redraws the progress.
final class PanelController {
    let mini: Mini
    private let panel: SummonPanel
    private let view: PanelView
    private var timer: Timer?
    private var positioned = false

    var isVisible: Bool { panel.isVisible }

    init(mini: Mini) {
        self.mini = mini
        view = PanelView(mini: mini)
        panel = SummonPanel(contentRect: NSRect(x: 0, y: 0, width: PanelView.width, height: PanelView.compactHeight),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.animationBehavior = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = view
        mini.onChange = { [weak self] in self?.redraw() }
        mini.onQueueToggled = { [weak self] in self?.resize() }
        mini.onHide = { [weak self] in self?.hide() }
    }

    func toggle() { isVisible ? hide() : show() }

    func show() {
        if !positioned { place(); positioned = true }
        resize()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(view)
        mini.shown()
        manageTimer()
    }

    func hide() {
        panel.orderOut(nil)
        mini.hidden()
        resize()
        manageTimer()
    }

    private func place() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let f = screen?.visibleFrame else { return }
        let h = PanelView.height(queueOpen: false)
        panel.setFrame(NSRect(x: f.midX - PanelView.width / 2, y: f.maxY - f.height * 0.18 - h, width: PanelView.width, height: h), display: false)
    }

    /// The panel grows downward from its top edge when the queue opens.
    private func resize() {
        let h = PanelView.height(queueOpen: mini.queueOpen)
        var f = panel.frame
        if abs(f.height - h) < 0.5 { return }
        f.origin.y += f.height - h
        f.size.height = h
        panel.setFrame(f, display: true)
    }

    private func redraw() {
        guard panel.isVisible else { return }
        view.needsDisplay = true
        manageTimer()
    }

    /// The only repeating timer: visible and playing, once a second, with tolerance so the CPU can batch the wake-ups.
    private func manageTimer() {
        let want = panel.isVisible && (mini.model.player?.status == .playing) && !ProcessInfo.processInfo.isLowPowerModeEnabled
        if want && timer == nil {
            let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.view.needsDisplay = true }
            t.tolerance = 0.25
            RunLoop.main.add(t, forMode: .common)
            timer = t
        } else if !want, let t = timer {
            t.invalidate(); timer = nil
        }
    }
}
