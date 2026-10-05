// Ed25519 (RFC 8032) in Swift. CryptoKit's Curve25519.Signing signs with a
// random nonce (valid, but not RFC 8032's deterministic signature), while the
// protocol's vectors — and the web's and Android's Bouncy Castle — sign
// deterministically: the hub proof, KT tree heads, release manifests and v2
// device certificates must come out byte for byte. Verification is strict as
// Bouncy Castle's: S < L, canonical encodings of A and R, cofactorless check.
// Field arithmetic in radix 2^51 with UInt128 products.

import CryptoKit
import M5Core

/// An element of GF(2^255 − 19), five 51-bit limbs (weakly reduced: each < 2^52).
struct Fe: Sendable {
    var l0, l1, l2, l3, l4: UInt64

    static let mask: UInt64 = (1 << 51) - 1
    static let zero = Fe(l0: 0, l1: 0, l2: 0, l3: 0, l4: 0)
    static let one = Fe(l0: 1, l1: 0, l2: 0, l3: 0, l4: 0)

    init(l0: UInt64, l1: UInt64, l2: UInt64, l3: UInt64, l4: UInt64) { self.l0 = l0; self.l1 = l1; self.l2 = l2; self.l3 = l3; self.l4 = l4 }

    init(_ small: UInt64) { self = Fe(l0: small, l1: 0, l2: 0, l3: 0, l4: 0).carried() }

    /// 32 little-endian bytes, the top bit ignored.
    init(bytes b: ArraySlice<UInt8>) {
        let base = b.startIndex
        func load(_ at: Int) -> UInt64 {
            var v: UInt64 = 0
            for i in 0..<8 { v |= UInt64(b[base + at + i]) << (8 * UInt64(i)) }
            return v
        }
        let w0 = load(0), w1 = load(8), w2 = load(16), w3 = load(24) & 0x7fffffffffffffff
        l0 = w0 & Fe.mask
        l1 = (w0 >> 51 | w1 << 13) & Fe.mask
        l2 = (w1 >> 38 | w2 << 26) & Fe.mask
        l3 = (w2 >> 25 | w3 << 39) & Fe.mask
        l4 = w3 >> 12
    }

    func carried() -> Fe {
        var r = self
        var c = r.l0 >> 51; r.l0 &= Fe.mask; r.l1 += c
        c = r.l1 >> 51; r.l1 &= Fe.mask; r.l2 += c
        c = r.l2 >> 51; r.l2 &= Fe.mask; r.l3 += c
        c = r.l3 >> 51; r.l3 &= Fe.mask; r.l4 += c
        c = r.l4 >> 51; r.l4 &= Fe.mask; r.l0 += c * 19
        c = r.l0 >> 51; r.l0 &= Fe.mask; r.l1 += c
        return r
    }

    static func + (a: Fe, b: Fe) -> Fe { Fe(l0: a.l0 + b.l0, l1: a.l1 + b.l1, l2: a.l2 + b.l2, l3: a.l3 + b.l3, l4: a.l4 + b.l4).carried() }

    static func - (a: Fe, b: Fe) -> Fe {
        // a + 4p − b (b < 2^52 per limb)
        Fe(l0: a.l0 + 0x1fffffffffffb4 - b.l0, l1: a.l1 + 0x1ffffffffffffc - b.l1, l2: a.l2 + 0x1ffffffffffffc - b.l2,
           l3: a.l3 + 0x1ffffffffffffc - b.l3, l4: a.l4 + 0x1ffffffffffffc - b.l4).carried()
    }

    static prefix func - (a: Fe) -> Fe { Fe.zero - a }

    static func * (a: Fe, b: Fe) -> Fe {
        @inline(__always) func m(_ x: UInt64, _ y: UInt64) -> UInt128 { UInt128(x) * UInt128(y) }
        let b1 = b.l1 * 19, b2 = b.l2 * 19, b3 = b.l3 * 19, b4 = b.l4 * 19
        let r0 = m(a.l0, b.l0) + m(a.l1, b4) + m(a.l2, b3) + m(a.l3, b2) + m(a.l4, b1)
        var r1 = m(a.l0, b.l1) + m(a.l1, b.l0) + m(a.l2, b4) + m(a.l3, b3) + m(a.l4, b2)
        var r2 = m(a.l0, b.l2) + m(a.l1, b.l1) + m(a.l2, b.l0) + m(a.l3, b4) + m(a.l4, b3)
        var r3 = m(a.l0, b.l3) + m(a.l1, b.l2) + m(a.l2, b.l1) + m(a.l3, b.l0) + m(a.l4, b4)
        var r4 = m(a.l0, b.l4) + m(a.l1, b.l3) + m(a.l2, b.l2) + m(a.l3, b.l1) + m(a.l4, b.l0)
        let mk = UInt128(Fe.mask)
        r1 += r0 >> 51; var o0 = UInt64(r0 & mk)
        r2 += r1 >> 51; let o1 = UInt64(r1 & mk)
        r3 += r2 >> 51; let o2 = UInt64(r2 & mk)
        r4 += r3 >> 51; let o3 = UInt64(r3 & mk)
        let c = UInt64(r4 >> 51); let o4 = UInt64(r4 & mk)
        o0 += c * 19
        return Fe(l0: o0, l1: o1, l2: o2, l3: o3, l4: o4).carried()
    }

    func squared() -> Fe { self * self }

    func pow(_ e: [UInt8]) -> Fe {
        // e little-endian bytes, public exponent
        var r = Fe.one
        for i in stride(from: e.count * 8 - 1, through: 0, by: -1) {
            r = r.squared()
            if (e[i >> 3] >> UInt8(i & 7)) & 1 == 1 { r = r * self }
        }
        return r
    }

    /// p − 2 and (p − 5) / 8, little-endian.
    static let pMinus2: [UInt8] = [0xeb] + [UInt8](repeating: 0xff, count: 30) + [0x7f]
    static let pMinus5Over8: [UInt8] = [0xfd] + [UInt8](repeating: 0xff, count: 30) + [0x0f]

    func inverted() -> Fe { pow(Fe.pMinus2) }

    /// The canonical 32-byte little-endian encoding.
    var bytes: Bytes {
        let h = carried()
        // The integer Σ l_i·2^(51 i) as four 64-bit words (it is < 2^256: every limb < 2^52).
        let low: UInt128 = UInt128(UInt64.max)
        var acc = UInt128(h.l0) + (UInt128(h.l1) << 51)
        var w = [UInt64](repeating: 0, count: 4)
        w[0] = UInt64(acc & low); acc >>= 64
        acc += UInt128(h.l2) << 38
        w[1] = UInt64(acc & low); acc >>= 64
        acc += UInt128(h.l3) << 25
        w[2] = UInt64(acc & low); acc >>= 64
        acc += UInt128(h.l4) << 12
        w[3] = UInt64(acc & low); acc >>= 64
        var top = UInt64(acc) << 1 | w[3] >> 63
        // Fold 2^255 ≡ 19 until the value is below 2^255, then subtract p once if needed.
        while top != 0 {
            w[3] &= 0x7fffffffffffffff
            var carry = UInt128(top) * 19
            for i in 0..<4 {
                let s = UInt128(w[i]) + carry
                w[i] = UInt64(s & low)
                carry = s >> 64
            }
            top = UInt64(carry) << 1 | w[3] >> 63
        }
        let p: [UInt64] = [0xffffffffffffffed, 0xffffffffffffffff, 0xffffffffffffffff, 0x7fffffffffffffff]
        var geP = true
        for i in stride(from: 3, through: 0, by: -1) where w[i] != p[i] { geP = w[i] > p[i]; break }
        if geP {
            var borrow: UInt64 = 0
            for i in 0..<4 {
                let (d1, o1) = w[i].subtractingReportingOverflow(p[i])
                let (d2, o2) = d1.subtractingReportingOverflow(borrow)
                w[i] = d2
                borrow = (o1 || o2) ? 1 : 0
            }
        }
        var out = Bytes(repeating: 0, count: 32)
        for (wi, x) in w.enumerated() {
            for i in 0..<8 { out[wi * 8 + i] = UInt8(truncatingIfNeeded: x >> (8 * UInt64(i))) }
        }
        return out
    }

    var isZero: Bool { bytes.allSatisfy { $0 == 0 } }
    var isNegative: Bool { bytes[0] & 1 == 1 }
    static func == (a: Fe, b: Fe) -> Bool { a.bytes == b.bytes }

    /// Constant-time select: `b` when `flag`, else `a`.
    static func select(_ a: Fe, _ b: Fe, _ flag: Bool) -> Fe {
        let m: UInt64 = flag ? ~0 : 0
        return Fe(l0: a.l0 ^ (m & (a.l0 ^ b.l0)), l1: a.l1 ^ (m & (a.l1 ^ b.l1)), l2: a.l2 ^ (m & (a.l2 ^ b.l2)),
                  l3: a.l3 ^ (m & (a.l3 ^ b.l3)), l4: a.l4 ^ (m & (a.l4 ^ b.l4)))
    }
}

/// A point in extended twisted Edwards coordinates.
struct EdPoint: Sendable {
    var x, y, z, t: Fe

    static let d: Fe = (-Fe(121665)) * Fe(121666).inverted()
    static let d2: Fe = d + d
    static let sqrtM1: Fe = {
        // 2^((p−1)/4)
        let e: [UInt8] = [0xfb] + [UInt8](repeating: 0xff, count: 30) + [0x1f]
        return Fe(2).pow(e)
    }()
    static let identity = EdPoint(x: .zero, y: .one, z: .one, t: .zero)
    static let base: EdPoint = EdPoint.decode([0x58] + [UInt8](repeating: 0x66, count: 31))!

    static func + (p: EdPoint, q: EdPoint) -> EdPoint {
        let a = (p.y - p.x) * (q.y - q.x)
        let b = (p.y + p.x) * (q.y + q.x)
        let c = p.t * EdPoint.d2 * q.t
        let dd = p.z * (q.z + q.z)
        let e = b - a, f = dd - c, g = dd + c, h = b + a
        return EdPoint(x: e * f, y: g * h, z: f * g, t: e * h)
    }

    func doubled() -> EdPoint {
        let a = x.squared(), b = y.squared()
        let c = z.squared() + z.squared()
        let h = a + b
        let e = h - (x + y).squared()
        let g = a - b
        let f = c + g
        return EdPoint(x: e * f, y: g * h, z: f * g, t: e * h)
    }

    static prefix func - (p: EdPoint) -> EdPoint { EdPoint(x: -p.x, y: p.y, z: p.z, t: -p.t) }

    static func select(_ a: EdPoint, _ b: EdPoint, _ flag: Bool) -> EdPoint {
        EdPoint(x: Fe.select(a.x, b.x, flag), y: Fe.select(a.y, b.y, flag), z: Fe.select(a.z, b.z, flag), t: Fe.select(a.t, b.t, flag))
    }

    /// [s]P for a 32-byte little-endian scalar: double-and-add with both branches computed.
    func times(_ s: Bytes) -> EdPoint {
        var r = EdPoint.identity
        for i in stride(from: 255, through: 0, by: -1) {
            r = r.doubled()
            let bit = (s[i >> 3] >> UInt8(i & 7)) & 1 == 1
            r = EdPoint.select(r, r + self, bit)
        }
        return r
    }

    var encoded: Bytes {
        let zi = z.inverted()
        let ax = x * zi, ay = y * zi
        var out = ay.bytes
        if ax.isNegative { out[31] |= 0x80 }
        return out
    }

    /// RFC 8032 § 5.1.3 decoding; nil for a non-canonical y or no square root.
    static func decode(_ b: Bytes) -> EdPoint? {
        guard b.count == 32 else { return nil }
        let sign = b[31] >> 7
        var yb = b
        yb[31] &= 0x7f
        // y < p
        let y = Fe(bytes: yb[0..<32])
        if y.bytes != yb { return nil }
        let y2 = y.squared()
        let u = y2 - .one
        let v = EdPoint.d * y2 + .one
        let v3 = v.squared() * v
        let v7 = v3.squared() * v
        var x = u * v3 * (u * v7).pow(Fe.pMinus5Over8)
        let vx2 = v * x.squared()
        if vx2 == u {
            // ok
        } else if vx2 == -u {
            x = x * EdPoint.sqrtM1
        } else {
            return nil
        }
        if x.isZero && sign == 1 { return nil }
        if (x.isNegative ? 1 : 0) != sign { x = -x }
        return EdPoint(x: x, y: y, z: .one, t: x * y)
    }
}

enum Ed25519Impl {
    /// L = 2^252 + 27742317777372353535851937790883648493, little-endian bytes.
    static let L: [Int64] = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
                             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]

    /// x (64 limbs of 8 bits, possibly larger) mod L → 32 bytes (TweetNaCl's modL).
    static func modL(_ xIn: [Int64]) -> Bytes {
        var x = xIn
        for i in stride(from: 63, through: 32, by: -1) {
            var carry: Int64 = 0
            var j = i - 32
            while j < i - 12 {
                x[j] += carry - 16 * x[i] * L[j - (i - 32)]
                carry = (x[j] + 128) >> 8
                x[j] -= carry << 8
                j += 1
            }
            x[j] += carry
            x[i] = 0
        }
        var carry: Int64 = 0
        for j in 0..<32 {
            x[j] += carry - (x[31] >> 4) * L[j]
            carry = x[j] >> 8
            x[j] &= 255
        }
        for j in 0..<32 { x[j] -= carry * L[j] }
        var r = Bytes(repeating: 0, count: 32)
        for i in 0..<32 {
            x[i + 1] += x[i] >> 8
            r[i] = UInt8(x[i] & 255)
        }
        return r
    }

    static func reduce(_ h: Bytes) -> Bytes { modL(h.map { Int64($0) } + [Int64](repeating: 0, count: max(0, 64 - h.count))) }

    static func sha512(_ parts: Bytes...) -> Bytes {
        var h = SHA512()
        for p in parts { h.update(data: p) }
        return Array(h.finalize())
    }

    static func expand(_ seed: Bytes) -> (a: Bytes, prefix: Bytes) {
        var d = sha512(seed)
        d[0] &= 248
        d[31] &= 127
        d[31] |= 64
        return (Array(d[0..<32]), Array(d[32..<64]))
    }

    static func publicKey(seed: Bytes) -> Bytes { EdPoint.base.times(expand(seed).a).encoded }

    static func sign(seed: Bytes, message: Bytes) -> Bytes {
        let (a, prefix) = expand(seed)
        let pk = EdPoint.base.times(a).encoded
        let r = reduce(sha512(prefix, message))
        let R = EdPoint.base.times(r).encoded
        let k = reduce(sha512(R, pk, message))
        var x = [Int64](repeating: 0, count: 64)
        for i in 0..<32 { x[i] = Int64(r[i]) }
        for i in 0..<32 { for j in 0..<32 { x[i + j] += Int64(k[i]) * Int64(a[j]) } }
        return R + modL(x)
    }

    /// S < L (little-endian comparison).
    static func scalarIsCanonical(_ s: ArraySlice<UInt8>) -> Bool {
        let base = s.startIndex
        for i in stride(from: 31, through: 0, by: -1) {
            let a = Int64(s[base + i]), b = L[i]
            if a < b { return true }
            if a > b { return false }
        }
        return false
    }

    static func verify(publicKey: Bytes, message: Bytes, signature: Bytes) -> Bool {
        guard publicKey.count == 32, signature.count == 64 else { return false }
        let rBytes = Array(signature[0..<32])
        guard scalarIsCanonical(signature[32..<64]) else { return false }
        // R must be a canonical encoding (y < p).
        var ry = rBytes
        ry[31] &= 0x7f
        guard Fe(bytes: ry[0..<32]).bytes == ry else { return false }
        guard let A = EdPoint.decode(publicKey) else { return false }
        let k = reduce(sha512(rBytes, publicKey, message))
        let check = EdPoint.base.times(Array(signature[32..<64])) + (-A).times(k)
        return check.encoded == rBytes
    }
}
