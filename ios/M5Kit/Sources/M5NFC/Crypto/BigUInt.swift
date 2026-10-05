// A small arbitrary-precision unsigned integer — what java.math.BigInteger
// does for EcCurve.java: the PACE curves' field arithmetic (up to 521 bits).
// 64-bit limbs, little-endian, schoolbook multiplication and Knuth's
// algorithm D for division. Not constant-time (neither is BigInteger):
// every key it touches is an ephemeral one used once, against the holder's
// own document.

import Foundation

public struct BigUInt: Sendable, Hashable, Comparable, CustomStringConvertible {
    /// Little-endian 64-bit limbs, no zero limb at the top (zero = []).
    public private(set) var limbs: [UInt64]

    public static let zero = BigUInt(limbs: [])
    public static let one = BigUInt(1)

    init(limbs: [UInt64]) { self.limbs = limbs; normalize() }

    public init(_ v: UInt64) { limbs = v == 0 ? [] : [v] }
    public init(_ v: Int) { precondition(v >= 0, "BigUInt is unsigned"); self.init(UInt64(v)) }

    /// Big-endian unsigned bytes.
    public init(bytes: [UInt8]) {
        var l = [UInt64]()
        l.reserveCapacity(bytes.count / 8 + 1)
        var i = bytes.count
        while i > 0 {
            let lo = max(0, i - 8)
            var v: UInt64 = 0
            for k in lo..<i { v = v << 8 | UInt64(bytes[k]) }
            l.append(v)
            i = lo
        }
        self.init(limbs: l)
    }

    /// Hex digits (any case, no prefix); nil when not hex.
    public init?(hex: String) {
        var digits = Array(hex.utf8)
        if digits.isEmpty { return nil }
        if digits.count % 2 == 1 { digits.insert(0x30, at: 0) }
        guard let b = Hex.decodeStrict(String(decoding: digits, as: UTF8.self)) else { return nil }
        self.init(bytes: b)
    }

    private mutating func normalize() { while let last = limbs.last, last == 0 { limbs.removeLast() } }

    public var isZero: Bool { limbs.isEmpty }

    /// The number of significant bits (BigInteger.bitLength).
    public var bitWidth: Int { limbs.isEmpty ? 0 : limbs.count * 64 - limbs[limbs.count - 1].leadingZeroBitCount }

    public func testBit(_ i: Int) -> Bool {
        let w = i / 64
        return w < limbs.count && (limbs[w] >> UInt64(i % 64)) & 1 == 1
    }

    /// Big-endian bytes, left-padded to `size`; throws when the number does not fit.
    public func bytes(size: Int) throws -> [UInt8] {
        guard bitWidth <= 8 * size else { throw NfcError(.invalidArgument, "integer does not fit") }
        var out = [UInt8](repeating: 0, count: size)
        for (i, limb) in limbs.enumerated() {
            for b in 0..<8 {
                let pos = size - 1 - (i * 8 + b)
                if pos < 0 { break }
                out[pos] = UInt8(truncatingIfNeeded: limb >> UInt64(8 * b))
            }
        }
        return out
    }

    /// Minimal big-endian bytes.
    public var bytes: [UInt8] { (try? bytes(size: max(1, (bitWidth + 7) / 8))) ?? [0] }

    public var hex: String {
        if isZero { return "0" }
        var s = Hex.encode(bytes)
        while s.hasPrefix("0") && s.count > 1 { s.removeFirst() }
        return s
    }

    public var description: String { hex }

    /* ------------------------------------------------------------ compare */

    public static func < (a: BigUInt, b: BigUInt) -> Bool { compare(a.limbs, b.limbs) < 0 }

    static func compare(_ a: [UInt64], _ b: [UInt64]) -> Int {
        if a.count != b.count { return a.count < b.count ? -1 : 1 }
        var i = a.count - 1
        while i >= 0 {
            if a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
            i -= 1
        }
        return 0
    }

    /* ------------------------------------------------------------ + − × */

    public static func + (a: BigUInt, b: BigUInt) -> BigUInt {
        let (long, short) = a.limbs.count >= b.limbs.count ? (a.limbs, b.limbs) : (b.limbs, a.limbs)
        var r = long
        var carry: UInt64 = 0
        for i in 0..<long.count {
            let (s1, o1) = r[i].addingReportingOverflow(i < short.count ? short[i] : 0)
            let (s2, o2) = s1.addingReportingOverflow(carry)
            r[i] = s2
            carry = (o1 ? 1 : 0) + (o2 ? 1 : 0)
            if carry == 0 && i >= short.count { break }
        }
        if carry != 0 { r.append(carry) }
        return BigUInt(limbs: r)
    }

    /// a − b; requires a ≥ b.
    public static func - (a: BigUInt, b: BigUInt) -> BigUInt {
        precondition(a >= b, "BigUInt subtraction underflow")
        var r = a.limbs
        var borrow: UInt64 = 0
        for i in 0..<r.count {
            let (d1, o1) = r[i].subtractingReportingOverflow(i < b.limbs.count ? b.limbs[i] : 0)
            let (d2, o2) = d1.subtractingReportingOverflow(borrow)
            r[i] = d2
            borrow = (o1 ? 1 : 0) + (o2 ? 1 : 0)
            if borrow == 0 && i >= b.limbs.count { break }
        }
        return BigUInt(limbs: r)
    }

    public static func * (a: BigUInt, b: BigUInt) -> BigUInt {
        if a.isZero || b.isZero { return .zero }
        let x = a.limbs, y = b.limbs
        var r = [UInt64](repeating: 0, count: x.count + y.count)
        r.withUnsafeMutableBufferPointer { rp in
            x.withUnsafeBufferPointer { xp in
                y.withUnsafeBufferPointer { yp in
                    for i in 0..<xp.count {
                        let xi = xp[i]
                        if xi == 0 { continue }
                        var carry: UInt64 = 0
                        for j in 0..<yp.count {
                            let (h, l) = xi.multipliedFullWidth(by: yp[j])
                            let (s1, o1) = l.addingReportingOverflow(rp[i + j])
                            let (s2, o2) = s1.addingReportingOverflow(carry)
                            rp[i + j] = s2
                            carry = h &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
                        }
                        rp[i + yp.count] = carry
                    }
                }
            }
        }
        return BigUInt(limbs: r)
    }

    /* ------------------------------------------------------------ shifts */

    public func shiftedLeft(_ n: Int) -> BigUInt {
        if isZero || n == 0 { return self }
        let words = n / 64, bits = UInt64(n % 64)
        var r = [UInt64](repeating: 0, count: limbs.count + words + 1)
        for i in 0..<limbs.count {
            r[i + words] |= bits == 0 ? limbs[i] : limbs[i] << bits
            if bits != 0 { r[i + words + 1] |= limbs[i] >> (64 - bits) }
        }
        return BigUInt(limbs: r)
    }

    public func shiftedRight(_ n: Int) -> BigUInt {
        let words = n / 64, bits = UInt64(n % 64)
        if words >= limbs.count { return .zero }
        var r = [UInt64](repeating: 0, count: limbs.count - words)
        for i in 0..<r.count {
            r[i] = bits == 0 ? limbs[i + words] : limbs[i + words] >> bits
            if bits != 0 && i + words + 1 < limbs.count { r[i] |= limbs[i + words + 1] << (64 - bits) }
        }
        return BigUInt(limbs: r)
    }

    /* ------------------------------------------------------------ division */

    /// (quotient, remainder) — Knuth, TAOCP vol. 2, § 4.3.1, algorithm D.
    public static func divMod(_ u: BigUInt, _ v: BigUInt) -> (quotient: BigUInt, remainder: BigUInt) {
        precondition(!v.isZero, "division by zero")
        if u < v { return (.zero, u) }
        if v.limbs.count == 1 {
            let d = v.limbs[0]
            var q = [UInt64](repeating: 0, count: u.limbs.count)
            var r: UInt64 = 0
            var i = u.limbs.count - 1
            while i >= 0 {
                let (qq, rr) = d.dividingFullWidth((r, u.limbs[i]))
                q[i] = qq; r = rr
                i -= 1
            }
            return (BigUInt(limbs: q), BigUInt(r))
        }
        let n = v.limbs.count, m = u.limbs.count - n
        let s = v.limbs[n - 1].leadingZeroBitCount
        let vn = v.shiftedLeft(s).limbs
        var un = u.shiftedLeft(s).limbs
        while un.count < u.limbs.count + 1 { un.append(0) }
        var q = [UInt64](repeating: 0, count: m + 1)
        let vTop = vn[n - 1], vNext = vn[n - 2]
        var j = m
        while j >= 0 {
            let hi = un[j + n], lo = un[j + n - 1]
            var qhat: UInt64, rhat: UInt64
            var rhatOverflow = false
            if hi >= vTop {
                qhat = UInt64.max
                let (r, o) = lo.addingReportingOverflow(vTop)
                rhat = r; rhatOverflow = o
            } else {
                (qhat, rhat) = vTop.dividingFullWidth((hi, lo))
            }
            while !rhatOverflow {
                let (ph, pl) = qhat.multipliedFullWidth(by: vNext)
                // qhat·v[n−2] > rhat·b + u[j+n−2] ?
                if ph > rhat || (ph == rhat && pl > un[j + n - 2]) {
                    qhat -= 1
                    let (r, o) = rhat.addingReportingOverflow(vTop)
                    rhat = r; rhatOverflow = o
                } else { break }
            }
            // un[j…j+n] −= qhat · vn
            var borrow: UInt64 = 0, carry: UInt64 = 0
            for i in 0..<n {
                let (ph, pl) = qhat.multipliedFullWidth(by: vn[i])
                let (pl2, c1) = pl.addingReportingOverflow(carry)
                carry = ph &+ (c1 ? 1 : 0)
                let (t1, b1) = un[i + j].subtractingReportingOverflow(pl2)
                let (t2, b2) = t1.subtractingReportingOverflow(borrow)
                un[i + j] = t2
                borrow = (b1 ? 1 : 0) + (b2 ? 1 : 0)
            }
            let (t1, b1) = un[j + n].subtractingReportingOverflow(carry)
            let (t2, b2) = t1.subtractingReportingOverflow(borrow)
            un[j + n] = t2
            if b1 || b2 {
                // Subtracted one too many: add v back.
                qhat -= 1
                var c: UInt64 = 0
                for i in 0..<n {
                    let (s1, o1) = un[i + j].addingReportingOverflow(vn[i])
                    let (s2, o2) = s1.addingReportingOverflow(c)
                    un[i + j] = s2
                    c = (o1 ? 1 : 0) + (o2 ? 1 : 0)
                }
                un[j + n] &+= c
            }
            q[j] = qhat
            j -= 1
        }
        let r = BigUInt(limbs: Array(un[0..<n])).shiftedRight(s)
        return (BigUInt(limbs: q), r)
    }

    public static func % (a: BigUInt, m: BigUInt) -> BigUInt { divMod(a, m).remainder }
    public static func / (a: BigUInt, m: BigUInt) -> BigUInt { divMod(a, m).quotient }

    /* ------------------------------------------------------------ modular */

    /// self^e mod m (left-to-right square and multiply).
    public func power(_ e: BigUInt, modulus m: BigUInt) -> BigUInt {
        var r = BigUInt.one % m
        let base = self % m
        var i = e.bitWidth - 1
        while i >= 0 {
            r = (r * r) % m
            if e.testBit(i) { r = (r * base) % m }
            i -= 1
        }
        return r
    }

    /// The inverse modulo a prime `p` (Fermat: a^(p−2)); nil for 0.
    public func inversePrime(_ p: BigUInt) -> BigUInt? {
        let a = self % p
        if a.isZero { return nil }
        return a.power(p - BigUInt(2), modulus: p)
    }
}
