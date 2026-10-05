// The key-transparency Merkle tree (docs/protocol-v4.md § 14; merkle.ts;
// android p4/Merkle.java) — RFC 9162 hashing, shared with the server:
//
//   leaf hash = SHA-256(0x00 ‖ leaf bytes)      node hash = SHA-256(0x01 ‖ left ‖ right)
//   MTH({}) = SHA-256("")                        MTH(D[n]) = node(MTH(D[0:k]), MTH(D[k:n])), k = largest power of 2 < n
//
// Proofs are built from a list of leaf hashes (tests; the server's job) and
// verified with the RFC's algorithms (the client's job).

import M5Core

public enum Merkle {
    /// The hash of one log entry (its exact bytes; for JSON entries the UTF-8 of the canonical text).
    public static func leafHash(_ data: Bytes) -> Bytes { Crypto.sha256([0x00], data) }
    public static func leafHash(_ data: String) -> Bytes { leafHash(Prim.utf8(data)) }
    public static func nodeHash(_ left: Bytes, _ right: Bytes) -> Bytes { Crypto.sha256([0x01], left, right) }

    /// Largest power of two strictly smaller than n (n >= 2).
    private static func split(_ n: Int) -> Int {
        var k = 1
        while k << 1 < n { k <<= 1 }
        return k
    }

    /// MTH over leaf hashes [from, to).
    public static func treeHash(_ leaves: [Bytes], _ from: Int, _ to: Int) -> Bytes {
        let n = to - from
        if n == 0 { return Crypto.sha256([]) }
        if n == 1 { return leaves[from] }
        let k = split(n)
        return nodeHash(treeHash(leaves, from, from + k), treeHash(leaves, from + k, to))
    }

    /// The audit path of leaf `index` in the tree of the first `size` leaves (RFC 6962 § 2.1.1).
    public static func inclusionProof(_ leaves: [Bytes], _ index: Int, _ size: Int) -> [Bytes] {
        precondition(index >= 0 && index < size && size <= leaves.count, "leaf index outside the tree")
        var out = [Bytes]()
        path(leaves, index, 0, size, &out)
        return out
    }

    private static func path(_ leaves: [Bytes], _ m: Int, _ from: Int, _ to: Int, _ out: inout [Bytes]) {
        let n = to - from
        if n <= 1 { return }
        let k = split(n)
        if m < k { path(leaves, m, from, from + k, &out); out.append(treeHash(leaves, from + k, to)) }
        else { path(leaves, m - k, from + k, to, &out); out.append(treeHash(leaves, from, from + k)) }
    }

    /// The proof that the tree of `first` leaves is a prefix of the tree of `second` (RFC 6962 § 2.1.2).
    public static func consistencyProof(_ leaves: [Bytes], _ first: Int, _ second: Int) -> [Bytes] {
        precondition(first >= 0 && first <= second && second <= leaves.count, "tree sizes out of order")
        var out = [Bytes]()
        if first == 0 || first == second { return out }
        sub(leaves, first, 0, second, true, &out)
        return out
    }

    private static func sub(_ leaves: [Bytes], _ m: Int, _ from: Int, _ to: Int, _ whole: Bool, _ out: inout [Bytes]) {
        let n = to - from
        if m == n { if !whole { out.append(treeHash(leaves, from, to)) }; return }
        let k = split(n)
        if m <= k { sub(leaves, m, from, from + k, whole, &out); out.append(treeHash(leaves, from + k, to)) }
        else { sub(leaves, m - k, from + k, to, false, &out); out.append(treeHash(leaves, from, from + k)) }
    }

    /// RFC 9162 § 2.1.3.2: does `path` prove leaf hash `leaf` at `index` in the tree of `size` with `root`?
    public static func verifyInclusion(_ leaf: Bytes, _ index: Int64, _ size: Int64, _ path: [Bytes], _ root: Bytes) -> Bool {
        guard index >= 0, index < size, size <= P4.maxSafe else { return false }
        var fn = index, sn = size - 1
        var r = leaf
        for p in path {
            if sn == 0 { return false }
            if fn & 1 == 1 || fn == sn {
                r = nodeHash(p, r)
                if fn & 1 == 0 { while fn & 1 == 0 && fn != 0 { fn >>= 1; sn >>= 1 } }
            } else {
                r = nodeHash(r, p)
            }
            fn >>= 1
            sn >>= 1
        }
        return sn == 0 && r == root
    }

    private static func isPowerOfTwo(_ n: Int64) -> Bool { n > 0 && n & (n - 1) == 0 }

    /// RFC 9162 § 2.1.4.2: is the tree (first, firstRoot) a prefix of (second, secondRoot)?
    public static func verifyConsistency(_ first: Int64, _ second: Int64, _ firstRoot: Bytes, _ secondRoot: Bytes, _ proof: [Bytes]) -> Bool {
        guard first >= 0, first <= second, second <= P4.maxSafe else { return false }
        if first == second { return proof.isEmpty && firstRoot == secondRoot }
        if first == 0 { return proof.isEmpty }
        if proof.isEmpty { return false }
        var path = [Bytes]()
        if isPowerOfTwo(first) { path.append(firstRoot) }
        path.append(contentsOf: proof)
        var fn = first - 1, sn = second - 1
        while fn & 1 == 1 { fn >>= 1; sn >>= 1 }
        var fr = path[0], sr = path[0]
        for c in path.dropFirst() {
            if sn == 0 { return false }
            if fn & 1 == 1 || fn == sn {
                fr = nodeHash(c, fr)
                sr = nodeHash(c, sr)
                if fn & 1 == 0 { while fn & 1 == 0 && fn != 0 { fn >>= 1; sn >>= 1 } }
            } else {
                sr = nodeHash(sr, c)
            }
            fn >>= 1
            sn >>= 1
        }
        return sn == 0 && fr == firstRoot && sr == secondRoot
    }
}
