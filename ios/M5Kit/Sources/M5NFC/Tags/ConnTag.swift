// A room's connection card on NFC — the NFC side of A/nfc/Nfc.java (6.1) and
// A/nfc/ConnTag.java (6.12), compatible with the web (client/src/lib/nfc.ts,
// nfc/cards/connection-card.ts, nfc/tag-v2.ts):
//
//  - the card is an NDEF record of type application/vnd.m5cet.conn; its body is
//    format 2 ("m5cet:nfc:v2:" + JSON — an invitation or an offline tag, TagV2);
//    format 1 ("m5cet:nfc:v1:" + base64(salt 16 ‖ iv 12 ‖ AES-GCM) of {v: 1, room,
//    passphrase, name?, app?} under PBKDF2-SHA256 of a 4–16 digit PIN) is only
//    read — marked weak, with the offer to rewrite it as format 2; an older form
//    is a text record with the same string;
//  - writers write format 2 only (`NfcConnTag.prepare`).
// Reading a body and both formats' crypto are M5Crypto's (`ConnTag`, `TagV2`,
// `ConnTagV1`); here are the records, the `TagKdf` / `ShareInviteHTTP` seams and
// the writer. The radio (CoreNFC NFCNDEFReaderSession / NFCTagReaderSession) is the app's.

import Foundation
import M5Core
import M5Crypto

public enum ConnectionCard {
    public static let mime = "application/vnd.m5cet.conn"

    public static func validPin(_ p: String?) -> Bool { ConnTagV1.validPin(p) }

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

    /// Format 1 — {v:1, room, passphrase, name?, app?} sealed with the PIN (nfc.ts sealWithPin; M5Crypto's
    /// `ConnTagV1`). Never written by the app any more (§ 16.5); kept for the parity test with the web's vectors.
    public static func sealV1(_ card: NfcJSONObject, pin: String) throws -> String {
        guard validPin(pin) else { throw NfcError(.invalidArgument, "pin") }
        guard let o = JSON.parseObject(card.compact) else { throw NfcError(.invalidArgument, "the card is not a JSON object") }
        return try ConnTagV1.seal(o, pin: pin)
    }

    /// A format-1 card, or nil when the PIN is wrong or it is not one.
    public static func openV1(_ blob: String?, pin: String) -> NfcJSONObject? {
        guard let o = ConnTagV1.open(blob, pin: pin) else { return nil }
        return (try? NfcJSON.parse(o.stringify()))?.objectValue
    }
}

/// What a tag's body opened to (M5Crypto's `ConnTag.Read`), as M5NFC's JSON.
extension ConnTag.Read {
    public var json: NfcJSONObject {
        var o: NfcJSONObject = ["format": .string(format), "weak": .bool(weak), "need": .string(need), "error": .string(error), "origin": .string(origin)]
        if let r = room { o["room"] = ["room": .string(r.room), "passphrase": .string(r.passphrase), "name": .string(r.name)] }
        return o
    }
}

/// 6.12: a connection tag's body, read and written (docs/protocol-v4.md § 16) with M5NFC's seams. Writers write
/// format 2 only — an invitation (recommended: the room key stays on the server, sealed; the tag ends with the
/// invite) or an offline tag (under a 20-symbol code shown once). Readers open format 2, and format 1 with its
/// PIN — marked weak. Reading is M5Crypto's `ConnTag.open`.
public enum NfcConnTag {
    public typealias Read = ConnTag.Read

    /// Opens a tag body. `secret`: what the reader typed — the offline code (20 symbols) or a format-1 PIN;
    /// may be empty. `trustedOrigin`: the app's server — an invitation is redeemed only there. `redeem`
    /// false leaves an invitation unredeemed (need = "redeem": every redemption uses one of its uses).
    public static func open(_ body: String?, secret: String?, trustedOrigin: String?, redeem: Bool = true, kdf: any TagKdf, http: (any ShareInviteHTTP)?) async -> Read {
        return await ConnTag.open(body, secret: secret, trustedOrigin: trustedOrigin, redeem: redeem ? redeemer(http) : nil, kdf: kdf.derivation)
    }

    /// Redeems over `http` with ConnTag's reading of the outcome: a RedeemError's reason (wrong-code, burned,
    /// not-found; else "network"), CryptoError → "corrupt", anything else (no `http`, no network) → "network".
    static func redeemer(_ http: (any ShareInviteHTTP)?) -> ConnTag.Redeemer {
        { @Sendable tag in
            guard let http else { throw NfcError.io("network") }
            do {
                return try await NfcShareInvite.redeem(tag, http: http)
            } catch let e as NfcError where e.code == .io {
                throw ShareInvite.RedeemError(e.message)
            } catch let e as NfcError where e.code == .authFailed {
                throw CryptoError(e.message)
            }
        }
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
            let tag = try NfcTagV2.sealOffline(room, code: code, m: TagV2.writeMemoryKiB, i: TagV2.writePasses, kdf: kdf)
            return Prepared(body: TagV2.serialize(tag), code: TagV2.format(code), expiresAt: 0)
        }
        guard let http else { throw NfcError.unsupported("an invitation needs the server") }
        let tag = try NfcTagV2.newInvite(origin: origin)
        let c = try await NfcShareInvite.create(tag, room: room, name: room.name, maxUses: NfcShareInvite.defaultUses, ttlSec: NfcShareInvite.defaultTtlSec, http: http)
        return Prepared(body: TagV2.serialize(tag), code: nil, expiresAt: c.expiresAt)
    }
}
