package cz.m5cet.app.nfc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * ISO 7816-4 APDU helpers, status-word checks and a BER-TLV codec (6.5) — the
 * Java port of client/src/lib/nfc/cards/apdu.ts, carrying only what the EMV and
 * MRTD readers need. Pure functions plus a one-method {@link Transceiver} the
 * device layer (an open ISO-DEP) satisfies, so the readers are unit-testable
 * against a scripted card.
 */
public final class Apdu {
    private Apdu() {}

    /** The one call a reader makes against a card: send a command APDU, get the response (data ‖ SW). */
    public interface Transceiver { byte[] transmit(byte[] apdu) throws IOException; }

    /* ---------- hex / bytes ---------- */

    public static String hex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder s = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) s.append(String.format("%02X", b & 0xff));
        return s.toString();
    }

    public static byte[] unhex(String text) {
        String clean = text.replaceAll("(?i)0x", "").replaceAll("[^0-9a-fA-F]", "");
        int n = clean.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    public static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }

    public static byte[] u8(int... values) {
        byte[] out = new byte[values.length];
        for (int i = 0; i < values.length; i++) out[i] = (byte) (values[i] & 0xff);
        return out;
    }

    public static byte[] slice(byte[] a, int from, int to) {
        int lo = Math.max(0, from), hi = Math.min(a.length, to);
        if (hi < lo) hi = lo;
        byte[] out = new byte[hi - lo];
        System.arraycopy(a, lo, out, 0, out.length);
        return out;
    }

    public static byte[] slice(byte[] a, int from) { return slice(a, from, a.length); }

    /* ---------- APDU ---------- */

    /** Build a short-form case 1..4 APDU. {@code le} < 0 means "no Le"; 0 means "256 / as much as possible". */
    public static byte[] apdu(int cla, int ins, int p1, int p2, byte[] data, int le) {
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        w.write(cla & 0xff); w.write(ins & 0xff); w.write(p1 & 0xff); w.write(p2 & 0xff);
        if (data != null && data.length > 0) { w.write(data.length & 0xff); w.write(data, 0, data.length); }
        if (le >= 0) w.write(le & 0xff);
        return w.toByteArray();
    }

    public static final class Response {
        public final byte[] data; public final int sw1, sw2, sw;
        Response(byte[] data, int sw1, int sw2) { this.data = data; this.sw1 = sw1; this.sw2 = sw2; this.sw = (sw1 << 8) | sw2; }
    }

    public static Response splitResponse(byte[] raw) {
        if (raw == null || raw.length < 2) return new Response(new byte[0], 0x6f, 0x00);
        return new Response(slice(raw, 0, raw.length - 2), raw[raw.length - 2] & 0xff, raw[raw.length - 1] & 0xff);
    }

    public static boolean isOk(int sw) { return sw == 0x9000 || (sw >> 8) == 0x61 || sw == 0x9100; }

    /**
     * Transmit with the ISO 7816-4 transport dance handled: 6Cxx → retry with the
     * suggested Le, 61xx → GET RESPONSE until drained. Mirrors apdu.ts transmitSmart.
     */
    public static Response transmitSmart(Transceiver t, byte[] cmd) throws IOException {
        Response r = splitResponse(t.transmit(cmd));
        if (r.sw1 == 0x6c && cmd.length >= 5) {
            byte[] fixed = cmd.clone();
            fixed[fixed.length - 1] = (byte) r.sw2;
            r = splitResponse(t.transmit(fixed));
        }
        ByteArrayOutputStream chunks = new ByteArrayOutputStream();
        chunks.write(r.data, 0, r.data.length);
        int guard = 0;
        while (r.sw1 == 0x61 && guard++ < 64) {
            r = splitResponse(t.transmit(u8(cmd[0] & 0xf0, 0xc0, 0x00, 0x00, r.sw2)));
            chunks.write(r.data, 0, r.data.length);
        }
        return new Response(chunks.toByteArray(), r.sw1, r.sw2);
    }

    /* ---------- common ISO 7816 commands (apdu.ts ISO) ---------- */

    public static byte[] selectByAid(byte[] aid) { return apdu(0x00, 0xa4, 0x04, 0x00, aid, 0x00); }
    public static byte[] selectByFid(int fid, int p2) { return apdu(0x00, 0xa4, 0x00, p2, u8((fid >> 8) & 0xff, fid & 0xff), -1); }
    public static byte[] readBinary(int offset, int le) { return apdu(0x00, 0xb0, (offset >> 8) & 0x7f, offset & 0xff, null, le); }
    public static byte[] readRecord(int rec, int sfi) { return apdu(0x00, 0xb2, rec, (sfi << 3) | 0x04, null, 0x00); }

    /* ---------- BER-TLV ---------- */

    public static final class Tlv {
        public final int tag;            // the tag, packed big-endian (e.g. 0x5F24, 0xBF0C)
        public final byte[] tagBytes;
        public final int length;
        public final byte[] value;
        public final boolean constructed;
        public List<Tlv> children;
        Tlv(int tag, byte[] tagBytes, int length, byte[] value, boolean constructed) {
            this.tag = tag; this.tagBytes = tagBytes; this.length = length; this.value = value; this.constructed = constructed;
        }
    }

    private static int[] readTag(byte[] buf, int off) { // {tag, size}
        int tag = buf[off] & 0xff, size = 1;
        if ((tag & 0x1f) == 0x1f) {
            do {
                if (off + size >= buf.length) break;
                tag = (tag << 8) | (buf[off + size] & 0xff);
                size++;
            } while ((buf[off + size - 1] & 0x80) != 0);
        }
        return new int[]{tag, size};
    }

    private static int[] readLen(byte[] buf, int off) { // {length, size}
        int first = buf[off] & 0xff;
        if (first < 0x80) return new int[]{first, 1};
        int n = first & 0x7f;
        if (n == 0 || n > 4 || off + n >= buf.length) return new int[]{-1, 1};
        int length = 0;
        for (int i = 1; i <= n; i++) length = (length << 8) | (buf[off + i] & 0xff);
        return new int[]{length, 1 + n};
    }

    /** 6.7 (audit N18): how deep constructed tags are opened — a card's nesting cannot overflow the stack. */
    static final int MAX_TLV_DEPTH = 32;

    /** Parse a sequence of BER-TLV objects; constructed tags recurse into children. 00/FF padding is skipped. */
    public static List<Tlv> decodeTlv(byte[] buf, boolean recurse) { return decodeTlv(buf, recurse, 0); }

    private static List<Tlv> decodeTlv(byte[] buf, boolean recurse, int depth) {
        List<Tlv> out = new ArrayList<>();
        int off = 0;
        while (off < buf.length) {
            if ((buf[off] & 0xff) == 0x00 || (buf[off] & 0xff) == 0xff) { off++; continue; }
            int[] t = readTag(buf, off);
            if (off + t[1] >= buf.length) break;
            int[] l = readLen(buf, off + t[1]);
            if (l[0] < 0) break;
            int start = off + t[1] + l[1];
            if (start + l[0] > buf.length) break;
            byte[] value = slice(buf, start, start + l[0]);
            boolean constructed = (buf[off] & 0x20) != 0;
            Tlv node = new Tlv(t[0], slice(buf, off, off + t[1]), l[0], value, constructed);
            if (constructed && recurse && depth < MAX_TLV_DEPTH) {
                try { node.children = decodeTlv(value, true, depth + 1); } catch (RuntimeException e) { node.children = null; }
            }
            out.add(node);
            off = start + l[0];
        }
        return out;
    }

    public static List<Tlv> decodeTlv(byte[] buf) { return decodeTlv(buf, true); }

    /** Depth-first search for a tag. */
    public static Tlv findTlv(List<Tlv> list, int tag) {
        if (list == null) return null;
        for (Tlv n : list) {
            if (n.tag == tag) return n;
            Tlv inner = findTlv(n.children, tag);
            if (inner != null) return inner;
        }
        return null;
    }

    public static List<Tlv> findAllTlv(List<Tlv> list, int tag) {
        List<Tlv> acc = new ArrayList<>();
        findAllTlv(list, tag, acc);
        return acc;
    }

    private static void findAllTlv(List<Tlv> list, int tag, List<Tlv> acc) {
        if (list == null) return;
        for (Tlv n : list) {
            if (n.tag == tag) acc.add(n);
            findAllTlv(n.children, tag, acc);
        }
    }

    /** Pretty-print a TLV tree (the PPSE directory, for the EmvData.tree field). */
    public static String formatTlv(List<Tlv> list, int depth) {
        StringBuilder sb = new StringBuilder();
        String pad = repeat("  ", depth);
        for (Tlv n : list) {
            String tagHex = hex(n.tagBytes);
            if (n.children != null && !n.children.isEmpty()) {
                sb.append(pad).append(tagHex).append(" (").append(n.length).append(")\n");
                sb.append(formatTlv(n.children, depth + 1)).append("\n");
            } else {
                sb.append(pad).append(tagHex).append(" (").append(n.length).append(") ").append(hexSpaced(n.value));
                // Printable values also as text (apdu.ts formatTlv).
                boolean printable = n.value.length > 0;
                for (byte b : n.value) if ((b & 0xff) < 0x20 || (b & 0xff) >= 0x7f) { printable = false; break; }
                if (printable) sb.append("  \"").append(new String(n.value, java.nio.charset.StandardCharsets.US_ASCII)).append('"');
                sb.append("\n");
            }
        }
        // trim one trailing newline to mirror join("\n")
        if (sb.length() > 0 && sb.charAt(sb.length() - 1) == '\n') sb.setLength(sb.length() - 1);
        return sb.toString();
    }

    private static String hexSpaced(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < b.length; i++) { if (i > 0) s.append(' '); s.append(String.format("%02X", b[i] & 0xff)); }
        return s.toString();
    }

    private static String repeat(String s, int n) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < n; i++) out.append(s);
        return out.toString();
    }

    /** "0x5F24" → "5F24", "0x50" → "50" — the EMV tag key (upper hex, even length). */
    public static String tagHex(int tag) {
        String h = Integer.toHexString(tag).toUpperCase();
        if (h.length() % 2 != 0) h = "0" + h;
        return h;
    }
}
