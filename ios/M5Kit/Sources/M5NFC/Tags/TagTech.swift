// Which technology a presented card is (A/nfc/TagTech.java, detect.ts), and
// what this platform can do with it. Android maps its tech list + SAK / ATS;
// iOS maps what CoreNFC hands over (an NFCTag: .iso7816 / .miFare(family) /
// .iso15693 / .feliCa) — the app turns its NFCTag into `IOSTag` and asks here.
// `NfcPlatform` filters the catalogue by `NfcCapabilities`, so the UI only
// offers what the radio really does (no MIFARE Classic, raw frames, payment
// AIDs or emulation on an iPhone unless the capability says so).

import Foundation
import M5Core

public enum TagTech {
    /// The NXP DESFire ATS: historical bytes 75 77 81 02 80 (with or without the length byte).
    public static func isDesfireAts(_ ats: [UInt8]?) -> Bool {
        guard let ats, ats.count >= 5 else { return false }
        for off in 0...(ats.count - 5) where ats[off] == 0x75 && ats[off + 1] == 0x77 && ats[off + 2] == 0x81 && ats[off + 3] == 0x02 && ats[off + 4] == 0x80 { return true }
        return false
    }

    /// Android: the tech list and activation data → a catalogue tech (TagTech.map). `sak` −1 when unknown.
    public static func map(techs: [String], sak: Int, ats: [UInt8]?, connectionTag: Bool, m5cetCard: Bool) -> String {
        if m5cetCard { return NfcCatalog.m5cetCard }
        if connectionTag { return NfcCatalog.connectionTag }
        if techs.contains("NfcF") { return NfcCatalog.felica }
        if techs.contains("NfcV") { return NfcCatalog.iso15693 }
        if techs.contains("MifareClassic") {
            switch sak & 0xff { case 0x18: return NfcCatalog.mifareClassic4k; case 0x09: return NfcCatalog.mifareClassicMini; default: return NfcCatalog.mifareClassic1k }
        }
        if techs.contains("MifareUltralight") { return NfcCatalog.mifareUltralight }
        if techs.contains("IsoDep") { return isDesfireAts(ats) ? NfcCatalog.mifareDesfire : NfcCatalog.isoDep }
        if techs.contains("Ndef") || techs.contains("NdefFormatable") { return NfcCatalog.ndef }
        if techs.contains("NfcB") { return NfcCatalog.iso14443b }
        if techs.contains("NfcA") {
            switch sak & 0xff {
            case 0x08: return NfcCatalog.mifareClassic1k
            case 0x18: return NfcCatalog.mifareClassic4k
            case 0x09: return NfcCatalog.mifareClassicMini
            case 0x00: return NfcCatalog.mifareUltralight
            default: return sak & 0x20 != 0 ? NfcCatalog.isoDep : NfcCatalog.iso14443a
            }
        }
        return NfcCatalog.unknown
    }

    /// What CoreNFC reports about a tag (the app fills it from NFCTag; no CoreNFC types here).
    public enum IOSTag: Sendable, Hashable {
        /// NFCISO7816Tag: the AID the session selected (one of Info.plist's), its historical bytes / application data.
        case iso7816(initialSelectedAid: String, historicalBytes: [UInt8]?, applicationData: [UInt8]?)
        /// NFCMiFareTag with its mifareFamily ("ultralight", "plus", "desfire", "unknown") and historical bytes.
        case miFare(family: String, historicalBytes: [UInt8]?)
        /// NFCISO15693Tag.
        case iso15693
        /// NFCFeliCaTag.
        case feliCa
    }

    /// iOS: the catalogue tech of a CoreNFC tag. `ntag` true when GET_VERSION (60) said NTAG21x.
    public static func map(ios tag: IOSTag, ntag: Bool = false, connectionTag: Bool = false, m5cetCard: Bool = false) -> String {
        if m5cetCard { return NfcCatalog.m5cetCard }
        if connectionTag { return NfcCatalog.connectionTag }
        switch tag {
        case .feliCa: return NfcCatalog.felica
        case .iso15693: return NfcCatalog.iso15693
        case .miFare(let family, let hb):
            switch family {
            case "desfire": return NfcCatalog.mifareDesfire
            case "ultralight": return ntag ? NfcCatalog.ntag21x : NfcCatalog.mifareUltralight
            default: return isDesfireAts(hb) ? NfcCatalog.mifareDesfire : NfcCatalog.iso14443a
            }
        case .iso7816(let aid, _, _):
            let a = JSText.upperASCII(aid)
            if a == Hex.upper(MrtdReader.aid) { return NfcCatalog.eid }
            if EmvTags.scheme(forAid: a) != nil { return NfcCatalog.emv }
            if a == Hex.upper(Ndef.t4tAid) { return NfcCatalog.ndef }
            return NfcCatalog.isoDep
        }
    }

    /// GET_VERSION (0x60) of an Ultralight: NTAG21x report vendor NXP (0x04) and product type 0x04.
    public static func looksNtag(getVersion v: [UInt8]?) -> Bool { (v?.count ?? 0) >= 8 && v![1] == 0x04 && v![2] == 0x04 }

    /// The techs the workbench can present for the manual override list.
    public static let selectable: [String] = [
        NfcCatalog.m5cetCard, NfcCatalog.connectionTag, NfcCatalog.ndef, NfcCatalog.mifareClassic1k, NfcCatalog.mifareClassic4k, NfcCatalog.mifareClassicMini,
        NfcCatalog.mifareUltralight, NfcCatalog.ntag21x, NfcCatalog.mifareDesfire, NfcCatalog.isoDep, NfcCatalog.iso15693, NfcCatalog.felica, NfcCatalog.emv, NfcCatalog.eid,
    ]
}

/// The catalogue as this device can run it. An op needs capabilities (`required(op:tech:)`); what a transport
/// lacks is hidden with the reason (`limit(op:tech:)`) — the iOS limits of docs/ios-architecture.md § 5, in code.
public enum NfcPlatform {
    /// The capabilities an op needs on a technology.
    public static func required(op: String, tech: String) -> NfcCapabilities {
        if tech.hasPrefix("mifare-classic") && (op.hasPrefix("classic-") || op == "write-uid") { return op == "write-uid" ? [.mifareClassic, .rawFrames] : [.mifareClassic] }
        switch op {
        case "scan", "read-uid", "read-public": return []
        case "ndef-read", "m5-read", "conn-read": return [.ndefRead]
        case "ndef-write", "m5-write", "m5-erase", "conn-write": return [.ndefWrite]
        case "ndef-lock": return [.ndefLock]
        case "m5-emulate", "conn-emulate": return [.emulation]
        case "write-uid": return [.rawFrames]
        case "ul-read", "ul-write", "ul-password", "ntag-read", "ntag-write", "ntag-password", "ntag-counter": return [.mifareUltralight]
        case "desfire-apps", "desfire-files", "desfire-read", "desfire-write": return [.desfire]
        case "v-read", "v-write": return [.iso15693]
        case "felica-systems", "felica-read": return [.felica]
        case "emv-public", "emv-read": return [.iso7816, .paymentAids]
        case "eid-public", "eid-read": return [.iso7816]
        case "raw-apdu", "select-aid", "app-template": return [.iso7816]
        default: return []
        }
    }

    /// Why an op is not offered with these capabilities (nil when it is) — for the UI to say, not to fake.
    public static func limit(op: String, tech: String, capabilities caps: NfcCapabilities) -> String? {
        let missing = required(op: op, tech: tech).subtracting(caps)
        if missing.isEmpty { return nil }
        if caps.isEmpty { return "This device has no NFC reader (iPad and Apple Watch have none)." }
        if missing.contains(.mifareClassic) { return "MIFARE Classic is not available on iPhone (Core NFC has no MIFARE Classic)." }
        if missing.contains(.rawFrames) { return "Raw ISO 14443-3 frames are not available on iPhone (Core NFC sends APDUs and MIFARE commands only)." }
        if missing.contains(.emulation) { return "Card emulation needs the HCE entitlement (Core NFC CardSession) — not available on this device." }
        if missing.contains(.paymentAids) { return "Core NFC does not allow payment applications (EMV AIDs) — use an external reader." }
        return "This reader cannot do it."
    }

    /// The ops of a technology this device can run.
    public static func ops(for tech: String, capabilities caps: NfcCapabilities) -> [NfcCatalog.Op] {
        NfcCatalog.ops(for: tech).filter { limit(op: $0.id, tech: tech, capabilities: caps) == nil }
    }

    /// The technologies a reader with these capabilities talks to (the model's `enum`, the manual override list).
    public static func technologies(capabilities caps: NfcCapabilities) -> [String] {
        NfcCatalog.catalog.map(\.tech).filter { tech in
            if tech == NfcCatalog.unknown { return false }
            if tech.hasPrefix("mifare-classic") { return caps.contains(.mifareClassic) }
            if tech == NfcCatalog.emv { return caps.contains(.iso7816) && caps.contains(.paymentAids) }
            if tech == NfcCatalog.felica { return caps.contains(.felica) }
            if tech == NfcCatalog.iso15693 { return caps.contains(.iso15693) }
            return !caps.isEmpty
        }
    }

    /// Which template card types run with these capabilities (an EMV template needs payment AIDs).
    public static func templateRuns(_ t: ApduTemplates.Template, capabilities caps: NfcCapabilities) -> Bool {
        guard caps.contains(.iso7816) || caps.contains(.desfire) else { return false }
        switch t.cardType {
        case ApduTemplates.emv: return caps.contains(.paymentAids)
        case ApduTemplates.desfire: return caps.contains(.desfire) || caps.contains(.iso7816)
        default: return caps.contains(.iso7816)
        }
    }
}
