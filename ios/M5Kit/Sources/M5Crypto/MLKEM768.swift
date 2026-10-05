// ML-KEM-768 (FIPS 203, final) in Swift — exactly what noble's ml_kem768 and
// Bouncy Castle give: key generation from a 64-byte seed d ‖ z, encapsulation
// with an explicit 32-byte message m (ML-KEM.Encaps_internal), and the
// expanded 2400-byte decapsulation key. CryptoKit's MLKEM768 takes the seed
// (`PrivateKey(seedRepresentation:)`) but cannot encapsulate with a given m
// nor import an expanded key, both of which the protocol-4 vectors (and
// Android's stored keys) need; the tests check this implementation against
// CryptoKit in both directions.

import M5Core

enum MLKEM768Impl {
    static let n = 256, q: Int32 = 3329, k = 3, eta1 = 2, eta2 = 2, du = 10, dv = 4
    static let ekBytes = 1184, dkBytes = 2400, ctBytes = 1088

    typealias Poly = [Int32] // 256 coefficients in [0, q)

    /// ζ^BitRev7(i) mod q, i = 0…127.
    static let zetas: [Int32] = {
        var out = [Int32](repeating: 0, count: 128)
        for i in 0..<128 {
            var r = 0
            for b in 0..<7 where (i >> b) & 1 == 1 { r |= 1 << (6 - b) }
            out[i] = powmod(17, r)
        }
        return out
    }()

    /// ζ^(2·BitRev7(i)+1) mod q, i = 0…127.
    static let gammas: [Int32] = {
        var out = [Int32](repeating: 0, count: 128)
        for i in 0..<128 {
            var r = 0
            for b in 0..<7 where (i >> b) & 1 == 1 { r |= 1 << (6 - b) }
            out[i] = powmod(17, 2 * r + 1)
        }
        return out
    }()

    static func powmod(_ base: Int32, _ e: Int) -> Int32 {
        var r: Int64 = 1, b = Int64(base), e = e
        while e > 0 { if e & 1 == 1 { r = r * b % Int64(q) }; b = b * b % Int64(q); e >>= 1 }
        return Int32(r)
    }

    @inline(__always) static func mod(_ x: Int32) -> Int32 { let r = x % q; return r < 0 ? r + q : r }
    @inline(__always) static func mulmod(_ a: Int32, _ b: Int32) -> Int32 { Int32(Int64(a) * Int64(b) % Int64(q)) }

    static func ntt(_ f: inout Poly) {
        var i = 1
        var len = 128
        while len >= 2 {
            var start = 0
            while start < 256 {
                let z = zetas[i]; i += 1
                for j in start..<start + len {
                    let t = mulmod(z, f[j + len])
                    f[j + len] = mod(f[j] - t)
                    f[j] = mod(f[j] + t)
                }
                start += 2 * len
            }
            len /= 2
        }
    }

    static func invNtt(_ f: inout Poly) {
        var i = 127
        var len = 2
        while len <= 128 {
            var start = 0
            while start < 256 {
                let z = zetas[i]; i -= 1
                for j in start..<start + len {
                    let t = f[j]
                    f[j] = mod(t + f[j + len])
                    f[j + len] = mulmod(z, mod(f[j + len] - t))
                }
                start += 2 * len
            }
            len *= 2
        }
        for j in 0..<256 { f[j] = mulmod(f[j], 3303) }
    }

    static func multiplyNtts(_ f: Poly, _ g: Poly) -> Poly {
        var h = Poly(repeating: 0, count: 256)
        for i in 0..<128 {
            let a0 = Int64(f[2 * i]), a1 = Int64(f[2 * i + 1]), b0 = Int64(g[2 * i]), b1 = Int64(g[2 * i + 1])
            let qq = Int64(q)
            h[2 * i] = Int32((a0 * b0 + (a1 * b1 % qq) * Int64(gammas[i])) % qq)
            h[2 * i + 1] = Int32((a0 * b1 + a1 * b0) % qq)
        }
        return h
    }

    static func add(_ a: Poly, _ b: Poly) -> Poly { (0..<256).map { mod(a[$0] + b[$0]) } }
    static func sub(_ a: Poly, _ b: Poly) -> Poly { (0..<256).map { mod(a[$0] - b[$0]) } }

    /* ------------------------------------------------------------ encoding */

    static func byteEncode(_ f: Poly, _ d: Int) -> Bytes {
        var out = Bytes(repeating: 0, count: 32 * d)
        var bit = 0
        for x in f {
            let v = UInt32(x)
            for b in 0..<d {
                if (v >> UInt32(b)) & 1 == 1 { out[bit >> 3] |= UInt8(1 << (bit & 7)) }
                bit += 1
            }
        }
        return out
    }

    /// ByteDecode_d; for d = 12 the values are NOT reduced (the caller checks them against q).
    static func byteDecode(_ b: ArraySlice<UInt8>, _ d: Int) -> Poly {
        var f = Poly(repeating: 0, count: 256)
        let base = b.startIndex
        var bit = 0
        for i in 0..<256 {
            var v: Int32 = 0
            for j in 0..<d {
                if (b[base + (bit >> 3)] >> UInt8(bit & 7)) & 1 == 1 { v |= 1 << j }
                bit += 1
            }
            f[i] = v
        }
        return f
    }

    static func compress(_ x: Int32, _ d: Int) -> Int32 {
        Int32(((UInt64(x) << UInt64(d)) + 1664) / 3329 & ((1 << UInt64(d)) - 1))
    }

    static func decompress(_ y: Int32, _ d: Int) -> Int32 {
        Int32((UInt64(y) * 3329 + (1 << UInt64(d - 1))) >> UInt64(d))
    }

    /* ------------------------------------------------------------ sampling */

    static func sampleNtt(_ rho: Bytes, _ j: UInt8, _ i: UInt8) -> Poly {
        var xof = Keccak.shake128XOF(rho + [j, i])
        var a = Poly(repeating: 0, count: 256)
        var n = 0
        while n < 256 {
            let c = xof.squeeze(168)
            var at = 0
            while at + 3 <= c.count && n < 256 {
                let d1 = Int32(c[at]) + 256 * (Int32(c[at + 1]) & 15)
                let d2 = (Int32(c[at + 1]) >> 4) + 16 * Int32(c[at + 2])
                if d1 < q { a[n] = d1; n += 1 }
                if d2 < q && n < 256 { a[n] = d2; n += 1 }
                at += 3
            }
        }
        return a
    }

    static func cbd(_ b: Bytes, _ eta: Int) -> Poly {
        var f = Poly(repeating: 0, count: 256)
        func bit(_ i: Int) -> Int32 { Int32((b[i >> 3] >> UInt8(i & 7)) & 1) }
        for i in 0..<256 {
            var x: Int32 = 0, y: Int32 = 0
            for j in 0..<eta { x += bit(2 * i * eta + j); y += bit(2 * i * eta + eta + j) }
            f[i] = mod(x - y)
        }
        return f
    }

    static func prf(_ s: Bytes, _ b: UInt8, _ eta: Int) -> Bytes { Keccak.shake256(s + [b], 64 * eta) }

    static func matrix(_ rho: Bytes) -> [[Poly]] {
        (0..<k).map { i in (0..<k).map { j in sampleNtt(rho, UInt8(j), UInt8(i)) } }
    }

    /* --------------------------------------------------------------- K-PKE */

    static func pkeKeyGen(_ d: Bytes) -> (ek: Bytes, dk: Bytes) {
        let g = Keccak.sha3_512(d + [UInt8(k)])
        let rho = Array(g[0..<32]), sigma = Array(g[32..<64])
        let a = matrix(rho)
        var nonce: UInt8 = 0
        var s = [Poly](), e = [Poly]()
        for _ in 0..<k { s.append(cbd(prf(sigma, nonce, eta1), eta1)); nonce += 1 }
        for _ in 0..<k { e.append(cbd(prf(sigma, nonce, eta1), eta1)); nonce += 1 }
        for i in 0..<k { ntt(&s[i]); ntt(&e[i]) }
        var ek = Bytes(), dk = Bytes()
        for i in 0..<k {
            var t = e[i]
            for j in 0..<k { t = add(t, multiplyNtts(a[i][j], s[j])) }
            ek += byteEncode(t, 12)
        }
        ek += rho
        for i in 0..<k { dk += byteEncode(s[i], 12) }
        return (ek, dk)
    }

    static func pkeEncrypt(_ ek: Bytes, _ m: Bytes, _ r: Bytes) -> Bytes {
        var t = [Poly]()
        for i in 0..<k { t.append(byteDecode(ek[(384 * i)..<(384 * i + 384)], 12)) }
        let rho = Array(ek[(384 * k)..<(384 * k + 32)])
        let a = matrix(rho)
        var nonce: UInt8 = 0
        var y = [Poly](), e1 = [Poly]()
        for _ in 0..<k { y.append(cbd(prf(r, nonce, eta1), eta1)); nonce += 1 }
        for _ in 0..<k { e1.append(cbd(prf(r, nonce, eta2), eta2)); nonce += 1 }
        let e2 = cbd(prf(r, nonce, eta2), eta2)
        for i in 0..<k { ntt(&y[i]) }
        var c = Bytes()
        for i in 0..<k {
            var u = Poly(repeating: 0, count: 256)
            for j in 0..<k { u = add(u, multiplyNtts(a[j][i], y[j])) }
            invNtt(&u)
            u = add(u, e1[i])
            c += byteEncode(u.map { compress($0, du) }, du)
        }
        var v = Poly(repeating: 0, count: 256)
        for j in 0..<k { v = add(v, multiplyNtts(t[j], y[j])) }
        invNtt(&v)
        let mu = byteDecode(m[0..<32], 1).map { decompress($0, 1) }
        v = add(add(v, e2), mu)
        c += byteEncode(v.map { compress($0, dv) }, dv)
        return c
    }

    static func pkeDecrypt(_ dk: ArraySlice<UInt8>, _ c: Bytes) -> Bytes {
        var u = [Poly]()
        for i in 0..<k { u.append(byteDecode(c[(320 * i)..<(320 * i + 320)], du).map { decompress($0, du) }) }
        let v = byteDecode(c[(320 * k)..<(320 * k + 128)], dv).map { decompress($0, dv) }
        var s = [Poly]()
        let base = dk.startIndex
        for i in 0..<k { s.append(byteDecode(dk[(base + 384 * i)..<(base + 384 * i + 384)], 12).map { mod($0) }) }
        var w = Poly(repeating: 0, count: 256)
        for i in 0..<k {
            var ui = u[i]
            ntt(&ui)
            w = add(w, multiplyNtts(s[i], ui))
        }
        invNtt(&w)
        let diff = sub(v, w)
        return byteEncode(diff.map { compress($0, 1) }, 1)
    }

    /* --------------------------------------------------------------- ML-KEM */

    static func keygen(seed: Bytes) -> (ek: Bytes, dk: Bytes) {
        let d = Array(seed[0..<32]), z = Array(seed[32..<64])
        let (ek, dkPke) = pkeKeyGen(d)
        return (ek, dkPke + ek + Keccak.sha3_256(ek) + z)
    }

    /// FIPS 203 § 7.2 modulus check: every 12-bit value of ek's t̂ is < q.
    static func ekIsValid(_ ek: Bytes) -> Bool {
        guard ek.count == ekBytes else { return false }
        for i in 0..<k {
            let f = byteDecode(ek[(384 * i)..<(384 * i + 384)], 12)
            if f.contains(where: { $0 >= q }) { return false }
        }
        return true
    }

    static func encaps(ek: Bytes, m: Bytes) -> (ct: Bytes, ss: Bytes) {
        let g = Keccak.sha3_512(m + Keccak.sha3_256(ek))
        let key = Array(g[0..<32]), r = Array(g[32..<64])
        return (pkeEncrypt(ek, m, r), key)
    }

    /// FIPS 203 § 7.3 hash check: H(ek inside dk) equals the stored hash.
    static func dkIsValid(_ dk: Bytes) -> Bool {
        guard dk.count == dkBytes else { return false }
        let ek = Array(dk[(384 * k)..<(768 * k + 32)])
        return ByteOps.ctEqual(Keccak.sha3_256(ek), Array(dk[(768 * k + 32)..<(768 * k + 64)]))
    }

    static func decaps(dk: Bytes, ct: Bytes) -> Bytes {
        let dkPke = dk[0..<(384 * k)]
        let ek = Array(dk[(384 * k)..<(768 * k + 32)])
        let h = Array(dk[(768 * k + 32)..<(768 * k + 64)])
        let z = Array(dk[(768 * k + 64)..<(768 * k + 96)])
        let m = pkeDecrypt(dkPke, ct)
        let g = Keccak.sha3_512(m + h)
        let key = Array(g[0..<32]), r = Array(g[32..<64])
        let rejected = Keccak.shake256(z + ct, 32)
        let again = pkeEncrypt(ek, m, r)
        // Constant-time select of the implicit rejection.
        let same = ByteOps.ctEqual(again, ct)
        let mask: UInt8 = same ? 0xff : 0x00
        return (0..<32).map { (key[$0] & mask) | (rejected[$0] & ~mask) }
    }
}
