// The ISO 7816 application identifiers the iOS app must list in Info.plist
// (com.apple.developer.nfc.readersession.iso7816.select-identifiers). Core NFC
// presents an ISO-DEP card as NFCISO7816Tag only when it answers SELECT of one
// of them, and refuses SELECT of an AID that is not listed — so every AID the
// readers here select must be in the list. The app copies `infoPlist` (or the
// JSON in README.md); IOSAidsTests keeps the two equal and checks that every AID
// the code selects is listed.
//
// Apple: "Core NFC doesn't support payment-related Application IDs." The payment
// AIDs (PPSE / PSE and the schemes') are listed so a reader with payment
// support — and a future entitlement — finds them, but on an iPhone an EMV read
// is expected to be refused: `NfcCapabilities.paymentAids` stays off for Core
// NFC and the UI says so (`NfcPlatform.limit`).

import Foundation
import M5Core

public enum IOSAids {
    public struct Entry: Sendable, Hashable {
        public let aid: String
        public let name: String
        /// A payment application (Core NFC refuses these).
        public let payment: Bool
    }

    /// Every AID, in the order Core NFC should try them (documents and tags first, then payment).
    public static let entries: [Entry] = [
        Entry(aid: "A0000002471001", name: "ICAO eMRTD (LDS1) — e-passport / e-ID", payment: false),
        Entry(aid: "D2760000850101", name: "NFC Forum Type 4 Tag — NDEF (mapping 2.0)", payment: false),
        Entry(aid: "D2760000850100", name: "NFC Forum Type 4 Tag — NDEF (mapping 1.0)", payment: false),
        Entry(aid: "325041592E5359532E4444463031", name: "PPSE 2PAY.SYS.DDF01 (contactless directory)", payment: true),
        Entry(aid: "315041592E5359532E4444463031", name: "PSE 1PAY.SYS.DDF01 (contact directory)", payment: true),
        Entry(aid: "A0000000031010", name: "Visa credit / debit", payment: true),
        Entry(aid: "A0000000032010", name: "Visa Electron", payment: true),
        Entry(aid: "A0000000032020", name: "V PAY", payment: true),
        Entry(aid: "A0000000033010", name: "Visa Interlink", payment: true),
        Entry(aid: "A0000000038010", name: "Visa Plus", payment: true),
        Entry(aid: "A0000000041010", name: "Mastercard credit / debit", payment: true),
        Entry(aid: "A0000000043060", name: "Maestro", payment: true),
        Entry(aid: "A000000004306001", name: "Maestro UK", payment: true),
        Entry(aid: "A0000000046000", name: "Cirrus", payment: true),
        Entry(aid: "A00000002501", name: "American Express", payment: true),
        Entry(aid: "A0000000651010", name: "JCB", payment: true),
        Entry(aid: "A0000001523010", name: "Discover / Diners", payment: true),
        Entry(aid: "A0000003241010", name: "Discover (ZIP)", payment: true),
        Entry(aid: "A000000333010101", name: "UnionPay debit", payment: true),
        Entry(aid: "A000000333010102", name: "UnionPay credit", payment: true),
        Entry(aid: "A0000002771010", name: "Interac", payment: true),
        Entry(aid: "A0000006581010", name: "Mir", payment: true),
        Entry(aid: "A0000005241010", name: "RuPay", payment: true),
        Entry(aid: "A0000000421010", name: "CB (Cartes Bancaires)", payment: true),
        Entry(aid: "A0000003591010028001", name: "girocard", payment: true),
    ]

    /// The Info.plist array (com.apple.developer.nfc.readersession.iso7816.select-identifiers).
    public static let infoPlist: [String] = entries.map(\.aid)

    /// The non-payment AIDs (what Core NFC really selects on an iPhone).
    public static let documents: [String] = entries.filter { !$0.payment }.map(\.aid)

    /// The AIDs the readers in M5NFC select themselves: the e-ID, the Type 4 tag, the payment directories,
    /// the EMV candidate AIDs and the standard templates' scheme AIDs.
    public static var selectedByCode: [String] {
        var out = [Hex.upper(MrtdReader.aid), Hex.upper(Ndef.t4tAid), Hex.upper(EmvReader.ppse), Hex.upper(EmvReader.pse)]
        for c in EmvTags.candidateAids where !out.contains(c.aid) { out.append(c.aid) }
        for a in ["A0000000032020"] where !out.contains(a) { out.append(a) } // V PAY (standard template)
        return out
    }

    /// The list as JSON (an array of strings), for the app's build scripts.
    public static var json: String { NfcJSON(infoPlist).pretty(indent: 2) }
}
