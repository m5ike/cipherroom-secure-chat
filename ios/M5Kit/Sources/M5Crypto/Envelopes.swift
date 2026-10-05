// Chat envelopes, sealed signals and file bodies of protocol 3
// (client/src/lib/envelope.ts; android chat/Envelopes.java): AES-256-GCM with
// the context "m5cet/2|purpose|…" as associated data, a body signed inside
// the encryption with the device's identity.

import Foundation
import M5Core

public enum Envelopes {
    /// "m5cet/2|part|part|…" — numbers written as JavaScript writes them.
    public static func context(_ parts: [CustomStringConvertible]) -> Bytes {
        var s = "m5cet/2"
        for p in parts {
            s += "|"
            if let d = p as? Double { s += JSONNumber(d).description } else { s += p.description }
        }
        return Crypto.utf8(s)
    }

    public static func context(_ parts: CustomStringConvertible...) -> Bytes { context(parts) }

    public struct Signer: Sendable, Equatable {
        public let publicKey: String
        public let valid: Bool
        public let accountKey: String?
        public let accountValid: Bool
        public init(publicKey: String, valid: Bool, accountKey: String?, accountValid: Bool) {
            self.publicKey = publicKey; self.valid = valid; self.accountKey = accountKey; self.accountValid = accountValid
        }
    }

    public struct Body: Sendable {
        public let body: String
        public let signer: Signer?
        public init(body: String, signer: Signer?) { self.body = body; self.signer = signer }
    }

    public struct Opened: Sendable {
        public let payload: JSONObject
        public let version: Int
        public let signer: Signer?
        public init(payload: JSONObject, version: Int, signer: Signer?) { self.payload = payload; self.version = version; self.signer = signer }
    }

    /* ------------------------------------------------------------ bodies */

    /// {"b": body, "pk": identity key, "s": signature over ctx ‖ body} (unsigned without an identity).
    public static func signBody(_ body: String, _ ctx: Bytes, _ identity: ChatIdentity?) throws -> String {
        var inner = JSONObject([("b", .string(body))])
        if let identity {
            inner["pk"] = .string(identity.publicKey)
            inner["s"] = .string(try identity.sign(ctx + Crypto.utf8(body)))
        }
        return inner.stringify()
    }

    public static func readBody(_ plain: String, _ ctx: Bytes) throws -> Body {
        guard let inner = JSON.parseObject(plain), let body = inner.string("b") else { throw CryptoError("malformed body") }
        if let pk = inner.string("pk"), let s = inner.string("s") {
            let valid = Ec.verify(pk, ctx + Crypto.utf8(body), s)
            let apk = inner.string("apk"), ac = inner.string("ac")
            let accountValid = valid && apk != nil && ac != nil && Handshake.verifyDeviceCertV1(apk, ac, pk)
            return Body(body: body, signer: Signer(publicKey: pk, valid: valid, accountKey: apk, accountValid: accountValid))
        }
        return Body(body: body, signer: nil)
    }

    static func sealed(_ key: Bytes, _ plain: Bytes, _ ctx: Bytes) throws -> JSONObject {
        let iv = Crypto.random(12)
        return JSONObject([("iv", .string(Crypto.b64(iv))), ("ciphertext", .string(Crypto.b64(try Crypto.gcmSeal(key, iv, plain, ctx))))])
    }

    static func open(_ key: Bytes, _ iv: String, _ ciphertext: String, _ ctx: Bytes) throws -> String {
        Crypto.str(try Crypto.gcmOpen(key, try Crypto.unb64(iv), try Crypto.unb64(ciphertext), ctx))
    }

    public static func parse(_ json: String) throws -> JSONObject {
        guard let o = JSON.parseObject(json) else { throw CryptoError("not a JSON payload") }
        return o
    }

    /// org.json's optInt(key, fallback): a number (truncated), else the fallback.
    static func optInt(_ o: JSONObject, _ key: String, _ fallback: Int) -> Int {
        guard let d = o.double(key) else { return fallback }
        return Int(exactly: d.rounded(.towardZero)) ?? fallback
    }

    /* ---------------------------------------------------------- messages */

    /// Sealed with the room's message key (relayed, queued, 3.0 peers).
    public static func sealMessage(_ keys: RoomKeys, id: String, payload: JSONObject, identity: ChatIdentity?) throws -> JSONObject {
        let ctx = context("msg", keys.room, id)
        let plain = try signBody(payload.stringify(), ctx, identity)
        var out = try sealed(keys.message, Crypto.utf8(plain), ctx)
        out["v"] = .int(keys.version)
        out["id"] = .string(id)
        return out
    }

    /// Opens a protocol-3 room envelope (v: 3). Versions 1 and 2 (clients older than 3.1) are no longer opened (F-20).
    public static func openMessage(_ keys: RoomKeys, _ envelope: JSONObject) throws -> Opened {
        let v = optInt(envelope, "v", 1)
        if v != 3 { throw CryptoError("envelope version \(v) is no longer opened") }
        if v != keys.version { throw CryptoError("envelope from another key version") }
        let id = envelope.optString("id")
        if id.isEmpty { throw CryptoError("envelope without id") }
        let ctx = context("msg", keys.room, id)
        let b = try readBody(try open(keys.message, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx)
        let payload = try parse(b.body)
        if payload.string("id") != id { throw CryptoError("envelope id mismatch") }
        return Opened(payload: payload, version: v, signer: b.signer)
    }

    /* ----------------------------------------------------------- signals */

    public static func sealSignal(_ keys: RoomKeys, from: String, to: String, payload: JSONObject) throws -> JSONObject {
        var s = try sealed(keys.signal, Crypto.utf8(payload.stringify()), context("signal", keys.room, from, to))
        s["v"] = 2
        return JSONObject([("sealed", .object(s))])
    }

    public static func openSignal(_ keys: RoomKeys, from: String, to: String, sealed: JSONObject?) throws -> JSONObject {
        guard let sealed, optInt(sealed, "v", 0) == 2 else { throw CryptoError("not a sealed signal") }
        return try parse(try open(keys.signal, sealed.optString("iv"), sealed.optString("ciphertext"), context("signal", keys.room, from, to)))
    }

    /* ------------------------------------------------------------- files */

    public static func fileMetaContext(_ transferId: String) -> Bytes { context("file-meta", transferId) }
    public static func fileChunkContext(_ transferId: String, _ seq: Int, _ total: Int) -> Bytes { context("chunk", transferId, seq, total) }
    public static func fileEndContext(_ transferId: String) -> Bytes { context("file-end", transferId) }

    public static func sealFileBody(_ fileKey: Bytes, _ ctx: Bytes, _ value: JSONObject, _ identity: ChatIdentity?) throws -> JSONObject {
        try sealed(fileKey, Crypto.utf8(try signBody(value.stringify(), ctx, identity)), ctx)
    }

    public static func openFileBody(_ fileKey: Bytes, _ ctx: Bytes, iv: String, ciphertext: String) throws -> JSONObject {
        try parse(try readBody(try open(fileKey, iv, ciphertext, ctx), ctx).body)
    }

    /// A file frame's body with its signer (the end must be signed by the meta's signer).
    public static func openFileBodyFull(_ fileKey: Bytes, _ ctx: Bytes, iv: String, ciphertext: String) throws -> Body {
        try readBody(try open(fileKey, iv, ciphertext, ctx), ctx)
    }

    public static func sealChunk(_ fileKey: Bytes, _ ctx: Bytes, _ data: Bytes) throws -> JSONObject { try sealed(fileKey, data, ctx) }

    public static func openChunk(_ fileKey: Bytes, _ ctx: Bytes, iv: String, ciphertext: String) throws -> Bytes {
        try Crypto.gcmOpen(fileKey, try Crypto.unb64(iv), try Crypto.unb64(ciphertext), ctx)
    }
}
