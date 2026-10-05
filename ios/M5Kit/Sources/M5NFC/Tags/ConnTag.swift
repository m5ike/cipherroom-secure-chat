// A room's connection card on NFC — the pure parts of A/nfc/Nfc.java (6.1) and
// A/nfc/ConnTag.java (6.12), compatible with the web (client/src/lib/nfc.ts,
// nfc/cards/connection-card.ts, nfc/tag-v2.ts):
//
//  - the card is an NDEF record of type application/vnd.m5cet.conn; its body is
//    format 2 ("m5cet:nfc:v2:" + JSON — an invitation or an offline tag, TagV2);
//    format 1 ("m5cet:nfc:v1:" + base64(salt 16 ‖ iv 12 ‖ AES-GCM) of {v: 1, room,
//    passphrase, name?, app?} under PBKDF2-SHA256 of a 4–16 digit PIN) is only
//    read — marked weak, with the offer to rewrite it as format 2; an older form
//    is a text record with the same string;
//  - writers write format 2 only (`ConnTag.prepare`).
// The radio (CoreNFC NFCNDEFReaderSession / NFCTagReaderSession) is the app's.

import Foundation

public enum ConnectionCard {
    public static let mime = "application/vnd.m5cet.conn"
    static let rounds = 200_000

    public static func validPin(_ p: String?) -> Bool { p?.fullMatch("[0-9]{4,16}") ?? false }

    /// The connection-tag body among a message's records: the MIME record first, else a text record holding one.
    public static func body(of records: [NdefRecord]?) -> String? {
        guard let records else { return nil }
        var text: String? = nil
        for r in records {
            if r.tnf == Tnf.mime.rawValue && r.typeString == mime { return String(decoding: r.payload, as: UTF8.self) }
            if text == nil, case .text(let s, _, _) = Ndef.decodeRecord(r), s.hasPrefix(TagV2.v1Prefix) || s.hasPrefix(TagV2.prefix) { text = s }
        }
        return text
    }

    /// The NDEF record a prepared body is written as.
    public static func record(_ body: String) -> NdefRecord { Ndef.mimeRecord(mime, Array(body.utf8)) }

    static func key(_ pin: String, _ salt: [UInt8]) throws -> [UInt8] {
        try NfcCrypto.pbkdf2Sha256(password: Array(pin.utf8), salt: salt, rounds: rounds, length: 32)
    }

    /// Format 1 — {v:1, room, passphrase, name?, app?} sealed with the PIN (nfc.ts sealWithPin). Never
    /// written by the app any more (§ 16.5); kept for the parity test with the web's format-1 vectors.
    public static func sealV1(_ card: NfcJSONObject, pin: String) throws -> String {
        guard validPin(pin) else { throw NfcError(.invalidArgument, "pin") }
        let salt = NfcCrypto.random(16), iv = NfcCrypto.random(12)
        let ct = try NfcCrypto.gcmSeal(key: try key(pin, salt), iv: iv, plaintext: Array(card.compact.utf8), aad: [])
        return TagV2.v1Prefix + Data(salt + iv + ct).base64EncodedString()
    }

    /// A format-1 card, or nil when the PIN is wrong or it is not one.
    public static func openV1(_ blob: String?, pin: String) -> NfcJSONObject? {
        guard let blob, blob.hasPrefix(TagV2.v1Prefix), let d = Data(base64Encoded: JSText.trim(String(blob.dropFirst(TagV2.v1Prefix.count)))) else { return nil }
        let all = [UInt8](d)
        guard all.count >= 29, let k = try? key(pin, Array(all[0..<16])),
              let plain = try? NfcCrypto.gcmOpen(key: k, iv: Array(all[16..<28]), sealed: Array(all[28...]), aad: []),
              let o = (try? NfcJSON.parse(String(decoding: plain, as: UTF8.self)))?.objectValue,
              o.string("room") != nil, o.string("passphrase") != nil else { return nil }
        return o
    }
}

/// 6.12: a connection tag's body, read and written (docs/protocol-v4.md § 16). Writers write format 2 only
/// — an invitation (recommended: the room key stays on the server, sealed; the tag ends with the invite) or
/// an offline tag (under a 20-symbol code shown once). Readers open format 2, and format 1 with its PIN —
/// marked weak.
public enum ConnTag {
    /// What a tag's body opened to.
    public struct Read: Sendable {
        /// "v2-inv", "v2-off", "v1", "v2" (malformed) or "" (not a connection tag).
        public var format = ""
        /// Format 1: whoever read the tag can guess its PIN offline.
        public var weak = false
        /// The room, when it opened.
        public var room: TagV2.Room?
        /// What is missing to open it: "code" (offline), "pin" (format 1), "redeem", "" (nothing).
        public var need = ""
        /// Why it did not open (wrong-code, wrong-pin, other-server, burned, not-found, network, bad-tag, bad-code, corrupt).
        public var error = ""
        /// An invitation's server, when it is not this app's.
        public var origin = ""

        public var json: NfcJSONObject {
            var o: NfcJSONObject = ["format": .string(format), "weak": .bool(weak), "need": .string(need), "error": .string(error), "origin": .string(origin)]
            if let r = room { o["room"] = ["room": .string(r.room), "passphrase": .string(r.passphrase), "name": .string(r.name)] }
            return o
        }
    }

    /// Opens a tag body. `secret`: what the reader typed — the offline code (20 symbols) or a format-1 PIN;
    /// may be empty. `trustedOrigin`: the app's server — an invitation is redeemed only there. `redeem`
    /// false leaves an invitation unredeemed (need = "redeem": every redemption uses one of its uses).
    public static func open(_ body: String?, secret: String?, trustedOrigin: String?, redeem: Bool = true, kdf: any TagKdf, http: (any ShareInviteHTTP)?) async -> Read {
        var r = Read()
        let s = JSText.trim(secret ?? "")
        guard let body else { return r }
        if body.hasPrefix(TagV2.prefix) {
            let tag: TagV2.Tag
            do { tag = try TagV2.parse(body) } catch { r.format = "v2"; r.error = "bad-tag"; return r }
            if tag.invite {
                r.format = "v2-inv"
                guard let mine = TagV2.safeOrigin(trustedOrigin ?? ""), mine == tag.o else { r.error = "other-server"; r.origin = tag.o ?? ""; return r }
                if !redeem { r.need = "redeem"; return r }
                guard let http else { r.error = "network"; return r }
                do { r.room = try await ShareInvite.redeem(tag, http: http) }
                catch let e as NfcError where e.code == .io {
                    r.error = ["wrong-code", "burned", "not-found"].contains(e.message) ? e.message : "network"
                } catch let e as NfcError where e.code == .authFailed { r.error = "corrupt" }
                catch { r.error = "network" }
                return r
            }
            r.format = "v2-off"
            if TagV2.normalize(s, TagV2.offlineCodeSymbols) == nil { r.need = "code"; if !s.isEmpty { r.error = "bad-code" }; return r }
            do { r.room = try TagV2.openOffline(tag, code: s, kdf: kdf) }
            catch let e as TagV2.TagError { r.error = e.code == "auth-failed" ? "wrong-code" : "bad-tag" }
            catch { r.error = "bad-tag" }
            return r
        }
        if body.hasPrefix(TagV2.v1Prefix) {
            r.format = "v1"
            r.weak = true
            if !ConnectionCard.validPin(s) { r.need = "pin"; return r }
            guard let o = ConnectionCard.openV1(body, pin: s) else { r.error = "wrong-pin"; return r }
            r.room = TagV2.Room(room: o.optString("room"), passphrase: o.optString("passphrase"), name: o.optString("name"), app: o.optString("app"))
            return r
        }
        return r
    }

    /// A format-2 body ready to write, and the offline code to show once (nil for an invitation).
    public struct Prepared: Sendable { public let body: String; public let code: String?; public let expiresAt: Int64 }

    /// A format-2 body for the room `card` ({room, passphrase, name}): "inv" — an invitation made on the server
    /// at `origin` (10 uses, 7 days); "off" — sealed under a fresh code with the room KDF's cost (Argon2id 64 MiB, 3 passes).
    public static func prepare(_ card: NfcJSONObject, kind: String, origin: String, appVersion: String, kdf: any TagKdf, http: (any ShareInviteHTTP)?) async throws -> Prepared {
        // No suggested name: a reader keeps its own (§ 16.3 / 16.4); the writer's nickname is not handed out.
        let room = TagV2.Room(room: card.optString("room"), passphrase: card.optString("passphrase"), name: "", app: appVersion)
        if kind == "off" {
            let code = TagV2.newCode()
            let tag = try TagV2.sealOffline(room, code: code, m: TagV2.writeMemoryKiB, i: TagV2.writePasses, kdf: kdf)
            return Prepared(body: TagV2.serialize(tag), code: TagV2.format(code), expiresAt: 0)
        }
        guard let http else { throw NfcError.unsupported("an invitation needs the server") }
        let tag = try TagV2.newInvite(origin: origin)
        let c = try await ShareInvite.create(tag, room: room, name: room.name, maxUses: ShareInvite.defaultUses, ttlSec: ShareInvite.defaultTtlSec, http: http)
        return Prepared(body: TagV2.serialize(tag), code: nil, expiresAt: c.expiresAt)
    }
}
