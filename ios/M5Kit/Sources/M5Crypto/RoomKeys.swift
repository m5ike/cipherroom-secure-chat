// A room's keys (client/src/lib/envelope.ts deriveRoomKeys; android chat/RoomKeys.java):
//
//   passphrase ─NFC─▶ Argon2id(64 MiB, 3 passes, salt "m5cet:room:v3:<room>")      (v3)
//                  or PBKDF2-SHA256(600 000, salt "m5cet:room:v2:<room>")          (v2)
//   seed ─HKDF-SHA256(salt "m5cet:v2")─▶ message, signal, files, check (8 B hex), room-id (24 B)
//
// The server only ever sees roomId ("r3." + base64url), never the name.

import Foundation
import M5Core
import Synchronization

public final class RoomKeys: Sendable {
    public static let argon2MemoryKiB = 64 * 1024
    public static let argon2Passes = 3
    public static let pbkdf2Iterations = 600_000
    private static let hkdfSalt = Crypto.utf8("m5cet:v2")

    public let version: Int
    public let room: String
    public let roomId: String
    public let message: Bytes
    public let signal: Bytes
    public let files: Bytes
    public let check: String
    private let seed: Bytes
    private let passphrase: String?
    private let previousKeys = Mutex<RoomKeys?>(nil)

    private init(version: Int, room: String, seed: Bytes, passphrase: String?) {
        self.version = version
        self.room = room
        self.seed = seed
        self.passphrase = passphrase
        func d(_ info: String, _ n: Int) -> Bytes { Crypto.hkdf(seed, RoomKeys.hkdfSalt, Crypto.utf8(info), n) }
        message = d("message", 32)
        signal = d("signal", 32)
        files = d("files", 32)
        check = Crypto.hex(d("check", 8))
        roomId = version == 3 ? "r3." + Crypto.b64url(d("room-id", 24)) : room
    }

    /// app-helpers.ts normalizeRoom: lower case, anything but [a-z0-9._-] runs → "-", trimmed of "-", at most 48.
    public static func normalizeRoom(_ value: String) -> String {
        var out = ""
        var dash = false
        for u in value.javaTrimmed.lowercased().unicodeScalars {
            let keep = ("a"..."z").contains(u) || ("0"..."9").contains(u) || u == "." || u == "_" || u == "-"
            if keep { out.unicodeScalars.append(u); dash = false }
            else if !dash { out += "-"; dash = true }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        if out.count > 48 { out = String(out.prefix(48)) }
        return out.isEmpty ? "secure-room" : out
    }

    /// v3 keys: Argon2id of the NFC passphrase (64 MiB, 3 passes unless given).
    public static func derive(room: String, passphrase: String, memoryKiB: Int = argon2MemoryKiB, passes: Int = argon2Passes) throws -> RoomKeys {
        let password = passphrase.precomposedStringWithCanonicalMapping
        let seed = try Argon2.argon2id(password: Crypto.utf8(password), salt: Crypto.utf8("m5cet:room:v3:" + room), passes: passes, memoryKiB: memoryKiB)
        return RoomKeys(version: 3, room: room, seed: seed, passphrase: passphrase)
    }

    /// v2 keys: PBKDF2-SHA256 (600 000) — envelopes queued by 3.0.
    public static func deriveV2(room: String, passphrase: String) -> RoomKeys {
        let password = passphrase.precomposedStringWithCanonicalMapping
        let seed = Crypto.pbkdf2(Crypto.utf8(password), Crypto.utf8("m5cet:room:v2:" + room), pbkdf2Iterations, 32)
        return RoomKeys(version: 2, room: room, seed: seed, passphrase: passphrase)
    }

    /// Keys from a stored room secret (the vault keeps the seed, not the passphrase).
    public static func fromSeed(room: String, seed: Bytes, version: Int = 3) -> RoomKeys {
        RoomKeys(version: version, room: room, seed: seed, passphrase: nil)
    }

    /// The room secret (for the vault).
    public var secret: Bytes { seed }

    /// The v2 keys of the same passphrase, derived on first need (nil for v2 keys or without the passphrase).
    public func previous() -> RoomKeys? {
        guard version == 3, let passphrase else { return nil }
        return previousKeys.withLock { cached in
            if let c = cached { return c }
            let v2 = RoomKeys.deriveV2(room: room, passphrase: passphrase)
            cached = v2
            return v2
        }
    }

    /// HKDF from the room secret, for sub-keys other parts need.
    public func derive(_ info: String, _ bytes: Int) -> Bytes { Crypto.hkdf(seed, RoomKeys.hkdfSalt, Crypto.utf8(info), bytes) }

    /// One AES key per file transfer (protocol 3).
    public func fileKey(_ transferId: String) -> Bytes { Crypto.hkdf(files, Crypto.utf8(transferId), Crypto.utf8("file"), 32) }

    /// § 13: the room's hub-auth seed (HubProof).
    public func hubSeed() -> Bytes { derive(P4.lHubSeed, 32) }
}
