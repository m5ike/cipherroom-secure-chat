// ui/bubble/Hides (6.2): hiding and deleting messages in this device's view. A
// hide lasts 15 minutes, an hour, 8 hours, a day or until the next sign-in — the
// next time the app is unlocked: such a hide names the unlock it was made in,
// and every unlock (or a new start of the app) begins a new one. Deleting takes
// the message out of this device's view and history, not anyone else's. Both
// go to the operator's audit journal (ChatMessageAudit).
//
// One implementation in the app: the current unlock and hide / unhide / delete
// are the People part's (PeopleParts.defaultHides / PeopleParts.hides — the
// message details hide there); the list reads the same unlock, and the chat
// installs the audit line into it (installAudit). The rules below are Android's,
// pure, for the list and the tests.

import Foundation
import M5Core
import M5Proto

@MainActor
enum BubbleHides {
    nonisolated static let signIn = ChatMessage.untilSignIn
    /// The choices of the details view, in order; the "hidden" step's meta names them ("signin" is an unhide's).
    nonisolated static let durations: [Int64] = [15 * 60_000, 3_600_000, 8 * 3_600_000, 86_400_000, signIn]
    nonisolated static let names = ["15m", "1h", "8h", "1d", "until-signin"]

    /// The unlock the app is in now (People's, renewed by its lock participant at every unlock; never stored).
    static var unlock: String { PeopleParts.defaultHides.unlock }

    /// The app was unlocked: hides "until the next sign-in" end — the lists filter again, the audit queue goes.
    static func unlocked() {
        ChatState.shared.hidesChanged()
        ChatMessageAudit.flush()
    }

    /// The audit line of every hide, unhide and delete (People's hides call it); a deleted message's pictures go too.
    static func installAudit() {
        PeopleParts.defaultHides.audit = { action, room, m, until in
            ChatMessageAudit.add(action, room: room, message: m, until: until)
            if action == "delete" { ChatState.shared.forget(m.id) }
        }
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

    /// Hides for durations[choice]; logged (through People's hides).
    static func hide(_ room: any RoomModel, _ m: ChatMessage, choice: Int) { PeopleParts.hides.hide(room, m, choice: choice) }

    /// Shows a hidden message again before its time; logged.
    static func unhide(_ room: any RoomModel, _ m: ChatMessage) { PeopleParts.hides.unhide(room, m) }

    /// Deletes it from this device (view and history); logged.
    static func delete(_ room: any RoomModel, _ m: ChatMessage) { PeopleParts.hides.delete(room, m) }
}
