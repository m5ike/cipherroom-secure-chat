package cz.m5cet.app.p4;

import java.util.Arrays;

/**
 * Call media keys of protocol 4 (docs/protocol-v4.md § 9; media4.ts) — the
 * frame IV and the sealed-frame layout of media-frames.ts. The Android app
 * does not seal call frames (its hello has no "media" cap), so calls keep
 * WebRTC's own DTLS-SRTP; this is the byte layout only, checked against the
 * vectors, for when it does.
 *
 *   IV = epoch (4 bytes, big-endian) || frame counter (8 bytes, big-endian)
 *   frame = clear prefix || AES-GCM(prefix as AAD) || IV || clear length || 0x6d 0xe3
 */
public final class Media4 {
    private Media4() {}

    public static final long FRAME_LIMIT = 1L << 32;
    private static final byte[] TRAILER = {0x6d, (byte) 0xe3};

    /** § 9 frame IV. */
    public static byte[] frameIv(long epoch, long counter) throws P4Error {
        if (epoch < 0 || epoch > 0xffffffffL) throw P4Error.malformed("epoch is a 32-bit unsigned integer");
        if (counter < 0 || counter >= FRAME_LIMIT) throw P4Error.malformed("frame counter out of range");
        byte[] iv = new byte[12];
        for (int i = 0; i < 4; i++) iv[i] = (byte) (epoch >>> (24 - 8 * i));
        for (int i = 0; i < 8; i++) iv[4 + i] = (byte) (counter >>> (56 - 8 * i));
        return iv;
    }

    /** media-frames.ts sealFrame: the first `clear` bytes stay readable (and are the AAD). */
    public static byte[] sealFrame(byte[] key, byte[] frame, int clear, byte[] iv) throws P4Error {
        if (clear < 0 || clear > frame.length || clear > 255) throw P4Error.malformed("clear prefix");
        byte[] prefix = Arrays.copyOf(frame, clear);
        byte[] ct = Prim.aesGcmSeal(key, iv, prefix, Arrays.copyOfRange(frame, clear, frame.length));
        byte[] out = new byte[clear + ct.length + 12 + 1 + 2];
        System.arraycopy(prefix, 0, out, 0, clear);
        System.arraycopy(ct, 0, out, clear, ct.length);
        System.arraycopy(iv, 0, out, clear + ct.length, 12);
        out[out.length - 3] = (byte) clear;
        out[out.length - 2] = TRAILER[0];
        out[out.length - 1] = TRAILER[1];
        return out;
    }

    /** media-frames.ts openFrame; null when the frame is not sealed or does not open. */
    public static byte[] openFrame(byte[] key, byte[] b) {
        int overhead = 16 + 12 + 1 + 2;
        if (b.length < overhead || b[b.length - 2] != TRAILER[0] || b[b.length - 1] != TRAILER[1] || (b[b.length - 3] & 0xff) > b.length - overhead) return null;
        int clear = b[b.length - 3] & 0xff;
        int ivAt = b.length - 3 - 12;
        byte[] prefix = Arrays.copyOf(b, clear);
        try {
            byte[] plain = Prim.aesGcmOpen(key, Arrays.copyOfRange(b, ivAt, ivAt + 12), prefix, Arrays.copyOfRange(b, clear, ivAt));
            return Prim.concat(prefix, plain);
        } catch (P4Error e) {
            return null;
        }
    }
}
