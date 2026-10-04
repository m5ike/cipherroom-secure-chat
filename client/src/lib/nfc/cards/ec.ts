// Elliptic curves over prime fields (6.6) — just what PACE's generic mapping
// needs: point addition, doubling and scalar multiplication (Jacobian
// coordinates, one inversion per result), the on-curve check and the
// uncompressed encoding 04 || X || Y, all with BigInt. The six standardized
// PACE curves (ICAO 9303-11 Table 12) follow; their constants were generated
// from OpenSSL's explicit parameters (`openssl ecparam -name … -param_enc
// explicit`), and k·G on every curve is cross-checked against node:crypto in
// test/nfc-pace.test.ts.
//
// Not constant-time (BigInt never is). Acceptable here: every key is an
// ephemeral one used once, against the holder's own document.

export type Point = { x: bigint; y: bigint };

export type Curve = {
  name: string;
  /** The OpenSSL / Node name (createECDH). */
  nodeName: string;
  /** Field size in bytes — the width of each coordinate. */
  size: number;
  p: bigint; a: bigint; b: bigint;
  G: Point;
  /** Order of G, and the cofactor (1 for every PACE curve). */
  n: bigint; h: bigint;
};

const mod = (v: bigint, m: bigint): bigint => { const r = v % m; return r < 0n ? r + m : r; };

/** Modular inverse by the extended Euclidean algorithm. */
export function modInverse(v: bigint, m: bigint): bigint {
  let r0 = mod(v, m), r1 = m, s0 = 1n, s1 = 0n;
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error("not invertible");
  return mod(s0, m);
}

export function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** Big-endian, left-padded to `size` bytes. */
export function bigIntToBytes(n: bigint, size: number): Uint8Array {
  if (n < 0n || n >> BigInt(8 * size) !== 0n) throw new Error("integer does not fit");
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/* ------------------------------------------------------------ arithmetic */

// Jacobian (X, Y, Z) stands for (X/Z², Y/Z³); Z = 0 is the point at infinity.
type Jac = { X: bigint; Y: bigint; Z: bigint };
const INF: Jac = { X: 1n, Y: 1n, Z: 0n };

function jDouble(c: Curve, P: Jac): Jac {
  if (P.Z === 0n || P.Y === 0n) return INF;
  const p = c.p;
  const XX = (P.X * P.X) % p, YY = (P.Y * P.Y) % p, YYYY = (YY * YY) % p, ZZ = (P.Z * P.Z) % p;
  const S = (4n * P.X * YY) % p;
  const M = (3n * XX + c.a * ((ZZ * ZZ) % p)) % p; // general a: brainpool curves are not a = −3
  const X3 = mod(M * M - 2n * S, p);
  const Y3 = mod(M * (S - X3) - 8n * YYYY, p);
  const Z3 = (2n * P.Y * P.Z) % p;
  return { X: X3, Y: Y3, Z: Z3 };
}

function jAdd(c: Curve, P: Jac, Q: Jac): Jac {
  if (P.Z === 0n) return Q;
  if (Q.Z === 0n) return P;
  const p = c.p;
  const Z1Z1 = (P.Z * P.Z) % p, Z2Z2 = (Q.Z * Q.Z) % p;
  const U1 = (P.X * Z2Z2) % p, U2 = (Q.X * Z1Z1) % p;
  const S1 = (((P.Y * Q.Z) % p) * Z2Z2) % p, S2 = (((Q.Y * P.Z) % p) * Z1Z1) % p;
  const H = mod(U2 - U1, p), r = mod(S2 - S1, p);
  if (H === 0n) return r === 0n ? jDouble(c, P) : INF; // P = Q, or P = −Q
  const HH = (H * H) % p, HHH = (H * HH) % p, V = (U1 * HH) % p;
  const X3 = mod(r * r - HHH - 2n * V, p);
  const Y3 = mod(r * (V - X3) - S1 * HHH, p);
  const Z3 = (((P.Z * Q.Z) % p) * H) % p;
  return { X: X3, Y: Y3, Z: Z3 };
}

const toJac = (P: Point | null): Jac => (P ? { X: P.x, Y: P.y, Z: 1n } : INF);

function toAffine(c: Curve, P: Jac): Point | null {
  if (P.Z === 0n) return null;
  const zi = modInverse(P.Z, c.p), zi2 = (zi * zi) % c.p;
  return { x: (P.X * zi2) % c.p, y: (((P.Y * zi2) % c.p) * zi) % c.p };
}

/** P + Q (null is the point at infinity). */
export function pointAdd(c: Curve, P: Point | null, Q: Point | null): Point | null {
  return toAffine(c, jAdd(c, toJac(P), toJac(Q)));
}

/** k·P (P defaults to the generator) by double-and-add from the top bit. */
export function pointMul(c: Curve, k: bigint, P: Point | null = c.G): Point | null {
  if (k < 0n) throw new Error("negative scalar");
  const base = toJac(P);
  let R = INF;
  for (let i = k.toString(2).length - 1; i >= 0; i--) {
    R = jDouble(c, R);
    if ((k >> BigInt(i)) & 1n) R = jAdd(c, R, base);
  }
  return toAffine(c, R);
}

/** Whether P is a point of the curve: both coordinates in [0, p) and y² = x³ + ax + b. */
export function onCurve(c: Curve, P: Point): boolean {
  const { p, a, b } = c;
  if (P.x < 0n || P.x >= p || P.y < 0n || P.y >= p) return false;
  return mod(P.y * P.y - (P.x * P.x * P.x + a * P.x + b), p) === 0n;
}

/** Uncompressed point encoding 04 || X || Y, each coordinate `size` bytes. */
export function encodePoint(c: Curve, P: Point): Uint8Array {
  const out = new Uint8Array(1 + 2 * c.size);
  out[0] = 0x04;
  out.set(bigIntToBytes(P.x, c.size), 1);
  out.set(bigIntToBytes(P.y, c.size), 1 + c.size);
  return out;
}

/** Decodes an uncompressed point; null when malformed or not on the curve. */
export function decodePoint(c: Curve, bytes: Uint8Array): Point | null {
  if (bytes.length !== 1 + 2 * c.size || bytes[0] !== 0x04) return null;
  const P = { x: bytesToBigInt(bytes.subarray(1, 1 + c.size)), y: bytesToBigInt(bytes.subarray(1 + c.size)) };
  return onCurve(c, P) ? P : null;
}

/** A uniformly random private key in [1, n − 1]. */
export function randomScalar(c: Curve): bigint {
  const bytes = new Uint8Array(c.size + 8); // 64 extra bits make the reduction bias negligible
  crypto.getRandomValues(bytes);
  return (bytesToBigInt(bytes) % (c.n - 1n)) + 1n;
}

/* ------------------------------------------------------------ the PACE curves */

const big = (h: string) => BigInt(`0x${h}`);
function def(name: string, nodeName: string, size: number, p: string, a: string, b: string, gx: string, gy: string, n: string, h: number): Curve {
  return { name, nodeName, size, p: big(p), a: big(a), b: big(b), G: { x: big(gx), y: big(gy) }, n: big(n), h: BigInt(h) };
}

/** Standardized domain parameters by PACE parameter id (ICAO 9303-11 Table 12) — the ones this reader runs. */
export const PACE_CURVES: Record<number, Curve> = {
  12: def("NIST P-256", "prime256v1", 32,
    "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF",
    "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC",
    "5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B",
    "6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296",
    "4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5",
    "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 1),
  13: def("brainpoolP256r1", "brainpoolP256r1", 32,
    "A9FB57DBA1EEA9BC3E660A909D838D726E3BF623D52620282013481D1F6E5377",
    "7D5A0975FC2C3057EEF67530417AFFE7FB8055C126DC5C6CE94A4B44F330B5D9",
    "26DC5C6CE94A4B44F330B5D9BBD77CBF958416295CF7E1CE6BCCDC18FF8C07B6",
    "8BD2AEB9CB7E57CB2C4B482FFC81B7AFB9DE27E1E3BD23C23A4453BD9ACE3262",
    "547EF835C3DAC4FD97F8461A14611DC9C27745132DED8E545C1D54C72F046997",
    "A9FB57DBA1EEA9BC3E660A909D838D718C397AA3B561A6F7901E0E82974856A7", 1),
  15: def("NIST P-384", "secp384r1", 48,
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFF",
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFC",
    "B3312FA7E23EE7E4988E056BE3F82D19181D9C6EFE8141120314088F5013875AC656398D8A2ED19D2A85C8EDD3EC2AEF",
    "AA87CA22BE8B05378EB1C71EF320AD746E1D3B628BA79B9859F741E082542A385502F25DBF55296C3A545E3872760AB7",
    "3617DE4A96262C6F5D9E98BF9292DC29F8F41DBD289A147CE9DA3113B5F0B8C00A60B1CE1D7E819D7A431D7C90EA0E5F",
    "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973", 1),
  16: def("brainpoolP384r1", "brainpoolP384r1", 48,
    "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B412B1DA197FB71123ACD3A729901D1A71874700133107EC53",
    "7BC382C63D8C150C3C72080ACE05AFA0C2BEA28E4FB22787139165EFBA91F90F8AA5814A503AD4EB04A8C7DD22CE2826",
    "4A8C7DD22CE28268B39B55416F0447C2FB77DE107DCD2A62E880EA53EEB62D57CB4390295DBC9943AB78696FA504C11",
    "1D1C64F068CF45FFA2A63A81B7C13F6B8847A3E77EF14FE3DB7FCAFE0CBD10E8E826E03436D646AAEF87B2E247D4AF1E",
    "8ABE1D7520F9C2A45CB1EB8E95CFD55262B70B29FEEC5864E19C054FF99129280E4646217791811142820341263C5315",
    "8CB91E82A3386D280F5D6F7E50E641DF152F7109ED5456B31F166E6CAC0425A7CF3AB6AF6B7FC3103B883202E9046565", 1),
  17: def("brainpoolP512r1", "brainpoolP512r1", 64,
    "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA703308717D4D9B009BC66842AECDA12AE6A380E62881FF2F2D82C68528AA6056583A48F3",
    "7830A3318B603B89E2327145AC234CC594CBDD8D3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CA",
    "3DF91610A83441CAEA9863BC2DED5D5AA8253AA10A2EF1C98B9AC8B57F1117A72BF2C7B9E7C1AC4D77FC94CADC083E67984050B75EBAE5DD2809BD638016F723",
    "81AEE4BDD82ED9645A21322E9C4C6A9385ED9F70B5D916C1B43B62EEF4D0098EFF3B1F78E2D0D48D50D1687B93B97D5F7C6D5047406A5E688B352209BCB9F822",
    "7DDE385D566332ECC0EABFA9CF7822FDF209F70024A57B1AA000C55B881F8111B2DCDE494A5F485E5BCA4BD88A2763AED1CA2B2FA8F0540678CD1E0F3AD80892",
    "AADD9DB8DBE9C48B3FD4E6AE33C9FC07CB308DB3B3C9D20ED6639CCA70330870553E5C414CA92619418661197FAC10471DB1D381085DDADDB58796829CA90069", 1),
  18: def("NIST P-521", "secp521r1", 66,
    "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC",
    "51953EB9618E1C9A1F929A21A0B68540EEA2DA725B99B315F3B8B489918EF109E156193951EC7E937B1652C0BD3BB1BF073573DF883D2C34F1EF451FD46B503F00",
    "C6858E06B70404E9CD9E3ECB662395B4429C648139053FB521F828AF606B4D3DBAA14B5E77EFE75928FE1DC127A2FFA8DE3348B3C1856A429BF97E7E31C2E5BD66",
    "11839296A789A3BC0045C8A5FB42C7D1BD998F54449579B446817AFBD17273E662C97EE72995EF42640C550B9013FAD0761353C7086A272C24088BE94769FD16650",
    "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA51868783BF2F966B7FCC0148F709A5D03BB5C9B8899C47AEBB6FB71E91386409", 1),
};
