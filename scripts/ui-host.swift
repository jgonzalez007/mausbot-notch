// Loads the notch page in the same web engine the app uses, runs a test script in it, prints the
// script's result and saves the snapshots it asks for. Usage: ui-host <url> <script.js> <out-dir> <token>
import Cocoa
import WebKit

final class Host: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    let script: String
    let outDir: String
    let token: String
    var webView: WKWebView!
    var window: NSWindow!

    init(script: String, outDir: String, token: String) {
        self.script = script
        self.outDir = outDir
        self.token = token
    }

    func start(_ url: URL) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "notchHost")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "snapshot")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "settingsHost")
        config.userContentController.addUserScript(WKUserScript(source: """
            window.__MAUSBOT_NOTCH_AUTH_TOKEN = '\(token)';
            window.__errors = []; window.__sent = []; window.__native = []; window.__nativeAnswer = { ok: true };
            addEventListener('error', (e) => __errors.push(e.message));
            addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason)));
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let frame = NSRect(x: 0, y: 0, width: 700, height: 570)
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        // On screen but fully transparent and behind everything, so the page isn't throttled.
        window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = webView
        window.orderBack(nil)
        webView.load(URLRequest(url: url))
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.body),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("__sent.push(\(json))", completionHandler: nil)
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        if message.name == "settingsHost" {
            // Stands in for the app: remembers what was asked and answers what the test wants.
            guard let data = try? JSONSerialization.data(withJSONObject: message.body), let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("__native.push(\(json)); JSON.stringify(__nativeAnswer)") { answer, _ in
                let data = Data(((answer as? String) ?? "{}").utf8)
                replyHandler(try? JSONSerialization.jsonObject(with: data), nil)
            }
            return
        }
        let file = "\(outDir)/\((message.body as? String ?? "shot").replacingOccurrences(of: "/", with: "-")).png"
        webView.takeSnapshot(with: nil) { image, _ in
            if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: file))
            }
            replyHandler(true, nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
                print(result as? String ?? "")
                exit(0)
            } catch {
                print("FAIL - \((error as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? error)")
                exit(1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("FAIL - \(error.localizedDescription)")
        exit(1)
    }
}

let args = CommandLine.arguments
let host = Host(script: try! String(contentsOfFile: args[2], encoding: .utf8), outDir: args[3], token: args[4])
NSApplication.shared.setActivationPolicy(.accessory)
DispatchQueue.main.async { host.start(URL(string: args[1])!) }
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { print("FAIL - timed out"); exit(1) }
NSApplication.shared.run()
