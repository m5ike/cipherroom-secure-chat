package cz.m5cet.app.nfc;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** BER-TLV fixture builders for the card tests (the web tests' encodeTlv / T / oid / int helpers). */
final class Tlvs {
    private Tlvs() {}

    static byte[] ascii(String s) { return s.getBytes(StandardCharsets.US_ASCII); }

    /** Tag (1–3 bytes, packed big-endian) + DER length + the concatenated values. */
    static byte[] T(int tag, byte[]... values) {
        byte[] v = Apdu.concat(values);
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        if (tag > 0xffff) w.write((tag >> 16) & 0xff);
        if (tag > 0xff) w.write((tag >> 8) & 0xff);
        w.write(tag & 0xff);
        int n = v.length;
        if (n < 0x80) w.write(n);
        else if (n <= 0xff) { w.write(0x81); w.write(n); }
        else if (n <= 0xffff) { w.write(0x82); w.write(n >> 8); w.write(n & 0xff); }
        else { w.write(0x83); w.write(n >> 16); w.write((n >> 8) & 0xff); w.write(n & 0xff); }
        w.write(v, 0, v.length);
        return w.toByteArray();
    }

    static byte[] oid(String dotted) { return T(0x06, Asn1.oidBytes(dotted)); }

    static byte[] integer(int n) { return T(0x02, Apdu.u8(n)); }

    static byte[] fill(int n, int value) { byte[] b = new byte[n]; java.util.Arrays.fill(b, (byte) value); return b; }

    static byte[] ok(byte[] resp) { return Apdu.concat(resp, Apdu.u8(0x90, 0x00)); }

    static byte[] sw(int sw) { return Apdu.u8(sw >> 8, sw & 0xff); }
}
