// Hub join proof (docs/protocol-v4.md § 13, G-09; hub-proof.ts; android
// p4/HubProof.java). A join carries a proof that the joiner knows the room
// KEY: an Ed25519 key pair derived from the room secret (hubSeed =
// RoomKeys.derive("m5cet/hub-auth/4", 32 bytes)) signs the server's
// per-socket nonce. The server learns only the public key (the room's verifier).

import M5Core

public enum HubProof {
    /// The room's hub public key (raw 32 bytes, b64) — the same in every member's client.
    public static func pub(_ seed: Bytes) throws -> String { Prim.b64(try Prim.ed25519Public(seed)) }

    /// § 13: the bytes the proof signs. The nonce is the server's: b64url of 24 bytes.
    public static func joinData(_ roomId: String, _ nonce: String) throws -> Bytes {
        _ = try Prim.unb64url(nonce, length: 24)
        return try Prim.join(P4.lHubJoin, roomId, nonce)
    }

    /// § 13: the `proof` of a join frame: {pub, sig}.
    public static func build(seed: Bytes, roomId: String, nonce: String) throws -> JSONObject {
        let sig = try Prim.ed25519Sign(seed, try joinData(roomId, nonce))
        return JSONObject([("pub", .string(try pub(seed))), ("sig", .string(Prim.b64(sig)))])
    }

    /// Server side (and tests): does `sig` prove the key behind `pub` for this room and nonce? Never throws.
    public static func verify(pub: String, sig: String, roomId: String, nonce: String) -> Bool {
        guard (try? Prim.unb64(pub, length: 32)) != nil, (try? Prim.unb64(sig, length: 64)) != nil,
              let data = try? joinData(roomId, nonce) else { return false }
        return Prim.ed25519Verify(pub, data, sig)
    }
}
