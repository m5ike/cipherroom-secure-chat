package cz.m5cet.app.nfc;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * BAC — Basic Access Control (6.5), ICAO 9303 Part 11 — the Java port of
 * client/src/lib/nfc/cards/bac.ts. The holder opens their own travel document
 * with the key the MRZ carries (passport number, date of birth, date of expiry):
 * a mutual authentication yields session keys and every later APDU is wrapped in
 * secure messaging. The document's own access mechanism, not a bypass — and it
 * only reads. Pinned byte-for-byte to the ICAO worked example (BacDesTest).
 */
public final class Bac {
    private Bac() {}

    private static byte[] sha1(byte[] data) {
        try { return MessageDigest.getInstance("SHA-1").digest(data); }
        catch (NoSuchAlgorithmException e) { throw new RuntimeException(e); }
    }

    private static byte[] ascii(String s) { return s.getBytes(StandardCharsets.US_ASCII); }

    /* ------------------------------------------------------------ the MRZ key */

    public static final class MrzKey {
        public final String documentNumber, dateOfBirth, dateOfExpiry;
        public MrzKey(String documentNumber, String dateOfBirth, String dateOfExpiry) {
            this.documentNumber = documentNumber; this.dateOfBirth = dateOfBirth; this.dateOfExpiry = dateOfExpiry;
        }
    }

    private static int checkValue(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'A' && c <= 'Z') return 10 + (c - 'A');
        return 0; // '<' and everything else
    }

    /** ICAO check digit (weights 7,3,1) over A–Z, 0–9 and '<'. */
    public static String checkDigit(String field) {
        int[] w = {7, 3, 1};
        int sum = 0;
        for (int i = 0; i < field.length(); i++) sum += checkValue(Character.toUpperCase(field.charAt(i))) * w[i % 3];
        return String.valueOf(sum % 10);
    }

    private static String padEnd(String s, int len, char c) {
        StringBuilder b = new StringBuilder(s);
        while (b.length() < len) b.append(c);
        return b.toString();
    }

    private static String left(String s, int n) { return s.length() <= n ? s : s.substring(0, n); }

    /** The MRZ information string the BAC seed is hashed from. */
    public static String mrzInformation(MrzKey key) {
        String doc = left(padEnd(key.documentNumber.toUpperCase().replaceAll("[^A-Z0-9<]", ""), 9, '<'), 9);
        String dob = left(key.dateOfBirth.replaceAll("\\D", ""), 6);
        String exp = left(key.dateOfExpiry.replaceAll("\\D", ""), 6);
        return doc + checkDigit(doc) + dob + checkDigit(dob) + exp + checkDigit(exp);
    }

    /** Reads the BAC key fields out of a 2- or 3-line MRZ (TD1/TD2/TD3). */
    public static MrzKey mrzKeyFromMrz(String mrz) {
        String[] parts = mrz.toUpperCase().split("\\r?\\n");
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (String l : parts) { String s = l.replaceAll("\\s", ""); if (!s.isEmpty()) lines.add(s); }
        if (lines.size() == 2 && lines.get(0).length() >= 36 && lines.get(1).length() >= 36) {
            String l2 = lines.get(1);
            return new MrzKey(l2.substring(0, 9).replace("<", ""), l2.substring(13, 19), l2.substring(21, 27));
        }
        if (lines.size() == 2 && lines.get(0).length() >= 30) {
            String l1 = lines.get(0), l2 = lines.get(1);
            return new MrzKey(l1.substring(5, 14).replace("<", ""), l2.substring(0, 6), l2.substring(8, 14));
        }
        if (lines.size() == 3 && lines.get(0).length() >= 30) {
            String l1 = lines.get(0), l2 = lines.get(1);
            return new MrzKey(l1.substring(5, 14).replace("<", ""), l2.substring(0, 6), l2.substring(8, 14));
        }
        if (lines.size() >= 2 && lines.get(1).length() >= 28) {
            String l2 = lines.get(1);
            return new MrzKey(l2.substring(0, 9).replace("<", ""), l2.substring(13, 19), l2.substring(21, 27));
        }
        return null;
    }

    /* ------------------------------------------------------------ key derivation */

    private static byte[] fixParity(byte[] k) {
        byte[] out = k.clone();
        for (int i = 0; i < out.length; i++) {
            int b = out[i] & 0xfe, ones = 0;
            for (int j = 1; j < 8; j++) ones += (b >> j) & 1;
            out[i] = (byte) (b | (ones % 2 == 0 ? 1 : 0));
        }
        return out;
    }

    /** Derives one 16-byte 2-key 3DES key from a seed and a counter (1 = enc, 2 = mac). */
    public static byte[] deriveKey(byte[] seed, int counter) {
        byte[] h = sha1(Apdu.concat(seed, Apdu.u8(0, 0, 0, counter)));
        return fixParity(Apdu.concat(Apdu.slice(h, 0, 8), Apdu.slice(h, 8, 16)));
    }

    public static final class Keys { public final byte[] kenc, kmac, seed; Keys(byte[] e, byte[] m, byte[] s) { kenc = e; kmac = m; seed = s; } }

    /** Kenc and Kmac from the MRZ information (the BAC seed = SHA1(MRZ info)[0:16]). */
    public static Keys bacKeys(MrzKey key) {
        byte[] seed = Apdu.slice(sha1(ascii(mrzInformation(key))), 0, 16);
        return new Keys(deriveKey(seed, 1), deriveKey(seed, 2), seed);
    }

    /* ------------------------------------------------- mutual authentication */

    /** The EXTERNAL AUTHENTICATE command data (Eifd || Mifd) for a mutual auth. */
    public static byte[] mutualAuthCommand(byte[] kenc, byte[] kmac, byte[] rndIfd, byte[] rndIcc, byte[] kifd) {
        byte[] s = Apdu.concat(rndIfd, rndIcc, kifd);
        byte[] eifd = Des.tdesCbcEncrypt(kenc, s);
        byte[] mifd = Des.retailMac(kmac, Des.pad(eifd));
        return Apdu.concat(eifd, mifd);
    }

    public static final class Session {
        public final byte[] ksenc, ksmac;
        public final byte[] ssc; // mutated in place as secure messaging advances
        Session(byte[] ksenc, byte[] ksmac, byte[] ssc) { this.ksenc = ksenc; this.ksmac = ksmac; this.ssc = ssc; }
    }

    /** Verifies the chip's answer and derives the session keys + the SSC. */
    public static Session sessionFromAuth(byte[] kenc, byte[] kmac, byte[] rndIfd, byte[] rndIcc, byte[] kifd, byte[] response) {
        if (response.length < 40) throw new IllegalStateException("mutual authenticate answer too short");
        byte[] eicc = Apdu.slice(response, 0, 32), micc = Apdu.slice(response, 32, 40);
        if (!Apdu.hex(Des.retailMac(kmac, Des.pad(eicc))).equals(Apdu.hex(micc)))
            throw new IllegalStateException("the document's MAC did not verify (wrong MRZ?)");
        byte[] r = Des.tdesCbcDecrypt(kenc, eicc);
        byte[] rndIfdBack = Apdu.slice(r, 8, 16), kicc = Apdu.slice(r, 16, 32);
        if (!Apdu.hex(rndIfdBack).equals(Apdu.hex(rndIfd)))
            throw new IllegalStateException("the document did not echo our nonce (wrong MRZ?)");
        byte[] seed = new byte[16];
        for (int i = 0; i < 16; i++) seed[i] = (byte) (kifd[i] ^ kicc[i]);
        byte[] ssc = Apdu.concat(Apdu.slice(rndIcc, 4, 8), Apdu.slice(rndIfd, 4, 8));
        return new Session(deriveKey(seed, 1), deriveKey(seed, 2), ssc);
    }

    /* --------------------------------------------------------- secure messaging */

    private static void incSsc(byte[] ssc) {
        for (int i = ssc.length - 1; i >= 0; i--) { ssc[i] = (byte) ((ssc[i] + 1) & 0xff); if (ssc[i] != 0) break; }
    }

    private static byte[] len1(int n) {
        if (n < 0x80) return Apdu.u8(n);
        if (n < 0x100) return Apdu.u8(0x81, n);
        return Apdu.u8(0x82, (n >> 8) & 0xff, n & 0xff);
    }

    /** Wraps a plain [CLA INS P1 P2 (Lc data)(Le)] APDU in secure messaging. */
    public static byte[] protectApdu(Session s, byte[] apduBytes) {
        int cla = (apduBytes[0] & 0xff) | 0x0c, ins = apduBytes[1] & 0xff, p1 = apduBytes[2] & 0xff, p2 = apduBytes[3] & 0xff;
        byte[] data = new byte[0];
        int le = -1;
        if (apduBytes.length == 5) le = apduBytes[4] & 0xff;
        else if (apduBytes.length > 5) {
            int lc = apduBytes[4] & 0xff;
            data = Apdu.slice(apduBytes, 5, 5 + lc);
            if (apduBytes.length > 5 + lc) le = apduBytes[5 + lc] & 0xff;
        }
        incSsc(s.ssc);
        byte[] header = Des.pad(Apdu.u8(cla, ins, p1, p2));
        byte[] do87 = new byte[0], do97 = new byte[0];
        if (data.length > 0) {
            byte[] enc = Des.tdesCbcEncrypt(s.ksenc, Des.pad(data));
            byte[] body = Apdu.concat(Apdu.u8(0x01), enc);
            do87 = Apdu.concat(Apdu.u8(0x87), len1(body.length), body);
        }
        if (le >= 0) do97 = Apdu.u8(0x97, 0x01, le);
        byte[] n = Des.pad(Apdu.concat(s.ssc, header, do87, do97));
        byte[] cc = Des.retailMac(s.ksmac, n);
        byte[] do8e = Apdu.concat(Apdu.u8(0x8e, 0x08), cc);
        byte[] body = Apdu.concat(do87, do97, do8e);
        return Apdu.concat(Apdu.u8(cla, ins, p1, p2), len1(body.length), body, Apdu.u8(0x00));
    }

    public static final class Sm { public final byte[] data; public final int sw; Sm(byte[] data, int sw) { this.data = data; this.sw = sw; } }

    /** Unwraps a secure-messaging response → the plaintext data and the real SW. */
    public static Sm unprotectResponse(Session s, byte[] resp) {
        int sw = ((resp[resp.length - 2] & 0xff) << 8) | (resp[resp.length - 1] & 0xff);
        byte[] body = Apdu.slice(resp, 0, resp.length - 2);
        incSsc(s.ssc);
        int[] i = {0};
        byte[] do87 = new byte[0], do99 = new byte[0], do8e = new byte[0], encData = new byte[0];
        while (i[0] < body.length) {
            int tag = body[i[0]++] & 0xff;
            if (i[0] >= body.length) break;          // no length byte — tolerate a trailing byte (as the web does)
            int L = readLen(body, i);
            if (L < 0 || i[0] + L > body.length) break;
            byte[] v = Apdu.slice(body, i[0], i[0] + L); i[0] += L;
            if (tag == 0x87) { do87 = Apdu.concat(Apdu.u8(0x87), len1(L), v); encData = Apdu.slice(v, 1); }
            else if (tag == 0x99) do99 = Apdu.concat(Apdu.u8(0x99), len1(L), v);
            else if (tag == 0x8e) do8e = v;
        }
        byte[] n = Des.pad(Apdu.concat(s.ssc, do87, do99));
        // 6.7 (audit N18): data or a protected status without DO'8E was taken unchecked — a relay could strip the MAC.
        if (do8e.length == 0 && (do87.length > 0 || do99.length > 0)) throw new IllegalStateException("secure messaging: the response carries no MAC");
        if (do8e.length > 0 && !java.security.MessageDigest.isEqual(Des.retailMac(s.ksmac, n), do8e))
            throw new IllegalStateException("secure-messaging MAC did not verify");
        // 6.6: the processing status the chip protected (DO'99') is the command's
        // real status — a chip may answer 9000 outside while a file is absent (6A82)
        // or EAC-protected (6982) inside.
        if (do99.length == 4) sw = ((do99[2] & 0xff) << 8) | (do99[3] & 0xff);
        if (encData.length == 0) return new Sm(new byte[0], sw);
        return new Sm(Des.unpad(Des.tdesCbcDecrypt(s.ksenc, encData)), sw);
    }

    private static int readLen(byte[] body, int[] i) {
        int L = body[i[0]++] & 0xff;
        if (L == 0x81) { if (i[0] >= body.length) return -1; L = body[i[0]++] & 0xff; }
        else if (L == 0x82) { if (i[0] + 1 >= body.length) return -1; L = ((body[i[0]++] & 0xff) << 8) | (body[i[0]++] & 0xff); }
        return L;
    }
}
