// Run by scripts/swift-test.sh: the rules that decide whether a draft may be pasted.
import Foundation

@main
enum DraftSpotTest {
    static func main() {
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print(ok ? "ok   - \(name)" : "FAIL - \(name)")
            if !ok { failed += 1 }
        }
        func spot(_ title: String, url: String = "", labels: [String] = ["Message"]) -> DraftSpot {
            DraftSpot(windowTitle: title, pageURL: url, role: "AXTextArea", labels: labels)
        }
        func same(_ a: DraftSpot, _ b: DraftSpot, field: Bool = true, acted: Bool = false) -> Bool {
            a.isSamePlace(as: b, sameField: field, userActed: acted)
        }

        check("Slack unread count is ignored", same(spot("general - Acme - Slack"), spot("general - Acme - 2 new items - Slack")))
        check("leading unread count is ignored", same(spot("Discord | #ops"), spot("(3) Discord | #ops")))
        check("Gmail inbox count is ignored", same(spot("Inbox (3) - a@b.c"), spot("Inbox (12) - a@b.c")))
        check("edited mark is ignored", same(spot("Letter"), spot("Letter — Edited")))
        check("unsaved dot is ignored", same(spot("notes.md"), spot("● notes.md")))
        check("general-1 and general-2 differ", !same(spot("general-1 - Slack"), spot("general-2 - Slack")))
        check("numbered titles differ", !same(spot("Unit 12"), spot("Unit 14")))
        check("another person's window differs", !same(spot("Maria"), spot("John")))
        check("another page differs", !same(spot("Chat", url: "https://x/a"), spot("Chat", url: "https://x/b")))
        check("another field label differs", !same(spot("WhatsApp", labels: ["Type to Maria"]), spot("WhatsApp", labels: ["Type to John"])))
        check("rebuilt field with a label is accepted", same(spot("Chat"), spot("Chat"), field: false))
        check("rebuilt field without a label is refused", !same(spot("Chat", labels: ["", ""]), spot("Chat", labels: ["", ""]), field: false))
        check("native app after a click is refused", !same(spot("Messages"), spot("Messages"), acted: true))
        check("same page after a click is accepted", same(spot("Chat", url: "https://x/a"), spot("Chat", url: "https://x/a"), acted: true))
        check("native app, nothing touched, is accepted", same(spot("Messages"), spot("Messages")))

        if failed > 0 { exit(1) }
        print("\nALL DRAFT SPOT TESTS PASSED")
    }
}
