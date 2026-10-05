// 6.12: the server side of an NFC invitation tag (docs/protocol-v4.md § 16.3) —
// A/nfc/ShareInvite.java: an ordinary invite (server/share.ts, the web's
// lib/share-link.ts) made with the id, link key and code the tag's secret
// derives (TagV2.inviteKeys):
//
//   proof   = b64url(PBKDF2-SHA256(code, "m5cet:share:v1:proof:" + id, 200 000, 32))
//   wrapKey = HKDF(salt = id, linkKey ‖ serverKey ‖ PBKDF2(code, "m5cet:share:v1:enc:" + id), "m5cet:share:v1:wrap", 32)
//   payload {v:1, room, passphrase, name, createdAt, server?} under AES-256-GCM(wrapKey), AAD = id
//
// The server keeps only what it cannot open. The crypto and the request
// bodies are M5Crypto's `ShareInvite`; here are the two POSTs, through
// `ShareInviteHTTP`, which the app wires to M5Net.

import Foundation
import M5Core
import M5Crypto

/// The two POSTs an invitation needs (M5Net in the app; a fake in tests).
public protocol ShareInviteHTTP: Sendable {
    /// POST `url` with a JSON body; the HTTP status and the answer's body.
    func post(_ url: String, json body: [UInt8]) async throws -> (status: Int, body: [UInt8])
}

/// An invitation tag's invite on its server — M5Crypto's `ShareInvite` over `ShareInviteHTTP`. Its errors are
/// `NfcError`s: `.io` with the server's reason (wrong-code, burned, not-found, …), `.authFailed` for a payload
/// that does not open.
public enum NfcShareInvite {
    /// Writers' defaults: 10 uses, 7 days (the server's maximum).
    public static let defaultUses = ShareInvite.defaultUses
    public static let defaultTtlSec = ShareInvite.defaultTtlSec

    /// What the server checks (another salt than the encryption's).
    public static func proof(code: String, id: String) throws -> String { ShareInvite.proof(code: code, id: id) }

    /// The sealed payload (iv, ciphertext), base64url.
    public static func seal(code: String, id: String, linkKey: [UInt8], serverKey: [UInt8], payload: NfcJSONObject) throws -> (iv: String, ciphertext: String) {
        guard let o = JSON.parseObject(payload.compact) else { throw NfcError(.invalidArgument, "the payload is not a JSON object") }
        return try ShareInvite.seal(code: code, id: id, linkKey: linkKey, serverKey: serverKey, payload: o)
    }

    /// Opens what the server answered; the payload must be {v:1, room, passphrase, name} and for this server.
    public static func open(code: String, id: String, linkKey: [UInt8], serverKey: [UInt8], iv: String, ciphertext: String) throws -> TagV2.Room {
        do { return try ShareInvite.open(code: code, id: id, linkKey: linkKey, serverKey: serverKey, iv: iv, ciphertext: ciphertext) }
        catch let e as CryptoError { throw NfcError(.authFailed, e.message) }
    }

    /// What a created invite gives the writer: the token that ends it early, its limits.
    public struct Created: Sendable { public let revokeToken: String; public let expiresAt: Int64; public let maxUses: Int }

    /// POST <o>/api/share/create for an invitation tag.
    public static func create(_ tag: TagV2.Tag, room: TagV2.Room, name: String?, maxUses: Int, ttlSec: Int, http: any ShareInviteHTTP, now: Date = Date()) async throws -> Created {
        var serverKey = Crypto.random(32)
        let revoke = Crypto.random(32)
        defer { Crypto.wipe(&serverKey) }
        let body = try ShareInvite.createBody(tag: tag, room: room, name: name, maxUses: maxUses, ttlSec: ttlSec,
                                              now: Int64((now.timeIntervalSince1970 * 1000).rounded()), serverKey: serverKey, revoke: revoke)
        let (status, data) = try await http.post((tag.o ?? "") + "/api/share/create", json: Array(body.stringify().utf8))
        guard let answer = (try? NfcJSON.parse(String(decoding: data, as: UTF8.self)))?.objectValue else { throw NfcError.io("the server's answer is not JSON") }
        guard (200..<300).contains(status), answer.optBool("ok") else { throw NfcError.io(answer.optString("reason", "the server did not make the invitation")) }
        return Created(revokeToken: B64.url(revoke), expiresAt: answer.optInt64("expiresAt"), maxUses: answer.optInt("maxUses", maxUses))
    }

    /// POST <o>/api/share/redeem for an invitation tag: the room, or an error whose message says why not
    /// (wrong-code, burned, not-found, …).
    public static func redeem(_ tag: TagV2.Tag, http: any ShareInviteHTTP) async throws -> TagV2.Room {
        let body = try ShareInvite.redeemBody(tag: tag)
        let (status, data) = try await http.post((tag.o ?? "") + "/api/share/redeem", json: Array(body.stringify().utf8))
        let answer = (try? NfcJSON.parse(String(decoding: data, as: UTF8.self)))?.objectValue
        if !(200..<300).contains(status) {
            let reason = answer?.optString("reason") ?? ""
            throw NfcError.io(reason.isEmpty ? "not-found" : reason)
        }
        guard let answer else { throw NfcError.io("the server's answer is not usable") }
        guard answer.optBool("ok") else { throw NfcError.io(answer.optString("reason", "not-found")) }
        guard let serverKey = try? TagV2.fromB64url(answer.optString("serverKey")) else { throw NfcError.io("the server's answer is not usable") }
        var keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        defer { Crypto.wipe(&keys.linkKey) }
        return try open(code: keys.code, id: tag.id ?? "", linkKey: keys.linkKey, serverKey: serverKey, iv: answer.optString("iv"), ciphertext: answer.optString("ciphertext"))
    }
}
