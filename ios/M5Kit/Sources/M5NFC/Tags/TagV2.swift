// NFC connection tag v2 (6.12, F-12; docs/protocol-v4.md § 16) — A/nfc/TagV2.java,
// byte for byte the web (client/src/lib/nfc/tag-v2.ts; vectors test/vectors/nfc-tag-v2.json).
// Format 2 never uses a PIN:
//
//   inv   an invitation reference: the server's origin, the invite id and a
//         130-bit secret (26 Crockford base32 symbols); the room key stays on
//         the server, sealed under keys from that secret (ShareInvite)
//   off   the room on the tag, AES-256-GCM under Argon2id (64 MiB, 3 passes) of
//         a 100-bit code (20 symbols) that is NOT on the tag — shown once to
//         the writer, typed by the reader
//
// body = "m5cet:nfc:v2:" + JSON, in the record application/vnd.m5cet.conn.
// Argon2id is M5Crypto's (vendored reference C): the app hands it in as a `TagKdf`.

import Foundation

/// Argon2id (v 0x13) — the app wires it to M5Crypto (CArgon2). Tests use the vectors' precomputed keys.
public protocol TagKdf: Sendable {
    func argon2id(password: [UInt8], salt: [UInt8], passes: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> [UInt8]
}

public enum TagV2 {
    public static let prefix = "m5cet:nfc:v2:"
    public static let v1Prefix = "m5cet:nfc:v1:"
    static let label = "m5cet/nfc-tag/2"
    public static let crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    public static let inviteSecretSymbols = 26, offlineCodeSymbols = 20
    /// The room KDF's cost (RoomKeys): what writers use.
    public static let writeMemoryKiB = 64 * 1024, writePasses = 3
    /// What a reader accepts from a tag.
    public static let minMemoryKiB = 8, maxMemoryKiB = 256 * 1024, minPasses = 1, maxPasses = 10

    /// A tag's content that is not usable (malformed, unknown version or type, out-of-bounds cost, wrong code).
    public struct TagError: Error, Sendable, CustomStringConvertible, LocalizedError {
        public let code: String
        public let message: String
        public var description: String { message }
        public var errorDescription: String? { message }
    }

    /// A parsed v2 tag: inv (o, id, k) or off (m, i, s, n, c).
    public struct Tag: Sendable, Hashable {
        public let t: String
        public let o: String?, id: String?, k: String?
        public let m: Int, i: Int
        public let s: String?, n: String?, c: String?
        public var invite: Bool { t == "inv" }
    }

    /// What a tag opens to: the room to join; `name` a suggested name only.
    public struct Room: Sendable, Hashable {
        public let room: String, passphrase: String, name: String, app: String
        public init(room: String, passphrase: String, name: String = "", app: String = "") { self.room = room; self.passphrase = passphrase; self.name = name; self.app = app }
    }

    /* ------------------------------------------------------------ base32 / base64url */

    public static func b64url(_ b: [UInt8]) -> String {
        Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func fromB64url(_ s: String?) throws -> [UInt8] {
        guard let s, s.fullMatch("[A-Za-z0-9_-]*") else { throw TagError(code: "card-error", message: "not base64url") }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t) else { throw TagError(code: "card-error", message: "not base64url") }
        return [UInt8](d)
    }

    /// `n` symbols of Crockford base32, uniform (one random byte each, its low 5 bits).
    public static func randomBase32(_ n: Int) -> String {
        let alphabet = Array(crockford)
        return String(NfcCrypto.random(n).map { alphabet[Int($0 & 31)] })
    }

    /// The canonical form of a typed or read code: upper case; spaces, "-", ".", "_" removed; O → 0, I and L → 1;
    /// then only alphabet symbols and exactly `n` of them. Nil otherwise (U and anything else).
    public static func normalize(_ input: String?, _ n: Int) -> String? {
        guard let input else { return nil }
        let s = JSText.upperASCII(input).replacingRegex("[\\s._-]+", with: "")
            .replacingOccurrences(of: "O", with: "0").replacingOccurrences(of: "I", with: "1").replacingOccurrences(of: "L", with: "1")
        guard s.count == n, s.allSatisfy({ crockford.contains($0) }) else { return nil }
        return s
    }

    /// "ABCDE-FGHJK-…" — groups of five.
    public static func format(_ code: String) -> String { code.replacingRegex("(.{5})(?=.)", with: "$1-") }

    public static func newCode() -> String { randomBase32(offlineCodeSymbols) }

    /* ------------------------------------------------------------ parse */

    /// An https:// (or http:// on localhost, 127.0.0.1, [::1]) origin without path or user; nil otherwise.
    public static func safeOrigin(_ value: String?) -> String? {
        guard let value, let u = URLComponents(string: value), u.user == nil, u.password == nil else { return nil }
        guard var host = u.host?.lowercased(), !host.isEmpty else { return nil }
        let scheme = (u.scheme ?? "").lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        let port = u.port
        let defaultPort = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        let h = host.contains(":") ? "[\(host)]" : host
        return "\(scheme)://\(h)" + (defaultPort ? "" : ":\(port!)")
    }

    static func isInt(_ v: NfcJSON?) -> Bool { guard let d = v?.doubleValue else { return false }; return d == d.rounded() && abs(d) < 1e9 }

    /// The record body ("m5cet:nfc:v2:{…}") as a v2 tag.
    public static func parse(_ body: String?) throws -> Tag {
        guard let body, body.hasPrefix(prefix) else { throw TagError(code: "card-error", message: "not a v2 connection tag") }
        guard let o = (try? NfcJSON.parse(String(body.dropFirst(prefix.count))))?.objectValue else { throw TagError(code: "card-error", message: "the tag's JSON is malformed") }
        guard let v = o["v"]?.doubleValue, v == 2 else { throw TagError(code: "card-error", message: "unknown tag version") }
        let t = o.optString("t")
        if t == "inv" {
            let origin = o.string("o").flatMap(safeOrigin)
            let k = o.string("k").flatMap { normalize($0, inviteSecretSymbols) }
            guard let origin, let id = o.string("id"), id.fullMatch("[A-Za-z0-9_-]{22}"), let k else { throw TagError(code: "card-error", message: "a malformed invitation tag") }
            return Tag(t: "inv", o: origin, id: id, k: k, m: 0, i: 0, s: nil, n: nil, c: nil)
        }
        if t == "off" {
            guard o.string("kdf") == "argon2id", isInt(o["p"]), o["p"]!.intValue == 1, isInt(o["m"]), isInt(o["i"]) else { throw TagError(code: "card-error", message: "an unknown key derivation") }
            let mem = o["m"]!.intValue!, passes = o["i"]!.intValue!
            guard mem >= minMemoryKiB, mem <= maxMemoryKiB, passes >= minPasses, passes <= maxPasses else { throw TagError(code: "card-error", message: "the tag's key derivation is out of bounds") }
            let s = o.string("s") ?? "", n = o.string("n") ?? "", c = o.string("c") ?? ""
            guard s.fullMatch("[A-Za-z0-9_-]{22}"), n.fullMatch("[A-Za-z0-9_-]{16}"), c.fullMatch("[A-Za-z0-9_-]{24,4096}") else { throw TagError(code: "card-error", message: "a malformed offline tag") }
            return Tag(t: "off", o: nil, id: nil, k: nil, m: mem, i: passes, s: s, n: n, c: c)
        }
        throw TagError(code: "card-error", message: "unknown tag type")
    }

    /// A JSON string as JavaScript's JSON.stringify writes it.
    public static func quote(_ s: String) -> String { NfcJSON.quote(s) }

    /// The record body: the prefix + JSON with the keys in § 16's order, no spaces.
    public static func serialize(_ tag: Tag) -> String {
        if tag.invite { return prefix + "{\"v\":2,\"t\":\"inv\",\"o\":\(quote(tag.o ?? "")),\"id\":\(quote(tag.id ?? "")),\"k\":\(quote(tag.k ?? ""))}" }
        return prefix + "{\"v\":2,\"t\":\"off\",\"kdf\":\"argon2id\",\"m\":\(tag.m),\"i\":\(tag.i),\"p\":1,\"s\":\(quote(tag.s ?? "")),\"n\":\(quote(tag.n ?? "")),\"c\":\(quote(tag.c ?? ""))}"
    }

    /* ------------------------------------------------------------ invite */

    /// § 16.3: the link key (32 B) and the code (12 digits) of an invite — HKDF-SHA256(ikm = ASCII(k), salt = ASCII(id)).
    public static func inviteKeys(id: String?, k: String?) throws -> (linkKey: [UInt8], code: String) {
        guard let secret = normalize(k, inviteSecretSymbols), let id, id.fullMatch("[A-Za-z0-9_-]{22}") else {
            throw TagError(code: "invalid-argument", message: "a bad invitation id or secret")
        }
        let ikm = Array(secret.utf8), salt = Array(id.utf8)
        let linkKey = NfcCrypto.hkdfSha256(ikm: ikm, salt: salt, info: Array((label + "/link").utf8), length: 32)
        let raw = NfcCrypto.hkdfSha256(ikm: ikm, salt: salt, info: Array((label + "/code").utf8), length: 8)
        let n = raw.reduce(UInt64(0)) { $0 << 8 | UInt64($1) } % 1_000_000_000_000
        return (linkKey, JSText.padStart(String(n), 12, "0"))
    }

    /// A new invitation tag for the server at `origin` (the invite is then created there with inviteKeys).
    public static func newInvite(origin: String) throws -> Tag {
        guard let o = safeOrigin(origin) else { throw TagError(code: "invalid-argument", message: "the server's origin is not https") }
        return Tag(t: "inv", o: o, id: b64url(NfcCrypto.random(16)), k: randomBase32(inviteSecretSymbols), m: 0, i: 0, s: nil, n: nil, c: nil)
    }

    /* ------------------------------------------------------------ offline */

    static func offlineAad(_ m: Int, _ i: Int, _ s: String) -> [UInt8] { Array("\(label)|off|argon2id|\(m)|\(i)|1|\(s)".utf8) }

    /// § 16.4: K = Argon2id(v 0x13, password = ASCII(code), salt = ASCII(s as written), t = i, m = m, p = 1, 32 bytes).
    public static func offlineKey(code: String, m: Int, i: Int, s: String, kdf: any TagKdf) throws -> [UInt8] {
        try kdf.argon2id(password: Array(code.utf8), salt: Array(s.utf8), passes: i, memoryKiB: m, parallelism: 1, length: 32)
    }

    /// The room sealed for an offline tag under `code` (20 base32 symbols); salt and IV given for tests, else random.
    public static func sealOffline(_ room: Room, code: String, m: Int, i: Int, kdf: any TagKdf, salt: [UInt8]? = nil, iv: [UInt8]? = nil) throws -> Tag {
        guard !room.room.isEmpty, !room.passphrase.isEmpty else { throw TagError(code: "invalid-argument", message: "a connection tag needs a room and a key") }
        guard let canonical = normalize(code, offlineCodeSymbols) else { throw TagError(code: "invalid-argument", message: "the code is not 20 base32 symbols") }
        let s = b64url(salt ?? NfcCrypto.random(16))
        let ivBytes = iv ?? NfcCrypto.random(12)
        var plain = "{\"room\":\(quote(room.room)),\"passphrase\":\(quote(room.passphrase))"
        if !room.name.isEmpty { plain += ",\"name\":\(quote(room.name))" }
        if !room.app.isEmpty { plain += ",\"app\":\(quote(room.app))" }
        plain += "}"
        var key = try offlineKey(code: canonical, m: m, i: i, s: s, kdf: kdf)
        defer { NfcCrypto.wipe(&key) }
        let ct = try NfcCrypto.gcmSeal(key: key, iv: ivBytes, plaintext: Array(plain.utf8), aad: offlineAad(m, i, s))
        return Tag(t: "off", o: nil, id: nil, k: nil, m: m, i: i, s: s, n: b64url(ivBytes), c: b64url(ct))
    }

    /// Opens an offline tag with the code the writer was shown; a wrong code or a changed tag fails ("auth-failed").
    public static func openOffline(_ tag: Tag, code codeInput: String?, kdf: any TagKdf) throws -> Room {
        guard let code = normalize(codeInput, offlineCodeSymbols) else { throw TagError(code: "invalid-argument", message: "the code is 20 base32 symbols") }
        var key = try offlineKey(code: code, m: tag.m, i: tag.i, s: tag.s ?? "", kdf: kdf)
        defer { NfcCrypto.wipe(&key) }
        let plain: [UInt8]
        do { plain = try NfcCrypto.gcmOpen(key: key, iv: try fromB64url(tag.n), sealed: try fromB64url(tag.c), aad: offlineAad(tag.m, tag.i, tag.s ?? "")) }
        catch { throw TagError(code: "auth-failed", message: "wrong code, or the tag was changed") }
        guard let o = (try? NfcJSON.parse(String(decoding: plain, as: UTF8.self)))?.objectValue, let room = o.string("room"), let pass = o.string("passphrase"),
              !room.isEmpty, !pass.isEmpty else { throw TagError(code: "card-error", message: "the tag does not hold a room") }
        return Room(room: room, passphrase: pass, name: o.string("name") ?? "", app: o.string("app") ?? "")
    }
}
