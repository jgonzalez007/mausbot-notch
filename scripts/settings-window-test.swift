// Run by ui-test.mjs: the app's own Settings window, against the test bridge. It is never brought on screen.
import Cocoa
import WebKit

@main
@MainActor
enum SettingsWindowTest {
    static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { await run() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { fail("timed out") }
        NSApplication.shared.run()
    }

    static func fail(_ why: String) -> Never {
        print("FAIL - Settings window: \(why)")
        exit(1)
    }

    static func until(_ why: String, _ condition: () async -> Bool) async {
        for _ in 0..<100 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        fail(why)
    }

    static func run() async {
        let port = Int(CommandLine.arguments[1])!
        let token = WKUserScript(source: "window.__MAUSBOT_NOTCH_AUTH_TOKEN='\(CommandLine.arguments[2])';", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        var asked: [String] = []
        var closed = false
        let settings = SettingsWindow(
            port: port,
            answer: { asked.append($0["type"] as? String ?? ""); return ["ok": true] },
            didBecomeKey: {},
            didClose: { closed = true }
        )
        settings.open(tab: "general", tokenScript: token)
        guard let web = settings.webView else { fail("no page") }
        func js(_ code: String) async -> Any? { try? await web.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page) }

        await until("the General tab loads with the saved settings") {
            await js("return !document.querySelector('[data-panel=general]').hidden && document.querySelector('#hotkey-label').textContent") as? String == "⌥Space"
        }
        _ = await js("document.querySelector('#hotkey-record').click()")
        await until("the page reaches the app and gets its answer") {
            await js("return document.querySelector('#hotkey-label').textContent") as? String == "Press keys…"
        }
        if asked != ["beginRecording"] { fail("asked \(asked)") }
        for address in ["https://example.com/", "file:///etc/hosts", "http://127.0.0.1:\(port + 1)/", "http://localhost:\(port)/", "data:text/html,x"] {
            _ = await js("location.href = '\(address)'")
            try? await Task.sleep(nanoseconds: 200_000_000)
            if web.url?.host != "127.0.0.1" || web.url?.port != port { fail("left for \(address)") }
        }
        settings.window?.close()
        if !closed || settings.webView != nil || settings.window != nil { fail("closing keeps the page") }
        settings.open(tab: "bots", tokenScript: token)
        if settings.webView === web || settings.webView == nil { fail("a new window reuses the old page") }
        print("ok   - the app's Settings window loads, reaches the app, stays on the bridge's pages and starts afresh")
        exit(0)
    }
}
