package cz.m5cet.app.p4;

import java.util.Arrays;

/**
 * Padding (docs/protocol-v4.md § 10; pad.ts), ISO/IEC 7816-4:
 *   pad(m)   = m || 0x80 || 0x00…  up to the smallest PAD_BUCKETS entry that is
 *              >= len(m) + 1; above 65 536, the next multiple of 65 536
 *   unpad(m) = strip trailing 0x00, then require and strip one 0x80
 */
public final class Pad {
    private Pad() {}

    private static final int TOP = P4.PAD_BUCKETS[P4.PAD_BUCKETS.length - 1];

    /** The padded length (marker included) of a message of `length` bytes. */
    public static int paddedLength(int length) {
        if (length < 0) throw new IllegalArgumentException("message length");
        long need = (long) length + 1;
        for (int bucket : P4.PAD_BUCKETS) if (bucket >= need) return bucket;
        long out = ((need + TOP - 1) / TOP) * TOP;
        if (out > Integer.MAX_VALUE) throw new IllegalArgumentException("message length");
        return (int) out;
    }

    public static byte[] pad(byte[] message) {
        byte[] out = new byte[paddedLength(message.length)];
        System.arraycopy(message, 0, out, 0, message.length);
        out[message.length] = (byte) 0x80;
        return out;
    }

    /** The message inside; a missing 0x80 marker is `malformed`. */
    public static byte[] unpad(byte[] padded) throws P4Error {
        int i = padded.length - 1;
        while (i >= 0 && padded[i] == 0x00) i--;
        if (i < 0 || padded[i] != (byte) 0x80) throw P4Error.malformed("bad padding");
        return Arrays.copyOf(padded, i);
    }
}
