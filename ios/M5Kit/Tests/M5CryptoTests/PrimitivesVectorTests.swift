// test/vectors/p4.json: join, pad, unpad, HKDF, KDF_RK, KDF_CK, keyIv,
// ML-KEM-768 (and CryptoKit's ML-KEM against it), Ed25519 (RFC 8032), strict base64.

import CryptoKit
import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite struct PrimitivesVectorTests {
    let V = Repo.p4

    @Test func joinPadUnpad() throws {
        #expect(V.s("format") == "m5cet-p4-vectors/1")
        let joins = V.a("join")
        #expect(joins.count >= 2)
        for j in joins {
            let parts: [any JoinPart] = j.a("parts").map { p -> any JoinPart in p.int64Value.map { $0 as any JoinPart } ?? (p.stringValue ?? "") }
            #expect(try Prim.joinText(parts) == j.s("text"))
        }
        let pads = V.a("pad")
        #expect(pads.count == 11)
        for c in pads {
            let m = bytes(Int(c.i("len"))) { $0 % 251 }
            let p = Pad.pad(m)
            #expect(p.count == Int(c.i("paddedLength")))
            #expect(Pad.paddedLength(Int(c.i("len"))) == Int(c.i("paddedLength")))
            #expect(Prim.hex(Prim.H(p)) == c.s("sha256"))
            if c["in"] != nil {
                #expect(Prim.b64(m) == c.s("in"))
                #expect(Prim.b64(p) == c.s("out"))
            }
            #expect(try Pad.unpad(p) == m)
        }
        for c in V.a("unpad") {
            let input = try Prim.unb64(c.s("in"))
            if c["ok"]?.boolValue == true { #expect(Prim.b64(try Pad.unpad(input)) == c.s("out")) }
            else { expectP4("malformed") { _ = try Pad.unpad(input) } }
        }
    }

    @Test func joinRefusesSeparatorsAndBadIntegers() {
        let bad: [any JoinPart] = ["a|b", "é", "\n", Int64(-1), P4.maxSafe + 1]
        for b in bad { expectP4("malformed") { _ = try Prim.join("x", b) } }
    }

    @Test func hkdfKdfRkKdfCkKeyIv() throws {
        for c in V.a("hkdf") {
            #expect(Prim.b64(Prim.hkdf(try Prim.unb64(c.s("salt")), try Prim.unb64(c.s("ikm")), c.s("info"), Int(c.i("length")))) == c.s("okm"))
        }
        for c in V.a("kdfRk") {
            let kss: Bytes? = c["kss"]?.isNull == false ? try Prim.unb64(c.s("kss")) : nil
            let r = Ratchet.kdfRk(try Prim.unb64(c.s("rk")), try Prim.unb64(c.s("dh")), kss)
            #expect(Prim.b64(r.rk) == c.s("rkOut"))
            #expect(Prim.b64(r.ck) == c.s("ck"))
        }
        let ck = V.a("kdfCk")[0]
        let r = Ratchet.kdfCk(try Prim.unb64(ck.s("ck")))
        #expect(Prim.b64(r.mk) == ck.s("mk"))
        #expect(Prim.b64(r.next) == ck.s("next"))
        for c in V.a("keyIv") {
            let k = Prim.keyIv(try Prim.unb64(c.s("mk")), c.s("label"))
            #expect(Prim.b64(k.key) == c.s("key"))
            #expect(Prim.b64(k.iv) == c.s("iv"))
        }
    }

    @Test func mlKem768KeygenEncapsDecaps() throws {
        let cases = V.a("mlkem")
        #expect(cases.count == 2)
        for c in cases {
            let kp = try Kem.keygenFromSeed(try Prim.unb64(c.s("seed")))
            #expect(Prim.b64(kp.ek) == c.s("ek"))
            #expect(Prim.b64(kp.dk) == c.s("dk"))
            #expect(Kem.kid(kp.ek) == c.s("kid"))
            let e = try Kem.encapsWith(kp.ek, try Prim.unb64(c.s("m")))
            #expect(Prim.b64(e.ct) == c.s("ct"))
            #expect(Prim.b64(e.ss) == c.s("ss"))
            #expect(Prim.b64(try Kem.decaps(try Prim.unb64(c.s("ct")), kp.dk)) == c.s("ss"))
            // Implicit rejection: a changed ciphertext gives another secret, never an error.
            var bad = try Prim.unb64(c.s("ct"))
            bad[17] ^= 1
            #expect(Prim.b64(try Kem.decaps(bad, kp.dk)) != c.s("ss"))
        }
    }

    @Test func mlKemRefusesWrongSizesAndInvalidKeys() throws {
        let kp = try Kem.keygenFromSeed(Bytes(repeating: 0, count: 64))
        expectP4("malformed") { _ = try Kem.encapsWith(Bytes(repeating: 0, count: 1183), Bytes(repeating: 0, count: 32)) }
        expectP4("kct") { _ = try Kem.decaps(Bytes(repeating: 0, count: 1087), kp.dk) }
        var ek = kp.ek
        ek[0] = 0xff; ek[1] = 0xff // a coefficient >= q: FIPS 203 § 7.2 input check
        expectP4("malformed") { _ = try Kem.encapsWith(ek, Bytes(repeating: 0, count: 32)) }
        var dk = kp.dk
        dk[2400 - 40] ^= 1 // the stored H(ek): the § 7.3 hash check
        expectP4("kct") { _ = try Kem.decaps(Bytes(repeating: 0, count: 1088), dk) }
    }

    /// CryptoKit's MLKEM768 against this implementation: the same ek from the
    /// same seed, and secrets that agree in both directions. (CryptoKit cannot
    /// encapsulate with a given m, so the vectors' ciphertexts need ours.)
    @Test func cryptoKitMlKemAgreesWithOurs() throws {
        for c in V.a("mlkem") {
            let seed = try Prim.unb64(c.s("seed"))
            let ours = try Kem.keygenFromSeed(seed)
            let theirs = try MLKEM768.PrivateKey(seedRepresentation: seed, publicKey: nil)
            #expect(Array(theirs.publicKey.rawRepresentation) == ours.ek)
            // CryptoKit decapsulates the vector's (and our) ciphertext to the same secret.
            let ss = try theirs.decapsulate(try Prim.unb64(c.s("ct")))
            #expect(ss.withUnsafeBytes { Array($0) } == (try Prim.unb64(c.s("ss"))))
            // CryptoKit encapsulates (random m); we decapsulate to its secret.
            let enc = try theirs.publicKey.encapsulate()
            #expect(try Kem.decaps(Array(enc.encapsulated), ours.dk) == enc.sharedSecret.withUnsafeBytes { Array($0) })
        }
        // A fresh seed both ways.
        let seed = Crypto.random(64)
        let ours = try Kem.keygenFromSeed(seed)
        let theirs = try MLKEM768.PrivateKey(seedRepresentation: seed, publicKey: nil)
        #expect(Array(theirs.publicKey.rawRepresentation) == ours.ek)
        let mine = try Kem.encapsWith(ours.ek, Crypto.random(32))
        #expect(try theirs.decapsulate(mine.ct).withUnsafeBytes { Array($0) } == mine.ss)
    }

    @Test func sha3AndShakeMatchFips202AndCryptoKit() {
        #expect(Hex.encode(SHA3.sha256([])) == "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a")
        #expect(Hex.encode(SHA3.shake128([], count: 32)) == "7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26")
        #expect(Hex.encode(SHA3.shake256([], count: 32)) == "46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f")
        for n in [0, 1, 71, 72, 73, 135, 136, 137, 500] {
            let m = bytes(n) { $0 * 7 + 3 }
            #expect(SHA3.sha256(m) == Array(SHA3_256.hash(data: m)))
            #expect(SHA3.sha512(m) == Array(SHA3_512.hash(data: m)))
        }
    }

    /// RFC 8032 § 7.1 test vectors 1–3 and the 1023-byte one's public key.
    @Test func ed25519Rfc8032() throws {
        let cases: [(String, String, String, String)] = [
            ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
             "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
            ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
             "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
            ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
             "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
        ]
        for (sk, pk, msg, sig) in cases {
            let seed = Hex.decode(sk)!, m = Hex.decode(msg)!
            #expect(Hex.encode(try Prim.ed25519Public(seed)) == pk)
            let s = try Prim.ed25519Sign(seed, m)
            #expect(Hex.encode(s) == sig)
            #expect(Prim.ed25519Verify(Hex.decode(pk)!, m, s))
            var bad = s
            bad[5] ^= 1
            #expect(!Prim.ed25519Verify(Hex.decode(pk)!, m, bad))
            #expect(!Prim.ed25519Verify(Hex.decode(pk)!, m + [0], s))
            // CryptoKit verifies our signature, and we verify CryptoKit's (randomized) one.
            let ck = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            #expect(Array(ck.publicKey.rawRepresentation) == Hex.decode(pk)!)
            #expect(ck.publicKey.isValidSignature(s, for: m))
            #expect(Prim.ed25519Verify(Hex.decode(pk)!, m, Array(try ck.signature(for: m))))
        }
        // S >= L is refused (malleability).
        let seed = Hex.decode(cases[0].0)!, pub = try Prim.ed25519Public(seed)
        var s = try Prim.ed25519Sign(seed, [])
        let L: Bytes = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14] + Bytes(repeating: 0, count: 15) + [0x10]
        var carry = 0
        for i in 0..<32 { let v = Int(s[32 + i]) + Int(L[i]) + carry; s[32 + i] = UInt8(v & 255); carry = v >> 8 }
        #expect(!Prim.ed25519Verify(pub, [], s))
    }

    @Test func strictBase64() {
        for bad in ["QQ", "QR==", "Q Q==", "QQ==\n", "QQ=="] {
            expectP4("malformed", "\(bad)") { _ = try Prim.unb64(bad, length: 2) }
        }
        expectP4("malformed") { _ = try Prim.unb64url("QR", length: -1) }
        #expect((try? Prim.unb64("QUI=", length: 2)) == [0x41, 0x42])
        #expect((try? Prim.unb64url("QUI", length: 2)) == [0x41, 0x42])
    }

    @Test func p256SpkiPkcs8EcdhEcdsa() throws {
        let hs = V.o("handshake")
        for side in ["A", "B"] {
            let p = hs.o(side)
            let pair = try Prim.importP256Pkcs8(p.s("devicePkcs8"))
            #expect(pair.spki == p.s("pk"))
            #expect(Prim.isP256Spki(p.s("pk")))
            let sig = try Prim.ecdsaSign(pair, [1, 2, 3])
            #expect(Prim.ecdsaVerify(p.s("pk"), [1, 2, 3], sig))
            #expect(!Prim.ecdsaVerify(p.s("pk"), [1, 2, 4], sig))
        }
        // A compressed point, another curve's prefix or stray bytes: not a P-256 key.
        let good = try Prim.unb64(hs.o("A").s("pk"))
        #expect(!Prim.isP256Spki(Prim.b64(good + [0])))
        var off = good
        off[90] ^= 1
        #expect(!Prim.isP256Spki(Prim.b64(off)))
        var compressed = good
        compressed[26] = 0x02
        #expect(!Prim.isP256Spki(Prim.b64(compressed)))
        // ECDH is symmetric.
        let a = Prim.generateP256(), b = Prim.generateP256()
        #expect(try Prim.ecdh(a, b.spki) == (try Prim.ecdh(b, a.spki)))
        // PKCS#8 round trip.
        #expect(try Prim.importP256Pkcs8(a.pkcs8).spki == a.spki)
    }
}
