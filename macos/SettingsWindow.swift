import Cocoa
import WebKit

/// Keeps a web view on the bridge's own pages. Without it, dropping a link or a file on the window
/// would open it there, with the launch token and the app's message handlers in reach.
final class BridgePagesOnly: NSObject, WKNavigationDelegate {
    private let port: Int

    init(port: Int) {
        self.port = port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(url?.scheme == "http" && url?.host == "127.0.0.1" && url?.port == port ? .allow : .cancel)
    }
}

/// The Settings window (public/settings.html). It is made anew each time, so a key typed but not
/// saved is gone once the window closes.
final class SettingsWindow: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply {
    private static let handlerName = "settingsHost"

    private let port: Int
    private let pagesOnly: BridgePagesOnly
    private let answer: ([String: Any]) -> [String: Any]
    private let didBecomeKey: () -> Void
    private let didClose: () -> Void
    private(set) var window: NSWindow?
    private(set) var webView: WKWebView?

    init(port: Int, answer: @escaping ([String: Any]) -> [String: Any], didBecomeKey: @escaping () -> Void, didClose: @escaping () -> Void) {
        self.port = port
        pagesOnly = BridgePagesOnly(port: port)
        self.answer = answer
        self.didBecomeKey = didBecomeKey
        self.didClose = didClose
    }

    /// `tokenScript` hands the page the launch token; `tab` nil keeps the one showing.
    func show(tab: String?, tokenScript: WKUserScript?) {
        let tab = tab.flatMap { ["bots", "model", "presets", "general"].contains($0) ? $0 : nil }
        if let webView, let tab {
            webView.evaluateJavaScript("location.hash = '\(tab)'", completionHandler: nil)
        }
        if window == nil { open(tab: tab ?? "bots", tokenScript: tokenScript) }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func open(tab: String, tokenScript: WKUserScript?) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
        if let tokenScript { config.userContentController.addUserScript(tokenScript) }
        let frame = NSRect(x: 0, y: 0, width: 600, height: 560)
        let webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = pagesOnly
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "MausBot Notch Settings"
        window.minSize = NSSize(width: 480, height: 380)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        self.window = window
        self.webView = webView
        if let url = URL(string: "http://127.0.0.1:\(port)/settings.html#\(tab)") {
            webView.load(URLRequest(url: url))
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        didBecomeKey()
    }

    func windowWillClose(_ notification: Notification) {
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView = nil
        window = nil
        didClose()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(answer(message.body as? [String: Any] ?? [:]), nil)
    }
}
