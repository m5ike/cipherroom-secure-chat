// ui/bubble/Hides (6.2): hiding and deleting messages in this device's view. A
// hide lasts 15 minutes, an hour, 8 hours, a day or until the next sign-in — the
// next time the app is unlocked: such a hide names the unlock it was made in,
// and every unlock (or a new start of the app) begins a new one. Deleting takes
// the message out of this device's view and history, not anyone else's. Both
// go to the operator's audit journal (ChatMessageAudit).
//
// Who calls hide / unhide / delete: the message details (msg.info, the people
// agent's MsgDetails) — they are here because the list needs the same rules.

import Foundation
import M5Core
import M5Crypto
import M5Proto

@MainActor
enum BubbleHides {
    nonisolated static let signIn = ChatMessage.untilSignIn
    /// The choices of the details view, in order; the "hidden" step's meta names them ("signin" is an unhide's).
    nonisolated static let durations: [Int64] = [15 * 60_000, 3_600_000, 8 * 3_600_000, 86_400_000, signIn]
    nonisolated static let names = ["15m", "1h", "8h", "1d", "until-signin"]

    /// The unlock the app is in now (never stored: a new start is a new one).
    private(set) static var unlock = newToken()

    private static func newToken() -> String {
        var b = [UInt8](repeating: 0, count: 9)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// The app was unlocked: hides "until the next sign-in" end, the lists filter again, the audit queue goes.
    static func unlocked() {
        unlock = newToken()
        ChatState.shared.hidesChanged()
        ChatMessageAudit.flush()
    }

    /// Is the message hidden in this view now?
    static func hidden(_ m: ChatMessage, _ now: Int64) -> Bool { hidden(m, now, unlock) }

    nonisolated static func hidden(_ m: ChatMessage, _ now: Int64, _ currentUnlock: String) -> Bool {
        if m.hiddenUntil == signIn { return currentUnlock == m.hiddenFor }
        return m.hiddenUntil > now
    }

    /// A hide that is over (its time passed, or the app was unlocked since): cleared, with its "unhidden" step. True when that happened.
    static func endIfOver(_ m: inout ChatMessage, _ now: Int64) -> Bool { endIfOver(&m, now, unlock) }

    nonisolated static func endIfOver(_ m: inout ChatMessage, _ now: Int64, _ currentUnlock: String) -> Bool {
        if m.hiddenUntil == 0 || hidden(m, now, currentUnlock) { return false }
        let signin = m.hiddenUntil == signIn
        m.mark("unhidden", signin ? "signin" : "time", at: signin ? now : m.hiddenUntil)
        m.hiddenUntil = 0
        m.hiddenFor = nil
        return true
    }

    /// When the next timed hide among these ends (Int64.max = none).
    nonisolated static func nextEnd(_ messages: [ChatMessage], _ now: Int64) -> Int64 {
        var next = Int64.max
        for m in messages where m.hiddenUntil > now { next = min(next, m.hiddenUntil) }
        return next
    }

    /// Hides for durations[choice]; logged.
    static func hide(_ room: any RoomModel, _ m: ChatMessage, choice: Int) {
        let i = max(0, min(durations.count - 1, choice))
        let span = durations[i]
        let until = span == signIn ? signIn : Millis.now + span
        room.hide(m.id, until: until, unlock: unlock, why: names[i])
        ChatMessageAudit.add("hide", room: room, message: m, until: until == signIn ? 0 : until)
    }

    /// Shows a hidden message again before its time; logged.
    static func unhide(_ room: any RoomModel, _ m: ChatMessage) {
        room.hide(m.id, until: 0, unlock: nil, why: "user")
        ChatMessageAudit.add("unhide", room: room, message: m, until: 0)
    }

    /// Deletes it from this device (view and history); logged. Its pictures and previews leave the memory too.
    static func delete(_ room: any RoomModel, _ m: ChatMessage) {
        ChatMessageAudit.add("delete", room: room, message: m, until: 0)
        ChatState.shared.forget(m.id)
        room.deleteLocal(m.id)
    }
}
