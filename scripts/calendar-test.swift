// Run by scripts/swift-test.sh: which days the Calendar view accepts, and which links its events may open.
import EventKit
import Foundation

@main
enum CalendarTest {
    static func main() {
        var failed = 0
        func check(_ name: String, _ ok: Bool) {
            print(ok ? "ok   - \(name)" : "FAIL - \(name)")
            if !ok { failed += 1 }
        }
        var chicago = Calendar(identifier: .gregorian)
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        let hours = { (text: String) in CalendarEvents.day(text, calendar: chicago).map { $0.duration / 3600 } }
        check("a day starts at local midnight", CalendarEvents.day("2026-11-25", calendar: chicago)?.start == ISO8601DateFormatter().date(from: "2026-11-25T06:00:00Z"))
        check("ordinary, spring and fall days", hours("2026-11-25") == 24 && hours("2026-03-08") == 23 && hours("2026-11-01") == 25)
        check("days that don't exist are refused", hours("2026-02-30") == nil && hours("2026-13-01") == nil)
        check("anything that isn't a date is refused", ["", "today", "2026-1-5", "2026-11-25T00:00:00", "2026-11-25\n", "'); Application('Finder'); ('"].allSatisfy { hours($0) == nil })

        // Which link an event offers. Anyone can send an invitation, so look-alikes matter.
        func join(_ text: String) -> String? { EventLink.find(url: nil, location: nil, notes: text)?.url.absoluteString }
        check("meeting links are found in text", [
            "https://us02web.zoom.us/j/123?pwd=abc", "https://meet.google.com/abc-defg-hij",
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y", "https://acme.webex.com/meet/jose",
            "https://acme.webex.com/acme/j.php?MTID=m1", "https://global.gotomeeting.com/join/123", "https://attendee.gotowebinar.com/join/1/2"
        ].allSatisfy { (link: String) in join("Join here: \(link)\nThanks") == link })
        check("a link in HTML notes", join("<a href=\"https://zoom.us/j/1?a=b&amp;pwd=c\">Join</a>") == "https://zoom.us/j/1?a=b&pwd=c")
        check("http becomes https", join("http://zoom.us/j/1") == "https://zoom.us/j/1")
        check("Outlook Safe Links are unwrapped", join("https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fzoom.us%2Fj%2F9&data=x") == "https://zoom.us/j/9")
        check("look-alike and unsafe links are never a Join", [
            "https://zoom.us.evil.example/j/1", "https://evilzoom.us/j/1", "https://zoom.us@evil.example/j/1", "https://evil.example/zoom.us/j/1",
            "https://zoom.us:8443/j/1", "file:///Applications/zoom.us/j/1", "zoommtg://zoom.us/join?confno=1", "https://evil.example@zoom.us/j/1",
            "https://us02web.zoom.us/u/dialin", "https://acme.webex.com/acme/globalcallin.php?x=1", "https://notgotomeeting.com/join/1", "https://teams.microsoft.com/meetingOptions/?x=1",
            "https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example%2Fj%2F9", "no link"
        ].allSatisfy { join($0) == nil })
        let page = EventLink.find(url: URL(string: "https://example.com/tickets"), location: nil, notes: nil)
        check("another URL opens under its own host", page == EventLink(url: URL(string: "https://example.com/tickets")!, label: "example.com", isMeeting: false))
        check("a meeting wins over another URL", EventLink.find(url: URL(string: "https://example.com"), location: "https://zoom.us/j/5", notes: nil)?.isMeeting == true)
        check("only web addresses open", ["file:///etc/passwd", "javascript:alert(1)", "tel:5551234", "x-apple.systempreferences:x"].allSatisfy { EventLink.find(url: URL(string: $0), location: nil, notes: nil) == nil })
        check("how often it repeats", CalendarEvents.repeats(EKRecurrenceRule(recurrenceWith: .weekly, interval: 2, end: nil)) == "Every 2 weeks" && CalendarEvents.repeats(nil) == "")
        exit(failed == 0 ? 0 : 1)
    }
}
