package cz.m5cet.app.chat;

/**
 * Argon2id, version 0x13 (RFC 9106), with its BLAKE2b — the web client's
 * room KDF (hash-wasm; 64 MiB, 3 passes, 1 lane, 32 bytes). Plain Java over
 * one long[] of the memory, no allocation per block; checked against the
 * RFC's test vector and against hash-wasm (InteropTest).
 */
public final class Argon2 {
    private Argon2() {}

    private static final int VERSION = 0x13;
    private static final int TYPE_ID = 2;
    private static final int SYNC_POINTS = 4;
    private static final int QWORDS = 128; // 1024-byte block

    /**
     * 6.7 (audit S13): one derivation at a time. Each holds its whole memory
     * (64 MiB for a room); rooms connecting together (up to 8, by policy 16)
     * used to derive at once and run out of memory. Fair, so none starves.
     */
    private static final java.util.concurrent.locks.ReentrantLock ONE_AT_A_TIME = new java.util.concurrent.locks.ReentrantLock(true);
    private static final java.util.concurrent.atomic.AtomicInteger ACTIVE = new java.util.concurrent.atomic.AtomicInteger();
    private static volatile int peak;

    /** The most derivations that ever ran at the same time (1 — for the tests). */
    static int peakConcurrency() { return peak; }

    /**
     * @param memoryKiB m (KiB), passes t, lanes p — secret and data may be empty.
     */
    public static byte[] argon2id(byte[] password, byte[] salt, int passes, int memoryKiB, int lanes, int length, byte[] secret, byte[] data) {
        if (lanes < 1 || passes < 1 || length < 4) throw new IllegalArgumentException("bad Argon2 parameters");
        ONE_AT_A_TIME.lock();
        try {
            int now = ACTIVE.incrementAndGet();
            if (now > peak) peak = now;
            return compute(password, salt, passes, memoryKiB, lanes, length, secret, data);
        } finally {
            ACTIVE.decrementAndGet();
            ONE_AT_A_TIME.unlock();
        }
    }

    private static byte[] compute(byte[] password, byte[] salt, int passes, int memoryKiB, int lanes, int length, byte[] secret, byte[] data) {
        int mPrime = Math.max(memoryKiB, 8 * lanes) / (SYNC_POINTS * lanes) * (SYNC_POINTS * lanes);
        int laneLength = mPrime / lanes;
        int segmentLength = laneLength / SYNC_POINTS;
        long[] mem = new long[mPrime * QWORDS];

        Blake2b h = new Blake2b(64);
        h.update(le32(lanes)); h.update(le32(length)); h.update(le32(memoryKiB)); h.update(le32(passes));
        h.update(le32(VERSION)); h.update(le32(TYPE_ID));
        h.update(le32(password.length)); h.update(password);
        h.update(le32(salt.length)); h.update(salt);
        h.update(le32(secret == null ? 0 : secret.length)); if (secret != null) h.update(secret);
        h.update(le32(data == null ? 0 : data.length)); if (data != null) h.update(data);
        byte[] h0 = h.digest();

        byte[] seed = new byte[72];
        System.arraycopy(h0, 0, seed, 0, 64);
        for (int l = 0; l < lanes; l++) {
            for (int j = 0; j < 2; j++) {
                putLe32(seed, 64, j);
                putLe32(seed, 68, l);
                byte[] block = hPrime(seed, 1024);
                int base = (l * laneLength + j) * QWORDS;
                for (int q = 0; q < QWORDS; q++) mem[base + q] = le64(block, q * 8);
            }
        }

        long[] r = new long[QWORDS];
        long[] tmp = new long[QWORDS];
        long[] zero = new long[QWORDS];
        long[] inputBlock = new long[QWORDS];
        long[] addressBlock = new long[QWORDS];

        for (int pass = 0; pass < passes; pass++) {
            for (int slice = 0; slice < SYNC_POINTS; slice++) {
                for (int lane = 0; lane < lanes; lane++) {
                    boolean independent = pass == 0 && slice < SYNC_POINTS / 2;
                    if (independent) {
                        java.util.Arrays.fill(inputBlock, 0);
                        inputBlock[0] = pass; inputBlock[1] = lane; inputBlock[2] = slice;
                        inputBlock[3] = mPrime; inputBlock[4] = passes; inputBlock[5] = TYPE_ID;
                    }
                    int start = (pass == 0 && slice == 0) ? 2 : 0;
                    if (independent && start != 0) nextAddresses(addressBlock, inputBlock, zero, r, tmp);
                    int curr = lane * laneLength + slice * segmentLength + start;
                    int prev = (curr % laneLength == 0) ? curr + laneLength - 1 : curr - 1;
                    for (int index = start; index < segmentLength; index++, curr++, prev++) {
                        if (curr % laneLength == 1) prev = curr - 1;
                        long pseudo;
                        if (independent) {
                            if (index % QWORDS == 0) nextAddresses(addressBlock, inputBlock, zero, r, tmp);
                            pseudo = addressBlock[index % QWORDS];
                        } else {
                            pseudo = mem[prev * QWORDS];
                        }
                        int refLane = (int) ((pseudo >>> 32) % lanes);
                        if (pass == 0 && slice == 0) refLane = lane;
                        boolean sameLane = refLane == lane;
                        int refIndex = indexAlpha(pass, slice, index, (int) (pseudo & 0xffffffffL), sameLane, laneLength, segmentLength);
                        int ref = refLane * laneLength + refIndex;
                        fillBlock(mem, prev * QWORDS, ref * QWORDS, curr * QWORDS, pass != 0, r, tmp);
                    }
                }
            }
        }

        long[] fin = new long[QWORDS];
        for (int l = 0; l < lanes; l++) {
            int last = (l * laneLength + laneLength - 1) * QWORDS;
            for (int q = 0; q < QWORDS; q++) fin[q] ^= mem[last + q];
        }
        java.util.Arrays.fill(mem, 0);
        byte[] finBytes = new byte[1024];
        for (int q = 0; q < QWORDS; q++) putLe64(finBytes, q * 8, fin[q]);
        return hPrime(finBytes, length);
    }

    private static int indexAlpha(int pass, int slice, int index, int j1, boolean sameLane, int laneLength, int segmentLength) {
        int area;
        if (pass == 0) {
            if (slice == 0) area = index - 1;
            else if (sameLane) area = slice * segmentLength + index - 1;
            else area = slice * segmentLength + (index == 0 ? -1 : 0);
        } else {
            if (sameLane) area = laneLength - segmentLength + index - 1;
            else area = laneLength - segmentLength + (index == 0 ? -1 : 0);
        }
        long rel = j1 & 0xffffffffL;
        rel = (rel * rel) >>> 32;
        rel = area - 1 - ((area * rel) >>> 32);
        int startPos = 0;
        if (pass != 0) startPos = (slice == SYNC_POINTS - 1) ? 0 : (slice + 1) * segmentLength;
        return (int) ((startPos + rel) % laneLength);
    }

    private static void nextAddresses(long[] address, long[] input, long[] zero, long[] r, long[] tmp) {
        input[6]++;
        // address = G(0, G(0, input))
        long[] once = new long[QWORDS];
        compress(zero, input, once, r, tmp, false);
        compress(zero, once, address, r, tmp, false);
    }

    /** mem[out] = G(mem[prev], mem[ref]) (xor the old content from the second pass on). */
    private static void fillBlock(long[] mem, int prev, int ref, int out, boolean xorOld, long[] r, long[] tmp) {
        for (int q = 0; q < QWORDS; q++) r[q] = mem[prev + q] ^ mem[ref + q];
        System.arraycopy(r, 0, tmp, 0, QWORDS);
        permute(r);
        if (xorOld) for (int q = 0; q < QWORDS; q++) mem[out + q] ^= tmp[q] ^ r[q];
        else for (int q = 0; q < QWORDS; q++) mem[out + q] = tmp[q] ^ r[q];
    }

    private static void compress(long[] x, long[] y, long[] out, long[] r, long[] tmp, boolean xorOld) {
        for (int q = 0; q < QWORDS; q++) r[q] = x[q] ^ y[q];
        System.arraycopy(r, 0, tmp, 0, QWORDS);
        permute(r);
        for (int q = 0; q < QWORDS; q++) out[q] = (xorOld ? out[q] : 0) ^ tmp[q] ^ r[q];
    }

    /** The permutation P on rows, then on columns, of the 8×8 matrix of 16-byte registers. */
    private static void permute(long[] v) {
        for (int i = 0; i < 8; i++) {
            int b = i * 16;
            round(v, b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8, b + 9, b + 10, b + 11, b + 12, b + 13, b + 14, b + 15);
        }
        for (int i = 0; i < 8; i++) {
            int b = i * 2;
            round(v, b, b + 1, b + 16, b + 17, b + 32, b + 33, b + 48, b + 49, b + 64, b + 65, b + 80, b + 81, b + 96, b + 97, b + 112, b + 113);
        }
    }

    private static void round(long[] v, int v0, int v1, int v2, int v3, int v4, int v5, int v6, int v7, int v8, int v9, int v10, int v11, int v12, int v13, int v14, int v15) {
        gb(v, v0, v4, v8, v12);
        gb(v, v1, v5, v9, v13);
        gb(v, v2, v6, v10, v14);
        gb(v, v3, v7, v11, v15);
        gb(v, v0, v5, v10, v15);
        gb(v, v1, v6, v11, v12);
        gb(v, v2, v7, v8, v13);
        gb(v, v3, v4, v9, v14);
    }

    private static long fBlaMka(long x, long y) {
        return x + y + 2 * (x & 0xffffffffL) * (y & 0xffffffffL);
    }

    private static void gb(long[] v, int a, int b, int c, int d) {
        v[a] = fBlaMka(v[a], v[b]); v[d] = Long.rotateRight(v[d] ^ v[a], 32);
        v[c] = fBlaMka(v[c], v[d]); v[b] = Long.rotateRight(v[b] ^ v[c], 24);
        v[a] = fBlaMka(v[a], v[b]); v[d] = Long.rotateRight(v[d] ^ v[a], 16);
        v[c] = fBlaMka(v[c], v[d]); v[b] = Long.rotateRight(v[b] ^ v[c], 63);
    }

    /** H' — the variable-length hash of RFC 9106 §3.3. */
    static byte[] hPrime(byte[] input, int length) {
        if (length <= 64) {
            Blake2b h = new Blake2b(length);
            h.update(le32(length));
            h.update(input);
            return h.digest();
        }
        byte[] out = new byte[length];
        Blake2b h = new Blake2b(64);
        h.update(le32(length));
        h.update(input);
        byte[] v = h.digest();
        System.arraycopy(v, 0, out, 0, 32);
        int at = 32;
        int r = (length + 31) / 32 - 2;
        for (int i = 2; i <= r; i++) {
            v = new Blake2b(64).updateThen(v).digest();
            System.arraycopy(v, 0, out, at, 32);
            at += 32;
        }
        byte[] last = new Blake2b(length - 32 * r).updateThen(v).digest();
        System.arraycopy(last, 0, out, at, last.length);
        return out;
    }

    static byte[] le32(int v) { return new byte[]{(byte) v, (byte) (v >>> 8), (byte) (v >>> 16), (byte) (v >>> 24)}; }
    static void putLe32(byte[] b, int at, int v) { b[at] = (byte) v; b[at + 1] = (byte) (v >>> 8); b[at + 2] = (byte) (v >>> 16); b[at + 3] = (byte) (v >>> 24); }
    static long le64(byte[] b, int at) {
        long v = 0;
        for (int i = 7; i >= 0; i--) v = (v << 8) | (b[at + i] & 0xffL);
        return v;
    }
    static void putLe64(byte[] b, int at, long v) { for (int i = 0; i < 8; i++) b[at + i] = (byte) (v >>> (8 * i)); }

    /** BLAKE2b (RFC 7693), unkeyed, any output length 1–64. */
    static final class Blake2b {
        private static final long[] IV = {
            0x6a09e667f3bcc908L, 0xbb67ae8584caa73bL, 0x3c6ef372fe94f82bL, 0xa54ff53a5f1d36f1L,
            0x510e527fade682d1L, 0x9b05688c2b3e6c1fL, 0x1f83d9abfb41bd6bL, 0x5be0cd19137e2179L,
        };
        private static final byte[][] SIGMA = {
            {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
            {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
            {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
            {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
            {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
            {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
            {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
            {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
            {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
            {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
        };
        private final long[] h = new long[8];
        private final byte[] buf = new byte[128];
        private int bufLen = 0;
        private long counter = 0;
        private final int outLen;
        private final long[] m = new long[16];
        private final long[] v = new long[16];

        Blake2b(int outLen) {
            this.outLen = outLen;
            System.arraycopy(IV, 0, h, 0, 8);
            h[0] ^= 0x01010000L ^ outLen;
        }

        Blake2b updateThen(byte[] data) { update(data); return this; }

        void update(byte[] data) {
            int at = 0;
            while (at < data.length) {
                if (bufLen == 128) {
                    counter += 128;
                    compress(false);
                    bufLen = 0;
                }
                int n = Math.min(128 - bufLen, data.length - at);
                System.arraycopy(data, at, buf, bufLen, n);
                bufLen += n;
                at += n;
            }
        }

        byte[] digest() {
            counter += bufLen;
            java.util.Arrays.fill(buf, bufLen, 128, (byte) 0);
            compress(true);
            byte[] full = new byte[64];
            for (int i = 0; i < 8; i++) putLe64(full, i * 8, h[i]);
            return java.util.Arrays.copyOf(full, outLen);
        }

        private void compress(boolean last) {
            for (int i = 0; i < 16; i++) m[i] = le64(buf, i * 8);
            System.arraycopy(h, 0, v, 0, 8);
            System.arraycopy(IV, 0, v, 8, 8);
            v[12] ^= counter;
            if (last) v[14] = ~v[14];
            for (int r = 0; r < 12; r++) {
                byte[] s = SIGMA[r % 10];
                g(0, 4, 8, 12, m[s[0]], m[s[1]]);
                g(1, 5, 9, 13, m[s[2]], m[s[3]]);
                g(2, 6, 10, 14, m[s[4]], m[s[5]]);
                g(3, 7, 11, 15, m[s[6]], m[s[7]]);
                g(0, 5, 10, 15, m[s[8]], m[s[9]]);
                g(1, 6, 11, 12, m[s[10]], m[s[11]]);
                g(2, 7, 8, 13, m[s[12]], m[s[13]]);
                g(3, 4, 9, 14, m[s[14]], m[s[15]]);
            }
            for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
        }

        private void g(int a, int b, int c, int d, long x, long y) {
            v[a] = v[a] + v[b] + x; v[d] = Long.rotateRight(v[d] ^ v[a], 32);
            v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 24);
            v[a] = v[a] + v[b] + y; v[d] = Long.rotateRight(v[d] ^ v[a], 16);
            v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 63);
        }
    }
}
