// Elliptic curves over prime fields (6.6) — A/nfc/EcCurve.java (ec.ts): just
// what PACE's generic mapping needs. Point addition, doubling and scalar
// multiplication (Jacobian coordinates, one inversion per result), the
// on-curve check and the uncompressed encoding 04 ‖ X ‖ Y. CryptoKit cannot do
// the generic mapping (s·G + H on an arbitrary generator, and it has no
// brainpool curves), so this is self-contained.
//
// The six standardized PACE curves (ICAO 9303-11 Table 12) are `paceCurves`;
// their constants are ec.ts's verbatim, and k·G on every curve is pinned to
// node:crypto (PaceTests). `nil` is the point at infinity.

import Foundation

public final class EcCurve: Sendable, CustomStringConvertible {
    /// An affine point.
    public struct Point: Sendable, Hashable, CustomStringConvertible {
        public let x: BigUInt, y: BigUInt
        public init(x: BigUInt, y: BigUInt) { self.x = x; self.y = y }
        public var description: String { "(\(x.hex), \(y.hex))" }
    }

    public let name: String
    /// The OpenSSL / Node name (createECDH).
    public let nodeName: String
    /// Field size in bytes — the width of each coordinate.
    public let size: Int
    public let p: BigUInt, a: BigUInt, b: BigUInt
    public let G: Point
    /// The order of G, and the cofactor (1 for every PACE curve).
    public let n: BigUInt, h: BigUInt

    init(_ name: String, _ nodeName: String, _ size: Int, p: String, a: String, b: String, gx: String, gy: String, n: String, h: UInt64) {
        self.name = name; self.nodeName = nodeName; self.size = size
        self.p = BigUInt(hex: p)!; self.a = BigUInt(hex: a)!; self.b = BigUInt(hex: b)!
        self.G = Point(x: BigUInt(hex: gx)!, y: BigUInt(hex: gy)!)
        self.n = BigUInt(hex: n)!; self.h = BigUInt(h)
    }

    public var description: String { name }

    /* ------------------------------------------------------------ field */

    @inline(__always) func mulMod(_ x: BigUInt, _ y: BigUInt) -> BigUInt { (x * y) % p }
    @inline(__always) func addMod(_ x: BigUInt, _ y: BigUInt) -> BigUInt { let s = x + y; return s >= p ? s - p : s }
    @inline(__always) func subMod(_ x: BigUInt, _ y: BigUInt) -> BigUInt { x >= y ? x - y : p - (y - x) }

    /* ------------------------------------------------------------ arithmetic */

    // Jacobian (X, Y, Z) stands for (X/Z², Y/Z³); Z = 0 is the point at infinity.
    struct Jac { var X: BigUInt, Y: BigUInt, Z: BigUInt; var inf: Bool { Z.isZero } }
    static let infinity = Jac(X: .one, Y: .one, Z: .zero)

    func jDouble(_ P: Jac) -> Jac {
        if P.inf || P.Y.isZero { return EcCurve.infinity }
        let XX = mulMod(P.X, P.X), YY = mulMod(P.Y, P.Y), YYYY = mulMod(YY, YY), ZZ = mulMod(P.Z, P.Z)
        let XYY = mulMod(P.X, YY)
        let S = addMod(addMod(XYY, XYY), addMod(XYY, XYY))                          // 4·X·YY
        let M = addMod(addMod(addMod(XX, XX), XX), mulMod(a, mulMod(ZZ, ZZ)))     // 3·XX + a·ZZ² (brainpool: a ≠ −3)
        let X3 = subMod(mulMod(M, M), addMod(S, S))
        let Y2 = addMod(YYYY, YYYY), Y4 = addMod(Y2, Y2), Y8 = addMod(Y4, Y4)                // 8·YYYY
        let Y3 = subMod(mulMod(M, subMod(S, X3)), Y8)
        let YZ = mulMod(P.Y, P.Z)
        let Z3 = addMod(YZ, YZ)
        return Jac(X: X3, Y: Y3, Z: Z3)
    }

    func jAdd(_ P: Jac, _ Q: Jac) -> Jac {
        if P.inf { return Q }
        if Q.inf { return P }
        let Z1Z1 = mulMod(P.Z, P.Z), Z2Z2 = mulMod(Q.Z, Q.Z)
        let U1 = mulMod(P.X, Z2Z2), U2 = mulMod(Q.X, Z1Z1)
        let S1 = mulMod(mulMod(P.Y, Q.Z), Z2Z2), S2 = mulMod(mulMod(Q.Y, P.Z), Z1Z1)
        let H = subMod(U2, U1), r = subMod(S2, S1)
        if H.isZero { return r.isZero ? jDouble(P) : EcCurve.infinity } // P = Q, or P = −Q
        let HH = mulMod(H, H), HHH = mulMod(H, HH), V = mulMod(U1, HH)
        let X3 = subMod(subMod(mulMod(r, r), HHH), addMod(V, V))
        let Y3 = subMod(mulMod(r, subMod(V, X3)), mulMod(S1, HHH))
        let Z3 = mulMod(mulMod(P.Z, Q.Z), H)
        return Jac(X: X3, Y: Y3, Z: Z3)
    }

    func toJac(_ P: Point?) -> Jac { P.map { Jac(X: $0.x, Y: $0.y, Z: .one) } ?? EcCurve.infinity }

    func toAffine(_ P: Jac) -> Point? {
        if P.inf { return nil }
        guard let zi = P.Z.inversePrime(p) else { return nil }
        let zi2 = mulMod(zi, zi)
        return Point(x: mulMod(P.X, zi2), y: mulMod(mulMod(P.Y, zi2), zi))
    }

    /// P + Q (nil is the point at infinity).
    public func add(_ P: Point?, _ Q: Point?) -> Point? { toAffine(jAdd(toJac(P), toJac(Q))) }

    /// k·G.
    public func mul(_ k: BigUInt) -> Point? { mul(k, G) }

    /// k·P by double-and-add from the top bit; nil when the result is the point at infinity.
    public func mul(_ k: BigUInt, _ P: Point?) -> Point? {
        let base = toJac(P)
        var R = EcCurve.infinity
        var i = k.bitWidth - 1
        while i >= 0 {
            R = jDouble(R)
            if k.testBit(i) { R = jAdd(R, base) }
            i -= 1
        }
        return toAffine(R)
    }

    /// Whether P is a point of the curve: both coordinates in [0, p) and y² = x³ + ax + b.
    public func onCurve(_ P: Point) -> Bool {
        if P.x >= p || P.y >= p { return false }
        let lhs = mulMod(P.y, P.y)
        let rhs = addMod(addMod(mulMod(mulMod(P.x, P.x), P.x), mulMod(a, P.x)), b % p)
        return lhs == rhs
    }

    /// Uncompressed point encoding 04 ‖ X ‖ Y, each coordinate `size` bytes.
    public func encode(_ P: Point) -> [UInt8] {
        [0x04] + ((try? P.x.bytes(size: size)) ?? []) + ((try? P.y.bytes(size: size)) ?? [])
    }

    /// Decodes an uncompressed point; nil when malformed or not on the curve.
    public func decode(_ bytes: [UInt8]?) -> Point? {
        guard let bytes, bytes.count == 1 + 2 * size, bytes[0] == 0x04 else { return nil }
        let P = Point(x: BigUInt(bytes: Array(bytes[1..<(1 + size)])), y: BigUInt(bytes: Array(bytes[(1 + size)...])))
        return onCurve(P) ? P : nil
    }

    /// A uniformly random private key in [1, n − 1] (64 extra random bits make the reduction bias negligible).
    public func randomScalar() -> BigUInt {
        BigUInt(bytes: NfcCrypto.random(size + 8)) % (n - .one) + .one
    }

    /* ------------------------------------------------------------ the PACE curves */

    /// Standardized domain parameters by PACE parameter id (ICAO 9303-11 Table 12) — the ones this reader runs.
    public static let paceCurveIds: [Int] = [12, 13, 15, 16, 17, 18]

    public static let paceCurves: [Int: EcCurve] = [
        12: EcCurve("NIST P-256", "prime256v1", 32,
            p: "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF",
            a: "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC",
            b: "5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B",
            gx: "6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296",
            gy: "4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5",
            n: "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", h: 1),
        13: EcCurve("brainpoolP256r1", "brainpoolP256r1", 32,
            p: "A9FB57DBA1EEA9BC3E660A909D838D726E3BF623D52620282013481D1F6E5377",
            a: "7D5A0975FC2C3057EEF67530417AFFE7FB8055C126DC5C6CE94A4B44F330B5D9",
            b: "26DC5C6CE94A4B44F330B5D9BBD77CBF958416295CF7E1CE6BCCDC18FF8C07B6",
            gx: "8BD2AEB9CB7E57CB2C4B482FFC81B7AFB9DE27E1E3BD23C23A4453BD9ACE3262",
            gy: "547EF835C3DAC4FD97F8461A14611DC9C27745132DED8E545C1D54C72F046997",
            n: "A9FB57DBA1EEA9BC3E660A909D838D718C397AA3B561A6F7901E0E82974856A7", h: 1),
        15: EcCurve("NIST P-384", "secp384r1", 48,
            p: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFF",
            a: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFC",
            b: "B3312FA7E23EE7E4988E056BE3F82D19181D9C6EFE8141120314088F5013875AC656398D8A2ED19D2A85C8EDD3EC2AEF",
            gx: "AA87CA22BE8B05378EB1C71EF320AD746E1D3B628BA79B9859F741E082542A385502F25DBF55296C3A545E3872760AB7",
            gy: "3617DE4A96262C6F5D9E98BF9292DC29F8F41DBD289A147CE9DA3113B5F0B8C00A60B1CE1D7E819D7A431D7C90EA0E5F",
            n: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973", h: 1),
        16: EcCurve("brainpoolP384r1", "brainpoolP384r1", 48,
            p: "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B412B1DA197FB71123ACD3A729901D1A71874700133107EC53",
            a: "7BC382C63D8C150C3C72080ACE05AFA0C2BEA28E4FB22787139165EFBA91F90F8AA5814A503AD4EB04A8C7DD22CE2826",
            b: "4A8C7DD22CE28268B39B55416F0447C2FB77DE107DCD2A62E880EA53EEB62D57CB4390295DBC9943AB78696FA504C11",
            gx: "1D1C64F068CF45FFA2A63A81B7C13F6B8847A3E77EF14FE3DB7FCAFE0CBD10E8E826E03436D646AAEF87B2E247D4AF1E",
            gy: "8ABE1D7520F9C2A45CB1EB8E95CFD55262B70B29FEEC5864E19C054FF99129280E4646217791811142820341263C5315",
            n: "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B31F166E6CAC0425A7CF3AB6AF6B7FC3103B883202E9046565", h: 1),
        17: EcCurve("brainpoolP512r1", "brainpoolP512r1", 64,
            p: "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA703308717D4D9B009BC66842AECDA12AE6A380E62881FF2F2D82C68528AA6056583A48F3",
            a: "7830A3318B603B89E2327145AC234CC594CBDD8D3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CA",
            b: "3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CADC083E67984050B75EBAE5DD2809BD638016F723",
            gx: "81AEE4BDD82ED9645A21322E9C4C6A9385ED9F70B5D916C1B43B62EEF4D0098EFF3B1F78E2D0D48D50D1687B93B97D5F7C6D5047406A5E688B352209BCB9F822",
            gy: "7DDE385D566332ECC0EABFA9CF7822FDF209F70024A57B1AA000C55B881F8111B2DCDE494A5F485E5BCA4BD88A2763AED1CA2B2FA8F0540678CD1E0F3AD80892",
            n: "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA70330870553E5C414CA92619418661197FAC10471DB1D381085DDADDB58796829CA90069", h: 1),
        18: EcCurve("NIST P-521", "secp521r1", 66,
            p: "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            a: "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC",
            b: "51953EB9618E1C9A1F929A21A0B68540EEA2DA725B99B315F3B8B489918EF109E156193951EC7E937B1652C0BD3BB1BF073573DF883D2C34F1EF451FD46B503F00",
            gx: "C6858E06B70404E9CD9E3ECB662395B4429C648139053FB521F828AF606B4D3DBAA14B5E77EFE75928FE1DC127A2FFA8DE3348B3C1856A429BF97E7E31C2E5BD66",
            gy: "11839296A789A3BC0045C8A5FB42C7D1BD998F54449579B446817AFBD17273E662C97EE72995EF42640C550B9013FAD0761353C7086A272C24088BE94769FD16650",
            n: "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA51868783BF2F966B7FCC0148F709A5D03BB5C9B8899C47AEBB6FB71E91386409", h: 1),
    ]

    /// The curve for a PACE parameter id, or nil when this reader does not run it.
    public static func forParameterId(_ id: Int?) -> EcCurve? { id.flatMap { paceCurves[$0] } }
}
