import AppKit
import Carbon.HIToolbox

/// Global hotkey through Carbon RegisterEventHotKey. Needs no Accessibility or
/// Input Monitoring permission, and costs nothing while idle (no event tap).
final class HotKey {
    var action: (() -> Void)?
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            if let userData = userData {
                Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue().action?()
            }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    @discardableResult
    func register(code: UInt32, mods: UInt32) -> Bool {
        if let r = ref { UnregisterEventHotKey(r); ref = nil }
        let id = EventHotKeyID(signature: OSType(0x524D_4E31), id: 1)  // 'RMN1'
        let st = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &ref)
        return st == noErr
    }
}
