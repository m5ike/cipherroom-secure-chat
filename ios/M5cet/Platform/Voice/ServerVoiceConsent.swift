// 6.12 (security analysis G-14, the web's serverVoiceConsent in
// client/src/lib/speak-send.ts) — port of
// android/app/src/main/java/cz/m5cet/app/voice/ServerVoiceConsent.java:
// voice.engine = server means the server's speech provider reads the text of a
// voice message (or hears a recording to transcribe) — the message itself still
// goes end-to-end encrypted. The first time in a room the person is asked, the
// provider named; "no" sends nothing. A yes holds for that room until the app
// locks (VoiceService.forgetSecrets) or the process ends.
//
// Pure (the question is the caller's dialog): ServerVoiceConsentTests.

import Foundation
import M5Core

@MainActor
enum ServerVoiceConsent {
    /// What is sent: the text to be spoken, or a recording to be transcribed.
    enum Use: String, Sendable { case speak = "SPEAK", transcribe = "TRANSCRIBE" }

    /// Asks the person (on the main actor): the provider's name, then yes or no.
    typealias Ask = @MainActor (_ use: Use, _ provider: String, _ answer: @escaping @MainActor (Bool) -> Void) -> Void

    private static var given = Set<String>()

    static func slot(_ room: String?, _ use: Use) -> String { use.rawValue + "|" + (room ?? "") }

    /// Whether the person agreed in this room already (this process, since the last lock).
    static func isGiven(_ room: String?, _ use: Use) -> Bool { given.contains(slot(room, use)) }

    /// then(true) at once when agreed earlier in this room, else after asking (a yes is remembered for
    /// the room); then(false) for a no or no one to ask.
    static func check(_ room: String?, _ use: Use, provider: String?, ask: Ask?, then: @escaping @MainActor (Bool) -> Void) {
        let k = slot(room, use)
        if given.contains(k) { then(true); return }
        guard let ask else { then(false); return }
        let name = (provider ?? "").javaTrimmed
        ask(use, name.isEmpty ? "?" : name) { yes in
            if yes { given.insert(k) }
            then(yes)
        }
    }

    /// The app locked (or the tests): ask again everywhere.
    static func reset() { given.removeAll() }
}
