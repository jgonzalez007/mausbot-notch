import Cocoa
import WebKit
import Carbon
import Security
import ApplicationServices
import CoreGraphics
import Vision
import ScreenCaptureKit
import ServiceManagement

// Global reference for Carbon HotKey C callback
private weak var sharedAppDelegate: AppDelegate?

private func carbonHotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    theEvent: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let theEvent = theEvent else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        theEvent,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    if status == noErr {
        DispatchQueue.main.async {
            switch hotKeyID.id {
            case 1:
                sharedAppDelegate?.toggleNotchExpand()
            case 2:
                sharedAppDelegate?.cyclePrevBot()
            case 3:
                sharedAppDelegate?.cycleNextBot()
            case 4:
                sharedAppDelegate?.handleEscapeKey()
            default:
                break
            }
        }
    }
    return noErr
}

// MARK: - Non-Activating Borderless Notch Panel
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - Transparent WebView with First-Click Acceptance
final class NotchWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }
}

// MARK: - Main Application Delegate
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private var panel: NotchPanel!
    private var webView: NotchWebView!
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var launchAuthToken: String?

    private let bridgePort = 4799
    // Kai OS's notch canvas: its biggest shape (560×480, KaiNotchLayout.expandedSize) plus slack.
    private let panelWidth: CGFloat = 700
    private let panelHeight: CGFloat = 570
    private var hitRectInPanel = NSRect(x: 94, y: 0, width: 212, height: 56)
    private var isNotchOpen = false
    private var isTypingInNotch = false
    private var currentBotName = "MausBot"
    private var currentStatus = "idle"
    private var rosterBots: [[String: String]] = []
    private var selectedBotId: String = ""

    private var globalMouseMonitor: Any?
    private var globalClickMonitor: Any?
    private var localMouseMonitor: Any?
    private var commandMonitors: [Any] = []
    private var commandMonitorsInstalledWhileTrusted = false
    private var commandMonitorHealthTimer: Timer?
    private var toggleHotKeyRef: EventHotKeyRef?
    private var leftArrowHotKeyRef: EventHotKeyRef?
    private var rightArrowHotKeyRef: EventHotKeyRef?
    private var escapeHotKeyRef: EventHotKeyRef?

    // Bare double-tap of ⌘ (no other key) reads what's on screen and asks the bot to answer it.
    // Same gesture rules as Kai OS (KaiHoldGesture): a tap is a press shorter than 0.25 s,
    // and the second tap must start within 0.35 s of the first one ending.
    /// Where the next double-⌘ draft goes, decided at the moment of the double tap (like Kai OS).
    private var pendingReply: PendingReply?
    /// Proofread / Rewrite: the text read from the field the user is writing in, kept so an approved
    /// suggestion can go back in its place (Kai's KaiFocusedText).
    private var focusedText: FocusedText?
    private var commandPressedAt: TimeInterval?
    private var lastCommandTapAt: TimeInterval?
    private let commandTapMaxHold: TimeInterval = 0.25
    private let commandDoubleTapWindow: TimeInterval = 0.35
    // Hardware key codes and device-specific flag bits for the left and right ⌘ keys.
    private static let commandKeyMasks: [UInt16: UInt] = [55: 0x08, 54: 0x10]

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedAppDelegate = self
        NSApp.setActivationPolicy(.accessory)

        registerCarbonGlobalHotKeys()
        requestAccessibilityIfNeeded()
        ScreenContext.startTrackingFrontmostApp()

        ensureNodeServerRunning { [weak self] in
            DispatchQueue.main.async {
                self?.setupStatusItem()
                self?.setupNotchPanel()
                self?.setupEventMonitors()
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(repositionNotchPanel),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    /// Double-⌘ listens for ⌘ presses in other apps, which macOS only delivers to apps
    /// trusted for Accessibility. Ask once at launch so the gesture doesn't silently do nothing.
    private func requestAccessibilityIfNeeded() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            NSLog("MausBot Notch: Accessibility not granted yet; double-⌘ works only inside the notch until it is.")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hk1 = toggleHotKeyRef { UnregisterEventHotKey(hk1) }
        updateExpandedNavigationHotKeys(active: false, includeArrows: false)
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
    }

    private func updateExpandedNavigationHotKeys(active: Bool, includeArrows: Bool) {
        if let hk = leftArrowHotKeyRef {
            UnregisterEventHotKey(hk)
            leftArrowHotKeyRef = nil
        }
        if let hk = rightArrowHotKeyRef {
            UnregisterEventHotKey(hk)
            rightArrowHotKeyRef = nil
        }
        if let hk = escapeHotKeyRef {
            UnregisterEventHotKey(hk)
            escapeHotKeyRef = nil
        }

        guard active else { return }

        let escID = EventHotKeyID(signature: OSType(0x4D424E34), id: 4)
        RegisterEventHotKey(
            UInt32(kVK_Escape),
            0,
            escID,
            GetApplicationEventTarget(),
            0,
            &escapeHotKeyRef
        )

        if includeArrows {
            let leftID = EventHotKeyID(signature: OSType(0x4D424E32), id: 2)
            RegisterEventHotKey(
                UInt32(kVK_LeftArrow),
                0,
                leftID,
                GetApplicationEventTarget(),
                0,
                &leftArrowHotKeyRef
            )

            let rightID = EventHotKeyID(signature: OSType(0x4D424E33), id: 3)
            RegisterEventHotKey(
                UInt32(kVK_RightArrow),
                0,
                rightID,
                GetApplicationEventTarget(),
                0,
                &rightArrowHotKeyRef
            )
        }
    }

    // MARK: - Carbon Global HotKeys (works across all apps, no Accessibility prompt)
    private func registerCarbonGlobalHotKeys() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            carbonHotKeyHandler,
            1,
            &eventType,
            nil,
            nil
        )

        // HotKey 1: Option + Space -> Toggle Notch Expand/Collapse
        let hkID1 = EventHotKeyID(signature: OSType(0x4D424E31), id: 1)
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hkID1,
            GetApplicationEventTarget(),
            0,
            &toggleHotKeyRef
        )
    }

    // MARK: - Node Server Management
    private func launchAuthTokenFilePath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Application Support/MausBot Notch/launch-auth-token"
    }

    private func readLaunchAuthTokenFromDisk() -> String? {
        let path = launchAuthTokenFilePath()
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    private func generateLaunchAuthToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        let data = Data(bytes)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func resolveLaunchAuthToken() -> String? {
        if let token = launchAuthToken, !token.isEmpty { return token }
        if let disk = readLaunchAuthTokenFromDisk() {
            launchAuthToken = disk
            return disk
        }
        return nil
    }

    private func bootstrapHealthCheck(token: String?, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(bridgePort)/api/bootstrap") else {
            completion(false)
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.6
        if let token = token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            completion(ok)
        }.resume()
    }

    private func ensureNodeServerRunning(completion: @escaping () -> Void) {
        if launchAuthToken == nil {
            launchAuthToken = readLaunchAuthTokenFromDisk()
        }
        bootstrapHealthCheck(token: launchAuthToken) { [weak self] healthy in
            guard let self = self else {
                completion()
                return
            }
            if healthy {
                completion()
                return
            }
            if self.launchAuthToken == nil, let diskToken = self.readLaunchAuthTokenFromDisk() {
                self.launchAuthToken = diskToken
                self.bootstrapHealthCheck(token: diskToken) { healthyWithDisk in
                    if healthyWithDisk {
                        completion()
                    } else {
                        self.spawnEmbeddedNodeServer(completion: completion)
                    }
                }
                return
            }
            self.spawnEmbeddedNodeServer(completion: completion)
        }
    }

    private func spawnEmbeddedNodeServer(completion: @escaping () -> Void) {
        let bundleServerPath = Bundle.main.resourceURL?.appendingPathComponent("app/server.mjs").path
        let siblingServerPath = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("server.mjs").path
        let serverPath: String
        if let bPath = bundleServerPath, FileManager.default.fileExists(atPath: bPath) {
            serverPath = bPath
        } else {
            serverPath = siblingServerPath
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let nodeCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.nvm/current/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.local/share/fnm/aliases/default/bin/node"
        ]
        let nodeBin = nodeCandidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/env"
        let proc = Process()
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", serverPath]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = [serverPath]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: (serverPath as NSString).deletingLastPathComponent)
        let token = generateLaunchAuthToken()
        self.launchAuthToken = token
        var env = ProcessInfo.processInfo.environment
        env["MAUSBOT_NOTCH_AUTH_TOKEN"] = token
        env["PORT"] = String(bridgePort)
        proc.environment = env
        do {
            try proc.run()
            self.serverProcess = proc
        } catch {
            NSLog("[MausBotNotch] Failed to start server.mjs: \(error)")
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.55) { [weak self] in
            if self?.resolveLaunchAuthToken() == nil {
                self?.launchAuthToken = self?.readLaunchAuthTokenFromDisk()
            }
            completion()
        }
    }

    // MARK: - Main Screen & Hardware Notch Detection
    private func primaryMacScreen() -> NSScreen? {
        if #available(macOS 12.0, *) {
            if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
                return notched
            }
        }
        return NSScreen.screens.first ?? NSScreen.main
    }

    private func detectHardwareNotchGeometry(for screen: NSScreen) -> (width: CGFloat, height: CGFloat) {
        if #available(macOS 12.0, *) {
            if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
                let gap = screen.frame.width - left.width - right.width
                let h = max(32, screen.safeAreaInsets.top)
                if gap > 100 && gap < 320 {
                    return (gap, h)
                }
            }
        }
        return (185, 32)
    }

    private func setupNotchPanel() {
        guard let screen = primaryMacScreen() else { return }
        let frame = NSRect(
            x: screen.frame.midX - panelWidth / 2,
            y: screen.frame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )

        panel = NotchPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.acceptsMouseMovedEvents = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "notchHost")

        if let token = resolveLaunchAuthToken() {
            let escaped = token
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let scriptSource = "window.__MAUSBOT_NOTCH_AUTH_TOKEN='\(escaped)';"
            let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            config.userContentController.addUserScript(userScript)
        }

        webView = NotchWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight), configuration: config)
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false

        panel.contentView = webView
        panel.orderFrontRegardless()

        if let url = URL(string: "http://127.0.0.1:\(bridgePort)/?native=1") {
            webView.load(URLRequest(url: url))
        }

        let notchGeo = detectHardwareNotchGeometry(for: screen)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.sendCommandToWeb([
                "action": "setNotchGeometry",
                "notchWidth": Int(notchGeo.width),
                "notchHeight": Int(notchGeo.height)
            ])
        }
    }

    @objc private func repositionNotchPanel() {
        guard let screen = primaryMacScreen(), let panel = panel else { return }
        let frame = NSRect(
            x: screen.frame.midX - panelWidth / 2,
            y: screen.frame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )
        panel.setFrame(frame, display: true)
    }

    // MARK: - Surgical Hit-Testing
    private func setupEventMonitors() {
        let handleMouseMove: () -> Void = { [weak self] in
            self?.updateMousePassthrough()
        }

        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { _ in
            handleMouseMove()
        })

        // Collapse when clicking outside the expanded notch
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            guard let self = self, self.isNotchOpen, let panel = self.panel else { return }
            let mouseScreen = NSEvent.mouseLocation
            let panelFrame = panel.frame
            let localX = mouseScreen.x - panelFrame.minX
            let localTopY = panelFrame.maxY - mouseScreen.y
            if !self.hitRectInPanel.insetBy(dx: -10, dy: -10).contains(NSPoint(x: localX, y: localTopY)) {
                self.sendCommandToWeb(["action": "toggleExpand"])
            }
        })

        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown], handler: { event in
            handleMouseMove()
            return event
        })

        setupCommandDoubleTapMonitors()
    }

    // MARK: - Bare ⌘⌘ Double-Tap (screen-aware answer)
    // Ported from Kai OS (KaiSidekickHotkeyMonitor.swift):
    // - Only modifier changes are watched globally. macOS withholds global keyDown events from
    //   apps it doesn't trust, and asking for them can leave the flagsChanged monitor silent too.
    // - A monitor installed before Accessibility was granted stays deaf, so the monitors are
    //   reinstalled whenever the trust state changes (checked every 1.5 s and on app activation).
    private func setupCommandDoubleTapMonitors() {
        installCommandMonitors()
        commandMonitorHealthTimer?.invalidate()
        commandMonitorHealthTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.commandMonitors.isEmpty || AXIsProcessTrusted() != self.commandMonitorsInstalledWhileTrusted {
                self.installCommandMonitors()
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, AXIsProcessTrusted() != self.commandMonitorsInstalledWhileTrusted else { return }
            self.installCommandMonitors()
        }
    }

    private func installCommandMonitors() {
        commandMonitors.forEach(NSEvent.removeMonitor)
        commandMonitors = []
        commandMonitorsInstalledWhileTrusted = AXIsProcessTrusted()
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { [weak self] event in
            self?.handleCommandEvent(event)
        }) {
            commandMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown], handler: { [weak self] event in
            self?.handleCommandEvent(event)
            return event
        }) {
            commandMonitors.append(local)
        }
    }

    private func handleCommandEvent(_ event: NSEvent) {
        guard event.type == .flagsChanged, let mask = Self.commandKeyMasks[event.keyCode] else {
            // Any other key or modifier breaks the sequence.
            commandPressedAt = nil
            lastCommandTapAt = nil
            return
        }
        let time = event.timestamp
        if event.modifierFlags.rawValue & mask != 0 {
            commandPressedAt = time
            return
        }
        guard let pressedAt = commandPressedAt else { return }
        commandPressedAt = nil
        // A key pressed while ⌘ was held (⌘C, ⌘Tab) makes it a shortcut, not a tap. Asking the
        // system when the last key went down needs no keyDown monitor.
        if CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown) < time - pressedAt {
            lastCommandTapAt = nil
            return
        }
        guard time - pressedAt <= commandTapMaxHold else {
            lastCommandTapAt = nil
            return
        }
        if let last = lastCommandTapAt, pressedAt - last <= commandDoubleTapWindow {
            lastCommandTapAt = nil
            DispatchQueue.main.async { [weak self] in self?.answerFromScreen() }
        } else {
            lastCommandTapAt = time
        }
    }

    /// Double-tap ⌘ (bare, no other key) — Kai OS's reply flow: read the email, Slack conversation,
    /// selected text or screen in front of the user, draft a reply as them with a local model
    /// (no tools, the text is untrusted), then write the draft into a Mail reply or at the cursor.
    /// Nothing is ever sent; the user reviews the draft where it lands and sends it themselves.
    func answerFromScreen() {
        // Decide which app to read, and where the draft goes, BEFORE the notch takes focus.
        let target = ScreenContext.targetApp()
        let cursorInTextArea = target.map { ScreenContext.focusIsTextArea(pid: $0.processIdentifier) } ?? false
        pendingReply = nil
        repositionNotchPanel()
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "screenAnswerReading"])
        Task { @MainActor in
            do {
                let context = try await ScreenContext.capture(app: target)
                let destination: ReplyDestination = cursorInTextArea ? .cursor : (context.kind == .mail ? .mailReply : .awaitingCursor)
                self.pendingReply = PendingReply(app: target, destination: destination, mailMessageID: context.mailMessageID)
                self.sendCommandToWeb(["action": "draftReply", "context": context.payload, "destination": destination.rawValue])
            } catch {
                self.sendCommandToWeb(["action": "screenAnswerFailed", "error": error.localizedDescription])
            }
        }
    }

    /// Writes a finished draft where `pendingReply` says. Called once per double tap.
    private func writeDraft(_ text: String) {
        guard let pending = pendingReply else { return }
        pendingReply = nil
        guard pending.destination != .awaitingCursor else { return }
        guard AXIsProcessTrusted() else {
            sendCommandToWeb(["action": "draftWriteFailed", "error": ScreenContextError.accessibilityNeeded.localizedDescription])
            return
        }
        let appName = pending.app?.localizedName ?? "that app"
        sendCommandToWeb(["action": "draftWriting", "caption": pending.destination == .mailReply ? "Opening a reply in Mail…" : "Writing it in \(appName)…"])
        Task { @MainActor in
            do {
                if pending.destination == .mailReply {
                    guard let id = pending.mailMessageID else { throw ScreenContextError.noMailSelection }
                    try ScreenContext.openMailReply(messageID: id)
                    // Mail needs a moment to open the reply and put the cursor in its body.
                    try? await Task.sleep(nanoseconds: 900_000_000)
                } else {
                    // Give keyboard focus back to the user's app before pasting.
                    pending.app?.activate(options: [])
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
                try await ScreenContext.paste(text)
                let place = pending.destination == .mailReply ? "a Mail reply" : "your cursor in \(appName)"
                self.sendCommandToWeb(["action": "draftWritten", "caption": "Written in \(place). Review it and send it yourself."])
            } catch {
                self.sendCommandToWeb(["action": "draftWriteFailed", "error": error.localizedDescription])
            }
        }
    }

    /// Summarize / Proofread / Rewrite from the notch's buttons (Kai's KaiScreenTaskController.begin).
    /// Proofread and Rewrite read what the user is writing first (the selection, or the whole field);
    /// Proofread falls back to the screen. Summarize reads the screen. Nothing is changed until Replace.
    private func runScreenTask(_ task: String) {
        let target = ScreenContext.targetApp()
        focusedText = nil
        Task { @MainActor in
            if task != "summarize", let found = await FocusedText.capture(target: target) {
                self.focusedText = found
                self.sendCommandToWeb(["action": "screenTaskText", "task": task, "source": "field",
                                       "text": found.original, "isSelection": found.isSelection,
                                       "app": found.appName, "canReplace": true])
                return
            }
            if task == "rewrite" {
                self.sendCommandToWeb(["action": "screenTaskFailed", "error": "Select the text you want to rewrite (or click into it), then choose a Rewrite option again."])
                return
            }
            do {
                let context = try await ScreenContext.capture(app: target)
                self.sendCommandToWeb(["action": "screenTaskText", "task": task, "source": "screen",
                                       "text": context.body, "kind": context.kind.rawValue, "from": context.from,
                                       "subject": context.subject, "app": context.app, "canReplace": false])
            } catch {
                self.sendCommandToWeb(["action": "screenTaskFailed", "error": error.localizedDescription])
            }
        }
    }

    /// The user pressed Replace: the suggestion goes where the original was (Kai's replaceOriginal).
    private func replaceFocusedText(_ text: String) {
        guard let field = focusedText else {
            sendCommandToWeb(["action": "replaceFailed", "error": "There's no text to replace. Press Proofread again."])
            return
        }
        Task { @MainActor in
            do {
                try await field.replace(with: text)
                self.focusedText = nil
                self.sendCommandToWeb(["action": "replaced", "caption": "Replaced your text in \(field.appName)."])
            } catch {
                self.sendCommandToWeb(["action": "replaceFailed", "error": error.localizedDescription])
            }
        }
    }

    private func updateMousePassthrough() {
        guard let panel = panel else { return }
        let mouseScreen = NSEvent.mouseLocation
        let panelFrame = panel.frame

        let localX = mouseScreen.x - panelFrame.minX
        let localTopY = panelFrame.maxY - mouseScreen.y

        let paddedHitRect = hitRectInPanel.insetBy(dx: -10, dy: -6)
        let isInside = paddedHitRect.contains(NSPoint(x: localX, y: localTopY))

        if panel.ignoresMouseEvents == isInside {
            panel.ignoresMouseEvents = !isInside
        }
    }

    // MARK: - Menu Bar Status Item
    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateStatusItemAppearance()
        rebuildStatusMenu()
    }

    private func updateStatusItemAppearance() {
        guard let button = statusItem?.button else { return }
        if currentStatus == "working" || currentStatus == "needs_approval" {
            button.title = "⏳ \(currentBotName)"
        } else {
            button.title = "✦ \(currentBotName)"
        }
    }

    private func rebuildStatusMenu() {
        let menu = NSMenu()

        let toggleItem = NSMenuItem(title: "Toggle MausBot Notch (⌥Space)", action: #selector(toggleNotchExpand), keyEquivalent: "")
        menu.addItem(toggleItem)

        menu.addItem(NSMenuItem.separator())

        if !rosterBots.isEmpty {
            let header = NSMenuItem(title: "Bots", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            for bot in rosterBots {
                guard let id = bot["id"], let name = bot["name"] else { continue }
                let item = NSMenuItem(title: name, action: #selector(selectBotFromMenu(_:)), keyEquivalent: "")
                item.representedObject = id
                item.state = (id == selectedBotId) ? .on : .off
                menu.addItem(item)
            }
            menu.addItem(NSMenuItem.separator())
        }

        let loginItem = NSMenuItem(title: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        loginItem.state = (SMAppService.mainApp.status == .enabled) ? .on : .off
        menu.addItem(loginItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit MausBot Notch", action: #selector(quitApp), keyEquivalent: "q")
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc func toggleNotchExpand() {
        repositionNotchPanel()
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "toggleExpand"])
    }

    func cyclePrevBot() {
        sendCommandToWeb(["action": "prevBot"])
    }

    func cycleNextBot() {
        sendCommandToWeb(["action": "nextBot"])
    }

    func handleEscapeKey() {
        sendCommandToWeb(["action": "escape"])
    }

    @objc private func selectBotFromMenu(_ sender: NSMenuItem) {
        guard let botId = sender.representedObject as? String else { return }
        selectedBotId = botId
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "selectBot", "botId": botId])
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            rebuildStatusMenu()
        } catch {
            // Registration can fail when the app runs from an unstable location
            // (e.g. a fresh build directory). The menu state stays honest.
            NSLog("[MausBotNotch] Launch-at-login toggle failed: \(error.localizedDescription)")
            rebuildStatusMenu()
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func sendCommandToWeb(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__notchCommand && window.__notchCommand(\(json))", completionHandler: nil)
    }

    // MARK: - WKScriptMessageHandler & WKUIDelegate
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "hitRect":
            let x = CGFloat((body["x"] as? NSNumber)?.doubleValue ?? 94)
            let y = CGFloat((body["y"] as? NSNumber)?.doubleValue ?? 0)
            let w = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? 212)
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 56)
            hitRectInPanel = NSRect(x: x, y: y, width: w, height: h)
            let wasOpen = isNotchOpen
            isNotchOpen = (body["isOpen"] as? Bool) ?? false
            isTypingInNotch = (body["isTyping"] as? Bool) ?? false

            updateExpandedNavigationHotKeys(active: isNotchOpen, includeArrows: isNotchOpen && !isTypingInNotch)

            if isNotchOpen && !wasOpen {
                panel.ignoresMouseEvents = false
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
                panel.makeFirstResponder(webView)
            }

            if let botName = body["botName"] as? String, !botName.isEmpty {
                currentBotName = botName
            }
            if let status = body["status"] as? String {
                currentStatus = status
            }
            updateStatusItemAppearance()
            rebuildStatusMenu()

        case "rosterLoaded":
            if let bots = body["bots"] as? [[String: String]] {
                rosterBots = bots
            }
            if let sel = body["selectedBotId"] as? String {
                selectedBotId = sel
            }
            rebuildStatusMenu()

        case "writeDraft":
            if let text = body["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                writeDraft(text)
            }

        case "screenTask":
            if let task = body["task"] as? String, ["summarize", "proofread", "rewrite"].contains(task) {
                runScreenTask(task)
            }

        case "replaceText":
            if let text = body["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                replaceFocusedText(text)
            }

        case "copyToClipboard":
            if let text = body["text"] as? String, !text.isEmpty {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
            }

        default:
            break
        }
    }
}

// MARK: - Screen-Aware Quick Reply (double ⌘)
//
// Priority order (no Screen Recording permission needed for the first three):
// 1. Mail selected message — via AppleScript (needs Automation → Mail)
// 2. Slack conversation    — via Accessibility tree walk (needs Accessibility)
// 3. Selected text         — AXSelectedText from the frontmost app (needs Accessibility)
// 4. Screen OCR            — ScreenCaptureKit + Vision (needs Screen Recording)
// The result is drafted into a reply by server.mjs (/api/draft-reply) and written back by writeDraft.
enum ReplyDestination: String {
    case cursor, mailReply, awaitingCursor
}

struct PendingReply {
    let app: NSRunningApplication?
    let destination: ReplyDestination
    let mailMessageID: String?
}

/// What the double tap read, sent to the local server to draft a reply from.
struct ReplyContext {
    enum Kind: String { case mail, chat, screen }
    let kind: Kind
    let app: String
    var from = ""
    var subject = ""
    let body: String
    var mailMessageID: String? = nil

    var payload: [String: Any] {
        ["kind": kind.rawValue, "app": app, "from": from, "subject": subject, "body": body]
    }
}

enum ScreenContextError: LocalizedError {
    case noMailSelection
    case automationNeeded
    case accessibilityNeeded
    case screenRecordingNeeded
    case mailReadFailed(String)
    case mailReplyFailed(String)
    case pasteFailed
    case nothingFound
    case textChanged
    case replaceFailed

    var errorDescription: String? {
        switch self {
        case .noMailSelection:
            return "Select a message in Mail, then double-tap ⌘ again."
        case .automationNeeded:
            return "Turn on Automation for MausBot Notch → Mail in System Settings → Privacy & Security, then try again."
        case .accessibilityNeeded:
            return "Turn on MausBot Notch in System Settings → Privacy & Security → Accessibility (called “Device Control and Data Access” on newer macOS), then try again."
        case .screenRecordingNeeded:
            return "To read the screen, turn on Screen Recording for MausBot Notch in System Settings → Privacy & Security, then quit and reopen the notch."
        case .mailReadFailed(let detail):
            return "Couldn't read the selected email from Mail (\(detail))."
        case .mailReplyFailed(let detail):
            return "Couldn't open a reply in Mail (\(detail)). Click the draft to copy it."
        case .pasteFailed:
            return "The draft couldn't be written into that app. Click it to copy it instead."
        case .nothingFound:
            return "Couldn't find any readable text on screen."
        case .textChanged:
            return "The text changed after the notch read it, so nothing was replaced. Press Proofread again."
        case .replaceFailed:
            return "Couldn't replace the text in that app. Use Copy and paste it yourself."
        }
    }
}

enum ScreenContext {
    static let slackBundleIdentifier = "com.tinyspeck.slackmacgap"
    static let mailBundleIdentifier = "com.apple.mail"

    /// The last app the user was in that isn't the notch itself (like Kai's updateFrontmostApp).
    private(set) static var lastExternalApp: NSRunningApplication?
    private static var activationObserver: NSObjectProtocol?

    static func startTrackingFrontmostApp() {
        remember(NSWorkspace.shared.frontmostApplication)
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { note in
            remember(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }
    }

    private static func remember(_ app: NSRunningApplication?) {
        guard let app, app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        lastExternalApp = app
    }

    static func targetApp() -> NSRunningApplication? {
        let front = NSWorkspace.shared.frontmostApplication
        if let front, front.bundleIdentifier != Bundle.main.bundleIdentifier { return front }
        return lastExternalApp
    }

    static func capture(app frontmost: NSRunningApplication?) async throws -> ReplyContext {
        let bundleID = frontmost?.bundleIdentifier
        let appName = frontmost?.localizedName ?? "the app"

        // 1. Mail selected message (AppleScript — no Screen Recording needed)
        if bundleID == mailBundleIdentifier {
            return try await MainActor.run { try mailSelection() }
        }

        // 2. Slack conversation via Accessibility (no Screen Recording needed)
        if bundleID == slackBundleIdentifier, let pid = frontmost?.processIdentifier {
            if let text = try? await Task.detached(priority: .userInitiated, operation: { try slackConversation(pid: pid) }).value, !text.isEmpty {
                return ReplyContext(kind: .chat, app: "Slack", body: text)
            }
            // Falls through to the screen below.
        }

        // 3. Text the user has highlighted in that app
        if let pid = frontmost?.processIdentifier,
           let selected = selectedText(pid: pid), !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return ReplyContext(kind: .screen, app: appName, body: selected)
        }

        // 4. What's on screen in that app — screenshot + on-device OCR. Never the clipboard.
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            throw ScreenContextError.screenRecordingNeeded
        }
        let text = try await screenText(app: frontmost)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ScreenContextError.nothingFound }
        return ReplyContext(kind: .screen, app: appName, body: text)
    }

    // MARK: Mail (AppleScript, read-only)
    private static func mailSelection() throws -> ReplyContext {
        let script = """
        tell application "Mail"
            set theSelection to selection
            if (count of theSelection) is 0 then return ""
            set m to item 1 of theSelection
            set sep to character id 31
            return (id of m as string) & sep & (sender of m) & sep & (subject of m) & sep & (content of m)
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else { throw ScreenContextError.nothingFound }
        var errorInfo: NSDictionary?
        let result = appleScript.executeAndReturnError(&errorInfo)
        if let errorInfo {
            let number = (errorInfo[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
            // -1743: the user hasn't granted (or has denied) Automation access to Mail.
            if number == -1743 || number == -1744 { throw ScreenContextError.automationNeeded }
            let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "error"
            throw ScreenContextError.mailReadFailed("\(message) \(number)")
        }
        let raw = result.stringValue ?? ""
        guard !raw.isEmpty else { throw ScreenContextError.noMailSelection }
        let parts = raw.components(separatedBy: "\u{1f}")
        guard parts.count >= 4 else { throw ScreenContextError.noMailSelection }
        return ReplyContext(kind: .mail, app: "Mail", from: parts[1], subject: parts[2],
                            body: parts[3...].joined(separator: "\u{1f}"), mailMessageID: parts[0])
    }

    /// Opens Mail's own reply to the message that was read, so Mail picks the recipient and
    /// quotes the original — the model never chooses who it goes to. Like Kai's KaiMailReplyScript.
    @MainActor
    static func openMailReply(messageID: String) throws {
        // Only digits ever go into the script text, so nothing from the email can become code.
        guard !messageID.isEmpty, messageID.allSatisfy(\.isNumber) else { throw ScreenContextError.mailReplyFailed("bad message id") }
        let script = """
        tell application "Mail"
            set theMessage to missing value
            repeat with m in (get selection)
                if (id of m as string) is "\(messageID)" then set theMessage to contents of m
            end repeat
            if theMessage is missing value then error "that message isn't selected anymore"
            set theReply to reply theMessage with opening window
            activate
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else { throw ScreenContextError.mailReplyFailed("script") }
        var errorInfo: NSDictionary?
        appleScript.executeAndReturnError(&errorInfo)
        if let errorInfo {
            let number = (errorInfo[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
            if number == -1743 || number == -1744 { throw ScreenContextError.automationNeeded }
            throw ScreenContextError.mailReplyFailed(errorInfo[NSAppleScript.errorMessage] as? String ?? "error \(number)")
        }
    }

    // MARK: Writing at the cursor (Kai's KaiPasteInserter): paste, then put the clipboard back.
    private static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    @MainActor
    static func paste(_ text: String) async throws {
        guard AXIsProcessTrusted() else { throw ScreenContextError.accessibilityNeeded }
        let pasteboard = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        pasteboard.clearContents()
        // Marked transient so clipboard managers don't keep the draft.
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: transientType)
        pasteboard.writeObjects([item])
        let draftChangeCount = pasteboard.changeCount
        let source = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false) else {
            throw ScreenContextError.pasteFailed
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        // Long enough for the target app to read the pasteboard before it's restored.
        try? await Task.sleep(nanoseconds: 600_000_000)
        // Leave it alone if the user copied something meanwhile.
        guard pasteboard.changeCount == draftChangeCount else { return }
        pasteboard.clearContents()
        let restored = saved.map { fields -> NSPasteboardItem in
            let item = NSPasteboardItem()
            fields.forEach { item.setData($0.1, forType: $0.0) }
            return item
        }
        if !restored.isEmpty { pasteboard.writeObjects(restored) }
    }

    /// True when the user's cursor is in a multi-line text box (an email body, a Slack
    /// message box) — then the draft is written right there. Same test as Kai's KaiFocusProbe.
    static func focusIsTextArea(pid: pid_t) -> Bool {
        guard AXIsProcessTrusted(), pid != ProcessInfo.processInfo.processIdentifier else { return false }
        let appElement = AXUIElementCreateApplication(pid)
        // Chromium browsers expose web page contents only after being asked to.
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
        let element = focused as! AXUIElement
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return (role as? String) == "AXTextArea" && settable.boolValue
    }

    // MARK: Slack (Accessibility tree, read-only — skips the draft/message box)
    private static func slackConversation(pid: pid_t) throws -> String {
        guard AXIsProcessTrusted() else { throw ScreenContextError.accessibilityNeeded }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var windowRef: CFTypeRef?
        var root: AXUIElement?
        if AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &windowRef) == .success, let window = windowRef {
            root = (window as! AXUIElement)
        } else if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowRef) == .success,
                  let windows = windowRef as? [AXUIElement], let first = windows.first {
            root = first
        }
        guard let root else { return "" }
        var lines: [String] = []
        var visited = 0
        let deadline = Date().addingTimeInterval(4)
        walkAX(root, depth: 0, visited: &visited, deadline: deadline, into: &lines)
        return lines.joined(separator: "\n")
    }

    // MARK: Selected text via AXSelectedText (works for most apps, no Screen Recording)
    private static func selectedText(pid: pid_t) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        // Try the focused element first, then the main window's focused UI element.
        var focusedRef: CFTypeRef?
        var element: AXUIElement?
        if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
           let el = focusedRef {
            element = (el as! AXUIElement)
        }
        guard let el = element else { return nil }
        var selRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXSelectedTextAttribute as CFString, &selRef) == .success,
           let text = selRef as? String, !text.isEmpty {
            return text
        }
        return nil
    }

    private static func walkAX(_ element: AXUIElement, depth: Int, visited: inout Int, deadline: Date, into lines: inout [String]) {
        guard depth < 60, visited < 6000, Date() < deadline else { return }
        visited += 1
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        // The message box can hold a draft the user hasn't sent yet.
        if let role = roleRef as? String, role == "AXTextArea" || role == "AXTextField" || role == "AXSecureTextField" { return }
        if roleRef as? String == "AXStaticText" {
            var valueRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success,
               let value = valueRef as? String, !value.isEmpty {
                lines.append(value)
            }
        }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return }
        for child in children { walkAX(child, depth: depth + 1, visited: &visited, deadline: deadline, into: &lines) }
    }

    // MARK: Generic screen (screenshot + on-device OCR — only called if Screen Recording already granted)
    private static func screenText(app: NSRunningApplication?) async throws -> String {
        let image: CGImage
        if #available(macOS 14.0, *) {
            image = try await captureWithScreenCaptureKit(pid: app?.processIdentifier)
        } else {
            let cursor = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { $0.frame.contains(cursor) } ?? NSScreen.main
            guard let displayID = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value,
                  let shot = CGDisplayCreateImage(CGDirectDisplayID(displayID)) else { throw ScreenContextError.nothingFound }
            image = shot
        }
        return try await recognizeText(in: image)
    }

    /// The app's front window if we can find it; otherwise the display under the cursor without the notch's own windows.
    @available(macOS 14.0, *)
    private static func captureWithScreenCaptureKit(pid: pid_t?) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false

        if let pid,
           let window = content.windows.first(where: {
               $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.isOnScreen
                   && $0.frame.width > 200 && $0.frame.height > 150
           }) {
            configuration.width = Int(window.frame.width * 2)
            configuration.height = Int(window.frame.height * 2)
            return try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
        }

        let cursor = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(cursor) } ?? NSScreen.main
        let displayID = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
            throw ScreenContextError.nothingFound
        }
        let ownApp = content.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
        configuration.width = display.width * 2
        configuration.height = display.height * 2
        return try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingApplications: ownApp, exceptingWindows: []),
            configuration: configuration)
    }

    private static func recognizeText(in image: CGImage) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let results = (request.results as? [VNRecognizedTextObservation]) ?? []
                let text = results.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                continuation.resume(returning: text)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

// MARK: - The text the user is writing (port of Kai OS's KaiFocusedText)
//
// Reads the selection, or the whole focused field, in the app the user was in. If that app doesn't
// expose its text through Accessibility (Chrome, Slack, Notion), it copies the selection the way the
// user would and puts the clipboard back. Replacing tries Accessibility first and only believes it
// when the text reads back; otherwise it pastes over the original. Password fields are never read.
@MainActor
final class FocusedText {
    let appName: String
    let original: String
    let isSelection: Bool
    private let pid: pid_t
    /// Nil when the text came from copying a selection, which can only be pasted back over.
    private let element: AXUIElement?

    private init(appName: String, original: String, isSelection: Bool, pid: pid_t, element: AXUIElement?) {
        self.appName = appName
        self.original = original
        self.isSelection = isSelection
        self.pid = pid
        self.element = element
    }

    static func capture(target: NSRunningApplication?, maxLength: Int = 12_000) async -> FocusedText? {
        guard AXIsProcessTrusted(), let target, !target.isTerminated else { return nil }
        // The notch took the keyboard when it opened; hand it back so a copy goes to the user's app.
        if NSApp.isActive || NSApp.keyWindow != nil { await handKeyboardBack(to: target) }
        for attempt in 1...2 {
            if let found = fromField(target, maxLength: maxLength) { return found }
            if let found = await bySelection(target, maxLength: maxLength) { return found }
            if attempt == 1 { try? await Task.sleep(nanoseconds: 400_000_000) }
        }
        return nil
    }

    private static func handKeyboardBack(to app: NSRunningApplication) async {
        NSApp.keyWindow?.resignKey()
        NSApp.deactivate()
        app.activate(options: [])
        try? await Task.sleep(nanoseconds: 300_000_000)
    }

    private static func fromField(_ app: NSRunningApplication, maxLength: Int) -> FocusedText? {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var focused: CFTypeRef?
        var status = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focused)
        if status != .success || focused == nil {
            status = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focused)
        }
        guard status == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement
        guard let pid = pidOf(element), pid == app.processIdentifier else { return nil }
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        guard let roleName = role as? String, ["AXTextArea", "AXTextField", "AXComboBox", "AXWebArea"].contains(roleName) else { return nil }
        var subrole: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
        if (subrole as? String) == (kAXSecureTextFieldSubrole as String) { return nil }

        let name = app.localizedName ?? "that app"
        if let selected = string(element, kAXSelectedTextAttribute),
           !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, selected.count <= maxLength {
            return FocusedText(appName: name, original: selected, isSelection: true, pid: app.processIdentifier, element: element)
        }
        if let whole = string(element, kAXValueAttribute),
           !whole.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, whole.count <= maxLength {
            return FocusedText(appName: name, original: whole, isSelection: false, pid: app.processIdentifier, element: element)
        }
        return nil
    }

    private static func bySelection(_ app: NSRunningApplication, maxLength: Int) async -> FocusedText? {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
            app.activate(options: [])
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return nil }
        }
        let board = NSPasteboard.general
        let saved = PasteboardSnapshot(board)
        let before = board.changeCount
        postCommand(key: kVK_ANSI_C)
        try? await Task.sleep(nanoseconds: 220_000_000)
        // Nothing selected means nothing was copied, and the clipboard is untouched.
        guard board.changeCount != before else { return nil }
        let copied = board.string(forType: .string)
        saved.restore(to: board)
        guard let copied, !copied.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, copied.count <= maxLength else { return nil }
        return FocusedText(appName: app.localizedName ?? "that app", original: copied, isSelection: true, pid: app.processIdentifier, element: nil)
    }

    /// Puts `text` where the original was. Changes nothing if the original is no longer there.
    func replace(with text: String) async throws {
        guard AXIsProcessTrusted() else { throw ScreenContextError.accessibilityNeeded }
        // Keep the field's own leading/trailing blank lines (Kai's matchingEdges).
        let final = isSelection ? text : Self.matchingEdges(of: original, text)
        guard let element else {
            try await pasteReplacing(final)
            return
        }
        let current = isSelection ? Self.string(element, kAXSelectedTextAttribute) : Self.string(element, kAXValueAttribute)
        guard current == original else { throw ScreenContextError.textChanged }
        let attribute = isSelection ? kAXSelectedTextAttribute : kAXValueAttribute
        if AXUIElementSetAttributeValue(element, attribute as CFString, final as CFTypeRef) == .success, await confirm(final) { return }
        try await pasteReplacing(final)
    }

    /// Some apps accept the Accessibility write and ignore it. Only believe it when the text reads back.
    private func confirm(_ text: String) async -> Bool {
        guard let element else { return false }
        try? await Task.sleep(nanoseconds: 150_000_000)
        if isSelection {
            return Self.string(element, kAXSelectedTextAttribute) == text || (Self.string(element, kAXValueAttribute)?.contains(text) ?? false)
        }
        return Self.string(element, kAXValueAttribute) == text
    }

    private func pasteReplacing(_ text: String) async throws {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { throw ScreenContextError.replaceFailed }
        await Self.handKeyboardBack(to: app)
        if let element { AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw ScreenContextError.replaceFailed }
        if !isSelection {
            Self.postCommand(key: kVK_ANSI_A)
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        do { try await ScreenContext.paste(text) } catch { throw ScreenContextError.replaceFailed }
    }

    static func matchingEdges(of original: String, _ suggestion: String) -> String {
        let lead = String(original.prefix(while: { $0.isWhitespace || $0.isNewline }))
        let trail = String(original.reversed().prefix(while: { $0.isWhitespace || $0.isNewline }).reversed())
        return lead + suggestion.trimmingCharacters(in: .whitespacesAndNewlines) + trail
    }

    private static func postCommand(key: Int) {
        let source = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(key), keyDown: down)
            event?.flags = .maskCommand
            event?.post(tap: .cghidEventTap)
        }
    }

    private static func pidOf(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
}

/// Everything on the clipboard, so it can be put back after a copy.
struct PasteboardSnapshot {
    private let items: [[(NSPasteboard.PasteboardType, Data)]]

    init(_ board: NSPasteboard) {
        items = (board.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
    }

    func restore(to board: NSPasteboard) {
        board.clearContents()
        let restored = items.map { fields -> NSPasteboardItem in
            let item = NSPasteboardItem()
            fields.forEach { item.setData($0.1, forType: $0.0) }
            return item
        }
        if !restored.isEmpty { board.writeObjects(restored) }
    }
}

// MARK: - Entry Point
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
