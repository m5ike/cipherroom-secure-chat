// The key-transparency Merkle tree on the server (protocol 4, § 14).
//
// The hashing is RFC 9162's, exactly as client/src/lib/p4/merkle.ts has it
// (the code every client verifies with):
//
//   leaf hash = SHA-256(0x00 || leaf)     node hash = SHA-256(0x01 || l || r)
//   MTH({})   = SHA-256("")               MTH(D[n]) = node(MTH(D[0:k]), MTH(D[k:n]))
//
// merkle.ts recomputes subtrees from the leaf hashes on every call (fine for a
// client checking one proof, not for a server answering many over 10^5
// leaves). Here every COMPLETE subtree (2^k leaves starting at a multiple of
// 2^k) is hashed once, when its last leaf arrives, and kept: the RFC's
// recursion only ever splits a range into such a complete left part and a
// smaller right part, so a root, an audit path or a consistency proof costs
// O(log n) cached lookups and at most O(log² n) fresh hashes. Roots are also
// memoized per size. Synchronous (node:crypto), so a proof is computed against
// one size without the log moving underneath it.
//
// test/kt-612.test.ts checks roots and proofs against merkle.ts and verifies
// them with merkle.ts's verifyInclusion / verifyConsistency.

import { createHash } from "node:crypto";

const ZERO = Buffer.from([0x00]);
const ONE = Buffer.from([0x01]);

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 9162 leaf hash of one log entry's exact bytes (the UTF-8 of a canonical JSON text). */
export function leafHashOf(data: Uint8Array | string): Buffer {
  return sha256(ZERO, typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

export function nodeHashOf(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(ONE, left, right);
}

const EMPTY_ROOT = sha256();

/** Largest power of two strictly smaller than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
const log2 = (n: number) => 31 - Math.clz32(n);

/** How many per-size roots are remembered (the newest sizes are what clients ask for). */
const ROOT_MEMO = 256;

export class MerkleTree {
  /** levels[k][i]: the hash of the complete subtree of 2^k leaves starting at leaf i·2^k. */
  private readonly levels: Buffer[][] = [[]];
  private readonly roots = new Map<number, Buffer>();

  get size(): number {
    return this.levels[0].length;
  }

  /** The leaf hash at `index`. */
  leaf(index: number): Buffer {
    const h = this.levels[0][index];
    if (!h) throw new RangeError("leaf index outside the tree");
    return h;
  }

  /** Appends one leaf hash; completes every subtree it closes. */
  push(leafHash: Buffer): void {
    if (leafHash.length !== 32) throw new RangeError("a leaf hash is 32 bytes");
    this.levels[0].push(leafHash);
    let k = 0;
    let index = this.levels[0].length - 1;
    while (index % 2 === 1) {
      const level = this.levels[k];
      const parent = nodeHashOf(level[index - 1], level[index]);
      k += 1;
      (this.levels[k] ??= []).push(parent);
      index = (index - 1) / 2;
    }
  }

  /** MTH over leaves [from, to). Every range the RFC's recursion reaches has a complete, cached left part. */
  private range(from: number, to: number): Buffer {
    const n = to - from;
    if (n === 0) return EMPTY_ROOT;
    if (isPowerOfTwo(n) && from % n === 0) {
      const cached = this.levels[log2(n)]?.[from / n];
      if (cached) return cached;
    }
    if (n === 1) return this.levels[0][from];
    const k = split(n);
    return nodeHashOf(this.range(from, from + k), this.range(from + k, to));
  }

  private check(size: number): void {
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= this.size)) throw new RangeError("tree size outside the log");
  }

  /** The root of the tree of the first `size` leaves. */
  root(size = this.size): Buffer {
    this.check(size);
    let r = this.roots.get(size);
    if (!r) {
      r = this.range(0, size);
      this.roots.set(size, r);
      if (this.roots.size > ROOT_MEMO) this.roots.delete(this.roots.keys().next().value!);
    }
    return r;
  }

  /** The audit path of leaf `index` in the tree of the first `size` leaves (RFC 9162 § 2.1.3.1), leaf upwards. */
  inclusion(index: number, size = this.size): Buffer[] {
    this.check(size);
    if (!(Number.isSafeInteger(index) && index >= 0 && index < size)) throw new RangeError("leaf index outside the tree");
    const out: Buffer[] = [];
    const path = (m: number, from: number, to: number): void => {
      const n = to - from;
      if (n <= 1) return;
      const k = split(n);
      if (m < k) {
        path(m, from, from + k);
        out.push(this.range(from + k, to));
      } else {
        path(m - k, from + k, to);
        out.push(this.range(from, from + k));
      }
    };
    path(index, 0, size);
    return out;
  }

  /** The proof that the tree of `first` leaves is a prefix of the tree of `second` (RFC 9162 § 2.1.4.1). */
  consistency(first: number, second = this.size): Buffer[] {
    this.check(second);
    if (!(Number.isSafeInteger(first) && first >= 0 && first <= second)) throw new RangeError("tree sizes out of order");
    if (first === 0 || first === second) return [];
    const out: Buffer[] = [];
    const sub = (m: number, from: number, to: number, whole: boolean): void => {
      const n = to - from;
      if (m === n) {
        if (!whole) out.push(this.range(from, to));
        return;
      }
      const k = split(n);
      if (m <= k) {
        sub(m, from, from + k, whole);
        out.push(this.range(from + k, to));
      } else {
        sub(m - k, from + k, to, false);
        out.push(this.range(from, from + k));
      }
    };
    sub(first, 0, second, true);
    return out;
  }
}
