// The texts of the system NFC sheet (NFCTagReaderSession.alertMessage, the error
// shown when it is invalidated) — from the design, like every text the app says.
// The provider is M5NFC's text chain (`NfcTexts`, which the app fills from the
// design strings with NfcTexts.install); the screens may pass their own. Keys are
// the default design's (nfc.model.*, nfc.done.*, nfc.err.*, nfc.tpl.*) with its
// English as the fallback; the few iPhone-only texts (nfc.ios.*) fall back to the
// nearest design key, so a design without them still speaks its own language.

import Foundation
import M5NFC

/// Looks a design text up: the key's text in the app's language, else `en`.
protocol NfcTextProvider: Sendable {
    func t(_ key: String, _ en: String) -> String
}

/// The design strings through M5NFC's chain (NfcTexts.install) — the app's default.
struct DesignNfcTexts: NfcTextProvider {
    func t(_ key: String, _ en: String) -> String { NfcTexts.t(key, en) }
}

/// Fixed strings (tests, previews): the key's entry, else the English.
struct FixedNfcTexts: NfcTextProvider {
    var strings: [String: String] = [:]
    func t(_ key: String, _ en: String) -> String { strings[key] ?? en }
}

/// What the sheet says, in the design's words.
struct NfcSheetTexts: Sendable {
    let provider: any NfcTextProvider

    init(_ provider: any NfcTextProvider = DesignNfcTexts()) { self.provider = provider }

    private func t(_ key: String, _ en: String) -> String { provider.t(key, en) }
    /// An iPhone-only key, falling back to a design key that says nearly the same.
    private func ios(_ key: String, _ designKey: String, _ en: String) -> String { t(key, t(designKey, en)) }
    private func fill(_ s: String, _ args: String...) -> String {
        var out = s
        for (i, a) in args.enumerated() { out = out.replacingOccurrences(of: "{\(i)}", with: a) }
        return out
    }

    /// Waiting for a card to read.
    var hold: String { ios("nfc.ios.hold", "nfc.model.hold", "Hold the card to the back of your phone") }
    /// Waiting for a tag to write.
    var holdWrite: String { ios("nfc.ios.holdWrite", "nfc.work.holdCard", "Hold the card…") }
    /// Waiting for a card a template runs on.
    var holdTemplate: String { t("nfc.tpl.hold", "Hold the card to the phone — the template runs every one of its steps.") }
    /// A card is connected and being read.
    var reading: String { t("nfc.model.reading", "Reading — keep the card still…") }
    /// A template step: "2/7 · READ RECORD (AFL)".
    func step(_ n: Int, _ total: Int, _ label: String) -> String {
        fill(t("nfc.ios.step", "{0}/{1} · {2}"), String(n), String(total), label)
    }
    var done: String { t("nfc.model.done", "Done") }
    func written(_ bytes: Int) -> String { fill(t("nfc.done.writtenBytes", "Written {0} B"), String(bytes)) }
    var locked: String { t("nfc.done.locked", "Locked read-only") }
    var lost: String { t("nfc.model.lost", "The card moved away — keep it there until the read is done.") }
    var failed: String { t("nfc.model.error", "The card could not be read.") }
    func timeout(_ seconds: Int) -> String { fill(t("nfc.model.timeout", "No card within {0} s."), String(seconds)) }
    /// Two or more tags in the field: the session looks again.
    var multipleTags: String { ios("nfc.ios.multipleTags", "nfc.model.hold", "More than one card — hold just one.") }
    /// The tag is not one this operation runs on: the session looks again.
    var notThisCard: String { t("nfc.model.notThisCard", "This card can't do that.") }
    var readOnly: String { t("nfc.err.readOnly", "The tag is read-only.") }
    func tooSmall(_ needs: Int, _ holds: Int) -> String { fill(t("nfc.err.tooSmall", "Too small: needs {0} B, the card holds {1} B."), String(needs), String(holds)) }
    var notWritable: String { t("nfc.err.notWritable", "This tag can't be written.") }
    var authFailed: String { t("nfc.model.authFailed", "The document did not open — check the CAN or the MRZ.") }
    /// The phone answers as a card (HCE).
    var emulating: String { t("nfc.emulating", "Answering as a card — hold the other phone to this one.") }

    /// The sheet's error line for a failure.
    func failure(_ e: NfcError) -> String {
        switch e.code {
        case .cardGone: return lost
        case .authFailed: return authFailed
        case .cardError where e.message == "read-only": return readOnly
        case .cardError where e.message == "too-small": return notWritable
        case .unsupported, .invalidArgument, .notARead: return e.message
        default: return failed
        }
    }
}
