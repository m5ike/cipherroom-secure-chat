// The hub join proof (protocol 4, § 13; G-09; Android chat/RoomSession.hubProof
// and p4/HubProof): a 6.12 client proves it holds the room KEY. From the room
// secret the crypto layer derives an Ed25519 key pair (hubSeed =
// RoomKeys.derive("m5cet/hub-auth/4", 32)) and signs the socket's nonce:
//
//   hello  { …, nonce }                 24 random bytes (b64url), one per socket
//   join   { …, proof: { pub, sig } }   pub = raw Ed25519 key (b64, 32 B),
//                                       sig = Ed25519(seed, "m5cet/hub-join/4|roomId|nonce") (b64, 64 B)
//
// Only blind room ids ("r3.…") can prove; a plain-name room joins without.
// A refused proof (another key registered the room — squatted — or a bad
// signature): when the server says a join without proof is admitted
// (`legacyAllowed`), join once more without it on the same socket and skip
// proofs for an hour; otherwise stop (review S14).
//
// The proof's bytes and keys are M5Crypto's (`HubProof`: joinData, pub, build,
// verify); this file is the network's part — the signer seam, the join frame's
// proof and what to do when the hub refuses it (`HubProofFrames`).

import Foundation
import M5Core
import M5Crypto

/// The room's hub key (M5Crypto: Ed25519 from the room's hubSeed). One per room; the seed never leaves it.
public protocol HubProofSigner: Sendable {
    /// The raw Ed25519 public key (32 bytes) and the signature (64 bytes) over `message`.
    func signHubJoin(_ message: Data) async throws -> (publicKey: Data, signature: Data)
}

/// A signer over the room's hub seed (`RoomKeys.hubSeed()`, 32 bytes): M5Crypto's Ed25519 (RFC 8032).
public struct HubSeedSigner: HubProofSigner {
    private let seed: Bytes
    public init(seed: Bytes) { self.seed = seed }

    public func signHubJoin(_ message: Data) async throws -> (publicKey: Data, signature: Data) {
        (Data(try Prim.ed25519Public(seed)), Data(try Prim.ed25519Sign(seed, Array(message))))
    }
}

public enum HubProofRefusal: Sendable, Equatable {
    /// Join again on this socket without the proof (`legacyAllowed: true`, once per socket).
    case legacy
    /// Disconnect: proofs are required, the server does not say, or the legacy join was refused too.
    case refuse
    /// The error is not about the proof.
    case none
}

/// The join frame's proof (M5Crypto's `HubProof` makes the bytes) and the answers to a refused one.
public enum HubProofFrames {
    public static let joinLabel = P4.lHubJoin

    /// Can this room prove (a blind v3 id)?
    public static func canProve(roomId: String) -> Bool { roomId.hasPrefix("r3.") }

    /// The bytes a join proof signs: join("m5cet/hub-join/4", roomId, nonce) — the nonce must be 24 bytes of
    /// canonical base64url, every part printable ASCII without "|" (`HubProof.joinData`, Prim.join).
    public static func message(roomId: String, nonce: String) throws -> Data {
        guard (try? Prim.unb64url(nonce, length: 24)) != nil else { throw NetError.invalid("the hub's nonce is not 24 bytes of base64url") }
        do { return Data(try HubProof.joinData(roomId, nonce)) } catch { throw NetError.invalid("a join proof part is not ASCII without |") }
    }

    /// The `proof` of a join frame; nil without a nonce, for a room that cannot prove, or when signing fails.
    public static func build(signer: (any HubProofSigner)?, roomId: String, nonce: String?) async -> HubJoinProof? {
        guard let signer, let nonce, !nonce.isEmpty, canProve(roomId: roomId), let msg = try? message(roomId: roomId, nonce: nonce),
              let (pub, sig) = try? await signer.signHubJoin(msg), pub.count == 32, sig.count == 64 else { return nil }
        return HubJoinProof(pub: Bytes.b64(pub), sig: Bytes.b64(sig))
    }

    /// What to do with an `error` frame (RoomSession.proofRefusal).
    public static func refusal(code: String, legacyAllowed: Bool?, retried: Bool) -> HubProofRefusal {
        guard code == "room-proof" || code == "room-proof-required" else { return .none }
        return !retried && legacyAllowed == true ? .legacy : .refuse
    }
}

/* ----------------------------------------------------------------- resume */

/// Each room's peer id and resume secret (the server's `joined`) — after the app was ended in the background
/// it comes back as the same member (the server kept it listed as away), not as a second one.
public protocol HubResumeStore: Sendable {
    func load(roomKey: String) async -> (peerId: String, secret: String)?
    func save(roomKey: String, peerId: String, secret: String) async
}

/// The resume secrets as Android keeps them (chat/Resume: the user tier's "resume" record, at most 64 rooms,
/// the oldest go first).
public actor StoredResumeStore: HubResumeStore {
    public static let record = "resume"
    static let max = 64
    private let store: any NetStateStore
    private let clock: NetClock

    public init(store: any NetStateStore, clock: NetClock = .system) {
        self.store = store
        self.clock = clock
    }

    public func load(roomKey: String) async -> (peerId: String, secret: String)? {
        guard let e = await store.load(Self.record)?.obj(roomKey), !e.str("peerId").isEmpty, !e.str("secret").isEmpty else { return nil }
        return (e.str("peerId"), e.str("secret"))
    }

    public func save(roomKey: String, peerId: String, secret: String) async {
        if peerId.isEmpty || secret.isEmpty { return }
        var all = await store.load(Self.record)?.objectValue ?? [:]
        if let old = all[roomKey], old.str("peerId") == peerId, old.str("secret") == secret { return }
        all[roomKey] = ["peerId": .string(peerId), "secret": .string(secret), "at": .int(clock.now())]
        while all.count > Self.max {
            guard let oldest = all.min(by: { ($0.value.int("at")) < ($1.value.int("at")) })?.key else { break }
            all.removeValue(forKey: oldest)
        }
        await store.save(Self.record, .object(all))
    }
}

/* ------------------------------------------------------ binary chunks */

/// A file chunk as one binary message (client/src/lib/binary-frames.ts, server/signaling/binary.ts):
///   'M' 0x4D · type (0x01 P2P, 0x11 proxy) · version · L · transferId (L bytes) · seq u32 BE · IV (12) · ciphertext + tag
public struct BinaryChunkFrame: Sendable, Equatable {
    public static let magic: UInt8 = 0x4D
    public static let p2p: UInt8 = 0x01
    public static let proxy: UInt8 = 0x11

    public let type: UInt8
    public let version: UInt8
    public let transferId: String
    public let seq: UInt32
    public let iv: Data
    public let data: Data

    public init(type: UInt8 = BinaryChunkFrame.proxy, version: UInt8, transferId: String, seq: UInt32, iv: Data, data: Data) {
        self.type = type
        self.version = version
        self.transferId = transferId
        self.seq = seq
        self.iv = iv
        self.data = data
    }

    public func encode() throws -> Data {
        let id = Data(transferId.utf8)
        guard !id.isEmpty, id.count <= 96 else { throw NetError.invalid("transfer id too long") }
        guard iv.count == 12 else { throw NetError.invalid("IV must be 12 bytes") }
        var out = Data([Self.magic, type, version, UInt8(id.count)])
        out.append(id)
        out.append(contentsOf: [UInt8(seq >> 24 & 0xFF), UInt8(seq >> 16 & 0xFF), UInt8(seq >> 8 & 0xFF), UInt8(seq & 0xFF)])
        out.append(iv)
        out.append(data)
        return out
    }

    /// nil for anything that is not a well-formed chunk frame.
    public static func decode(_ bytes: Data) -> BinaryChunkFrame? {
        let b = [UInt8](bytes)
        guard b.count >= 4 + 1 + 4 + 12 + 16, b[0] == magic, b[1] == p2p || b[1] == proxy else { return nil }
        let len = Int(b[3])
        guard len > 0, len <= 96, b.count >= 20 + len + 16 else { return nil }
        guard let id = String(bytes: b[4..<(4 + len)], encoding: .utf8), HubWire.isId(id) else { return nil }
        let seq = UInt32(b[4 + len]) << 24 | UInt32(b[5 + len]) << 16 | UInt32(b[6 + len]) << 8 | UInt32(b[7 + len])
        return BinaryChunkFrame(type: b[1], version: b[2], transferId: id, seq: seq, iv: Data(b[(8 + len)..<(20 + len)]), data: Data(b[(20 + len)...]))
    }
}
