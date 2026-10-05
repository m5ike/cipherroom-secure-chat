// What CallKit shows of a room's call and what Recents keeps of it.
//
// CallKit shows one name (the lock screen, the call screen) and, when
// Settings › Calls › "Calls in Recents" is on (Android: the phone's call log,
// key callLog), iOS keeps that name in the Phone app's Recents — which may also
// sync to the person's other devices. So:
//   * Recents on  → the name is Android's call log entry name (calls.logName:
//     the app's name by default, "app · room" or "people · room"), and while the
//     app is locked always only the app's name (CallLogBridge.entryName).
//   * Recents off → the name follows the notification privacy level like
//     Android's ring (telecom/CallRing): 0 the app's name, 1 the person, 2 the
//     person and the room; while the app is locked only the app's name.
// The handle is never the room: an opaque value (a keyed hash of the room key
// with this install's salt), so Recents names no room by itself; a call-back
// from Recents is mapped back to the room by recomputing it for the saved rooms.

import CryptoKit
import Foundation

enum CallNaming {
    /// calls.logName: what an entry in Recents is named.
    static let nameApp = "app", nameRoom = "room", namePeople = "people"
    private static let partMax = 60, nameMax = 120
    /// The handle values' prefix (CXHandle type generic).
    static let handlePrefix = "m5cet-"

    /// The name a Recents entry carries: the app's (the default, and always while the app is locked),
    /// "app · room", or "people · room" (port of CallLogBridge.entryName).
    static func entryName(level: String, locked: Bool, appName: String, room: String, people: [String]?) -> String {
        var app = clean(appName)
        if app.isEmpty { app = "M5cet" }
        let r = clean(room)
        if locked || r.isEmpty { return app }
        if level == nameRoom { return cut(app + " · " + r) }
        if level == namePeople {
            var names: [String] = []
            var more = 0
            for p in people ?? [] {
                let c = clean(p)
                if c.isEmpty { continue }
                if names.count < 3 { names.append(c) } else { more += 1 }
            }
            if names.isEmpty { return cut(app + " · " + r) }
            return cut(names.joined(separator: ", ") + (more > 0 ? " +\(more)" : "") + " · " + r)
        }
        return app
    }

    /// The name of a ringing call when Recents is off: by the notification privacy level (0, 1, 2).
    static func ringName(level: Int, locked: Bool, appName: String, room: String, who: String) -> String {
        var app = clean(appName)
        if app.isEmpty { app = "M5cet" }
        if locked || level <= 0 { return app }
        let w = clean(who), r = clean(room)
        if level == 1 { return w.isEmpty ? app : cut(w) }
        if w.isEmpty { return r.isEmpty ? app : cut(r) }
        return r.isEmpty ? cut(w) : cut(w + " · " + r)
    }

    /// What CallKit is told: Recents on → the entry name; off → the ring name.
    static func displayName(recents: Bool, logName: String, privacyLevel: Int, locked: Bool, appName: String,
                            room: String, who: String, people: [String]) -> String {
        recents
            ? entryName(level: logName, locked: locked, appName: appName, room: room, people: people.isEmpty && !who.isEmpty ? [who] : people)
            : ringName(level: privacyLevel, locked: locked, appName: appName, room: room, who: who)
    }

    /// The room's opaque handle value: "m5cet-" + 16 hex of HMAC-SHA256(salt, room key).
    static func handle(roomKey: String, salt: Data) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(roomKey.utf8), using: SymmetricKey(data: salt))
        return handlePrefix + mac.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// The saved room a handle stands for (a call-back from Recents), or nil.
    static func room(forHandle value: String, among roomKeys: [String], salt: Data) -> String? {
        guard value.hasPrefix(handlePrefix) else { return nil }
        return roomKeys.first { handle(roomKey: $0, salt: salt) == value }
    }

    /// One clean line: control, format and line / paragraph separators become spaces, runs of
    /// whitespace one space, at most partMax characters (CallLogBridge.clean).
    static func clean(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var gap = false
        for scalar in s.unicodeScalars {
            let cat = scalar.properties.generalCategory
            let blank = cat == .control || cat == .format || cat == .lineSeparator || cat == .paragraphSeparator
                || scalar == " " || scalar == "\t"
            if blank { gap = true; continue }
            if gap && !out.isEmpty { out.append(" ") }
            gap = false
            out.append(scalar)
        }
        let t = String(out)
        return t.count > partMax ? String(t.prefix(partMax)).trimmingCharacters(in: .whitespaces) : t
    }

    private static func cut(_ s: String) -> String { s.count > nameMax ? String(s.prefix(nameMax - 1)) + "…" : s }
}
