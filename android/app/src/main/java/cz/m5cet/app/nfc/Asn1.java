package cz.m5cet.app.nfc;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Small DER helpers (6.6) for the travel-document security objects — EF.SOD (a
 * CMS SignedData), DG14 / EF.CardAccess (SecurityInfos), DG15 (a public key)
 * and the document signer's X.509 certificate. The Java port of
 * client/src/lib/nfc/cards/asn1.ts. Reading only: names, dates, OIDs, hashes.
 * Nothing here verifies a signature.
 */
public final class Asn1 {
    private Asn1() {}

    public static final int SEQ = 0x30, SET = 0x31, OID = 0x06, INT = 0x02, OCTETS = 0x04, BITS = 0x03;

    /** DER children of a node (an OCTET STRING / BIT STRING holding DER is parsed on demand). */
    public static List<Apdu.Tlv> kids(Apdu.Tlv n) {
        if (n == null) return Collections.emptyList();
        if (n.children != null) return n.children;
        try { return Apdu.decodeTlv(n.tag == BITS ? Apdu.slice(n.value, 1) : n.value, true); }
        catch (RuntimeException e) { return Collections.emptyList(); }
    }

    /** Parses DER, tolerating trailing garbage. */
    public static List<Apdu.Tlv> der(byte[] bytes) {
        try { return Apdu.decodeTlv(bytes, true); } catch (RuntimeException e) { return Collections.emptyList(); }
    }

    /** The i-th element of a list, or null. */
    public static Apdu.Tlv at(List<Apdu.Tlv> list, int i) { return list != null && i >= 0 && i < list.size() ? list.get(i) : null; }

    /** An OBJECT IDENTIFIER's value → dotted text. */
    public static String oidText(byte[] v) {
        if (v == null || v.length == 0) return "";
        StringBuilder s = new StringBuilder();
        int first = v[0] & 0xff;
        s.append(first / 40).append('.').append(first % 40);
        long n = 0;
        for (int i = 1; i < v.length; i++) {
            n = n * 128 + (v[i] & 0x7f);
            if ((v[i] & 0x80) == 0) { s.append('.').append(n); n = 0; }
        }
        return s.toString();
    }

    /** Dotted text → an OBJECT IDENTIFIER's value bytes. */
    public static byte[] oidBytes(String text) {
        String[] p = text.split("\\.");
        List<Integer> out = new ArrayList<>();
        out.add(Integer.parseInt(p[0]) * 40 + Integer.parseInt(p[1]));
        for (int k = 2; k < p.length; k++) {
            long n = Long.parseLong(p[k]);
            List<Integer> enc = new ArrayList<>();
            enc.add((int) (n & 0x7f));
            long v = n / 128;
            while (v > 0) { enc.add(0, (int) ((v & 0x7f) | 0x80)); v /= 128; }
            out.addAll(enc);
        }
        byte[] b = new byte[out.size()];
        for (int i = 0; i < b.length; i++) b[i] = (byte) (int) out.get(i);
        return b;
    }

    /** An INTEGER's value (its last six bytes at most). */
    public static long intValue(byte[] v) {
        long n = 0;
        for (int i = Math.max(0, v.length - 6); i < v.length; i++) n = n * 256 + (v[i] & 0xff);
        return n;
    }

    /** Well-known OIDs the travel documents use. */
    public static final Map<String, String> OID_NAMES = new HashMap<>();
    private static void o(String oid, String name) { OID_NAMES.put(oid, name); }
    static {
        o("1.3.14.3.2.26", "SHA-1");
        o("2.16.840.1.101.3.4.2.4", "SHA-224");
        o("2.16.840.1.101.3.4.2.1", "SHA-256");
        o("2.16.840.1.101.3.4.2.2", "SHA-384");
        o("2.16.840.1.101.3.4.2.3", "SHA-512");
        o("1.2.840.113549.1.1.1", "RSA");
        o("1.2.840.10045.2.1", "EC");
        o("1.2.840.113549.1.7.2", "CMS signed data");
        o("2.23.136.1.1.1", "LDS security object");
        o("2.23.136.1.1.5", "Active Authentication");
        o("0.4.0.127.0.7.2.2.1.1", "Chip Authentication key (DH)");
        o("0.4.0.127.0.7.2.2.1.2", "Chip Authentication key (ECDH)");
        o("0.4.0.127.0.7.2.2.2", "Terminal Authentication");
        o("0.4.0.127.0.7.2.2.3.1.1", "Chip Authentication (DH, 3DES)");
        o("0.4.0.127.0.7.2.2.3.1.2", "Chip Authentication (DH, AES-128)");
        o("0.4.0.127.0.7.2.2.3.1.3", "Chip Authentication (DH, AES-192)");
        o("0.4.0.127.0.7.2.2.3.1.4", "Chip Authentication (DH, AES-256)");
        o("0.4.0.127.0.7.2.2.3.2.1", "Chip Authentication (ECDH, 3DES)");
        o("0.4.0.127.0.7.2.2.3.2.2", "Chip Authentication (ECDH, AES-128)");
        o("0.4.0.127.0.7.2.2.3.2.3", "Chip Authentication (ECDH, AES-192)");
        o("0.4.0.127.0.7.2.2.3.2.4", "Chip Authentication (ECDH, AES-256)");
        String[] maps = {"1", "DH-GM", "2", "ECDH-GM", "3", "DH-IM", "4", "ECDH-IM"};
        String[] ciphers = {"1", "3DES", "2", "AES-128", "3", "AES-192", "4", "AES-256"};
        for (int m = 0; m < maps.length; m += 2)
            for (int c = 0; c < ciphers.length; c += 2)
                o("0.4.0.127.0.7.2.2.4." + maps[m] + "." + ciphers[c], "PACE " + maps[m + 1] + " " + ciphers[c + 1]);
        o("0.4.0.127.0.7.2.2.4.6.2", "PACE ECDH-CAM AES-128");
        o("0.4.0.127.0.7.2.2.4.6.3", "PACE ECDH-CAM AES-192");
        o("0.4.0.127.0.7.2.2.4.6.4", "PACE ECDH-CAM AES-256");
        o("0.4.0.127.0.7.2.2.5", "Restricted Identification");
        o("0.4.0.127.0.7.2.2.6", "Card info");
        o("0.4.0.127.0.7.2.2.12", "PACE domain parameters");
        o("1.2.840.10045.3.1.7", "NIST P-256");
        o("1.3.132.0.34", "NIST P-384");
        o("1.3.132.0.35", "NIST P-521");
        o("1.3.36.3.3.2.8.1.1.7", "brainpoolP256r1");
        o("1.3.36.3.3.2.8.1.1.11", "brainpoolP384r1");
        o("1.3.36.3.3.2.8.1.1.13", "brainpoolP512r1");
        o("2.5.4.3", "CN"); o("2.5.4.6", "C"); o("2.5.4.7", "L"); o("2.5.4.8", "ST"); o("2.5.4.10", "O"); o("2.5.4.11", "OU"); o("2.5.4.5", "serialNumber");
    }

    public static String oidName(String oid) { String n = OID_NAMES.get(oid); return n != null ? n : oid; }

    /** Strict UTF-8, else Latin-1 (card text is not always well-formed). */
    public static String text(byte[] v) {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(v)).toString();
        } catch (CharacterCodingException e) {
            return new String(v, StandardCharsets.ISO_8859_1);
        }
    }

    /** An X.500 Name → "CN=…, O=…, C=…". */
    public static String nameText(Apdu.Tlv n) {
        List<String> parts = new ArrayList<>();
        for (Apdu.Tlv rdn : kids(n)) {
            for (Apdu.Tlv atv : kids(rdn)) {
                List<Apdu.Tlv> k = kids(atv);
                Apdu.Tlv type = at(k, 0), value = at(k, 1);
                if (type == null || value == null) continue;
                parts.add(oidName(oidText(type.value)) + "=" + text(value.value));
            }
        }
        return String.join(", ", parts);
    }

    /** UTCTime / GeneralizedTime → YYYY-MM-DD. */
    public static String timeText(Apdu.Tlv n) {
        if (n == null) return "";
        String s = text(n.value);
        if (n.tag == 0x17 && s.matches("^\\d{6}.*")) {
            int yy = Integer.parseInt(s.substring(0, 2));
            return (yy < 50 ? 2000 + yy : 1900 + yy) + "-" + s.substring(2, 4) + "-" + s.substring(4, 6);
        }
        if (s.matches("^\\d{8}.*")) return s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8);
        return s;
    }

    /** The interesting parts of an X.509 certificate: subject, issuer, serial, notBefore, notAfter. */
    public static JSONObject certInfo(Apdu.Tlv cert) {
        JSONObject out = new JSONObject();
        Apdu.Tlv tbs = at(kids(cert), 0);
        if (tbs == null) return out;
        List<Apdu.Tlv> k = new ArrayList<>(kids(tbs));
        if (!k.isEmpty() && k.get(0).tag == 0xa0) k.remove(0); // [0] version
        Apdu.Tlv serial = at(k, 0), issuer = at(k, 2), validity = at(k, 3), subject = at(k, 4);
        List<Apdu.Tlv> v = kids(validity);
        try {
            if (serial != null) out.put("serial", Apdu.hex(serial.value).toUpperCase());
            putNonEmpty(out, "issuer", nameText(issuer));
            putNonEmpty(out, "subject", nameText(subject));
            putNonEmpty(out, "notBefore", timeText(at(v, 0)));
            putNonEmpty(out, "notAfter", timeText(at(v, 1)));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    private static void putNonEmpty(JSONObject o, String k, String v) throws JSONException { if (v != null && !v.isEmpty()) o.put(k, v); }
}
