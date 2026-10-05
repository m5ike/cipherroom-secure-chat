// ML-KEM-768 for protocol 4 (FIPS 203; kem.ts; android p4/Kem.java). Sizes are
// pinned before the algorithm sees an input; key generation from a 64-byte
// seed (d ‖ z) and encapsulation with a given 32-byte m give exactly what
// noble's ml_kem768 gives (test/vectors/p4.json "mlkem").
//
// Decapsulation never fails on a well-sized ciphertext (implicit rejection: a
// tampered one yields an unrelated secret); every ciphertext is also bound into
// an AAD, so tampering shows up as an AEAD failure. See MLKEM768.swift for why
// this is not CryptoKit's MLKEM768 (the tests compare the two).

import M5Core

public enum Kem {
    /// An ML-KEM-768 key pair: the 1184-byte encapsulation key and the 2400-byte (expanded) decapsulation key.
    public struct KeyPair: Sendable {
        public let ek: Bytes
        public let dk: Bytes
    }

    /// One encapsulation: the 1088-byte ciphertext and the 32-byte shared secret.
    public struct Encapsulated: Sendable {
        public let ct: Bytes
        public let ss: Bytes
    }

    private static func sized(_ value: Bytes, _ length: Int, _ what: String, _ code: String) throws {
        if value.count != length { throw P4Error(code, "\(what) must be \(length) bytes") }
    }

    /// Key generation from a 64-byte seed (d ‖ z).
    public static func keygenFromSeed(_ seed: Bytes) throws -> KeyPair {
        try sized(seed, P4.kemSeed, "ML-KEM seed", "malformed")
        let (ek, dk) = MLKEM768Impl.keygen(seed: seed)
        return KeyPair(ek: ek, dk: dk)
    }

    /// A fresh key pair; the seed is drawn from `rng` (label `what`).
    public static func keygen(_ rng: any Rng, _ what: String) throws -> KeyPair {
        var seed = try rng.bytes(P4.kemSeed, what)
        defer { ByteOps.wipe(&seed) }
        return try keygenFromSeed(seed)
    }

    /// Encapsulation with an explicit 32-byte message m (vectors, replay).
    public static func encapsWith(_ ek: Bytes, _ m: Bytes) throws -> Encapsulated {
        try sized(ek, P4.kemEk, "ML-KEM encapsulation key", "malformed")
        try sized(m, 32, "ML-KEM message", "malformed")
        // FIPS 203 § 7.2 input check (coefficients < q): not a valid key.
        guard MLKEM768Impl.ekIsValid(ek) else { throw P4Error.malformed("invalid ML-KEM encapsulation key") }
        let (ct, ss) = MLKEM768Impl.encaps(ek: ek, m: m)
        return Encapsulated(ct: ct, ss: ss)
    }

    /// Encapsulation; m is drawn from `rng` (label `what`).
    public static func encaps(_ ek: Bytes, _ rng: any Rng, _ what: String) throws -> Encapsulated {
        var m = try rng.bytes(32, what)
        defer { ByteOps.wipe(&m) }
        return try encapsWith(ek, m)
    }

    /// Decapsulation; a ciphertext or key of the wrong size (or a key failing its hash check) is `kct`.
    public static func decaps(_ ct: Bytes, _ dk: Bytes) throws -> Bytes {
        try sized(ct, P4.kemCt, "ML-KEM ciphertext", "kct")
        try sized(dk, P4.kemDk, "ML-KEM decapsulation key", "kct")
        guard MLKEM768Impl.dkIsValid(dk) else { throw P4Error("kct", "ML-KEM decapsulation failed") }
        return MLKEM768Impl.decaps(dk: dk, ct: ct)
    }

    /// § 5.3 kid: b64url(H(ek))[0:16] — names one of the receiver's KEM keys.
    public static func kid(_ ek: Bytes) -> String { String(Prim.b64url(Prim.H(ek)).prefix(16)) }
}
