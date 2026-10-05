// NFC connection tag v2 (6.12, F-12; docs/protocol-v4.md § 16), byte for byte
// as the web (client/src/lib/nfc/tag-v2.ts; vectors test/vectors/nfc-tag-v2.json;
// android nfc/TagV2.java, ShareInvite.java, ConnTag.java, Nfc.java format 1).
//
//   inv   an invitation reference: the server's origin, the invite id and a
//         130-bit secret (26 Crockford base32 symbols); the room key stays on
//         the server, sealed under keys from that secret (ShareInvite)
//   off   the room on the tag, AES-256-GCM under Argon2id (64 MiB, 3 passes) of
//         a 100-bit code (20 symbols) that is NOT on the tag
//
// body = "m5cet:nfc:v2:" + JSON (keys in § 16's order), in the record
// application/vnd.m5cet.conn. The CoreNFC transport is the app's.

import Foundation
import M5Core

public enum TagV2 {
    public static let prefix = "m5cet:nfc:v2:"
    public static let v1Prefix = "m5cet:nfc:v1:"
    static let label = "m5cet/nfc-tag/2"
    public static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    public static let inviteSecretSymbols = 26, offlineCodeSymbols = 20
    /// The room KDF's cost (RoomKeys): what writers use.
    public static let writeMemoryKiB = 64 * 1024, writePasses = 3
    /// What a reader accepts from a tag.
    public static let minMemoryKiB = 8, maxMemoryKiB = 256 * 1024, minPasses = 1, maxPasses = 10

    /// A tag's content that is not readable (card-error, auth-failed, invalid-argument).
    public struct TagError: Error, Sendable, Equatable {
        public let code: String
        public let message: String
        public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    }

    /// A parsed v2 tag: inv (o, id, k) or off (m, i, s, n, c).
    public struct Tag: Sendable, Equatable {
        public let t: String
        public let o: String?, id: String?, k: String?
        public let m: Int, i: Int
        public let s: String?, n: String?, c: String?
        public var invite: Bool { t == "inv" }
    }

    /// What a tag opens to: the room to join; `name` a suggested name only.
    public struct Room: Sendable, Equatable {
        public let room: String, passphrase: String, name: String, app: String
        public init(room: String, passphrase: String, name: String = "", app: String = "") { self.room = room; self.passphrase = passphrase; self.name = name; self.app = app }
    }

    /* ------------------------------------------------------------ base32 */

    private static func isB64urlChar(_ u: UInt8) -> Bool { (65...90).contains(u) || (97...122).contains(u) || (48...57).contains(u) || u == 45 || u == 95 }
    private static func matches(_ s: String, _ min: Int, _ max: Int) -> Bool { s.utf8.count >= min && s.utf8.count <= max && s.utf8.allSatisfy(isB64urlChar) }

    static func fromB64url(_ s: String?) throws -> Bytes {
        guard let s, s.utf8.allSatisfy(isB64urlChar), let b = B64.decodeURL(s) else { throw TagError("card-error", "not base64url") }
        return b
    }

    /// `n` symbols of Crockford base32, uniform (one random byte each, its low 5 bits).
    public static func randomBase32(_ n: Int) -> String { String(Crypto.random(n).map { crockford[Int($0 & 31)] }) }

    /// The canonical form of a typed or read code: upper case; spaces, "-", ".", "_" removed;
    /// O → 0, I and L → 1; then only alphabet symbols and exactly `n` of them. Nil otherwise.
    public static func normalize(_ input: String?, _ n: Int) -> String? {
        guard let input else { return nil }
        var s = ""
        for u in input.uppercased().unicodeScalars {
            if u == "." || u == "_" || u == "-" || u == " " || u == "\t" || u == "\n" || u == "\u{0B}" || u == "\u{0C}" || u == "\r" { continue }
            switch u {
            case "O": s += "0"
            case "I", "L": s += "1"
            default: s.unicodeScalars.append(u)
            }
        }
        guard s.count == n, s.allSatisfy({ crockford.contains($0) }) else { return nil }
        return s
    }

    /// "ABCDE-FGHJK-…" — groups of five.
    public static func format(_ code: String) -> String {
        var out = ""
        for (i, ch) in code.enumerated() {
            if i > 0 && i % 5 == 0 { out += "-" }
            out.append(ch)
        }
        return out
    }

    public static func newCode() -> String { randomBase32(offlineCodeSymbols) }

    /* ------------------------------------------------------------- parse */

    /// https:// (or http:// on localhost, 127.0.0.1, [::1]) origin without path or user; nil otherwise.
    public static func safeOrigin(_ value: String?) -> String? {
        guard let value, let u = URLComponents(string: value), u.user == nil, u.password == nil, let rawHost = u.host, !rawHost.isEmpty else { return nil }
        let scheme = (u.scheme ?? "").lowercased()
        let host = rawHost.lowercased()
        let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
        if scheme != "https" && !(scheme == "http" && local) { return nil }
        let port = u.port
        let defaultPort = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        let h = host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host
        return scheme + "://" + h + (defaultPort ? "" : ":" + String(port!))
    }

    private static func isInt(_ v: JSON?) -> Int? {
        guard let d = v?.doubleValue, d == d.rounded(), abs(d) < 1e9 else { return nil }
        return Int(d)
    }

    /// The record body ("m5cet:nfc:v2:{…}") as a v2 tag.
    public static func parse(_ body: String?) throws -> Tag {
        guard let body, body.hasPrefix(prefix) else { throw TagError("card-error", "not a v2 connection tag") }
        guard let o = JSON.parseObject(String(body.dropFirst(prefix.count))) else { throw TagError("card-error", "the tag's JSON is malformed") }
        guard o.double("v") == 2 else { throw TagError("card-error", "unknown tag version") }
        switch o.optString("t") {
        case "inv":
            let origin = o.string("o").flatMap(safeOrigin)
            let k = o.string("k").flatMap { normalize($0, inviteSecretSymbols) }
            guard let origin, let id = o.string("id"), matches(id, 22, 22), let k else { throw TagError("card-error", "a malformed invitation tag") }
            return Tag(t: "inv", o: origin, id: id, k: k, m: 0, i: 0, s: nil, n: nil, c: nil)
        case "off":
            guard o.string("kdf") == "argon2id", isInt(o["p"]) == 1, let mem = isInt(o["m"]), let passes = isInt(o["i"]) else {
                throw TagError("card-error", "an unknown key derivation")
            }
            if mem < minMemoryKiB || mem > maxMemoryKiB || passes < minPasses || passes > maxPasses { throw TagError("card-error", "the tag's key derivation is out of bounds") }
            let s = o.string("s") ?? "", n = o.string("n") ?? "", c = o.string("c") ?? ""
            guard matches(s, 22, 22), matches(n, 16, 16), matches(c, 24, 4096) else { throw TagError("card-error", "a malformed offline tag") }
            return Tag(t: "off", o: nil, id: nil, k: nil, m: mem, i: passes, s: s, n: n, c: c)
        default:
            throw TagError("card-error", "unknown tag type")
        }
    }

    /// A JSON string as JavaScript's JSON.stringify writes it.
    public static func quote(_ s: String) -> String { JSON.quote(s) }

    /// The record body: the prefix + JSON with the keys in § 16's order, no spaces.
    public static func serialize(_ tag: Tag) -> String {
        if tag.invite {
            return prefix + "{\"v\":2,\"t\":\"inv\",\"o\":" + quote(tag.o ?? "") + ",\"id\":" + quote(tag.id ?? "") + ",\"k\":" + quote(tag.k ?? "") + "}"
        }
        return prefix + "{\"v\":2,\"t\":\"off\",\"kdf\":\"argon2id\",\"m\":\(tag.m),\"i\":\(tag.i),\"p\":1,\"s\":" + quote(tag.s ?? "")
            + ",\"n\":" + quote(tag.n ?? "") + ",\"c\":" + quote(tag.c ?? "") + "}"
    }

    /* ------------------------------------------------------------ invite */

    /// § 16.3: (linkKey 32 B, code 12 digits) of an invite — HKDF-SHA256(ikm = ASCII(k), salt = ASCII(id)).
    public static func inviteKeys(id: String?, k: String?) throws -> (linkKey: Bytes, code: String) {
        guard let secret = normalize(k, inviteSecretSymbols), let id, matches(id, 22, 22) else { throw TagError("invalid-argument", "a bad invitation id or secret") }
        let ikm = Crypto.utf8(secret), salt = Crypto.utf8(id)
        let linkKey = Crypto.hkdf(ikm, salt, Crypto.utf8(label + "/link"), 32)
        let raw = Crypto.hkdf(ikm, salt, Crypto.utf8(label + "/code"), 8)
        let v = raw.reduce(UInt64(0)) { $0 << 8 | UInt64($1) } % 1_000_000_000_000
        let s = String(v)
        return (linkKey, String(repeating: "0", count: 12 - s.count) + s)
    }

    /// A new invitation tag for the server at `origin` (the invite is then created there with inviteKeys).
    public static func newInvite(_ origin: String) throws -> Tag {
        guard let o = safeOrigin(origin) else { throw TagError("invalid-argument", "the server's origin is not https") }
        return Tag(t: "inv", o: o, id: Crypto.b64url(Crypto.random(16)), k: randomBase32(inviteSecretSymbols), m: 0, i: 0, s: nil, n: nil, c: nil)
    }

    /* ----------------------------------------------------------- offline */

    public static func offlineAad(m: Int, i: Int, s: String) -> Bytes { Crypto.utf8(label + "|off|argon2id|\(m)|\(i)|1|" + s) }

    /// § 16.4: K = Argon2id(v 0x13, password = ASCII(code), salt = ASCII(s as written), t = i, m = m, p = 1, 32 bytes).
    public static func offlineKey(code: String, m: Int, i: Int, s: String) throws -> Bytes {
        try Argon2.argon2id(password: Crypto.utf8(code), salt: Crypto.utf8(s), passes: i, memoryKiB: m, lanes: 1, length: 32)
    }

    /// The room sealed for an offline tag under `code` (20 base32 symbols); salt and IV given for tests, else random.
    public static func sealOffline(_ room: Room, code: String, m: Int = writeMemoryKiB, i: Int = writePasses, salt: Bytes? = nil, iv: Bytes? = nil) throws -> Tag {
        if room.room.isEmpty || room.passphrase.isEmpty { throw TagError("invalid-argument", "a connection tag needs a room and a key") }
        guard let canonical = normalize(code, offlineCodeSymbols) else { throw TagError("invalid-argument", "the code is not 20 base32 symbols") }
        let saltBytes = salt ?? Crypto.random(16), ivBytes = iv ?? Crypto.random(12)
        let s = Crypto.b64url(saltBytes)
        var plain = "{\"room\":" + quote(room.room) + ",\"passphrase\":" + quote(room.passphrase)
        if !room.name.isEmpty { plain += ",\"name\":" + quote(room.name) }
        if !room.app.isEmpty { plain += ",\"app\":" + quote(room.app) }
        plain += "}"
        let key = try offlineKey(code: canonical, m: m, i: i, s: s)
        let ct = try Crypto.gcmSeal(key, ivBytes, Crypto.utf8(plain), offlineAad(m: m, i: i, s: s))
        return Tag(t: "off", o: nil, id: nil, k: nil, m: m, i: i, s: s, n: Crypto.b64url(ivBytes), c: Crypto.b64url(ct))
    }

    /// Opens an offline tag with the code the writer was shown; a wrong code or a changed tag fails ("auth-failed").
    public static func openOffline(_ tag: Tag, code codeInput: String) throws -> Room {
        guard let code = normalize(codeInput, offlineCodeSymbols) else { throw TagError("invalid-argument", "the code is 20 base32 symbols") }
        let key: Bytes
        do { key = try offlineKey(code: code, m: tag.m, i: tag.i, s: tag.s ?? "") } catch { throw TagError("auth-failed", "wrong code, or the tag was changed") }
        let plain: Bytes
        do { plain = try Crypto.gcmOpen(key, try fromB64url(tag.n), try fromB64url(tag.c), offlineAad(m: tag.m, i: tag.i, s: tag.s ?? "")) }
        catch { throw TagError("auth-failed", "wrong code, or the tag was changed") }
        guard let o = JSON.parseObject(Crypto.str(plain)), let r = o.string("room"), let p = o.string("passphrase"), !r.isEmpty, !p.isEmpty else {
            throw TagError("card-error", "the tag does not hold a room")
        }
        return Room(room: r, passphrase: p, name: o.string("name") ?? "", app: o.string("app") ?? "")
    }
}

/// The server side of an NFC invitation tag (docs/protocol-v4.md § 16.3; android
/// nfc/ShareInvite.java) — an ordinary invite (server/share.ts, the web's
/// lib/share-link.ts) made with the id, link key and code the tag's secret derives:
///
///   proof   = b64url(PBKDF2-SHA256(code, "m5cet:share:v1:proof:" + id, 200 000, 32))
///   wrapKey = HKDF(salt = id, linkKey ‖ serverKey ‖ PBKDF2(code, "m5cet:share:v1:enc:" + id), "m5cet:share:v1:wrap", 32)
///   payload {v:1, room, passphrase, name, createdAt, server?} under AES-256-GCM(wrapKey), AAD = id
///
/// The HTTP calls (create / redeem) are M5Net's; their bodies are built here.
public enum ShareInvite {
    public static let pbkdf2Iterations = 200_000
    /// Writers' defaults: 10 uses, 7 days (the server's maximum).
    public static let defaultUses = 10
    public static let defaultTtlSec = 7 * 24 * 3600

    /// Why a redemption failed, as the server says it (wrong-code, burned, not-found) or "network".
    public struct RedeemError: Error, Sendable, Equatable {
        public let reason: String
        public init(_ reason: String) { self.reason = reason }
    }

    static func pbkdf2(_ code: String, _ salt: String) -> Bytes { Crypto.pbkdf2(Crypto.utf8(code), Crypto.utf8(salt), pbkdf2Iterations, 32) }

    /// base64url as Java's URL decoder reads it (padding optional).
    public static func fromB64url(_ s: String) throws -> Bytes { try Crypto.unb64url(s) }

    /// What the server checks (another salt than the encryption's).
    public static func proof(code: String, id: String) -> String { Crypto.b64url(pbkdf2(code, "m5cet:share:v1:proof:" + id)) }

    static func wrapKey(code: String, id: String, linkKey: Bytes, serverKey: Bytes) -> Bytes {
        let codeKey = pbkdf2(code, "m5cet:share:v1:enc:" + id)
        return Crypto.hkdf(linkKey + serverKey + codeKey, Crypto.utf8(id), Crypto.utf8("m5cet:share:v1:wrap"), 32)
    }

    /// The sealed payload (iv, ciphertext), both base64url.
    public static func seal(code: String, id: String, linkKey: Bytes, serverKey: Bytes, payload: JSONObject, iv: Bytes? = nil) throws -> (iv: String, ciphertext: String) {
        let key = wrapKey(code: code, id: id, linkKey: linkKey, serverKey: serverKey)
        let nonce = iv ?? Crypto.random(12)
        return (Crypto.b64url(nonce), Crypto.b64url(try Crypto.gcmSeal(key, nonce, Crypto.utf8(payload.stringify()), Crypto.utf8(id))))
    }

    /// Opens what the server answered; the payload must be {v:1, room, passphrase, name} and for this server.
    public static func open(code: String, id: String, linkKey: Bytes, serverKey: Bytes, iv: String, ciphertext: String) throws -> TagV2.Room {
        let key = wrapKey(code: code, id: id, linkKey: linkKey, serverKey: serverKey)
        let plain: Bytes
        do { plain = try Crypto.gcmOpen(key, try fromB64url(iv), try fromB64url(ciphertext), Crypto.utf8(id)) } catch { throw CryptoError("bad payload") }
        guard let o = JSON.parseObject(Crypto.str(plain)), Envelopes.optInt(o, "v", 0) == 1, let room = o.string("room"),
              let passphrase = o.string("passphrase"), let name = o.string("name") else { throw CryptoError("bad payload") }
        let server = o.optString("server")
        // A room on another signaling server is joined there — the app joins through its own only.
        if !server.isEmpty { throw CryptoError("the invitation is for another server (\(server))") }
        return TagV2.Room(room: room, passphrase: passphrase, name: name)
    }

    /// The body of POST <o>/api/share/create for an invitation tag; `serverKey` and `revoke` are 32 random bytes each.
    public static func createBody(tag: TagV2.Tag, room: TagV2.Room, name: String?, maxUses: Int, ttlSec: Int, now: Int64,
                                  serverKey: Bytes, revoke: Bytes) throws -> JSONObject {
        let keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        let shown = (name ?? "").javaTrimmed
        let payload = JSONObject([("v", 1), ("room", .string(room.room)), ("passphrase", .string(room.passphrase)),
                                  ("name", .string(shown.isEmpty ? "guest" : shown)), ("createdAt", .int(now))])
        let sealed = try seal(code: keys.code, id: tag.id!, linkKey: keys.linkKey, serverKey: serverKey, payload: payload)
        return JSONObject([("id", .string(tag.id!)), ("proof", .string(proof(code: keys.code, id: tag.id!))), ("revokeToken", .string(Crypto.b64url(revoke))),
                           ("serverKey", .string(Crypto.b64url(serverKey))), ("iv", .string(sealed.iv)), ("ciphertext", .string(sealed.ciphertext)),
                           ("maxUses", .int(maxUses)), ("ttlSec", .int(ttlSec))])
    }

    /// The body of POST <o>/api/share/redeem for an invitation tag.
    public static func redeemBody(tag: TagV2.Tag) throws -> JSONObject {
        let keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        return JSONObject([("id", .string(tag.id!)), ("proof", .string(proof(code: keys.code, id: tag.id!)))])
    }

    /// The room from the server's redeem answer {ok, serverKey, iv, ciphertext} (or its reason).
    public static func redeemed(tag: TagV2.Tag, answer: JSONObject) throws -> TagV2.Room {
        if answer.bool("ok") != true { throw RedeemError(answer.string("reason") ?? "not-found") }
        let keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        return try open(code: keys.code, id: tag.id!, linkKey: keys.linkKey, serverKey: try fromB64url(answer.optString("serverKey")),
                        iv: answer.optString("iv"), ciphertext: answer.optString("ciphertext"))
    }
}

/// Format 1 connection tags (6.11 and older; android nfc/Nfc.java seal/open):
/// "m5cet:nfc:v1:" + base64(salt 16 ‖ iv 12 ‖ AES-GCM) of {v: 1, room,
/// passphrase, name?, app?}, the key PBKDF2-SHA256 (200 000) of a 4–16 digit
/// PIN. Read only (weak); the app never writes it (§ 16.5) except for tests.
public enum ConnTagV1 {
    public static let rounds = 200_000

    public static func validPin(_ p: String?) -> Bool {
        guard let p, p.utf8.count >= 4, p.utf8.count <= 16 else { return false }
        return p.utf8.allSatisfy { (48...57).contains($0) }
    }

    static func key(_ pin: String, _ salt: Bytes) -> Bytes { Crypto.pbkdf2(Crypto.utf8(pin), salt, rounds, 32) }

    public static func seal(_ card: JSONObject, pin: String) throws -> String {
        if !validPin(pin) { throw CryptoError("pin") }
        let salt = Crypto.random(16), iv = Crypto.random(12)
        let ct = try Crypto.gcmSeal(key(pin, salt), iv, Crypto.utf8(card.stringify()), nil)
        return TagV2.v1Prefix + Crypto.b64(salt + iv + ct)
    }

    /// A format-1 card, or nil when the PIN is wrong or it is not one.
    public static func open(_ blob: String?, pin: String) -> JSONObject? {
        guard let blob, blob.hasPrefix(TagV2.v1Prefix), let all = B64.decodeTrimmed(String(blob.dropFirst(TagV2.v1Prefix.count))), all.count >= 29 else { return nil }
        guard let plain = try? Crypto.gcmOpen(key(pin, Array(all[0..<16])), Array(all[16..<28]), Array(all[28...]), nil),
              let o = JSON.parseObject(Crypto.str(plain)), o.string("room") != nil, o.string("passphrase") != nil else { return nil }
        return o
    }
}

/// A connection tag's body, read (6.12; android nfc/ConnTag.java): format 2
/// (an invitation, redeemed only on the app's own server; an offline tag with
/// its code), and format 1 with its PIN — marked weak.
public enum ConnTag {
    public struct Read: Sendable {
        /// "v2-inv", "v2-off", "v2" (bad), "v1" or "" (not a connection tag).
        public var format = ""
        /// Format 1: whoever read the tag can guess its PIN offline.
        public var weak = false
        public var room: TagV2.Room?
        /// What is missing to open it: "code", "pin", "redeem" or "".
        public var need = ""
        /// wrong-code, wrong-pin, bad-code, other-server, burned, not-found, network, corrupt, bad-tag.
        public var error = ""
        /// An invitation's server, when it is not this app's.
        public var origin = ""
    }

    /// Redeems an invitation on its server (M5Net), or throws ShareInvite.RedeemError / CryptoError.
    public typealias Redeemer = @Sendable (TagV2.Tag) async throws -> TagV2.Room

    public static func open(_ body: String?, secret: String?, trustedOrigin: String?, redeem: Redeemer?) async -> Read {
        var r = Read()
        let s = (secret ?? "").javaTrimmed
        guard let body else { return r }
        if body.hasPrefix(TagV2.prefix) {
            let tag: TagV2.Tag
            do { tag = try TagV2.parse(body) } catch { r.format = "v2"; r.error = "bad-tag"; return r }
            if tag.invite {
                r.format = "v2-inv"
                let mine = TagV2.safeOrigin(trustedOrigin ?? "")
                if mine == nil || mine != tag.o { r.error = "other-server"; r.origin = tag.o ?? ""; return r }
                guard let redeem else { r.need = "redeem"; return r }
                do { r.room = try await redeem(tag) }
                catch let e as ShareInvite.RedeemError { r.error = ["wrong-code", "burned", "not-found"].contains(e.reason) ? e.reason : "network" }
                catch is CryptoError { r.error = "corrupt" }
                catch { r.error = "network" }
                return r
            }
            r.format = "v2-off"
            if TagV2.normalize(s, TagV2.offlineCodeSymbols) == nil { r.need = "code"; if !s.isEmpty { r.error = "bad-code" }; return r }
            do { r.room = try TagV2.openOffline(tag, code: s) }
            catch let e as TagV2.TagError { r.error = e.code == "auth-failed" ? "wrong-code" : "bad-tag" }
            catch { r.error = "bad-tag" }
            return r
        }
        if body.hasPrefix(TagV2.v1Prefix) {
            r.format = "v1"
            r.weak = true
            if !ConnTagV1.validPin(s) { r.need = "pin"; return r }
            guard let o = ConnTagV1.open(body, pin: s) else { r.error = "wrong-pin"; return r }
            r.room = TagV2.Room(room: o.optString("room"), passphrase: o.optString("passphrase"), name: o.optString("name"), app: o.optString("app"))
            return r
        }
        return r
    }
}
