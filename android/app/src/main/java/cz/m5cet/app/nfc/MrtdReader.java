package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * MRTD reader (6.5) — e-passport / e-ID, ICAO 9303 — the Java port of
 * client/src/lib/nfc/cards/mrtd.ts. Opens the holder's own document with BAC
 * (keyed from the MRZ they supply — the document's own access control), then
 * reads over secure messaging: EF.COM (which data groups are present), DG1 (the
 * MRZ data) and DG2 (the face). Read-only; it never writes and only reads the
 * groups a border reader reads. The parsers are unit-tested (MrtdReaderTest),
 * mirroring test/nfc-mrtd.test.ts.
 */
public final class MrtdReader {
    private MrtdReader() {}

    private static final byte[] MRTD_AID = Apdu.u8(0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01);
    private static final int EF_COM = 0x011e, EF_DG1 = 0x0101, EF_DG2 = 0x0102;
    private static final SecureRandom RNG = new SecureRandom();

    public static final class Options {
        public String mrz;
        public Bac.MrzKey key;
        public String can;
        public boolean readPhoto = true;
    }

    private static byte[] randomBytes(int n) { byte[] b = new byte[n]; RNG.nextBytes(b); return b; }

    private static Apdu.Response plain(Apdu.Transceiver t, byte[] cmd) throws IOException { return Apdu.splitResponse(t.transmit(cmd)); }

    /** One secure-messaging exchange: protect → transmit → unprotect. */
    private static Bac.Sm sm(Apdu.Transceiver t, Bac.Session s, byte[] cmd) throws IOException {
        return Bac.unprotectResponse(s, t.transmit(Bac.protectApdu(s, cmd)));
    }

    /* ------------------------------------------------------------------ BAC */

    private static Bac.Session doBac(Apdu.Transceiver t, Bac.MrzKey key) throws IOException {
        Bac.Keys k = Bac.bacKeys(key);
        Apdu.Response chal = plain(t, Apdu.apdu(0x00, 0x84, 0x00, 0x00, null, 8)); // GET CHALLENGE
        if (!Apdu.isOk(chal.sw) || chal.data.length < 8) throw new IOException("the document did not answer GET CHALLENGE");
        byte[] rndIcc = Apdu.slice(chal.data, 0, 8);
        byte[] rndIfd = randomBytes(8);
        byte[] kifd = randomBytes(16);
        byte[] cmdData = Bac.mutualAuthCommand(k.kenc, k.kmac, rndIfd, rndIcc, kifd);
        Apdu.Response auth = plain(t, Apdu.apdu(0x00, 0x82, 0x00, 0x00, cmdData, 0x28)); // EXTERNAL AUTHENTICATE
        if (!Apdu.isOk(auth.sw)) throw new IOException("BAC failed — check the passport number, date of birth and expiry");
        return Bac.sessionFromAuth(k.kenc, k.kmac, rndIfd, rndIcc, kifd, auth.data);
    }

    /* ------------------------------------------------- read a file over SM */

    private static int[] derLength(byte[] head) { // {headerLen, total} or null
        if (head.length < 2) return null;
        int i = 1;
        if ((head[0] & 0x1f) == 0x1f) { while (i < head.length && (head[i] & 0x80) != 0) i++; i++; }
        if (i >= head.length) return null;
        int len = head[i++] & 0xff;
        if ((len & 0x80) != 0) { int n = len & 0x7f; len = 0; for (int j = 0; j < n && i < head.length; j++) len = (len << 8) | (head[i++] & 0xff); }
        return new int[]{i, i + len};
    }

    private static byte[] readFile(Apdu.Transceiver t, Bac.Session s, int fid, int cap) throws IOException {
        Bac.Sm sel = sm(t, s, Apdu.selectByFid(fid, 0x0c));
        if (!Apdu.isOk(sel.sw)) throw new IOException("select EF " + Integer.toHexString(fid) + " failed");
        Bac.Sm head = sm(t, s, Apdu.readBinary(0, 6));
        if (!Apdu.isOk(head.sw) || head.data.length == 0) throw new IOException("read EF " + Integer.toHexString(fid) + " failed");
        int[] info = derLength(head.data);
        int total = Math.min(info != null ? info[1] : head.data.length, cap);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] first = Apdu.slice(head.data, 0, Math.min(head.data.length, total));
        out.write(first, 0, first.length);
        int offset = first.length, guard = 0;
        while (offset < total && offset < 0x8000 && guard++ < 512) {
            int want = Math.min(0xe0, total - offset);
            Bac.Sm r = sm(t, s, Apdu.readBinary(offset, want));
            if (!Apdu.isOk(r.sw) || r.data.length == 0) break;
            out.write(r.data, 0, r.data.length);
            offset += r.data.length;
        }
        return out.toByteArray();
    }

    /* ------------------------------------------------------------ parsing */

    private static String datesFromYYMMDD(String s, boolean future) {
        if (!s.matches("\\d{6}")) return s;
        int yy = Integer.parseInt(s.substring(0, 2));
        int nowYY = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR) % 100;
        int century = future ? (yy < nowYY + 20 ? 2000 : 1900) : (yy <= nowYY ? 2000 : 1900);
        return (century + yy) + "-" + s.substring(2, 4) + "-" + s.substring(4, 6);
    }

    private static void putNames(JSONObject out, String field) throws JSONException {
        String[] parts = field.split("<<", -1);
        String surname = parts.length > 0 ? parts[0] : "";
        String given = parts.length > 1 ? parts[1] : "";
        out.put("surname", surname.replace("<", " ").trim());
        out.put("givenNames", given.replace("<", " ").trim());
    }

    /** Parses a TD1/TD2/TD3 MRZ string into fields (mrtd.ts parseMrz). */
    public static JSONObject parseMrz(String mrz) {
        try {
            String raw = mrz.replaceAll("[^A-Za-z0-9<\\n]", "").toUpperCase();
            JSONObject out = new JSONObject();
            out.put("mrz", raw);
            String flat = raw.replace("\n", "");
            // TD3 (passport): 2×44.
            if (raw.length() == 88 || flat.length() == 88) {
                String l1 = flat.substring(0, 44), l2 = flat.substring(44, 88);
                out.put("documentCode", l1.substring(0, 2).replace("<", ""));
                out.put("issuer", l1.substring(2, 5).replace("<", ""));
                putNames(out, l1.substring(5));
                out.put("documentNumber", l2.substring(0, 9).replace("<", ""));
                out.put("nationality", l2.substring(10, 13).replace("<", ""));
                out.put("dateOfBirth", datesFromYYMMDD(l2.substring(13, 19), false));
                out.put("sex", l2.substring(20, 21).replace("<", ""));
                out.put("dateOfExpiry", datesFromYYMMDD(l2.substring(21, 27), true));
                out.put("optionalData", l2.substring(28, 42).replaceAll("<+$", "").replace("<", ""));
                return out;
            }
            // TD1 (ID card): 3×30.
            if (flat.length() == 90) {
                String l1 = flat.substring(0, 30), l2 = flat.substring(30, 60), l3 = flat.substring(60, 90);
                out.put("documentCode", l1.substring(0, 2).replace("<", ""));
                out.put("issuer", l1.substring(2, 5).replace("<", ""));
                out.put("documentNumber", l1.substring(5, 14).replace("<", ""));
                out.put("dateOfBirth", datesFromYYMMDD(l2.substring(0, 6), false));
                out.put("sex", l2.substring(7, 8).replace("<", ""));
                out.put("dateOfExpiry", datesFromYYMMDD(l2.substring(8, 14), true));
                out.put("nationality", l2.substring(15, 18).replace("<", ""));
                putNames(out, l3);
                return out;
            }
            // TD2 (ID card): 2×36.
            if (flat.length() == 72) {
                String l1 = flat.substring(0, 36), l2 = flat.substring(36, 72);
                out.put("documentCode", l1.substring(0, 2).replace("<", ""));
                out.put("issuer", l1.substring(2, 5).replace("<", ""));
                putNames(out, l1.substring(5));
                out.put("documentNumber", l2.substring(0, 9).replace("<", ""));
                out.put("nationality", l2.substring(10, 13).replace("<", ""));
                out.put("dateOfBirth", datesFromYYMMDD(l2.substring(13, 19), false));
                out.put("sex", l2.substring(20, 21).replace("<", ""));
                out.put("dateOfExpiry", datesFromYYMMDD(l2.substring(21, 27), true));
                return out;
            }
            return out;
        } catch (JSONException e) { throw new RuntimeException(e); }
    }

    public static JSONObject mrzFromDg1(byte[] dg1) {
        List<Apdu.Tlv> tlv = Apdu.decodeTlv(dg1, true);
        Apdu.Tlv mrz = Apdu.findTlv(tlv, 0x5f1f);
        if (mrz == null) { Apdu.Tlv t61 = Apdu.findTlv(tlv, 0x61); mrz = t61 != null ? Apdu.findTlv(t61.children, 0x5f1f) : null; }
        if (mrz == null) return null;
        return parseMrz(new String(mrz.value, StandardCharsets.ISO_8859_1));
    }

    /** The data groups EF.COM lists in its tag-presence list (5C). */
    public static List<String> dataGroupsFromCom(byte[] com) {
        List<Apdu.Tlv> tlv = Apdu.decodeTlv(com, true);
        Apdu.Tlv list = Apdu.findTlv(tlv, 0x5c);
        if (list == null) { Apdu.Tlv t60 = Apdu.findTlv(tlv, 0x60); list = t60 != null ? Apdu.findTlv(t60.children, 0x5c) : null; }
        List<String> out = new ArrayList<>();
        if (list == null) return out;
        Map<Integer, String> map = new LinkedHashMap<>();
        map.put(0x61, "DG1"); map.put(0x75, "DG2"); map.put(0x63, "DG3"); map.put(0x76, "DG4"); map.put(0x65, "DG5");
        map.put(0x67, "DG7"); map.put(0x6b, "DG11"); map.put(0x6c, "DG12"); map.put(0x6d, "DG13"); map.put(0x6f, "DG15");
        for (byte b : list.value) { String dg = map.get(b & 0xff); if (dg != null) out.add(dg); }
        return out;
    }

    public static final class Face { public final String mime; public final byte[] data; Face(String mime, byte[] data) { this.mime = mime; this.data = data; } }

    /** Pulls the face image out of DG2 by its signature (JPEG or JPEG 2000). */
    public static Face faceFromDg2(byte[] dg2) {
        for (int i = 0; i + 3 < dg2.length; i++) {
            int b0 = dg2[i] & 0xff, b1 = dg2[i + 1] & 0xff, b2 = dg2[i + 2] & 0xff, b3 = dg2[i + 3] & 0xff;
            if (b0 == 0xff && b1 == 0xd8 && b2 == 0xff) return new Face("image/jpeg", Apdu.slice(dg2, i));
            if (b0 == 0x00 && b1 == 0x00 && b2 == 0x00 && b3 == 0x0c && i + 5 < dg2.length
                && (dg2[i + 4] & 0xff) == 0x6a && (dg2[i + 5] & 0xff) == 0x50) return new Face("image/jp2", Apdu.slice(dg2, i));
            if (b0 == 0xff && b1 == 0x4f && b2 == 0xff && b3 == 0x51) return new Face("image/jp2", Apdu.slice(dg2, i)); // JPEG2000 codestream
        }
        return null;
    }

    /* ------------------------------------------------------------------ public */

    /**
     * Reads an MRTD (passport / e-ID) into an {@code mrtd} JSONObject (the
     * NfcResult contract). The holder supplies the MRZ (or just the three BAC
     * fields). PACE-only documents (no BAC) are reported, not forced.
     */
    public static JSONObject readMrtd(Apdu.Transceiver t, Options opts) throws JSONException {
        try { plain(t, Apdu.selectByAid(MRTD_AID)); } catch (IOException e) { /* some chips select on first read */ }

        Bac.MrzKey key = opts.key != null ? opts.key : (opts.mrz != null ? Bac.mrzKeyFromMrz(opts.mrz) : null);
        if (key == null) return new JSONObject().put("present", true).put("access", "none")
            .put("message", "Give the MRZ (passport number, date of birth, expiry) to open the chip with BAC.");

        Bac.Session session;
        try { session = doBac(t, key); }
        catch (Exception e) { return new JSONObject().put("present", true).put("access", "none").put("message", e.getMessage() != null ? e.getMessage() : "BAC failed"); }

        JSONObject out = new JSONObject().put("present", true).put("access", "bac");
        try { out.put("dataGroups", new JSONArray(dataGroupsFromCom(readFile(t, session, EF_COM, 512)))); } catch (IOException e) { /* EF.COM optional */ }
        try { JSONObject mrz = mrzFromDg1(readFile(t, session, EF_DG1, 256)); if (mrz != null) out.put("mrzInfo", mrz); }
        catch (IOException e) { out.put("message", e.getMessage() != null ? e.getMessage() : "could not read DG1"); }
        if (opts.readPhoto) {
            try {
                Face face = faceFromDg2(readFile(t, session, EF_DG2, 40000));
                if (face != null) { out.put("photo", Base64.getEncoder().encodeToString(face.data)); out.put("photoMime", face.mime); }
            } catch (IOException e) { /* DG2 optional / larger than we read */ }
        }
        return out;
    }

    /** The NfcResult status for an MRTD read (web-executor.ts): ok when anything opened. */
    public static String statusFor(JSONObject mrtd) {
        return mrtd.has("mrzInfo") || !"none".equals(mrtd.optString("access")) ? "ok" : "auth-failed";
    }

    /** A one-line summary for a log / flash (mrtd.ts mrtdSummary). */
    public static String summary(JSONObject d) {
        JSONObject m = d.optJSONObject("mrzInfo");
        if (m == null) return !d.optString("message", "").isEmpty() ? d.optString("message") : (d.optBoolean("present") ? "MRTD present" : "no MRTD");
        List<String> bits = new ArrayList<>();
        String name = (m.optString("givenNames", "") + " " + m.optString("surname", "")).trim();
        if (!name.isEmpty()) bits.add(name);
        if (!m.optString("documentNumber", "").isEmpty()) bits.add(m.optString("documentNumber"));
        if (!m.optString("nationality", "").isEmpty()) bits.add(m.optString("nationality"));
        if (!d.optString("photo", "").isEmpty()) bits.add("+ photo");
        return String.join(" · ", bits);
    }
}
