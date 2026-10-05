// The M5Cet card — the app's own encrypted format on an NFC tag (6.3),
// A/nfc/M5Card.java, byte for byte client/src/lib/nfc/m5card.ts, so a card
// written on the web opens on Android and iOS and vice versa.
//
//   container = "M5CD" | ver(1) | flags(1) | count(1) | record*
//   record    = type(1) | mode(1) | rflags(1) | id(3) | salt(1+n) | iv(1+n)
//               | ct(u16 BE + bytes)             ct = AES-GCM(plaintext)
//               AAD = "M5CD" | ver | type | id
//
// A record's key: external (PIN) PBKDF2-SHA256(pin, salt, 600k) — a 6–18 digit
// code, so the card opens on ANY device; internal (passkey)
// HKDF-SHA256(account root, salt, "m5cet:nfc:card:v1") — only this user's
// devices. The caller passes that root; this never sees the account. A record
// can be one-time (rflags bit 0): after it was shown the reader rewrites the
// card without it (`removeRecord` + write).

import Foundation

public enum M5Card {
    public static let magic = "M5CD"
    public static let version = 1
    /// NDEF external type that carries a container (urn:nfc:ext:m5cet.cz:card).
    public static let externalType = "m5cet.cz:card"
    public static let pbkdf2Rounds = 600_000
    static let hkdfInfo = Array("m5cet:nfc:card:v1".utf8)

    public static let modeExternal = "external", modeInternal = "internal"

    /// The wire value (number) is fixed — never renumber (mirror m5card.ts).
    static let typeNames: [String?] = [nil, "passkey-backup", "identity-backup", "one-time-message", "message", "server-room", "external-key", "contact", "wifi", "url-login"]

    static func code(of type: String) throws -> Int {
        guard let i = typeNames.firstIndex(where: { $0 == type }), i > 0 else { throw NfcError(.invalidArgument, "unknown record type \(type)") }
        return i
    }

    static func type(of code: Int) -> String? { code > 0 && code < typeNames.count ? typeNames[code] : nil }

    /// A key for one record, given its mode and salt.
    public typealias KeyProvider = (_ mode: String, _ salt: [UInt8]) throws -> [UInt8]

    /// external (PIN) key: PBKDF2-SHA256(pin, salt, 600k) → 32 bytes.
    public static func pinKey(_ pin: String, _ salt: [UInt8]) throws -> [UInt8] {
        guard isValidPin(pin) else { throw NfcError(.invalidArgument, "A card PIN is 6–18 digits.") }
        return try NfcCrypto.pbkdf2Sha256(password: Array(pin.utf8), salt: salt, rounds: pbkdf2Rounds, length: 32)
    }

    /// internal (passkey) key: HKDF-SHA256(root, salt, "m5cet:nfc:card:v1") → 32 bytes.
    public static func accountKey(_ root: [UInt8], _ salt: [UInt8]) -> [UInt8] { NfcCrypto.hkdfSha256(ikm: root, salt: salt, info: hkdfInfo, length: 32) }

    /// Opens external records with `pin` and internal ones with `root` (nil when not signed in).
    public static func keys(pin: String?, root: [UInt8]?) -> KeyProvider {
        return { mode, salt in
            if mode == modeInternal {
                guard let root else { throw NfcError(.authFailed, NfcTexts.t("nfc.m5.needsAccount", "This record needs your account (sign in on this device).")) }
                return accountKey(root, salt)
            }
            guard let pin else { throw NfcError(.authFailed, NfcTexts.t("nfc.m5.needsPin", "This record needs a PIN.")) }
            return try pinKey(pin, salt)
        }
    }

    public static func isValidPin(_ pin: String?) -> Bool { pin?.fullMatch("[0-9]{6,18}") ?? false }

    /// One record as the app works with it (plaintext side).
    public struct Record: Sendable, Hashable {
        public var id: Int = 0
        public var type: String
        public var mode: String = modeExternal
        public var oneTime = false
        /// The record's own JSON shape (records.ts / RECORD_META).
        public var data: NfcJSONObject
        public init(type: String, mode: String = modeExternal, oneTime: Bool = false, id: Int = 0, data: NfcJSONObject) {
            self.type = type; self.mode = mode; self.oneTime = oneTime; self.id = id; self.data = data
        }
    }

    /// A record still sealed (as read off the card, before the key is known).
    public struct Sealed: Sendable, Hashable {
        public var id: Int, type: String, mode: String, oneTime: Bool
        public var salt: [UInt8], iv: [UInt8], ct: [UInt8]
        public init(id: Int, type: String, mode: String, oneTime: Bool, salt: [UInt8], iv: [UInt8], ct: [UInt8]) {
            self.id = id; self.type = type; self.mode = mode; self.oneTime = oneTime; self.salt = salt; self.iv = iv; self.ct = ct
        }
    }

    static func aad(_ type: Int, _ id: Int) -> [UInt8] { Array("M5CD".utf8) + Bytes.u8(version, type, id >> 16, id >> 8, id) }

    static func randomId() -> Int { let b = NfcCrypto.random(3); return Int(b[0]) << 16 | Int(b[1]) << 8 | Int(b[2]) }

    /* ------------------------------------------------------------ encrypt */

    /// Seals one record: a fresh salt and IV, AES-GCM with the record's AAD.
    public static func seal(_ rec: Record, _ keys: KeyProvider) throws -> Sealed {
        let type = try code(of: rec.type)
        let id = rec.id != 0 ? rec.id : randomId()
        let salt = NfcCrypto.random(16), iv = NfcCrypto.random(12)
        var key = try keys(rec.mode, salt)
        defer { NfcCrypto.wipe(&key) }
        let ct = try NfcCrypto.gcmSeal(key: key, iv: iv, plaintext: Array(rec.data.compact.utf8), aad: aad(type, id))
        return Sealed(id: id, type: rec.type, mode: rec.mode, oneTime: rec.oneTime, salt: salt, iv: iv, ct: ct)
    }

    public static func open(_ sealed: Sealed, _ keys: KeyProvider) throws -> Record {
        var key = try keys(sealed.mode, sealed.salt)
        defer { NfcCrypto.wipe(&key) }
        let type = try code(of: sealed.type)
        let plain: [UInt8]
        do { plain = try NfcCrypto.gcmOpen(key: key, iv: sealed.iv, sealed: sealed.ct, aad: aad(type, sealed.id)) } catch {
            throw NfcError(.authFailed, sealed.mode == modeInternal ? NfcTexts.t("nfc.m5.otherAccount", "This card was not written by this account.")
                                                                    : NfcTexts.t("nfc.m5.wrongPin", "Wrong PIN, or the record is damaged."))
        }
        guard let data = (try? NfcJSON.parse(String(decoding: plain, as: UTF8.self)))?.objectValue else {
            throw NfcError(.protocolError, NfcTexts.t("nfc.m5.damaged", "The record is damaged."))
        }
        return Record(type: sealed.type, mode: sealed.mode, oneTime: sealed.oneTime, id: sealed.id, data: data)
    }

    /* ------------------------------------------------------------ container bytes */

    /// The container bytes for a set of sealed records (≤ 64).
    public static func encodeContainer(_ records: [Sealed]) throws -> [UInt8] {
        guard records.count <= 64 else { throw NfcError(.invalidArgument, "A card holds at most 64 records.") }
        var w = Array("M5CD".utf8) + Bytes.u8(version, 0, records.count)
        for r in records {
            w += Bytes.u8(try code(of: r.type), r.mode == modeInternal ? 1 : 0, r.oneTime ? 1 : 0, r.id >> 16, r.id >> 8, r.id)
            w += [UInt8(r.salt.count)] + r.salt
            w += [UInt8(r.iv.count)] + r.iv
            w += Bytes.u8(r.ct.count >> 8, r.ct.count) + r.ct
        }
        return w
    }

    /// Whether a blob looks like an M5Cet container.
    public static func isM5Card(_ bytes: [UInt8]?) -> Bool {
        guard let b = bytes, b.count >= 7 else { return false }
        return b[0] == 0x4d && b[1] == 0x35 && b[2] == 0x43 && b[3] == 0x44
    }

    public static func decodeContainer(_ bytes: [UInt8]) throws -> [Sealed] {
        var r = Cursor(b: bytes)
        guard try r.u8() == 0x4d, try r.u8() == 0x35, try r.u8() == 0x43, try r.u8() == 0x44 else {
            throw NfcError(.protocolError, NfcTexts.t("nfc.m5.notCard", "Not an M5Cet card."))
        }
        let ver = try r.u8()
        guard ver == version else { throw NfcError(.unsupported, "M5Cet card version \(ver) is not supported.") }
        _ = try r.u8() // flags
        let count = try r.u8()
        var out = [Sealed]()
        for _ in 0..<count {
            let typeCode = try r.u8(), modeCode = try r.u8()
            let oneTime = try r.u8() == 1
            let id = try r.u8() << 16 | (try r.u8()) << 8 | (try r.u8())
            let salt = try r.lenBytes(), iv = try r.lenBytes()
            let ct = try r.take(try r.u16())
            guard let type = type(of: typeCode), modeCode == 0 || modeCode == 1 else { continue } // an unknown record type is skipped, not fatal
            out.append(Sealed(id: id, type: type, mode: modeCode == 0 ? modeExternal : modeInternal, oneTime: oneTime, salt: salt, iv: iv, ct: ct))
        }
        return out
    }

    /// The container with one sealed record removed (a one-time record after it was shown).
    public static func removeRecord(_ bytes: [UInt8], id: Int) throws -> [UInt8] { try encodeContainer(try decodeContainer(bytes).filter { $0.id != id }) }

    /// Builds a whole card from plaintext records in one go.
    public static func buildCard(_ records: [Record], _ keys: KeyProvider) throws -> [UInt8] { try encodeContainer(try records.map { try seal($0, keys) }) }

    /// The NDEF record that carries a container (external type m5cet.cz:card).
    public static func ndefRecord(_ container: [UInt8]) -> NdefRecord { Ndef.externalRecord(externalType, container) }

    struct Cursor {
        let b: [UInt8]
        var at = 0
        mutating func need(_ n: Int) throws { if at + n > b.count { throw NfcError(.protocolError, "M5Cet card is truncated.") } }
        mutating func u8() throws -> Int { try need(1); defer { at += 1 }; return Int(b[at]) }
        mutating func u16() throws -> Int { (try u8()) << 8 | (try u8()) }
        mutating func take(_ n: Int) throws -> [UInt8] { try need(n); defer { at += n }; return Array(b[at..<(at + n)]) }
        mutating func lenBytes() throws -> [UInt8] { try take(try u8()) }
    }
}

/// The shapes of an M5Cet card's records and how to show / act on one (6.3) — A/nfc/Records.java,
/// client/src/lib/nfc/records.ts (RECORD_META, recordSummary, BUILDABLE_RECORDS).
public enum M5Records {
    /// What to do once a record is opened.
    public static let display = "display", save = "save", run = "run"

    public struct Meta: Sendable, Hashable {
        /// The i18n key of the record's name, its icon (lucide), its action and the action's label key.
        public let label: String, icon: String, action: String, actionLabel: String
        public let oneTimeDefault: Bool, accountOnly: Bool
    }

    static let meta: [String: Meta] = [
        "passkey-backup": Meta(label: "nfc.rec.passkey", icon: "key-round", action: save, actionLabel: "nfc.rec.restore", oneTimeDefault: false, accountOnly: true),
        "identity-backup": Meta(label: "nfc.rec.identity", icon: "shield-user", action: save, actionLabel: "nfc.rec.restore", oneTimeDefault: false, accountOnly: true),
        "one-time-message": Meta(label: "nfc.rec.onetime", icon: "flame", action: display, actionLabel: "nfc.rec.show", oneTimeDefault: true, accountOnly: false),
        "message": Meta(label: "nfc.rec.message", icon: "message-square-lock", action: display, actionLabel: "nfc.rec.show", oneTimeDefault: false, accountOnly: false),
        "server-room": Meta(label: "nfc.rec.serverRoom", icon: "radio", action: run, actionLabel: "nfc.rec.join", oneTimeDefault: false, accountOnly: false),
        "external-key": Meta(label: "nfc.rec.externalKey", icon: "key", action: save, actionLabel: "nfc.rec.import", oneTimeDefault: false, accountOnly: false),
        "contact": Meta(label: "nfc.rec.contact", icon: "contact-round", action: save, actionLabel: "nfc.rec.saveContact", oneTimeDefault: false, accountOnly: false),
        "wifi": Meta(label: "nfc.rec.wifi", icon: "wifi", action: save, actionLabel: "nfc.rec.connect", oneTimeDefault: false, accountOnly: false),
        "url-login": Meta(label: "nfc.rec.urlLogin", icon: "log-in", action: run, actionLabel: "nfc.rec.open", oneTimeDefault: false, accountOnly: false),
    ]

    public static func meta(_ type: String) -> Meta? { meta[type] }

    /// The record types a person builds by hand (the M5Cet builder offers these).
    public static let buildable = ["message", "one-time-message", "server-room", "wifi", "url-login", "contact", "external-key", "passkey-backup", "identity-backup"]

    /// A one-line summary of a record for a list (no secrets) — recordSummary().
    public static func summary(_ type: String, _ d: NfcJSONObject?) -> String {
        let d = d ?? NfcJSONObject()
        func opt(_ k: String, _ dflt: String) -> String { let v = d.optString(k); return v.isEmpty ? dflt : v }
        switch type {
        case "wifi": return opt("ssid", "Wi-Fi")
        case "url-login": return opt("url", "")
        case "server-room": return d.has("name") ? d.optString("name") : d.optString("room")
        case "contact": return opt("name", "")
        case "external-key": return opt("label", "")
        case "message", "one-time-message":
            let t = d.optString("text")
            if !t.isEmpty { return JSText.prefix(t, 40) }
            if !d.optString("url").isEmpty { return d.optString("url") }
            return d.optObject("file")?.optString("name", "…") ?? "…"
        case "passkey-backup", "identity-backup":
            if let acc = d.optObject("account"), !acc.optString("username").isEmpty { return acc.optString("username") }
            return d.optString("user")
        default: return ""
        }
    }
}
