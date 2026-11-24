import Foundation

/// What identifies the place a double-⌘ draft belongs to. Plain values only, so the rules that decide
/// "is this still the same conversation?" can be tested without any app on screen
/// (scripts/draft-spot-test.swift).
struct DraftSpot: Equatable {
    /// The window's title with the parts that change by themselves removed.
    let title: String
    /// The page the field is in (browsers, Slack and other web-based apps). Empty in native apps.
    let pageURL: String
    let role: String
    /// What the app calls the field: its label, placeholder and page id ("Message #general").
    let labels: [String]

    init(windowTitle: String, pageURL: String, role: String, labels: [String]) {
        title = Self.stableTitle(windowTitle)
        self.pageURL = pageURL
        self.role = role
        self.labels = labels
    }

    /// - Parameters:
    ///   - sameField: the app says it is the very same field (some web pages rebuild theirs).
    ///   - userActed: the user clicked or typed since the double tap, so they may have moved on.
    func isSamePlace(as now: DraftSpot, sameField: Bool, userActed: Bool) -> Bool {
        guard self == now else { return false }
        let named = labels.contains { !$0.isEmpty }
        guard sameField || named else { return false }
        // A native app can show another conversation in the same window, title and field. If the
        // user did something meanwhile, only a page address is enough to say nothing moved.
        return !userActed || !pageURL.isEmpty
    }

    /// Unread counts and "edited" marks come and go without the user leaving the conversation.
    /// Other numbers stay: "general-1" and "general-2" are different places.
    static func stableTitle(_ title: String) -> String {
        var text = title
        for pattern in [
            #"^\s*[•●*]\s*"#,
            #"^\s*\(\d+\+?\)\s*"#,
            #"(?<=\s)\(\d+\+?\)(?=\s|$)"#,
            #"\s+[-–—|]\s+\d+\+? new (items?|messages?|notifications?)"#,
            #"\s+[-–—]\s+Edited\s*$"#
        ] {
            text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
