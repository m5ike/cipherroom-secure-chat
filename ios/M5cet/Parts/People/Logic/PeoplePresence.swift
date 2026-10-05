// 6.2 People: a person's status and connection quality as the web's recipients
// widget shows them (RecipientsWidget.tsx), and 6.7's presence — online, away or
// far away from the foreground flag and "last seen" (client/src/lib/presence.ts).
// Pure, so the unit tests pin them down. Ports of android/…/contacts/Presence.java
// and contacts/LastSeen.java.
//
//   online      a channel is open and the person is signed in
//   light       a channel is open, a guest without an account (P2P, "light")
//   dnd         in a call right now (busy)
//   away        signed in, not connected — the server holds messages for them
//   connecting  the channel is being set up
//   offline     the connection failed or closed

import Foundation
import M5Core

enum PeoplePresence {
    static let online = "online", light = "light", dnd = "dnd", away = "away", connecting = "connecting", offline = "offline"

    /// channel: "open", "connecting", "closed" or "away"; signedIn: the server reports an account on the
    /// connection; audio: the call state the person announced ("off", "live", "muted").
    static func status(_ channel: String?, signedIn: Bool, audio: String?) -> String {
        if channel == "away" { return away }
        if channel == "open" {
            if audio == "live" || audio == "muted" { return dnd }
            return signedIn ? online : light
        }
        if channel == "connecting" { return connecting }
        return offline
    }

    /// The order of the list: connected people first, away next (the server answers for them), the rest last.
    static func rank(_ status: String) -> Int {
        switch status {
        case online, light, dnd: 0
        case away: 1
        case connecting: 2
        default: 3
        }
    }

    /// A lucide icon for the status.
    static func icon(_ status: String) -> String {
        switch status {
        case online: "circle-check"
        case light: "circle-dot"
        case dnd: "circle-minus"
        case away: "moon"
        case connecting: "loader-circle"
        default: "circle-off"
        }
    }

    /// The status's colour: a theme token, or a fixed colour where the theme has none (light = sky blue).
    static func color(_ status: String) -> String {
        switch status {
        case online: "@success"
        case light: "#0ea5e9"
        case dnd: "@danger"
        case away: "@warning"
        default: "@muted"
        }
    }

    /// The latency meter of RecipientsWidget.tsx: 0–4 bars. Not open: 0; the round trip not known yet: 2;
    /// under 60 ms: 4, 120: 3, 250: 2, slower: 1. rttMs < 0 = not known.
    static func bars(open: Bool, rttMs: Int64) -> Int {
        if !open { return 0 }
        if rttMs < 0 { return 2 }
        return rttMs < 60 ? 4 : rttMs < 120 ? 3 : rttMs < 250 ? 2 : 1
    }

    /// The web's tone of the meter: good (4), ok (2–3), bad (1), off (0).
    static func tone(_ bars: Int) -> String { bars >= 4 ? "good" : bars >= 2 ? "ok" : bars >= 1 ? "bad" : "off" }

    static func signalIcon(_ bars: Int) -> String {
        switch max(0, min(4, bars)) {
        case 4: "signal"
        case 3: "signal-high"
        case 2: "signal-medium"
        case 1: "signal-low"
        default: "signal-zero"
        }
    }

    static func signalColor(_ bars: Int) -> String {
        switch tone(bars) {
        case "good": "@success"
        case "ok": "@warning"
        case "bad": "@danger"
        default: "@muted"
        }
    }

    /// "direct" (host / server-reflexive candidates), "relay" (TURN on either side) or "" before a pair is chosen.
    static func transport(_ localType: String?, _ remoteType: String?) -> String {
        if (localType ?? "").isEmpty && (remoteType ?? "").isEmpty { return "" }
        return localType == "relay" || remoteType == "relay" ? "relay" : "direct"
    }

    /// How long, as the web's user info says it (UserInfoModal dur()): "2 h 5 min", "3 min 12 s", "40 s"; "—" when unknown.
    static func duration(_ ms: Int64, h: String, m: String, s: String) -> String {
        if ms < 0 { return "—" }
        let sec = ms / 1000
        let hh = sec / 3600, mm = (sec % 3600) / 60, ss = sec % 60
        if hh > 0 { return "\(hh) \(h) \(mm) \(m)" }
        if mm > 0 { return "\(mm) \(m) \(ss) \(s)" }
        return "\(ss) \(s)"
    }

    /// Bytes as the web's user info shows them: "512 B", "1.5 kB", "2.25 MB".
    static func bytes(_ n: Int64) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f kB", locale: Locale(identifier: "en_US_POSIX"), Double(n) / 1024) }
        return String(format: "%.2f MB", locale: Locale(identifier: "en_US_POSIX"), Double(n) / (1024 * 1024))
    }
}

/// 6.7 presence: the same thresholds as the web, so the app and the web show the same colour.
///
///   connected and in the foreground     online   (green, @success)
///   last seen at most 5 minutes ago     online
///   last seen 5 to 60 minutes ago       away     (yellow, @warning)
///   last seen more than an hour ago     far      (orange — the theme has no token for it)
enum PeopleLastSeen {
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
    struct Ago: Equatable {
        let unit: String
        let n: Int64
    }

    static func ago(_ lastSeen: Int64, now: Int64) -> Ago {
        let ms = max(0, now - lastSeen)
        if ms < 60_000 { return Ago(unit: "now", n: 0) }
        if ms < 60 * 60_000 { return Ago(unit: "min", n: ms / 60_000) }
        if ms < 24 * 60 * 60_000 { return Ago(unit: "h", n: ms / (60 * 60_000)) }
        return Ago(unit: "d", n: ms / (24 * 60 * 60_000))
    }

    /// "Last seen 12 min ago", "In the app right now", or that it is not known.
    static func seenText(connected: Bool, foreground: Bool, lastSeen: Int64, now: Int64, t: (String) -> String) -> String {
        if connected && foreground { return t("presence.now") }
        if lastSeen <= 0 { return t("presence.seen.unknown") }
        let a = ago(lastSeen, now: now)
        let ago = a.unit == "now" ? t("presence.ago.now") : t("presence.ago." + a.unit).replacingOccurrences(of: "{n}", with: String(a.n))
        return t("presence.seen").replacingOccurrences(of: "{ago}", with: ago)
    }

    /// Adds what the People widget draws of a person's presence — presence, presenceColor, presenceLabel,
    /// seenText — from the room's facts (connected, foreground, lastSeen). A member whose connection went
    /// (channel "held") shows the presence as their status.
    static func decorate(_ u: inout JSONObject, t: (String) -> String, now: Int64) {
        guard u.has("lastSeen") else { return }
        let connected = u.bool("connected") ?? true, foreground = u.bool("foreground") ?? true
        let lastSeen = PeopleJSON.long(u, "lastSeen")
        let st = state(connected: connected, foreground: foreground, lastSeen: lastSeen, now: now)
        u["presence"] = .string(st)
        u["presenceColor"] = .string(color(st))
        u["presenceLabel"] = .string(t("presence." + st))
        u["seenText"] = .string(seenText(connected: connected, foreground: foreground, lastSeen: lastSeen, now: now, t: t))
        if u.optString("channel") == "held" {
            u["statusIcon"] = "moon"
            u["statusColor"] = .string(color(st))
            u["statusLabel"] = .string(t("presence." + st))
        }
    }
}

/// org.json's lenient number reads the Java code relies on (optDouble then a cast).
enum PeopleJSON {
    /// `(long) o.optDouble(key, fallback)`: a number truncated toward zero, else the fallback.
    static func long(_ o: JSONObject, _ key: String, _ fallback: Int64 = 0) -> Int64 {
        guard let d = o.double(key), d.isFinite else { return fallback }
        if d >= 9.2e18 { return Int64.max }
        if d <= -9.2e18 { return Int64.min }
        return Int64(d)
    }
}
