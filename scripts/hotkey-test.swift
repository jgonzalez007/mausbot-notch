// Run by scripts/swift-test.sh: which shortcuts are accepted, and that the bridge agrees.
import Carbon
import Foundation

@main
enum HotKeyTest {
    /// Prints "accepted" or "refused" for each shortcut given, for comparison with settings.mjs.
    static func main() {
        if CommandLine.arguments.count > 1 {
            for text in CommandLine.arguments.dropFirst() { print(HotKey(text) == nil ? "refused" : "accepted") }
            return
        }
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print(ok ? "ok   - \(name)" : "FAIL - \(name)")
            if !ok { failed += 1 }
        }
        check("the standard shortcut is ⌥Space", HotKey.standard.label == "⌥Space" && HotKey.standard.keyCode == 49 && HotKey.standard.modifiers == UInt32(optionKey))
        check("all modifiers", HotKey("Control+Option+Shift+Command+N")?.modifiers == UInt32(controlKey | optionKey | shiftKey | cmdKey))
        check("label", HotKey("Control+Shift+BracketLeft")?.label == "⌃⇧[")
        check("function key alone", HotKey("F5")?.keyCode == UInt32(kVK_F5))
        check("⌘C can't be taken", HotKey("Command+C") == nil)
        check("a plain key can't be taken", HotKey("N") == nil && HotKey("Shift+N") == nil && HotKey("F") == nil)
        check("unknown, misordered and empty are refused", ["", "+", "Option+", "Option+Nope", "Shift+Option+N", "Option+Option+N", "option+space"].allSatisfy { HotKey($0) == nil })
        if failed > 0 { exit(1) }
    }
}
