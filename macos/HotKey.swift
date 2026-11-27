import Carbon

/// A global shortcut as config.json spells it, such as "Control+Option+N". Same names and rules as
/// HOTKEY in settings.mjs: modifiers in this order, with Control or Option unless it's a function key.
struct HotKey: Equatable {
    static let standard = HotKey("Option+Space")!

    let keyCode: UInt32
    let modifiers: UInt32
    /// As menus show it: ⌃⌥N.
    let label: String

    private static let modifierKeys: [(name: String, flag: Int, symbol: String)] = [
        ("Control", controlKey, "⌃"), ("Option", optionKey, "⌥"), ("Shift", shiftKey, "⇧"), ("Command", cmdKey, "⌘")
    ]
    private static let symbols = [
        "Minus": "-", "Equal": "=", "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\", "Semicolon": ";",
        "Quote": "'", "Comma": ",", "Period": ".", "Slash": "/", "Backquote": "`"
    ]
    private static let keyCodes: [String: Int] = [
        "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G,
        "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L, "M": kVK_ANSI_M, "N": kVK_ANSI_N,
        "O": kVK_ANSI_O, "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T, "U": kVK_ANSI_U,
        "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X, "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "Space": kVK_Space, "Minus": kVK_ANSI_Minus, "Equal": kVK_ANSI_Equal, "BracketLeft": kVK_ANSI_LeftBracket,
        "BracketRight": kVK_ANSI_RightBracket, "Backslash": kVK_ANSI_Backslash, "Semicolon": kVK_ANSI_Semicolon,
        "Quote": kVK_ANSI_Quote, "Comma": kVK_ANSI_Comma, "Period": kVK_ANSI_Period, "Slash": kVK_ANSI_Slash, "Backquote": kVK_ANSI_Grave,
        "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6, "F7": kVK_F7, "F8": kVK_F8,
        "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12, "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15,
        "F16": kVK_F16, "F17": kVK_F17, "F18": kVK_F18, "F19": kVK_F19, "F20": kVK_F20
    ]

    init?(_ text: String) {
        var parts = text.components(separatedBy: "+")
        let key = parts.removeLast()
        guard let code = Self.keyCodes[key] else { return nil }
        let held = Self.modifierKeys.filter { parts.contains($0.name) }
        guard held.map(\.name) == parts else { return nil }
        let isFunctionKey = key.count > 1 && key.hasPrefix("F")
        guard isFunctionKey || parts.contains("Control") || parts.contains("Option") else { return nil }
        keyCode = UInt32(code)
        modifiers = held.reduce(0) { $0 | UInt32($1.flag) }
        label = held.map(\.symbol).joined() + (Self.symbols[key] ?? key)
    }

    /// macOS's own shortcuts (System Settings → Keyboard). Other apps' shortcuts can't be asked for.
    var isUsedByMacOS: Bool {
        var list: Unmanaged<CFArray>?
        guard CopySymbolicHotKeys(&list) == noErr, let shortcuts = list?.takeRetainedValue() as? [[String: Any]] else { return false }
        return shortcuts.contains {
            ($0[kHISymbolicHotKeyEnabled] as? Bool) == true
                && ($0[kHISymbolicHotKeyCode] as? NSNumber)?.uint32Value == keyCode
                && ($0[kHISymbolicHotKeyModifiers] as? NSNumber)?.uint32Value == modifiers
        }
    }
}
