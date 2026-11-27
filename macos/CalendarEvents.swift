import EventKit
import Foundation

/// One day of the Mac's own calendars, read for the notch's Calendar view. Never writes.
enum CalendarEvents {
    private static let store = EKEventStore()
    /// The link each listed event may open. Kept here so the page names an event, never an address.
    @MainActor private static var links: [String: URL] = [:]

    @MainActor static func link(for id: String) -> URL? { links[id] }

    /// The local day named by "2026-11-25". Nil for anything else, including days that don't exist.
    static func day(_ text: String, calendar: Calendar = .current) -> DateInterval? {
        guard text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let wanted = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let date = gregorian.date(from: wanted),
              gregorian.dateComponents([.year, .month, .day], from: date) == wanted else { return nil }
        return gregorian.dateInterval(of: .day, for: date)
    }

    /// The answer for the notch page: { date, status: "ok" | "denied" | "error", events, error? }.
    @MainActor static func answer(for date: String) async -> [String: Any] {
        guard let day = day(date) else { return ["date": date, "status": "error", "error": "Not a date."] }
        do {
            guard try await hasAccess() else { return ["date": date, "status": "denied"] }
        } catch {
            return ["date": date, "status": "error", "error": error.localizedDescription]
        }
        let found = store.events(matching: store.predicateForEvents(withStart: day.start, end: day.end, calendars: nil))
            // The predicate also returns events that only touch midnight at either end.
            .filter { $0.status != .canceled && $0.startDate < day.end && ($0.endDate > day.start || $0.startDate == day.start) }
            .sorted { ($0.isAllDay ? 0 : 1, $0.startDate) < ($1.isAllDay ? 0 : 1, $1.startDate) }
        let events: [[String: Any]] = found.map { event in
            let allDay = event.isAllDay || (event.startDate <= day.start && event.endDate >= day.end)
            let id = "\(event.calendarItemIdentifier)@\(event.startDate.timeIntervalSince1970)"
            let link = EventLink.find(url: event.url, location: event.location, notes: event.notes)
            links[id] = link?.url
            return [
                "id": id,
                "title": event.title ?? "",
                "calendar": event.calendar?.title ?? "",
                "color": hex(event.calendar?.cgColor),
                "allDay": allDay,
                // Only the part that falls on this day: an event from last night shows no start time.
                "startMs": event.startDate < day.start ? NSNull() : event.startDate.timeIntervalSince1970 * 1000 as Any,
                "endMs": event.endDate > day.end ? NSNull() : event.endDate.timeIntervalSince1970 * 1000 as Any,
                // The whole event, for its details.
                "wholeDays": event.isAllDay,
                "fromMs": event.startDate.timeIntervalSince1970 * 1000,
                "toMs": event.endDate.timeIntervalSince1970 * 1000,
                "repeats": repeats(event.recurrenceRules?.first),
                "location": event.location ?? "",
                "notes": event.notes ?? "",
                "organizer": name(event.organizer),
                "people": (event.attendees ?? []).filter { $0.participantType != .room && $0.participantType != .resource }.prefix(100)
                    .map { ["name": name($0), "reply": reply($0.participantStatus), "me": $0.isCurrentUser] as [String: Any] },
                "link": link.map { ["join": $0.isMeeting, "label": $0.label] as [String: Any] } ?? NSNull() as Any
            ]
        }
        return ["date": date, "status": "ok", "events": events]
    }

    static func repeats(_ rule: EKRecurrenceRule?) -> String {
        guard let rule else { return "" }
        let unit: String
        switch rule.frequency {
        case .daily: unit = "day"
        case .weekly: unit = "week"
        case .monthly: unit = "month"
        case .yearly: unit = "year"
        @unknown default: return "Repeats"
        }
        return rule.interval > 1 ? "Every \(rule.interval) \(unit)s" : "Every \(unit)"
    }

    private static func name(_ person: EKParticipant?) -> String {
        guard let person else { return "" }
        if let name = person.name, !name.isEmpty { return name }
        let address = person.url.absoluteString
        return address.lowercased().hasPrefix("mailto:") ? String(address.dropFirst(7)) : ""
    }

    private static func reply(_ status: EKParticipantStatus) -> String {
        switch status {
        case .accepted: return "Going"
        case .declined: return "Not going"
        case .tentative: return "Maybe"
        default: return ""
        }
    }

    private static func hasAccess() async throws -> Bool {
        if #available(macOS 14.0, *) {
            return try await store.requestFullAccessToEvents()
        }
        return try await store.requestAccess(to: .event)
    }

    private static func hex(_ color: CGColor?) -> String {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let parts = color?.converted(to: space, intent: .defaultIntent, options: nil)?.components, parts.count >= 3 else { return "#8e8e93" }
        return "#" + parts.prefix(3).map { String(format: "%02x", Int((min(max($0, 0), 1) * 255).rounded())) }.joined()
    }
}

/// The one link an event offers. Anyone can send an invitation, so its text isn't trusted: "Join" is
/// only for https links on a known meeting service; the event's own URL otherwise opens as a plain link.
struct EventLink: Equatable {
    let url: URL
    let label: String
    let isMeeting: Bool

    private static let services: [(name: String, domains: [String], paths: [String])] = [
        ("Zoom", ["zoom.us", "zoomgov.com"], ["/j/", "/my/", "/s/", "/w/", "/wc/"]),
        ("Google Meet", ["meet.google.com"], ["/"]),
        ("Teams", ["teams.microsoft.com", "teams.live.com", "teams.microsoft.us"], ["/l/meetup-join/", "/meet/"]),
        ("Webex", ["webex.com"], ["/meet/", "/join/", "/j.php", "/wbxmjs/", "/webappng/"]),
        ("GoTo", ["meet.goto.com", "gotomeet.me"], ["/"]),
        ("GoTo", ["gotomeeting.com", "gotowebinar.com", "app.goto.com"], ["/join", "/meeting/"]),
        ("FaceTime", ["facetime.apple.com"], ["/join"]),
        ("Whereby", ["whereby.com"], ["/"]),
        ("Jitsi", ["meet.jit.si"], ["/"]),
        ("Chime", ["chime.aws"], ["/"])
    ]

    static func find(url: URL?, location: String?, notes: String?) -> EventLink? {
        let own = url.flatMap(safe)
        let written = [location, notes].compactMap { $0 }.flatMap { urls(in: $0) }
        for candidate in ([own].compactMap { $0 } + written) {
            if let name = service(candidate) { return EventLink(url: candidate, label: name, isMeeting: true) }
        }
        return own.map { EventLink(url: $0, label: $0.host ?? "", isMeeting: false) }
    }

    private static func service(_ url: URL) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        return services.first { service in
            service.domains.contains { host == $0 || host.hasSuffix("." + $0) }
                && service.paths.contains { url.path.count > 1 && url.path.lowercased().contains($0) }
        }?.name
    }

    /// https on the ordinary port with no user name in it ("https://zoom.us@evil.example"). Outlook's
    /// Safe Links are unwrapped, so the address that is shown and checked is the real one.
    private static func safe(_ url: URL) -> URL? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased(), host.contains(".") else { return nil }
        if host.hasSuffix(".safelinks.protection.outlook.com") {
            guard let inner = parts.queryItems?.first(where: { $0.name == "url" })?.value.flatMap(URL.init(string:)),
                  inner.host?.lowercased().hasSuffix(".safelinks.protection.outlook.com") == false else { return nil }
            return safe(inner)
        }
        parts.scheme = "https"
        return parts.url
    }

    private static func urls(in text: String) -> [URL] {
        // Notes are often HTML, where a link's "&" is written "&amp;".
        let text = String(text.prefix(20_000)).replacingOccurrences(of: "&amp;", with: "&")
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        return detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { $0.url.flatMap(safe) }
    }
}
