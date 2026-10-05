// The People part's texts: from the design, always. The few the Android design
// does not have yet — the QR comparison of a safety number, which the web's user
// info has (client/src/lib/i18n-security.ts: cs, en, de) — fall back to the web's
// own words, then to the protocol's English ones (M5Proto P4Texts), as P4Texts
// does for a published design that is older than the app. Nothing here is made up:
// a key the design and these tables lack shows as itself.

import Foundation
import M5Design
import M5Proto

enum PeopleTexts {
    /// The web's words (i18n-security.ts) for keys the Android design lacks.
    static let web: [String: [String: String]] = [
        "cs": ["sec.safety.scan": "Naskenovat jeho kód",
               "sec.safety.verified": "Ověřeno: toto zařízení patří tomu, s kým jste čísla porovnali.",
               "sec.safety.mismatch": "Čísla se NESHODUJÍ — nejde o stejné zařízení."],
        "en": ["sec.safety.scan": "Scan their code",
               "sec.safety.verified": "Verified: this device belongs to the person you compared numbers with.",
               "sec.safety.mismatch": "The numbers do NOT match — this is not the same device."],
        "de": ["sec.safety.scan": "Seinen Code scannen",
               "sec.safety.verified": "Bestätigt: Dieses Gerät gehört der Person, mit der Sie die Nummer verglichen haben.",
               "sec.safety.mismatch": "Die Nummern stimmen NICHT überein — es ist nicht dasselbe Gerät."],
    ]

    /// The design's text, else the web's (the language, Slovak through Czech, then English), else P4Texts' English.
    static func t(_ translator: Translator, lang: String, _ key: String) -> String {
        let s = translator.t(key)
        if s != key { return s }
        for l in [lang, lang == "sk" ? "cs" : lang, "en"] { if let w = web[l]?[key] { return w } }
        return P4Texts.en[key] ?? key
    }

    /// People.fill: {name}, {contact} and {room} in a text.
    static func fill(_ text: String, name: String?, other: String? = nil) -> String {
        text.replacingOccurrences(of: "{name}", with: name ?? "")
            .replacingOccurrences(of: "{contact}", with: other ?? "")
            .replacingOccurrences(of: "{room}", with: other ?? "")
    }
}

extension DesignHost {
    /// A People text in this window's language (PeopleTexts).
    func peopleText(_ key: String) -> String { PeopleTexts.t(translator, lang: services.lang, key) }
}
