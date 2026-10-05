// Merkle tree of the key transparency log (protocol 4, docs/protocol-v4.md § 14).
//
// RFC 9162 (Certificate Transparency 2.0) hashing, shared by the server that
// keeps the log (server/kt) and the clients that check it (web here, Android
// a Java port):
//
//   leaf hash   = SHA-256(0x00 || leaf bytes)
//   node hash   = SHA-256(0x01 || left || right)
//   MTH({})     = SHA-256("")
//   MTH(D[n])   = node(MTH(D[0:k]), MTH(D[k:n])), k = largest power of 2 < n
//
// Inclusion proofs (§ 2.1.3) and consistency proofs (§ 2.1.4) are built from
// a list of LEAF HASHES and verified with the RFC's algorithms. Pure: only
// SHA-256 from WebCrypto (browsers, Node 24).

export type Hash = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

async function sha256(...parts: Uint8Array[]): Promise<Hash> {
  let len = 0;
  for (const p of parts) len += p.length;
  const all = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

const ZERO = new Uint8Array([0x00]);
const ONE = new Uint8Array([0x01]);

/** The hash of one log entry (its exact bytes; for JSON entries, the UTF-8 of the canonical text). */
export function leafHash(data: Uint8Array | string): Promise<Hash> {
  return sha256(ZERO, typeof data === "string" ? enc.encode(data) : data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Hash> {
  return sha256(ONE, left, right);
}

/** Largest power of two strictly smaller than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** MTH over leaf hashes [from, to). */
export async function treeHash(leaves: readonly Hash[], from = 0, to = leaves.length): Promise<Hash> {
  const n = to - from;
  if (n === 0) return sha256();
  if (n === 1) return leaves[from];
  const k = split(n);
  return nodeHash(await treeHash(leaves, from, from + k), await treeHash(leaves, from + k, to));
}

/** The audit path of leaf `index` in the tree of the first `size` leaves (RFC 6962 § 2.1.1). */
export async function inclusionProof(leaves: readonly Hash[], index: number, size = leaves.length): Promise<Hash[]> {
  if (!(index >= 0 && index < size && size <= leaves.length)) throw new RangeError("leaf index outside the tree");
  const path = async (m: number, from: number, to: number): Promise<Hash[]> => {
    const n = to - from;
    if (n <= 1) return [];
    const k = split(n);
    return m < k
      ? [...(await path(m, from, from + k)), await treeHash(leaves, from + k, to)]
      : [...(await path(m - k, from + k, to)), await treeHash(leaves, from, from + k)];
  };
  return path(index, 0, size);
}

/** The proof that the tree of `first` leaves is a prefix of the tree of `second` (RFC 6962 § 2.1.2). */
export async function consistencyProof(leaves: readonly Hash[], first: number, second = leaves.length): Promise<Hash[]> {
  if (!(first >= 0 && first <= second && second <= leaves.length)) throw new RangeError("tree sizes out of order");
  if (first === 0 || first === second) return [];
  const sub = async (m: number, from: number, to: number, whole: boolean): Promise<Hash[]> => {
    const n = to - from;
    if (m === n) return whole ? [] : [await treeHash(leaves, from, to)];
    const k = split(n);
    return m <= k
      ? [...(await sub(m, from, from + k, whole)), await treeHash(leaves, from + k, to)]
      : [...(await sub(m - k, from + k, to, false)), await treeHash(leaves, from, from + k)];
  };
  return sub(first, 0, second, true);
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** RFC 9162 § 2.1.3.2: does `path` prove leaf `leaf` (its leaf hash) at `index` in the tree with `root`? */
export async function verifyInclusion(leaf: Uint8Array, index: number, size: number, path: readonly Uint8Array[], root: Uint8Array): Promise<boolean> {
  if (!(Number.isSafeInteger(index) && Number.isSafeInteger(size) && index >= 0 && index < size)) return false;
  let fn = index;
  let sn = size - 1;
  let r: Uint8Array = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equal(r, root);
}

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** RFC 9162 § 2.1.4.2: is the tree (first, firstRoot) a prefix of (second, secondRoot)? */
export async function verifyConsistency(first: number, second: number, firstRoot: Uint8Array, secondRoot: Uint8Array, proof: readonly Uint8Array[]): Promise<boolean> {
  if (!(Number.isSafeInteger(first) && Number.isSafeInteger(second) && first >= 0 && first <= second)) return false;
  if (first === second) return proof.length === 0 && equal(firstRoot, secondRoot);
  if (first === 0) return proof.length === 0; // the empty tree is a prefix of every tree
  if (proof.length === 0) return false;
  const path = isPowerOfTwo(first) ? [firstRoot, ...proof] : [...proof];
  let fn = first - 1;
  let sn = second - 1;
  while ((fn & 1) === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr: Uint8Array = path[0];
  let sr: Uint8Array = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equal(fr, firstRoot) && equal(sr, secondRoot);
}
