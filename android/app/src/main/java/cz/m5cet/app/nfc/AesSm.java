package cz.m5cet.app.nfc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;

/**
 * AES secure messaging (6.6), ICAO 9303-11 §9.8.7 — the Java port of the AES
 * half of client/src/lib/nfc/cards/sm.ts. What PACE with an AES suite gives
 * the MRTD reader: wrap a plain APDU, unwrap the chip's answer. (PACE with
 * 3DES reuses BAC's secure messaging, {@link Bac#protectApdu}, with an 8-byte
 * zero SSC.) Pinned to the BSI TR-03110 worked example's 21 logged APDUs
 * (PaceTest).
 *
 * Commands: CLA | 0C, the data encrypted (AES-CBC, IV = E(KSenc, SSC)) in
 * DO87 (DO85 for an odd INS), Le in DO97, DO8E = CMAC(KSmac, SSC || header ||
 * DOs) cut to 8 bytes; short or extended length. Answers: DO8E checked over
 * SSC and every other data object, DO87 / DO85 decrypted, the status word
 * from DO99; a bare status word (the chip's answer to a secure-messaging
 * error) comes back as it is. The SSC (16 bytes, zero after PACE) is
 * incremented before each wrap and each unwrap, and mutated in place.
 */
public final class AesSm {
    public final byte[] ksenc, ksmac;
    /** The send sequence counter, mutated in place as secure messaging advances. */
    public final byte[] ssc;

    public AesSm(byte[] ksenc, byte[] ksmac, byte[] ssc) {
        if (ssc.length != 16) throw new IllegalArgumentException("the AES SSC is 16 bytes");
        this.ksenc = ksenc; this.ksmac = ksmac; this.ssc = ssc;
    }

    private static final byte[] EMPTY = new byte[0];

    private static void incSsc(byte[] ssc) {
        for (int i = ssc.length - 1; i >= 0; i--) { ssc[i] = (byte) ((ssc[i] + 1) & 0xff); if (ssc[i] != 0) break; }
    }

    /** ISO 9797-1 padding method 2 to the AES block: 80 then 00s. */
    static byte[] pad16(byte[] data) {
        byte[] out = new byte[data.length + (16 - (data.length % 16))];
        System.arraycopy(data, 0, out, 0, data.length);
        out[data.length] = (byte) 0x80;
        return out;
    }

    private static byte[] unpad16(byte[] data) throws PaceProtocol.PaceException {
        int i = data.length - 1;
        while (i >= 0 && data[i] == 0x00) i--;
        if (i < 0 || (data[i] & 0xff) != 0x80) throw protocol("secure messaging: the response padding is wrong");
        return Apdu.slice(data, 0, i);
    }

    private static PaceProtocol.PaceException protocol(String message) {
        return new PaceProtocol.PaceException(PaceProtocol.PaceException.PROTOCOL, message, null);
    }

    /* ------------------------------------------------------------ commands */

    /** A plain command APDU, short or extended: header, data, and the raw Le bytes (null for none). */
    private static final class Command {
        final byte[] header, data, le; final boolean extended;
        Command(byte[] header, byte[] data, byte[] le, boolean extended) { this.header = header; this.data = data; this.le = le; this.extended = extended; }
    }

    private static Command parseCommand(byte[] a) {
        if (a.length < 4) throw new IllegalArgumentException("APDU shorter than 4 bytes");
        byte[] header = Apdu.slice(a, 0, 4);
        if (a.length == 4) return new Command(header, EMPTY, null, false);
        if (a.length == 5) return new Command(header, EMPTY, Apdu.slice(a, 4, 5), false);
        if (a[4] == 0x00) { // extended length: 00 Lc1 Lc2 (data) (Le1 Le2), or 00 Le1 Le2
            if (a.length == 7) return new Command(header, EMPTY, Apdu.slice(a, 5, 7), true);
            int lc = ((a[5] & 0xff) << 8) | (a[6] & 0xff);
            int rest = a.length - 7 - lc;
            if (lc == 0 || (rest != 0 && rest != 2)) throw new IllegalArgumentException("inconsistent extended APDU length");
            return new Command(header, Apdu.slice(a, 7, 7 + lc), rest != 0 ? Apdu.slice(a, 7 + lc) : null, true);
        }
        int lc = a[4] & 0xff;
        int rest = a.length - 5 - lc;
        if (rest != 0 && rest != 1) throw new IllegalArgumentException("inconsistent APDU length (Lc=" + lc + ", total=" + a.length + ")");
        return new Command(header, Apdu.slice(a, 5, 5 + lc), rest != 0 ? Apdu.slice(a, 5 + lc) : null, false);
    }

    /** Wraps a plain APDU (short or extended) in AES secure messaging; increments the SSC first. */
    public byte[] protect(byte[] cmd) {
        Command c = parseCommand(cmd);
        byte[] head = Apdu.u8((c.header[0] & 0xff) | 0x0c, c.header[1], c.header[2], c.header[3]);
        incSsc(ssc);
        byte[] doData = EMPTY;
        if (c.data.length > 0) {
            byte[] enc = Aes.cbcEncrypt(ksenc, pad16(c.data), Aes.encryptBlock(ksenc, ssc));
            doData = (head[1] & 1) != 0 ? PaceProtocol.tlv(0x85, enc) : PaceProtocol.tlv(0x87, Apdu.concat(Apdu.u8(0x01), enc));
        }
        byte[] do97 = c.le != null ? PaceProtocol.tlv(0x97, c.le) : EMPTY;
        byte[] mac = Apdu.slice(Aes.cmac(ksmac, pad16(Apdu.concat(ssc, pad16(head), doData, do97))), 0, 8);
        byte[] body = Apdu.concat(doData, do97, PaceProtocol.tlv(0x8e, mac));
        if (c.extended || body.length > 0xff) return Apdu.concat(head, Apdu.u8(0x00, body.length >> 8, body.length), body, Apdu.u8(0x00, 0x00));
        return Apdu.concat(head, Apdu.u8(body.length), body, Apdu.u8(0x00));
    }

    /* ------------------------------------------------------------ answers */

    private static int[] readTag(byte[] buf, int off) throws PaceProtocol.PaceException { // {tag, size}
        if (off >= buf.length) throw protocol("TLV: tag beyond buffer");
        int tag = buf[off] & 0xff, size = 1;
        if ((tag & 0x1f) == 0x1f) {
            do {
                if (off + size >= buf.length) throw protocol("TLV: truncated multi-byte tag");
                tag = (tag << 8) | (buf[off + size] & 0xff);
                size++;
            } while ((buf[off + size - 1] & 0x80) != 0);
        }
        return new int[]{tag, size};
    }

    private static int[] readLength(byte[] buf, int off) throws PaceProtocol.PaceException { // {length, size}
        if (off >= buf.length) throw protocol("TLV: length beyond buffer");
        int first = buf[off] & 0xff;
        if (first < 0x80) return new int[]{first, 1};
        int n = first & 0x7f;
        if (n == 0 || n > 4) throw protocol("TLV: unsupported length form 0x" + Integer.toHexString(first));
        if (off + n >= buf.length) throw protocol("TLV: truncated length");
        long length = 0;
        for (int i = 1; i <= n; i++) length = (length << 8) | (buf[off + i] & 0xff);
        if (length > Integer.MAX_VALUE) throw protocol("secure messaging: truncated response");
        return new int[]{(int) length, 1 + n};
    }

    /**
     * Unwraps an AES secure-messaging answer (data ‖ SW): checks DO8E, decrypts
     * DO87 / DO85 and returns the plain data with DO99's status word (the outer
     * one when there is no DO99). Increments the SSC first.
     */
    public Bac.Sm unprotect(byte[] resp) throws IOException {
        if (resp == null || resp.length < 2) throw protocol("Response shorter than SW1SW2 (" + (resp == null ? 0 : resp.length) + " bytes)");
        int outer = ((resp[resp.length - 2] & 0xff) << 8) | (resp[resp.length - 1] & 0xff);
        byte[] body = Apdu.slice(resp, 0, resp.length - 2);
        incSsc(ssc);
        if (body.length == 0) return new Bac.Sm(EMPTY, outer);
        ByteArrayOutputStream covered = new ByteArrayOutputStream();
        byte[] mac = null, cryptogram = null;
        int sw = -1;
        for (int i = 0; i < body.length; ) {
            int[] tag = readTag(body, i);
            int[] len = readLength(body, i + tag[1]);
            int start = i + tag[1] + len[1];
            long end = (long) start + len[0];
            if (end > body.length) throw protocol("secure messaging: truncated response");
            byte[] value = Apdu.slice(body, start, (int) end);
            if (tag[0] == 0x8e) mac = value;
            else {
                covered.write(body, i, (int) end - i);
                if (tag[0] == 0x87) {
                    if (value.length == 0 || value[0] != 0x01) throw protocol("secure messaging: unknown padding indicator");
                    cryptogram = Apdu.slice(value, 1);
                } else if (tag[0] == 0x85) cryptogram = value;
                else if (tag[0] == 0x99 && value.length == 2) sw = ((value[0] & 0xff) << 8) | (value[1] & 0xff);
            }
            i = (int) end;
        }
        if (mac == null) throw protocol("secure messaging: the response carries no MAC");
        byte[] want = Apdu.slice(Aes.cmac(ksmac, pad16(Apdu.concat(ssc, covered.toByteArray()))), 0, 8);
        if (!MessageDigest.isEqual(want, mac)) throw protocol("secure-messaging MAC did not verify");
        byte[] data = EMPTY;
        if (cryptogram != null && cryptogram.length > 0) {
            if (cryptogram.length % 16 != 0) throw protocol("AES-CBC data must be a whole number of 16-byte blocks");
            data = unpad16(Aes.cbcDecrypt(ksenc, cryptogram, Aes.encryptBlock(ksenc, ssc)));
        }
        return new Bac.Sm(data, sw >= 0 ? sw : outer);
    }
}
