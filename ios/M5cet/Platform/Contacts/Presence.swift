// A person's status and connection quality (6.2), as the web's recipients
// widget shows them (RecipientsWidget.tsx) — port of
// android/app/src/main/java/cz/m5cet/app/contacts/Presence.java. Pure
// (PresenceTests). Candidate for M5Kit (M5Proto).
//
// The web knows a peer as connecting / open / closed, and a signed-in member
// who left as "away" (the server holds their messages). The app adds whether
// the connection carries an account and whether the person is in a call:
//
//   online      a channel is open and the person is signed in
//   light       a channel is open, a guest without an account (P2P, "light")
//   dnd         in a call right now (busy)
//   away        signed in, not connected — the server holds messages for them
//   connecting  the channel is being set up
//   offline     the connection failed or closed
//
// The call screen's own statistics summary (Android contacts/RtcStats) is
// already ported by Platform/Calls (RtcStats.swift, RtcStatsSummary) — its
// transport() is this file's transport().

import Foundation

enum Presence {
    static let online = "online", light = "light", dnd = "dnd", away = "away", connecting = "connecting", offline = "offline"

    /// channel: "open", "connecting", "closed" or "away"; signedIn: the server reports an account on the
    /// connection; audio: the call state the person announced ("off", "live", "muted").
    static func status(channel: String?, signedIn: Bool, audio: String?) -> String {
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
    static func transport(local: String?, remote: String?) -> String {
        if (local ?? "").isEmpty && (remote ?? "").isEmpty { return "" }
        return local == "relay" || remote == "relay" ? "relay" : "direct"
    }

    /// How long, as the web's user info says it (UserInfoModal dur()): "2 h 5 min", "3 min 12 s", "40 s";
    /// "—" when unknown.
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
        if n < 1024 * 1024 { return JavaFormat.fixed(Double(n) / 1024, 1) + " kB" }
        return JavaFormat.fixed(Double(n) / (1024 * 1024), 2) + " MB"
    }
}
