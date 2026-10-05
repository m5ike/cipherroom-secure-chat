// NFC connection tag v2 (6.12, F-12; docs/protocol-v4.md § 16) — A/nfc/TagV2.java,
// byte for byte the web (client/src/lib/nfc/tag-v2.ts; vectors test/vectors/nfc-tag-v2.json).
// Format 2 never uses a PIN:
//
//   inv   an invitation reference: the server's origin, the invite id and a
//         130-bit secret (26 Crockford base32 symbols); the room key stays on
//         the server, sealed under keys from that secret (NfcShareInvite)
//   off   the room on the tag, AES-256-GCM under Argon2id (64 MiB, 3 passes) of
//         a 100-bit code (20 symbols) that is NOT on the tag — shown once to
//         the writer, typed by the reader
//
// body = "m5cet:nfc:v2:" + JSON, in the record application/vnd.m5cet.conn.
// The format and its crypto are M5Crypto's `TagV2` (one implementation); this
// is M5NFC's face of it: `NfcTagV2` takes the Argon2id as a `TagKdf` the app
// (or a test, with the vectors' precomputed keys) hands in.

import Foundation
import M5Core
import M5Crypto

/// Argon2id (v 0x13) — `Argon2TagKdf` (M5Crypto's CArgon2) in the app. Tests use the vectors' precomputed keys.
public protocol TagKdf: Sendable {
    func argon2id(password: [UInt8], salt: [UInt8], passes: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> [UInt8]
}

/// M5Crypto's Argon2id (the vendored reference C).
public struct Argon2TagKdf: TagKdf {
    public init() {}
    public func argon2id(password: [UInt8], salt: [UInt8], passes: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> [UInt8] {
        try Argon2.argon2id(password: password, salt: salt, passes: passes, memoryKiB: memoryKiB, lanes: parallelism, length: length)
    }
}

extension TagKdf {
    /// The KDF as M5Crypto's `TagV2` takes it.
    var derivation: TagV2.KeyDerivation {
        { [self] password, salt, passes, memoryKiB, lanes, length in
            try self.argon2id(password: password, salt: salt, passes: passes, memoryKiB: memoryKiB, parallelism: lanes, length: length)
        }
    }
}

/// Format 2 with a `TagKdf` — a thin face of M5Crypto's `TagV2` (same types, same bytes).
public enum NfcTagV2 {
    public typealias Tag = TagV2.Tag
    public typealias Room = TagV2.Room
    public typealias TagError = TagV2.TagError

    public static let prefix = TagV2.prefix
    public static let v1Prefix = TagV2.v1Prefix
    public static let crockford = String(TagV2.crockford)
    public static let inviteSecretSymbols = TagV2.inviteSecretSymbols, offlineCodeSymbols = TagV2.offlineCodeSymbols
    /// The room KDF's cost (RoomKeys): what writers use.
    public static let writeMemoryKiB = TagV2.writeMemoryKiB, writePasses = TagV2.writePasses
    /// What a reader accepts from a tag.
    public static let minMemoryKiB = TagV2.minMemoryKiB, maxMemoryKiB = TagV2.maxMemoryKiB, minPasses = TagV2.minPasses, maxPasses = TagV2.maxPasses

    /* ------------------------------------------------------------ base32 / base64url */

    public static func b64url(_ b: [UInt8]) -> String { B64.url(b) }
    static func fromB64url(_ s: String?) throws -> [UInt8] { try TagV2.fromB64url(s) }

    /// `n` symbols of Crockford base32, uniform (one random byte each, its low 5 bits).
    public static func randomBase32(_ n: Int) -> String { TagV2.randomBase32(n) }

    /// The canonical form of a typed or read code (Java's `toUpperCase(Locale.ROOT)`; spaces, "-", ".", "_" removed;
    /// O → 0, I and L → 1); exactly `n` alphabet symbols, nil otherwise.
    public static func normalize(_ input: String?, _ n: Int) -> String? { TagV2.normalize(input, n) }

    /// "ABCDE-FGHJK-…" — groups of five.
    public static func format(_ code: String) -> String { TagV2.format(code) }

    public static func newCode() -> String { TagV2.newCode() }

    /* ------------------------------------------------------------ parse */

    /// An https:// (or http:// on localhost, 127.0.0.1, [::1]) origin without path or user; nil otherwise.
    public static func safeOrigin(_ value: String?) -> String? { TagV2.safeOrigin(value) }

    /// The record body ("m5cet:nfc:v2:{…}") as a v2 tag.
    public static func parse(_ body: String?) throws -> Tag { try TagV2.parse(body) }

    /// A JSON string as JavaScript's JSON.stringify writes it.
    public static func quote(_ s: String) -> String { TagV2.quote(s) }

    /// The record body: the prefix + JSON with the keys in § 16's order, no spaces.
    public static func serialize(_ tag: Tag) -> String { TagV2.serialize(tag) }

    /* ------------------------------------------------------------ invite */

    /// § 16.3: the link key (32 B) and the code (12 digits) of an invite.
    public static func inviteKeys(id: String?, k: String?) throws -> (linkKey: [UInt8], code: String) { try TagV2.inviteKeys(id: id, k: k) }

    /// A new invitation tag for the server at `origin` (the invite is then created there, NfcShareInvite.create).
    public static func newInvite(origin: String) throws -> Tag { try TagV2.newInvite(origin) }

    /* ------------------------------------------------------------ offline */

    static func offlineAad(_ m: Int, _ i: Int, _ s: String) -> [UInt8] { TagV2.offlineAad(m: m, i: i, s: s) }

    /// § 16.4: K = Argon2id(v 0x13, password = ASCII(code), salt = ASCII(s as written), t = i, m = m, p = 1, 32 bytes).
    public static func offlineKey(code: String, m: Int, i: Int, s: String, kdf: any TagKdf) throws -> [UInt8] {
        try TagV2.offlineKey(code: code, m: m, i: i, s: s, kdf: kdf.derivation)
    }

    /// The room sealed for an offline tag under `code` (20 base32 symbols); salt and IV given for tests, else random.
    public static func sealOffline(_ room: Room, code: String, m: Int, i: Int, kdf: any TagKdf, salt: [UInt8]? = nil, iv: [UInt8]? = nil) throws -> Tag {
        try TagV2.sealOffline(room, code: code, m: m, i: i, salt: salt, iv: iv, kdf: kdf.derivation)
    }

    /// Opens an offline tag with the code the writer was shown; a wrong code or a changed tag fails ("auth-failed").
    public static func openOffline(_ tag: Tag, code: String?, kdf: any TagKdf) throws -> Room {
        try TagV2.openOffline(tag, code: code ?? "", kdf: kdf.derivation)
    }
}
