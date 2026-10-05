// 6.12: the server side of an NFC invitation tag (docs/protocol-v4.md § 16.3) —
// A/nfc/ShareInvite.java: an ordinary invite (server/share.ts, the web's
// lib/share-link.ts) made with the id, link key and code the tag's secret
// derives (TagV2.inviteKeys):
//
//   proof   = b64url(PBKDF2-SHA256(code, "m5cet:share:v1:proof:" + id, 200 000, 32))
//   wrapKey = HKDF(salt = id, linkKey ‖ serverKey ‖ PBKDF2(code, "m5cet:share:v1:enc:" + id), "m5cet:share:v1:wrap", 32)
//   payload {v:1, room, passphrase, name, createdAt, server?} under AES-256-GCM(wrapKey), AAD = id
//
// The server keeps only what it cannot open. The crypto is here; the HTTP goes
// through `ShareInviteHTTP`, which the app wires to M5Net.

import Foundation

/// The two POSTs an invitation needs (M5Net in the app; a fake in tests).
public protocol ShareInviteHTTP: Sendable {
    /// POST `url` with a JSON body; the HTTP status and the answer's body.
    func post(_ url: String, json body: [UInt8]) async throws -> (status: Int, body: [UInt8])
}

public enum ShareInvite {
    static let pbkdf2Iterations = 200_000
    /// Writers' defaults: 10 uses, 7 days (the server's maximum).
    public static let defaultUses = 10
    public static let defaultTtlSec = 7 * 24 * 3600

    static func pbkdf2(_ code: String, _ salt: String) throws -> [UInt8] {
        try NfcCrypto.pbkdf2Sha256(password: Array(code.utf8), salt: Array(salt.utf8), rounds: pbkdf2Iterations, length: 32)
    }

    /// What the server checks (another salt than the encryption's).
    public static func proof(code: String, id: String) throws -> String {
        var p = try pbkdf2(code, "m5cet:share:v1:proof:" + id)
        defer { NfcCrypto.wipe(&p) }
        return TagV2.b64url(p)
    }

    static func wrapKey(code: String, id: String, linkKey: [UInt8], serverKey: [UInt8]) throws -> [UInt8] {
        var codeKey = try pbkdf2(code, "m5cet:share:v1:enc:" + id)
        var ikm = linkKey + serverKey + codeKey
        defer { NfcCrypto.wipe(&codeKey); NfcCrypto.wipe(&ikm) }
        return NfcCrypto.hkdfSha256(ikm: ikm, salt: Array(id.utf8), info: Array("m5cet:share:v1:wrap".utf8), length: 32)
    }

    /// The sealed payload (iv, ciphertext), base64url.
    public static func seal(code: String, id: String, linkKey: [UInt8], serverKey: [UInt8], payload: NfcJSONObject) throws -> (iv: String, ciphertext: String) {
        var key = try wrapKey(code: code, id: id, linkKey: linkKey, serverKey: serverKey)
        defer { NfcCrypto.wipe(&key) }
        let iv = NfcCrypto.random(12)
        return (TagV2.b64url(iv), TagV2.b64url(try NfcCrypto.gcmSeal(key: key, iv: iv, plaintext: Array(payload.compact.utf8), aad: Array(id.utf8))))
    }

    /// Opens what the server answered; the payload must be {v:1, room, passphrase, name}.
    public static func open(code: String, id: String, linkKey: [UInt8], serverKey: [UInt8], iv: String, ciphertext: String) throws -> TagV2.Room {
        var key = try wrapKey(code: code, id: id, linkKey: linkKey, serverKey: serverKey)
        defer { NfcCrypto.wipe(&key) }
        let plain: [UInt8]
        do { plain = try NfcCrypto.gcmOpen(key: key, iv: try TagV2.fromB64url(iv), sealed: try TagV2.fromB64url(ciphertext), aad: Array(id.utf8)) }
        catch { throw NfcError(.authFailed, "bad payload") }
        guard let o = (try? NfcJSON.parse(String(decoding: plain, as: UTF8.self)))?.objectValue, o.optInt("v") == 1,
              let room = o.string("room"), let pass = o.string("passphrase"), let name = o.string("name") else { throw NfcError(.authFailed, "bad payload") }
        let server = o.optString("server")
        // A room on another signaling server is joined there — the app joins through its own only.
        if !server.isEmpty { throw NfcError(.authFailed, "the invitation is for another server (\(server))") }
        return TagV2.Room(room: room, passphrase: pass, name: name)
    }

    /// What a created invite gives the writer: the token that ends it early, its limits.
    public struct Created: Sendable { public let revokeToken: String; public let expiresAt: Int64; public let maxUses: Int }

    /// POST <o>/api/share/create for an invitation tag.
    public static func create(_ tag: TagV2.Tag, room: TagV2.Room, name: String?, maxUses: Int, ttlSec: Int, http: any ShareInviteHTTP, now: Date = Date()) async throws -> Created {
        var keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        var serverKey = NfcCrypto.random(32)
        let revoke = NfcCrypto.random(32)
        defer { NfcCrypto.wipe(&keys.linkKey); NfcCrypto.wipe(&serverKey) }
        let id = tag.id ?? ""
        let trimmed = JSText.trim(name ?? "")
        let payload: NfcJSONObject = ["v": 1, "room": .string(room.room), "passphrase": .string(room.passphrase), "name": .string(trimmed.isEmpty ? "guest" : trimmed),
                                      "createdAt": .number((now.timeIntervalSince1970 * 1000).rounded())]
        let sealed = try seal(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey, payload: payload)
        let body: NfcJSONObject = ["id": .string(id), "proof": .string(try proof(code: keys.code, id: id)), "revokeToken": .string(TagV2.b64url(revoke)),
                                   "serverKey": .string(TagV2.b64url(serverKey)), "iv": .string(sealed.iv), "ciphertext": .string(sealed.ciphertext),
                                   "maxUses": NfcJSON(maxUses), "ttlSec": NfcJSON(ttlSec)]
        let (status, data) = try await http.post((tag.o ?? "") + "/api/share/create", json: Array(body.compact.utf8))
        guard let answer = (try? NfcJSON.parse(String(decoding: data, as: UTF8.self)))?.objectValue else { throw NfcError.io("the server's answer is not JSON") }
        guard (200..<300).contains(status), answer.optBool("ok") else { throw NfcError.io(answer.optString("reason", "the server did not make the invitation")) }
        return Created(revokeToken: TagV2.b64url(revoke), expiresAt: answer.optInt64("expiresAt"), maxUses: answer.optInt("maxUses", maxUses))
    }

    /// POST <o>/api/share/redeem for an invitation tag: the room, or an error whose message says why not
    /// (wrong-code, burned, not-found, …).
    public static func redeem(_ tag: TagV2.Tag, http: any ShareInviteHTTP) async throws -> TagV2.Room {
        var keys = try TagV2.inviteKeys(id: tag.id, k: tag.k)
        defer { NfcCrypto.wipe(&keys.linkKey) }
        let id = tag.id ?? ""
        let body: NfcJSONObject = ["id": .string(id), "proof": .string(try proof(code: keys.code, id: id))]
        let (status, data) = try await http.post((tag.o ?? "") + "/api/share/redeem", json: Array(body.compact.utf8))
        let answer = (try? NfcJSON.parse(String(decoding: data, as: UTF8.self)))?.objectValue
        if !(200..<300).contains(status) {
            let reason = answer?.optString("reason") ?? ""
            throw NfcError.io(reason.isEmpty ? "not-found" : reason)
        }
        guard let answer else { throw NfcError.io("the server's answer is not usable") }
        guard answer.optBool("ok") else { throw NfcError.io(answer.optString("reason", "not-found")) }
        guard let serverKey = try? TagV2.fromB64url(answer.optString("serverKey")) else { throw NfcError.io("the server's answer is not usable") }
        return try open(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey, iv: answer.optString("iv"), ciphertext: answer.optString("ciphertext"))
    }
}
