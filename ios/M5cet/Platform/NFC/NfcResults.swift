// What NfcService's readings hand back to the screens — Sendable values only
// (Android: the JSONObjects Nfc.readFrom / CardOps return).

import Foundation
import M5NFC

/// A tag read in one tap (Android Nfc.readFrom + TagTech.detect): its identity, NDEF state and records.
struct NfcTagRead: Sendable {
    /// The card as the reader saw it; `tech` refined to `m5cet-card` / `connection-tag` by its records.
    let identity: CardIdentity
    /// NDEF state and capacity; nil when the tag has no NDEF side.
    let ndef: NdefStatus?
    /// The NDEF records; nil when the tag is not NDEF formatted.
    let records: [NdefRecord]?

    init(identity: CardIdentity, ndef: NdefStatus?, records: [NdefRecord]?) {
        self.records = records
        self.ndef = ndef
        var id = identity
        let conn = ConnectionCard.body(of: records) != nil
        let m5 = NfcTagRead.m5Container(records) != nil
        if conn || m5 {
            id.tech = m5 ? NfcCatalog.m5cetCard : NfcCatalog.connectionTag
            id.label = NfcCatalog.techInfo(id.tech).label
        }
        self.identity = id
    }

    /// The connection tag's body (format 2, or a weak format 1), when the tag carries one.
    var connectionBody: String? { ConnectionCard.body(of: records) }

    /// The M5Cet card container (external record m5cet.cz:card), when the tag carries one.
    var m5Container: [UInt8]? { NfcTagRead.m5Container(records) }

    static func m5Container(_ records: [NdefRecord]?) -> [UInt8]? {
        for r in records ?? [] where r.tnf == Tnf.external.rawValue && r.typeString.lowercased() == M5Card.externalType && M5Card.isM5Card(r.payload) {
            return r.payload
        }
        return nil
    }

    /// Android Nfc.readFrom's object: {card, id, ndef, capacity?, writable?, records?} (records described in words).
    var json: NfcJSONObject {
        var o: NfcJSONObject = ["card": .object(identity.json), "id": .string(identity.uid)]
        if let ndef, ndef.state != .notSupported {
            o["ndef"] = true
            o["capacity"] = NfcJSON(ndef.capacity)
            o["writable"] = .bool(ndef.state == .readWrite)
            o["records"] = .array((records ?? []).map { .string(Ndef.describe($0)) })
        } else {
            o["ndef"] = false
        }
        return o
    }
}

/// A connection tag read and opened (Android Nfc.read → ConnTag.open, after the tag left the field).
struct NfcConnRead: Sendable {
    let tag: NfcTagRead
    /// The tag's body — kept to open it again with a code (Android Nfc.lastBody); never shown.
    let body: String?
    /// What it opened to (format, need, error, room).
    let read: NfcConnTag.Read
}

/// A workbench operation's input (Android NfcWorkbench: what is asked before the tap).
enum NfcOpInput: Sendable {
    case none
    /// ndef-write: one text record.
    case text(String)
    /// ndef-write / m5-write / conn-write: the records.
    case records([NdefRecord])
    /// raw-apdu / select-aid.
    case apdu([UInt8])
    /// ul-write / ntag-write (4 bytes), v-write: block and data.
    case block(Int, [UInt8])
    /// eid-read: the holder's key.
    case mrtd(MrtdReader.Options)
    /// app-template.
    case template(ApduTemplates.Template, MrtdReader.Options?)
    /// ndef-lock: the explicit yes to a permanent lock.
    case confirmLock(Bool)
}

/// A workbench operation's result: the card and what the op returned (Android runOp's `out`).
struct NfcOpResult: Sendable {
    let card: CardIdentity
    let output: NfcJSONObject
    /// app-template: the run.
    var template: TemplateRunResult?
}

/// What a model's "nfc" interaction does on this iPhone (Android NfcModelSheet.start).
enum ModelNfcPlan: Sendable {
    /// Answered at once: refused (a write, emulation, an unknown op), `enum`, or a reader this device has not.
    case answer(NfcJSONObject)
    /// An e-ID read without the holder's key: the sheet asks (ModelNfc.checkDocumentKey / withDocumentKey), then `read`.
    case askDocumentKey(ModelNfc.Command)
    /// Wait for the card (`NfcService.modelRead`), then the holder's consent (ModelNfc.consent / masked / declined).
    case read(ModelNfc.Command)
}
