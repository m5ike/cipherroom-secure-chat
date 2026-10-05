package cz.m5cet.app.p4;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import cz.m5cet.app.security.Crypto;

/**
 * The key-transparency Merkle tree (docs/protocol-v4.md § 14; merkle.ts) —
 * RFC 9162 hashing, shared with the server that keeps the log:
 *
 *   leaf hash = SHA-256(0x00 || leaf bytes)      node hash = SHA-256(0x01 || left || right)
 *   MTH({}) = SHA-256("")                          MTH(D[n]) = node(MTH(D[0:k]), MTH(D[k:n])), k = largest power of 2 < n
 *
 * Proofs are built from a list of leaf hashes (tests; the server's job) and
 * verified with the RFC's algorithms (the client's job).
 */
public final class Merkle {
    private Merkle() {}

    private static final byte[] ZERO = {0x00}, ONE = {0x01};

    /** The hash of one log entry (its exact bytes; for JSON entries the UTF-8 of the canonical text). */
    public static byte[] leafHash(byte[] data) { return Crypto.sha256(ZERO, data); }

    public static byte[] leafHash(String data) { return leafHash(Prim.utf8(data)); }

    public static byte[] nodeHash(byte[] left, byte[] right) { return Crypto.sha256(ONE, left, right); }

    /** Largest power of two strictly smaller than n (n >= 2). */
    private static int split(int n) {
        int k = 1;
        while (k << 1 < n) k <<= 1;
        return k;
    }

    /** MTH over leaf hashes [from, to). */
    public static byte[] treeHash(List<byte[]> leaves, int from, int to) {
        int n = to - from;
        if (n == 0) return Crypto.sha256();
        if (n == 1) return leaves.get(from);
        int k = split(n);
        return nodeHash(treeHash(leaves, from, from + k), treeHash(leaves, from + k, to));
    }

    /** The audit path of leaf `index` in the tree of the first `size` leaves (RFC 6962 § 2.1.1). */
    public static List<byte[]> inclusionProof(List<byte[]> leaves, int index, int size) {
        if (!(index >= 0 && index < size && size <= leaves.size())) throw new IllegalArgumentException("leaf index outside the tree");
        List<byte[]> out = new ArrayList<>();
        path(leaves, index, 0, size, out);
        return out;
    }

    private static void path(List<byte[]> leaves, int m, int from, int to, List<byte[]> out) {
        int n = to - from;
        if (n <= 1) return;
        int k = split(n);
        if (m < k) { path(leaves, m, from, from + k, out); out.add(treeHash(leaves, from + k, to)); }
        else { path(leaves, m - k, from + k, to, out); out.add(treeHash(leaves, from, from + k)); }
    }

    /** The proof that the tree of `first` leaves is a prefix of the tree of `second` (RFC 6962 § 2.1.2). */
    public static List<byte[]> consistencyProof(List<byte[]> leaves, int first, int second) {
        if (!(first >= 0 && first <= second && second <= leaves.size())) throw new IllegalArgumentException("tree sizes out of order");
        List<byte[]> out = new ArrayList<>();
        if (first == 0 || first == second) return out;
        sub(leaves, first, 0, second, true, out);
        return out;
    }

    private static void sub(List<byte[]> leaves, int m, int from, int to, boolean whole, List<byte[]> out) {
        int n = to - from;
        if (m == n) { if (!whole) out.add(treeHash(leaves, from, to)); return; }
        int k = split(n);
        if (m <= k) { sub(leaves, m, from, from + k, whole, out); out.add(treeHash(leaves, from + k, to)); }
        else { sub(leaves, m - k, from + k, to, false, out); out.add(treeHash(leaves, from, from + k)); }
    }

    /** RFC 9162 § 2.1.3.2: does `path` prove leaf hash `leaf` at `index` in the tree of `size` with `root`? */
    public static boolean verifyInclusion(byte[] leaf, long index, long size, List<byte[]> path, byte[] root) {
        if (!(index >= 0 && index < size && size <= Prim.MAX_SAFE)) return false;
        long fn = index, sn = size - 1;
        byte[] r = leaf;
        for (byte[] p : path) {
            if (sn == 0) return false;
            if ((fn & 1) == 1 || fn == sn) {
                r = nodeHash(p, r);
                if ((fn & 1) == 0) {
                    while ((fn & 1) == 0 && fn != 0) { fn >>= 1; sn >>= 1; }
                }
            } else {
                r = nodeHash(r, p);
            }
            fn >>= 1;
            sn >>= 1;
        }
        return sn == 0 && Arrays.equals(r, root);
    }

    private static boolean isPowerOfTwo(long n) { return n > 0 && (n & (n - 1)) == 0; }

    /** RFC 9162 § 2.1.4.2: is the tree (first, firstRoot) a prefix of (second, secondRoot)? */
    public static boolean verifyConsistency(long first, long second, byte[] firstRoot, byte[] secondRoot, List<byte[]> proof) {
        if (!(first >= 0 && first <= second && second <= Prim.MAX_SAFE)) return false;
        if (first == second) return proof.isEmpty() && Arrays.equals(firstRoot, secondRoot);
        if (first == 0) return proof.isEmpty();
        if (proof.isEmpty()) return false;
        List<byte[]> path = new ArrayList<>();
        if (isPowerOfTwo(first)) path.add(firstRoot);
        path.addAll(proof);
        long fn = first - 1, sn = second - 1;
        while ((fn & 1) == 1) { fn >>= 1; sn >>= 1; }
        byte[] fr = path.get(0), sr = path.get(0);
        for (byte[] c : path.subList(1, path.size())) {
            if (sn == 0) return false;
            if ((fn & 1) == 1 || fn == sn) {
                fr = nodeHash(c, fr);
                sr = nodeHash(c, sr);
                if ((fn & 1) == 0) {
                    while ((fn & 1) == 0 && fn != 0) { fn >>= 1; sn >>= 1; }
                }
            } else {
                sr = nodeHash(sr, c);
            }
            fn >>= 1;
            sn >>= 1;
        }
        return sn == 0 && Arrays.equals(fr, firstRoot) && Arrays.equals(sr, secondRoot);
    }
}
