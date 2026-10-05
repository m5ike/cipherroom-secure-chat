// Keccak-f[1600] and the FIPS 202 functions ML-KEM needs: SHA3-256, SHA3-512,
// SHAKE128 and SHAKE256 (CryptoKit has SHA-3 but no SHAKE). Checked against
// CryptoKit's SHA3 and the FIPS 202 examples in the tests.

import M5Core

struct Keccak {
    private var s = [UInt64](repeating: 0, count: 25)
    private let rate: Int
    private let pad: UInt8
    private var buffer = Bytes()
    private var squeezing = false
    private var out = Bytes()
    private var outAt = 0

    private static let rc: [UInt64] = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
        0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
        0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
        0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    private static let rotations: [UInt64] = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]

    init(rate: Int, pad: UInt8) { self.rate = rate; self.pad = pad }

    static func permute(_ a: inout [UInt64]) {
        a.withUnsafeMutableBufferPointer { st in
            var c = (UInt64(0), UInt64(0), UInt64(0), UInt64(0), UInt64(0))
            var b = [UInt64](repeating: 0, count: 25)
            b.withUnsafeMutableBufferPointer { b in
                for round in 0..<24 {
                    // θ
                    c.0 = st[0] ^ st[5] ^ st[10] ^ st[15] ^ st[20]
                    c.1 = st[1] ^ st[6] ^ st[11] ^ st[16] ^ st[21]
                    c.2 = st[2] ^ st[7] ^ st[12] ^ st[17] ^ st[22]
                    c.3 = st[3] ^ st[8] ^ st[13] ^ st[18] ^ st[23]
                    c.4 = st[4] ^ st[9] ^ st[14] ^ st[19] ^ st[24]
                    let d0 = c.4 ^ (c.1 << 1 | c.1 >> 63)
                    let d1 = c.0 ^ (c.2 << 1 | c.2 >> 63)
                    let d2 = c.1 ^ (c.3 << 1 | c.3 >> 63)
                    let d3 = c.2 ^ (c.4 << 1 | c.4 >> 63)
                    let d4 = c.3 ^ (c.0 << 1 | c.0 >> 63)
                    for y in stride(from: 0, to: 25, by: 5) {
                        st[y] ^= d0; st[y + 1] ^= d1; st[y + 2] ^= d2; st[y + 3] ^= d3; st[y + 4] ^= d4
                    }
                    // ρ and π
                    for x in 0..<5 {
                        for y in 0..<5 {
                            let i = x + 5 * y
                            let r = rotations[i]
                            let v = st[i]
                            b[y + 5 * ((2 * x + 3 * y) % 5)] = r == 0 ? v : (v << r | v >> (64 - r))
                        }
                    }
                    // χ
                    for y in stride(from: 0, to: 25, by: 5) {
                        let b0 = b[y], b1 = b[y + 1], b2 = b[y + 2], b3 = b[y + 3], b4 = b[y + 4]
                        st[y] = b0 ^ (~b1 & b2)
                        st[y + 1] = b1 ^ (~b2 & b3)
                        st[y + 2] = b2 ^ (~b3 & b4)
                        st[y + 3] = b3 ^ (~b4 & b0)
                        st[y + 4] = b4 ^ (~b0 & b1)
                    }
                    // ι
                    st[0] ^= rc[round]
                }
            }
        }
    }

    private mutating func absorbBlock(_ block: ArraySlice<UInt8>) {
        var i = block.startIndex
        for lane in 0..<(rate / 8) {
            var v: UInt64 = 0
            for k in 0..<8 { v |= UInt64(block[i + k]) << (8 * UInt64(k)) }
            s[lane] ^= v
            i += 8
        }
        Keccak.permute(&s)
    }

    mutating func absorb(_ data: Bytes) {
        precondition(!squeezing)
        buffer.append(contentsOf: data)
        var at = 0
        while buffer.count - at >= rate {
            absorbBlock(buffer[at..<at + rate])
            at += rate
        }
        if at > 0 { buffer.removeFirst(at) }
    }

    private mutating func finish() {
        var block = buffer
        block.append(pad)
        while block.count < rate { block.append(0) }
        block[rate - 1] |= 0x80
        absorbBlock(block[0..<rate])
        buffer.removeAll()
        squeezing = true
        fillOut()
    }

    private mutating func fillOut() {
        out = Bytes(repeating: 0, count: rate)
        for lane in 0..<(rate / 8) {
            let v = s[lane]
            for k in 0..<8 { out[lane * 8 + k] = UInt8(truncatingIfNeeded: v >> (8 * UInt64(k))) }
        }
        outAt = 0
    }

    mutating func squeeze(_ n: Int) -> Bytes {
        if !squeezing { finish() }
        var result = Bytes()
        result.reserveCapacity(n)
        while result.count < n {
            if outAt == rate { Keccak.permute(&s); fillOut() }
            let take = min(n - result.count, rate - outAt)
            result.append(contentsOf: out[outAt..<outAt + take])
            outAt += take
        }
        return result
    }

    static func sha3_256(_ data: Bytes) -> Bytes { var k = Keccak(rate: 136, pad: 0x06); k.absorb(data); return k.squeeze(32) }
    static func sha3_512(_ data: Bytes) -> Bytes { var k = Keccak(rate: 72, pad: 0x06); k.absorb(data); return k.squeeze(64) }
    static func shake128(_ data: Bytes, _ n: Int) -> Bytes { var k = Keccak(rate: 168, pad: 0x1f); k.absorb(data); return k.squeeze(n) }
    static func shake256(_ data: Bytes, _ n: Int) -> Bytes { var k = Keccak(rate: 136, pad: 0x1f); k.absorb(data); return k.squeeze(n) }
    static func shake128XOF(_ data: Bytes) -> Keccak { var k = Keccak(rate: 168, pad: 0x1f); k.absorb(data); return k }
}

/// FIPS 202 functions (public for tests and other ports).
public enum SHA3 {
    public static func sha256(_ data: Bytes) -> Bytes { Keccak.sha3_256(data) }
    public static func sha512(_ data: Bytes) -> Bytes { Keccak.sha3_512(data) }
    public static func shake128(_ data: Bytes, count: Int) -> Bytes { Keccak.shake128(data, count) }
    public static func shake256(_ data: Bytes, count: Int) -> Bytes { Keccak.shake256(data, count) }
}
