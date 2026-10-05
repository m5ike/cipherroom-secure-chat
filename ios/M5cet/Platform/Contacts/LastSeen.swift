// Presence (6.7): online, away or far away — from whether a member is
// connected with the app in the foreground, else from when they were last seen
// (the last time they had the app open while connected). Port of
// android/app/src/main/java/cz/m5cet/app/contacts/LastSeen.java and the web's
// client/src/lib/presence.ts (the server uses it too), with the same
// thresholds, so the app, Android and the web show the same colour:
//
//   connected and in the foreground     online   (green, @success)
//   last seen at most 5 minutes ago     online
//   last seen 5 to 60 minutes ago       away     (yellow, @warning)
//   last seen more than an hour ago     far      (orange — the theme has no token for it)
//
// Pure (LastSeenTests). Candidate for M5Kit (M5Proto, next to RoomPresence).

import Foundation
import M5Core

enum LastSeen {
    static let onlineMs: Int64 = 5 * 60_000
    static let awayMs: Int64 = 60 * 60_000
    static let online = "online", away = "away", far = "far"
    /// Far away: orange (Tailwind orange-500, as the web's dot in a dark tone).
    static let orange = "#f97316"

    /// The presence at `now`; lastSeen 0 = unknown, which counts as far away unless in the foreground.
    static func state(connected: Bool, foreground: Bool, lastSeen: Int64, now: Int64) -> String {
        if connected && foreground { return online }
        if lastSeen <= 0 { return far }
        let age = now - lastSeen
        if age <= onlineMs { return online }
        if age <= awayMs { return away }
        return far
    }

    /// When the member was last seen as of `now`: now while connected in the foreground.
    static func seenAt(connected: Bool, foreground: Bool, lastSeen: Int64, now: Int64) -> Int64 {
        connected && foreground ? now : lastSeen
    }

    /// Milliseconds until state() changes by itself; -1 when it does not without news.
    static func changeIn(connected: Bool, foreground: Bool, lastSeen: Int64, now: Int64) -> Int64 {
        if (connected && foreground) || lastSeen <= 0 { return -1 }
        let age = now - lastSeen
        if age <= onlineMs { return onlineMs - age + 1 }
        if age <= awayMs { return awayMs - age + 1 }
        return -1
    }

    /// The dot's colour: a theme token, orange where the theme has none.
    static func color(_ state: String) -> String {
        switch state {
        case online: "@success"
        case away: "@warning"
        default: orange
        }
    }

    /// "How long ago": a unit — "now" (under a minute), "min", "h" or "d" — and how many.
    struct Ago: Equatable, Sendable {
        let unit: String
        let n: Int64
    }

    static func ago(lastSeen: Int64, now: Int64) -> Ago {
        let ms = max(0, now - lastSeen)
        if ms < 60_000 { return Ago(unit: "now", n: 0) }
        if ms < 60 * 60_000 { return Ago(unit: "min", n: ms / 60_000) }
        if ms < 24 * 60 * 60_000 { return Ago(unit: "h", n: ms / (60 * 60_000)) }
        return Ago(unit: "d", n: ms / (24 * 60 * 60_000))
    }

    /// The app's words for a key (the design's strings).
    typealias Words = (String) -> String

    /// "Last seen 12 min ago", "In the app right now", or that it is not known.
    static func seenText(connected: Bool, foreground: Bool, lastSeen: Int64, now: Int64, words w: Words) -> String {
        if connected && foreground { return w("presence.now") }
        if lastSeen <= 0 { return w("presence.seen.unknown") }
        let a = ago(lastSeen: lastSeen, now: now)
        let text = a.unit == "now" ? w("presence.ago.now") : w("presence.ago." + a.unit).replacingOccurrences(of: "{n}", with: String(a.n))
        return w("presence.seen").replacingOccurrences(of: "{ago}", with: text)
    }

    /// Adds what the People widget draws of a person's presence — .presence, .presenceColor,
    /// .presenceLabel, .seenText — from the room's facts (.connected, .foreground, .lastSeen). A member
    /// whose connection went (channel "held") shows the presence as their status.
    static func decorate(_ person: JSONObject, words w: Words, now: Int64) -> JSONObject {
        guard person.has("lastSeen") else { return person }
        var u = person
        let connected = u.bool("connected") ?? true
        let foreground = u.bool("foreground") ?? true
        let lastSeen = Int64(u.double("lastSeen") ?? 0)
        let state = state(connected: connected, foreground: foreground, lastSeen: lastSeen, now: now)
        u["presence"] = .string(state)
        u["presenceColor"] = .string(color(state))
        u["presenceLabel"] = .string(w("presence." + state))
        u["seenText"] = .string(seenText(connected: connected, foreground: foreground, lastSeen: lastSeen, now: now, words: w))
        if u.optString("channel") == "held" {
            u["statusIcon"] = "moon"
            u["statusColor"] = .string(color(state))
            u["statusLabel"] = .string(w("presence." + state))
        }
        return u
    }
}
