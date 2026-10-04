package cz.m5cet.app.nfc;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Elliptic curves over prime fields (6.6) — the Java port of
 * client/src/lib/nfc/cards/ec.ts: just what PACE's generic mapping needs.
 * Point addition, doubling and scalar multiplication (Jacobian coordinates,
 * one inversion per result), the on-curve check and the uncompressed encoding
 * 04 || X || Y, with {@link BigInteger}. Android's JCA cannot do the generic
 * mapping (it needs s·G + H on an arbitrary generator, and brainpool curves
 * are not everywhere), so this is self-contained.
 *
 * The six standardized PACE curves (ICAO 9303-11 Table 12) are
 * {@link #PACE_CURVES}; their constants are ec.ts's verbatim (generated from
 * OpenSSL's explicit parameters), and k·G on every curve is pinned to
 * node:crypto (PaceTest). A point is {@link Point}; {@code null} is the point
 * at infinity.
 *
 * Not constant-time (BigInteger never is). Acceptable here: every key is an
 * ephemeral one used once, against the holder's own document.
 */
public final class EcCurve {
    /** An affine point. */
    public static final class Point {
        public final BigInteger x, y;
        public Point(BigInteger x, BigInteger y) { this.x = x; this.y = y; }
        @Override public boolean equals(Object o) { return o instanceof Point && ((Point) o).x.equals(x) && ((Point) o).y.equals(y); }
        @Override public int hashCode() { return x.hashCode() * 31 + y.hashCode(); }
        @Override public String toString() { return "(" + x.toString(16) + ", " + y.toString(16) + ")"; }
    }

    public final String name;
    /** The OpenSSL / Node name (createECDH). */
    public final String nodeName;
    /** Field size in bytes — the width of each coordinate. */
    public final int size;
    public final BigInteger p, a, b;
    public final Point G;
    /** Order of G, and the cofactor (1 for every PACE curve). */
    public final BigInteger n, h;

    private EcCurve(String name, String nodeName, int size, String p, String a, String b, String gx, String gy, String n, int h) {
        this.name = name; this.nodeName = nodeName; this.size = size;
        this.p = big(p); this.a = big(a); this.b = big(b);
        this.G = new Point(big(gx), big(gy));
        this.n = big(n); this.h = BigInteger.valueOf(h);
    }

    private static BigInteger big(String hex) { return new BigInteger(hex, 16); }

    private static final BigInteger TWO = BigInteger.valueOf(2), THREE = BigInteger.valueOf(3),
        FOUR = BigInteger.valueOf(4), EIGHT = BigInteger.valueOf(8);

    /* ------------------------------------------------------------ bytes */

    /** Big-endian unsigned. */
    public static BigInteger bytesToBigInt(byte[] b) { return new BigInteger(1, b); }

    /** Big-endian, left-padded to {@code size} bytes. */
    public static byte[] bigIntToBytes(BigInteger v, int size) {
        if (v.signum() < 0 || v.bitLength() > 8 * size) throw new IllegalArgumentException("integer does not fit");
        byte[] raw = v.toByteArray(); // may carry a leading sign byte
        byte[] out = new byte[size];
        int copy = Math.min(raw.length, size);
        System.arraycopy(raw, raw.length - copy, out, size - copy, copy);
        return out;
    }

    /* ------------------------------------------------------------ arithmetic */

    // Jacobian (X, Y, Z) stands for (X/Z², Y/Z³); Z = 0 is the point at infinity.
    private static final class Jac {
        final BigInteger X, Y, Z;
        Jac(BigInteger X, BigInteger Y, BigInteger Z) { this.X = X; this.Y = Y; this.Z = Z; }
        boolean inf() { return Z.signum() == 0; }
    }

    private static final Jac INF = new Jac(BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO);

    private Jac jDouble(Jac P) {
        if (P.inf() || P.Y.signum() == 0) return INF;
        BigInteger XX = P.X.multiply(P.X).mod(p), YY = P.Y.multiply(P.Y).mod(p), YYYY = YY.multiply(YY).mod(p), ZZ = P.Z.multiply(P.Z).mod(p);
        BigInteger S = FOUR.multiply(P.X).multiply(YY).mod(p);
        BigInteger M = THREE.multiply(XX).add(a.multiply(ZZ.multiply(ZZ).mod(p))).mod(p); // general a: brainpool curves are not a = −3
        BigInteger X3 = M.multiply(M).subtract(TWO.multiply(S)).mod(p);
        BigInteger Y3 = M.multiply(S.subtract(X3)).subtract(EIGHT.multiply(YYYY)).mod(p);
        BigInteger Z3 = TWO.multiply(P.Y).multiply(P.Z).mod(p);
        return new Jac(X3, Y3, Z3);
    }

    private Jac jAdd(Jac P, Jac Q) {
        if (P.inf()) return Q;
        if (Q.inf()) return P;
        BigInteger Z1Z1 = P.Z.multiply(P.Z).mod(p), Z2Z2 = Q.Z.multiply(Q.Z).mod(p);
        BigInteger U1 = P.X.multiply(Z2Z2).mod(p), U2 = Q.X.multiply(Z1Z1).mod(p);
        BigInteger S1 = P.Y.multiply(Q.Z).mod(p).multiply(Z2Z2).mod(p), S2 = Q.Y.multiply(P.Z).mod(p).multiply(Z1Z1).mod(p);
        BigInteger H = U2.subtract(U1).mod(p), r = S2.subtract(S1).mod(p);
        if (H.signum() == 0) return r.signum() == 0 ? jDouble(P) : INF; // P = Q, or P = −Q
        BigInteger HH = H.multiply(H).mod(p), HHH = H.multiply(HH).mod(p), V = U1.multiply(HH).mod(p);
        BigInteger X3 = r.multiply(r).subtract(HHH).subtract(TWO.multiply(V)).mod(p);
        BigInteger Y3 = r.multiply(V.subtract(X3)).subtract(S1.multiply(HHH)).mod(p);
        BigInteger Z3 = P.Z.multiply(Q.Z).mod(p).multiply(H).mod(p);
        return new Jac(X3, Y3, Z3);
    }

    private static Jac toJac(Point P) { return P == null ? INF : new Jac(P.x, P.y, BigInteger.ONE); }

    private Point toAffine(Jac P) {
        if (P.inf()) return null;
        BigInteger zi = P.Z.modInverse(p), zi2 = zi.multiply(zi).mod(p);
        return new Point(P.X.multiply(zi2).mod(p), P.Y.multiply(zi2).mod(p).multiply(zi).mod(p));
    }

    /** P + Q (null is the point at infinity). */
    public Point add(Point P, Point Q) { return toAffine(jAdd(toJac(P), toJac(Q))); }

    /** k·G. */
    public Point mul(BigInteger k) { return mul(k, G); }

    /** k·P by double-and-add from the top bit; null when the result is the point at infinity. */
    public Point mul(BigInteger k, Point P) {
        if (k.signum() < 0) throw new IllegalArgumentException("negative scalar");
        Jac base = toJac(P), R = INF;
        for (int i = k.bitLength() - 1; i >= 0; i--) {
            R = jDouble(R);
            if (k.testBit(i)) R = jAdd(R, base);
        }
        return toAffine(R);
    }

    /** Whether P is a point of the curve: both coordinates in [0, p) and y² = x³ + ax + b. */
    public boolean onCurve(Point P) {
        if (P.x.signum() < 0 || P.x.compareTo(p) >= 0 || P.y.signum() < 0 || P.y.compareTo(p) >= 0) return false;
        BigInteger lhs = P.y.multiply(P.y);
        BigInteger rhs = P.x.multiply(P.x).multiply(P.x).add(a.multiply(P.x)).add(b);
        return lhs.subtract(rhs).mod(p).signum() == 0;
    }

    /** Uncompressed point encoding 04 || X || Y, each coordinate {@link #size} bytes. */
    public byte[] encode(Point P) {
        byte[] out = new byte[1 + 2 * size];
        out[0] = 0x04;
        System.arraycopy(bigIntToBytes(P.x, size), 0, out, 1, size);
        System.arraycopy(bigIntToBytes(P.y, size), 0, out, 1 + size, size);
        return out;
    }

    /** Decodes an uncompressed point; null when malformed or not on the curve. */
    public Point decode(byte[] bytes) {
        if (bytes == null || bytes.length != 1 + 2 * size || bytes[0] != 0x04) return null;
        Point P = new Point(bytesToBigInt(Apdu.slice(bytes, 1, 1 + size)), bytesToBigInt(Apdu.slice(bytes, 1 + size)));
        return onCurve(P) ? P : null;
    }

    /** A uniformly random private key in [1, n − 1]. */
    public BigInteger randomScalar(SecureRandom rng) {
        byte[] bytes = new byte[size + 8]; // 64 extra bits make the reduction bias negligible
        rng.nextBytes(bytes);
        return bytesToBigInt(bytes).mod(n.subtract(BigInteger.ONE)).add(BigInteger.ONE);
    }

    @Override public String toString() { return name; }

    /* ------------------------------------------------------------ the PACE curves */

    /** Standardized domain parameters by PACE parameter id (ICAO 9303-11 Table 12) — the ones this reader runs. */
    public static final Map<Integer, EcCurve> PACE_CURVES;

    static {
        Map<Integer, EcCurve> m = new LinkedHashMap<>();
        m.put(12, new EcCurve("NIST P-256", "prime256v1", 32,
            "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF",
            "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC",
            "5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B",
            "6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296",
            "4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5",
            "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 1));
        m.put(13, new EcCurve("brainpoolP256r1", "brainpoolP256r1", 32,
            "A9FB57DBA1EEA9BC3E660A909D838D726E3BF623D52620282013481D1F6E5377",
            "7D5A0975FC2C3057EEF67530417AFFE7FB8055C126DC5C6CE94A4B44F330B5D9",
            "26DC5C6CE94A4B44F330B5D9BBD77CBF958416295CF7E1CE6BCCDC18FF8C07B6",
            "8BD2AEB9CB7E57CB2C4B482FFC81B7AFB9DE27E1E3BD23C23A4453BD9ACE3262",
            "547EF835C3DAC4FD97F8461A14611DC9C27745132DED8E545C1D54C72F046997",
            "A9FB57DBA1EEA9BC3E660A909D838D718C397AA3B561A6F7901E0E82974856A7", 1));
        m.put(15, new EcCurve("NIST P-384", "secp384r1", 48,
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFF",
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFC",
            "B3312FA7E23EE7E4988E056BE3F82D19181D9C6EFE8141120314088F5013875AC656398D8A2ED19D2A85C8EDD3EC2AEF",
            "AA87CA22BE8B05378EB1C71EF320AD746E1D3B628BA79B9859F741E082542A385502F25DBF55296C3A545E3872760AB7",
            "3617DE4A96262C6F5D9E98BF9292DC29F8F41DBD289A147CE9DA3113B5F0B8C00A60B1CE1D7E819D7A431D7C90EA0E5F",
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973", 1));
        m.put(16, new EcCurve("brainpoolP384r1", "brainpoolP384r1", 48,
            "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B412B1DA197FB71123ACD3A729901D1A71874700133107EC53",
            "7BC382C63D8C150C3C72080ACE05AFA0C2BEA28E4FB22787139165EFBA91F90F8AA5814A503AD4EB04A8C7DD22CE2826",
            "4A8C7DD22CE28268B39B55416F0447C2FB77DE107DCD2A62E880EA53EEB62D57CB4390295DBC9943AB78696FA504C11",
            "1D1C64F068CF45FFA2A63A81B7C13F6B8847A3E77EF14FE3DB7FCAFE0CBD10E8E826E03436D646AAEF87B2E247D4AF1E",
            "8ABE1D7520F9C2A45CB1EB8E95CFD55262B70B29FEEC5864E19C054FF99129280E4646217791811142820341263C5315",
            "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B31F166E6CAC0425A7CF3AB6AF6B7FC3103B883202E9046565", 1));
        m.put(17, new EcCurve("brainpoolP512r1", "brainpoolP512r1", 64,
            "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA703308717D4D9B009BC66842AECDA12AE6A380E62881FF2F2D82C68528AA6056583A48F3",
            "7830A3318B603B89E2327145AC234CC594CBDD8D3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CA",
            "3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CADC083E67984050B75EBAE5DD2809BD638016F723",
            "81AEE4BDD82ED9645A21322E9C4C6A9385ED9F70B5D916C1B43B62EEF4D0098EFF3B1F78E2D0D48D50D1687B93B97D5F7C6D5047406A5E688B352209BCB9F822",
            "7DDE385D566332ECC0EABFA9CF7822FDF209F70024A57B1AA000C55B881F8111B2DCDE494A5F485E5BCA4BD88A2763AED1CA2B2FA8F0540678CD1E0F3AD80892",
            "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA70330870553E5C414CA92619418661197FAC10471DB1D381085DDADDB58796829CA90069", 1));
        m.put(18, new EcCurve("NIST P-521", "secp521r1", 66,
            "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC",
            "51953EB9618E1C9A1F929A21A0B68540EEA2DA725B99B315F3B8B489918EF109E156193951EC7E937B1652C0BD3BB1BF073573DF883D2C34F1EF451FD46B503F00",
            "C6858E06B70404E9CD9E3ECB662395B4429C648139053FB521F828AF606B4D3DBAA14B5E77EFE75928FE1DC127A2FFA8DE3348B3C1856A429BF97E7E31C2E5BD66",
            "11839296A789A3BC0045C8A5FB42C7D1BD998F54449579B446817AFBD17273E662C97EE72995EF42640C550B9013FAD0761353C7086A272C24088BE94769FD16650",
            "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA51868783BF2F966B7FCC0148F709A5D03BB5C9B8899C47AEBB6FB71E91386409", 1));
        PACE_CURVES = Collections.unmodifiableMap(m);
    }

    /** The curve for a PACE parameter id, or null when this reader does not run it. */
    public static EcCurve forParameterId(Integer id) { return id == null ? null : PACE_CURVES.get(id); }
}
