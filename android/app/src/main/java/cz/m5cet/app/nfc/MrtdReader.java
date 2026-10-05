package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * MRTD reader (6.5, deep read 6.6) — e-passport / e-ID, ICAO 9303 — the Java port
 * of client/src/lib/nfc/cards/mrtd.ts. Opens the holder's own document with the
 * key they supply — PACE with the CAN printed on it (or the MRZ) where the chip
 * offers a variant this reader runs, else BAC with the MRZ: the document's own
 * access control — then reads, over secure messaging, everything a border reader
 * may read: EF.COM (the data groups present), EF.SOD (their hashes and the
 * document signer), DG1 (the MRZ), DG2 (the faces), DG5 / DG7 (portrait,
 * signature), DG11 / DG12 (more personal and document details), DG13, DG14
 * (security protocols), DG15 (the Active Authentication key), DG16 (persons to
 * notify). DG3 / DG4 (fingerprints, iris) need Extended Access Control — a
 * government terminal certificate — and are never selected. Read-only: it never
 * writes. Each group read is checked against its hash in EF.SOD (passive
 * authentication of what was read; the signer is not checked against a CSCA list).
 *
 * The result is the {@code mrtd} object of the NfcResult contract (command.ts
 * MrtdData). Unit-tested against a simulated BAC chip (MrtdDeepTest) and the
 * parsers alone (MrtdReaderTest), mirroring test/nfc-mrtd-deep.test.ts.
 */
public final class MrtdReader {
    private MrtdReader() {}

    private static final byte[] MRTD_AID = Apdu.u8(0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01);
    private static final int EF_CARD_ACCESS = 0x011c, EF_COM = 0x011e, EF_SOD = 0x011d;
    private static final SecureRandom RNG = new SecureRandom();

    private static int dgFid(int n) { return 0x0100 + n; }

    /** EF.COM tag-list byte → data group. */
    private static final Map<Integer, Integer> DG_TAG = new HashMap<>();
    /** How much of each group to read at most (the face can be large; the rest is small). */
    private static final Map<Integer, Integer> CAP = new HashMap<>();
    static {
        int[] tags = {0x61, 0x75, 0x63, 0x76, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70};
        for (int i = 0; i < tags.length; i++) DG_TAG.put(tags[i], i + 1);
        CAP.put(1, 512); CAP.put(2, 98_304); CAP.put(5, 98_304); CAP.put(7, 65_536); CAP.put(11, 65_536); CAP.put(12, 131_072);
        CAP.put(13, 32_768); CAP.put(14, 8192); CAP.put(15, 4096); CAP.put(16, 16_384);
    }
    /** Groups that hold only pictures. */
    private static final Set<Integer> IMAGE_GROUPS = new HashSet<>(Arrays.asList(2, 5, 7));
    /** Fingerprints and iris: Extended Access Control (a terminal certificate), not readable here. */
    private static final Set<Integer> EAC_GROUPS = new HashSet<>(Arrays.asList(3, 4));

    /** How the holder opens their document, and what to read (command.ts MrtdAccessArgs). */
    public static final class Options {
        /** The whole MRZ (2 or 3 lines) — the BAC key is derived from it. */
        public String mrz;
        /** Or just the three fields the BAC key needs. */
        public Bac.MrzKey key;
        /** A 6-digit Card Access Number (PACE). */
        public String can;
        /** Read the images (DG2, DG5, DG7, scans in DG11 / DG12) — default true. */
        public boolean readPhoto = true;
        /** Read every group the document lists, not only DG1 / DG2 — default true. */
        public boolean all = true;

        /** From an op's {@code args}: mrz, documentNumber + dateOfBirth + dateOfExpiry, can, readPhoto, all (snake_case accepted too). */
        public static Options fromArgs(JSONObject args) {
            Options o = new Options();
            if (args == null) return o;
            String mrz = str(args, "mrz", "mrz");
            if (mrz != null) o.mrz = mrz;
            String dn = str(args, "documentNumber", "document_number"), dob = str(args, "dateOfBirth", "date_of_birth"), exp = str(args, "dateOfExpiry", "date_of_expiry");
            if (dn != null && dob != null && exp != null) o.key = new Bac.MrzKey(dn, dob, exp);
            String can = str(args, "can", "can");
            if (can != null) o.can = can;
            Object rp = args.has("readPhoto") ? args.opt("readPhoto") : args.opt("read_photo");
            if (Boolean.FALSE.equals(rp)) o.readPhoto = false;
            if (Boolean.FALSE.equals(args.opt("all"))) o.all = false;
            return o;
        }

        private static String str(JSONObject a, String camel, String snake) {
            Object v = a.has(camel) ? a.opt(camel) : a.opt(snake);
            return v instanceof String ? (String) v : null;
        }
    }

    private static byte[] randomBytes(int n) { byte[] b = new byte[n]; RNG.nextBytes(b); return b; }

    private static Apdu.Response plain(Apdu.Transceiver t, byte[] cmd) throws IOException { return Apdu.splitResponse(t.transmit(cmd)); }

    /** 6282: end of file before Le — the bytes that came are good. */
    private static boolean readable(int sw) { return Apdu.isOk(sw) || sw == 0x6282; }

    /* ------------------------------------------------------------------ BAC */

    private static SmChannel doBac(Apdu.Transceiver t, Bac.MrzKey key) throws IOException {
        Bac.Keys k = Bac.bacKeys(key);
        Apdu.Response chal = plain(t, Apdu.apdu(0x00, 0x84, 0x00, 0x00, null, 8)); // GET CHALLENGE
        if (!Apdu.isOk(chal.sw) || chal.data.length < 8) throw new IOException("the document did not answer GET CHALLENGE");
        byte[] rndIcc = Apdu.slice(chal.data, 0, 8);
        byte[] rndIfd = randomBytes(8);
        byte[] kifd = randomBytes(16);
        byte[] cmdData = Bac.mutualAuthCommand(k.kenc, k.kmac, rndIfd, rndIcc, kifd);
        Apdu.Response auth = plain(t, Apdu.apdu(0x00, 0x82, 0x00, 0x00, cmdData, 0x28)); // EXTERNAL AUTHENTICATE
        if (!Apdu.isOk(auth.sw)) throw new IOException("BAC failed — check the document number, date of birth and expiry");
        try { return SmChannel.bac(t, Bac.sessionFromAuth(k.kenc, k.kmac, rndIfd, rndIcc, kifd, auth.data)); }
        catch (RuntimeException e) { throw new IOException(e.getMessage() != null ? e.getMessage() : "BAC failed", e); }
    }

    /* ------------------------------------------------------------ reading files */

    /** One command to the chip, plain or over secure messaging. */
    private interface Sender { SmChannel.Reply send(byte[] cmd) throws IOException; }

    /** A file read: its bytes (complete or capped) — or the status word that refused it. */
    private static final class FileRead {
        final byte[] bytes; final boolean complete; final int sw;
        private FileRead(byte[] bytes, boolean complete, int sw) { this.bytes = bytes; this.complete = complete; this.sw = sw; }
        static FileRead of(byte[] bytes, boolean complete) { return new FileRead(bytes, complete, 0x9000); }
        static FileRead refused(int sw) { return new FileRead(null, false, sw); }
    }

    /** The length of a BER-TLV object from its first bytes (tag + length): {headerLen, total}, or null. */
    private static int[] derLength(byte[] head) {
        if (head.length < 2) return null;
        int i = 1;
        if ((head[0] & 0x1f) == 0x1f) { while (i < head.length && (head[i] & 0x80) != 0) i++; i++; }
        if (i >= head.length) return null;
        int len = head[i++] & 0xff;
        if ((len & 0x80) != 0) { int n = len & 0x7f; len = 0; for (int j = 0; j < n && i < head.length; j++) len = (len << 8) | (head[i++] & 0xff); }
        return new int[]{i, i + len};
    }

    /** READ BINARY beyond 32 KB: INS B1 with the offset in DO 54, the data in DO 53. */
    private static SmChannel.Reply readBinaryAt(Sender send, int offset, int le) throws IOException {
        if (offset < 0x8000) return send.send(Apdu.readBinary(offset, le));
        byte[] off = Apdu.u8(0x54, 0x03, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff);
        SmChannel.Reply r = send.send(Apdu.apdu(0x00, 0xb1, 0x00, 0x00, off, le));
        Apdu.Tlv do53 = r.data.length > 0 ? Apdu.findTlv(Apdu.decodeTlv(r.data, false), 0x53) : null;
        return new SmChannel.Reply(do53 != null ? do53.value : r.data, r.sw);
    }

    /** Selects an EF (by file id) and reads all of it, up to {@code cap} bytes. */
    private static FileRead readFile(Sender send, int fid, int cap) throws IOException {
        SmChannel.Reply sel = send.send(Apdu.apdu(0x00, 0xa4, 0x02, 0x0c, Apdu.u8((fid >> 8) & 0xff, fid & 0xff), -1));
        if (!Apdu.isOk(sel.sw)) return FileRead.refused(sel.sw);
        SmChannel.Reply head = send.send(Apdu.readBinary(0, 8));
        if (!readable(head.sw) || head.data.length == 0) return FileRead.refused(head.sw != 0 ? head.sw : 0x6f00);
        int[] info = derLength(head.data);
        int want = info != null ? info[1] : head.data.length;
        int total = Math.min(want, cap);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] first = Apdu.slice(head.data, 0, Math.min(head.data.length, total));
        out.write(first, 0, first.length);
        int offset = first.length, guard = 0;
        while (offset < total && guard++ < 1024) {
            SmChannel.Reply r = readBinaryAt(send, offset, Math.min(0xe0, total - offset));
            if (!readable(r.sw) || r.data.length == 0) break;
            out.write(r.data, 0, r.data.length);
            offset += r.data.length;
        }
        byte[] bytes = out.toByteArray();
        return FileRead.of(bytes, bytes.length >= want);
    }

    private static String statusOf(int sw) {
        if (sw == 0x6a82 || sw == 0x6a83) return "absent";
        if (sw == 0x6982 || sw == 0x6985 || sw == 0x6986) return "protected";
        return "error";
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
                out.put("optionalData", l1.substring(15, 30).replaceAll("<+$", "").replace("<", ""));
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

    /** EF.COM, parsed: the data groups its tag list (5C) names, and the LDS / Unicode versions. */
    public static final class Com {
        public final List<Integer> groups = new ArrayList<>();
        public String lds, unicode;
    }

    /** EF.COM: the data groups its tag list (5C) names, and the LDS / Unicode versions. */
    public static Com parseCom(byte[] com) {
        Com out = new Com();
        List<Apdu.Tlv> tlv = Apdu.decodeTlv(com, true);
        Apdu.Tlv list = Apdu.findTlv(tlv, 0x5c);
        if (list != null) for (byte b : list.value) { Integer g = DG_TAG.get(b & 0xff); if (g != null) out.groups.add(g); }
        Apdu.Tlv lds = Apdu.findTlv(tlv, 0x5f01), uni = Apdu.findTlv(tlv, 0x5f36);
        if (lds != null && lds.value.length > 0) {
            String s = new String(lds.value, StandardCharsets.ISO_8859_1);
            out.lds = s.length() == 4 && s.matches("\\d{4}") ? Integer.parseInt(s.substring(0, 2)) + "." + Integer.parseInt(s.substring(2)) : s;
        }
        if (uni != null && uni.value.length > 0) {
            String s = new String(uni.value, StandardCharsets.ISO_8859_1);
            out.unicode = s.length() == 6 && s.matches("\\d{6}")
                ? Integer.parseInt(s.substring(0, 2)) + "." + Integer.parseInt(s.substring(2, 4)) + "." + Integer.parseInt(s.substring(4)) : s;
        }
        return out;
    }

    /** The data groups EF.COM lists in its tag-presence list (5C). */
    public static List<String> dataGroupsFromCom(byte[] com) {
        List<String> out = new ArrayList<>();
        for (int g : parseCom(com).groups) out.add("DG" + g);
        return out;
    }

    /** An image (face, portrait, signature, document scan): its MIME type and bytes. */
    public static final class Face { public final String mime; public final byte[] data; Face(String mime, byte[] data) { this.mime = mime; this.data = data; } }

    /** An image found by its signature inside a data object (JPEG, JPEG 2000, PNG). */
    public static Face imageIn(byte[] b) {
        for (int i = 0; i + 5 < b.length; i++) {
            int b0 = b[i] & 0xff, b1 = b[i + 1] & 0xff, b2 = b[i + 2] & 0xff, b3 = b[i + 3] & 0xff, b4 = b[i + 4] & 0xff, b5 = b[i + 5] & 0xff;
            if (b0 == 0xff && b1 == 0xd8 && b2 == 0xff) return new Face("image/jpeg", Apdu.slice(b, i));
            if (b0 == 0x00 && b1 == 0x00 && b2 == 0x00 && b3 == 0x0c && b4 == 0x6a && b5 == 0x50) return new Face("image/jp2", Apdu.slice(b, i));
            if (b0 == 0xff && b1 == 0x4f && b2 == 0xff && b3 == 0x51) return new Face("image/jp2", Apdu.slice(b, i)); // JPEG 2000 codestream
            if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4e && b3 == 0x47) return new Face("image/png", Apdu.slice(b, i));
        }
        return null;
    }

    /** Every face in DG2 (each biometric data block, 5F2E / 7F2E). */
    public static List<Face> facesFromDg2(byte[] dg2) {
        List<Apdu.Tlv> nodes;
        try { nodes = Apdu.decodeTlv(dg2, true); } catch (RuntimeException e) { nodes = Collections.emptyList(); }
        List<Apdu.Tlv> blocks = new ArrayList<>(Apdu.findAllTlv(nodes, 0x5f2e));
        blocks.addAll(Apdu.findAllTlv(nodes, 0x7f2e));
        List<Face> out = new ArrayList<>();
        for (Apdu.Tlv bl : blocks) { Face f = imageIn(bl.value); if (f != null) out.add(f); }
        if (out.isEmpty()) { Face one = imageIn(dg2); if (one != null) out.add(one); }
        return out;
    }

    /** Pulls the face image out of DG2 by its signature (JPEG, JPEG 2000 or PNG). */
    public static Face faceFromDg2(byte[] dg2) {
        List<Face> all = facesFromDg2(dg2);
        return all.isEmpty() ? imageIn(dg2) : all.get(0);
    }

    private static String mrzText(String s) {
        return s.replaceAll("<<+", ", ").replace("<", " ").replaceAll("\\s+", " ").trim();
    }

    /** A date that may be BCD (YYYYMMDD in 4 bytes) or ASCII digits. */
    private static String dateField(byte[] v) {
        String s = v.length == 4 || v.length == 7 ? Apdu.hex(v) : Asn1.text(v).trim();
        if (s.matches("\\d{14}")) return s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8) + " " + s.substring(8, 10) + ":" + s.substring(10, 12) + ":" + s.substring(12, 14);
        if (s.matches("\\d{8}")) return s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8);
        return s;
    }

    /** The images found while parsing (command.ts MrtdImage). */
    private static final class Found {
        final JSONArray images = new JSONArray();
        int count(String kind) {
            int n = 0;
            for (int i = 0; i < images.length(); i++) { JSONObject o = images.optJSONObject(i); if (o != null && kind.equals(o.optString("kind"))) n++; }
            return n;
        }
    }

    private static String extOf(String mime) {
        switch (mime) { case "image/jpeg": return "jpg"; case "image/jp2": return "jp2"; case "image/png": return "png"; default: return "bin"; }
    }

    private static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    private static void pushImage(Found found, int group, String kind, byte[] bytes, String label) throws JSONException {
        Face img = imageIn(bytes);
        if (img == null) return;
        int n = found.count(kind);
        found.images.put(new JSONObject().put("group", "DG" + group).put("kind", kind).put("mime", img.mime)
            .put("data", b64(img.data)).put("name", label + (n > 0 ? "-" + (n + 1) : "") + "." + extOf(img.mime)));
    }

    private static byte[] val(List<Apdu.Tlv> t, int tag) { Apdu.Tlv n = Apdu.findTlv(t, tag); return n != null ? n.value : null; }
    private static String txt(List<Apdu.Tlv> t, int tag) { byte[] v = val(t, tag); return v != null && v.length > 0 ? Asn1.text(v).trim() : null; }
    private static void putIf(JSONObject o, String k, String v) throws JSONException { if (v != null && !v.isEmpty()) o.put(k, v); }

    private static JSONArray texts(List<Apdu.Tlv> t, int tag) {
        JSONArray out = new JSONArray();
        for (Apdu.Tlv n : Apdu.findAllTlv(t, tag)) { String s = mrzText(Asn1.text(n.value).trim()); if (!s.isEmpty()) out.put(s); }
        return out;
    }

    /** DG11: additional personal details (command.ts MrtdPersonal). */
    public static JSONObject parseDg11(byte[] dg) throws JSONException { return parseDg11(dg, null); }

    private static JSONObject parseDg11(byte[] dg, Found found) throws JSONException {
        List<Apdu.Tlv> t = Apdu.decodeTlv(dg, true);
        JSONObject out = new JSONObject();
        String full = txt(t, 0x5f0e); if (full != null) putIf(out, "fullName", mrzText(full));
        JSONArray others = texts(t, 0x5f0f); if (others.length() > 0) out.put("otherNames", others);
        String pn = txt(t, 0x5f10); if (pn != null) putIf(out, "personalNumber", pn.replace("<", ""));
        byte[] dob = val(t, 0x5f2b); if (dob != null && dob.length > 0) putIf(out, "fullDateOfBirth", dateField(dob));
        String pob = txt(t, 0x5f11); if (pob != null) putIf(out, "placeOfBirth", mrzText(pob));
        String addr = txt(t, 0x5f42); if (addr != null) putIf(out, "address", mrzText(addr));
        String tel = txt(t, 0x5f12); putIf(out, "telephone", tel);
        String prof = txt(t, 0x5f13); if (prof != null) putIf(out, "profession", mrzText(prof));
        String title = txt(t, 0x5f14); if (title != null) putIf(out, "title", mrzText(title));
        String sum = txt(t, 0x5f15); if (sum != null) putIf(out, "personalSummary", mrzText(sum));
        String td = txt(t, 0x5f17);
        if (td != null) {
            JSONArray docs = new JSONArray();
            for (String d : td.split("<")) if (!d.isEmpty()) docs.put(d);
            if (docs.length() > 0) out.put("otherTravelDocuments", docs);
        }
        String cust = txt(t, 0x5f18); if (cust != null) putIf(out, "custody", mrzText(cust));
        byte[] proof = val(t, 0x5f16); if (proof != null && found != null) pushImage(found, 11, "document", proof, "proof-of-citizenship");
        return out;
    }

    /** DG12: additional document details (command.ts MrtdDocument). */
    public static JSONObject parseDg12(byte[] dg) throws JSONException { return parseDg12(dg, null); }

    private static JSONObject parseDg12(byte[] dg, Found found) throws JSONException {
        List<Apdu.Tlv> t = Apdu.decodeTlv(dg, true);
        JSONObject out = new JSONObject();
        String auth = txt(t, 0x5f19); if (auth != null) putIf(out, "issuingAuthority", mrzText(auth));
        byte[] doi = val(t, 0x5f26); if (doi != null && doi.length > 0) putIf(out, "dateOfIssue", dateField(doi));
        JSONArray persons = texts(t, 0x5f1a); if (persons.length() > 0) out.put("otherPersons", persons);
        putIf(out, "endorsements", txt(t, 0x5f1b));
        putIf(out, "taxExit", txt(t, 0x5f1c));
        byte[] pt = val(t, 0x5f55); if (pt != null && pt.length > 0) putIf(out, "personalizationTime", dateField(pt));
        putIf(out, "personalizationDevice", txt(t, 0x5f56));
        if (found != null) {
            byte[] front = val(t, 0x5f1d); if (front != null) pushImage(found, 12, "document", front, "document-front");
            byte[] rear = val(t, 0x5f1e); if (rear != null) pushImage(found, 12, "document", rear, "document-rear");
        }
        return out;
    }

    /** DG16: persons to notify ("name · telephone · address"). */
    public static List<String> parseDg16(byte[] dg) {
        List<Apdu.Tlv> t = Apdu.decodeTlv(dg, true);
        List<Apdu.Tlv> people = new ArrayList<>(Apdu.findAllTlv(t, 0xa1));
        people.addAll(Apdu.findAllTlv(t, 0xa2));
        people.addAll(Apdu.findAllTlv(t, 0xa3));
        List<String> out = new ArrayList<>();
        for (Apdu.Tlv p : people) {
            List<String> bits = new ArrayList<>();
            String name = txt(p.children, 0x5f51), tel = txt(p.children, 0x5f52), addr = txt(p.children, 0x5f53);
            if (name != null && !mrzText(name).isEmpty()) bits.add(mrzText(name));
            if (tel != null) bits.add(tel);
            if (addr != null && !mrzText(addr).isEmpty()) bits.add(mrzText(addr));
            if (!bits.isEmpty()) out.add(String.join(" · ", bits));
        }
        return out;
    }

    /** DG13 (optional, country-defined): readable text when it is text, else hex. */
    private static String optionalText(byte[] dg) {
        List<Apdu.Tlv> t = Apdu.decodeTlv(dg, false);
        byte[] body = t.isEmpty() ? dg : t.get(0).value;
        int printable = 0;
        for (byte b : body) if ((b & 0xff) >= 0x20 && (b & 0xff) < 0x7f) printable++;
        String s = printable > body.length * 0.85 ? Asn1.text(body).trim() : Apdu.hex(body).toUpperCase();
        return s.length() > 4000 ? s.substring(0, 4000) : s;
    }

    /** The body of a data group (the value inside its outer tag). */
    private static byte[] body(byte[] dg) {
        List<Apdu.Tlv> t = Apdu.decodeTlv(dg, false);
        return t.isEmpty() ? dg : t.get(0).value;
    }

    /** DG15: the Active Authentication public key — its algorithm and size ("RSA 1024", "EC brainpoolP256r1 (256 bit)"). */
    public static String aaKeyText(byte[] dg) {
        List<Apdu.Tlv> t = Asn1.der(dg);
        Apdu.Tlv top = Asn1.at(t, 0);
        Apdu.Tlv spki = top != null && top.tag != Asn1.SEQ ? Asn1.at(Asn1.kids(top), 0) : top;
        List<Apdu.Tlv> sk = Asn1.kids(spki);
        Apdu.Tlv alg = Asn1.at(sk, 0), key = Asn1.at(sk, 1);
        List<Apdu.Tlv> ak = Asn1.kids(alg);
        Apdu.Tlv algOid = Asn1.at(ak, 0), params = Asn1.at(ak, 1);
        if (algOid == null || algOid.tag != Asn1.OID) return "";
        String name = Asn1.oidName(Asn1.oidText(algOid.value));
        if (name.equals("RSA") && key != null && key.tag == Asn1.BITS) {
            Apdu.Tlv mod = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(key), 0)), 0); // BIT STRING { RSAPublicKey { modulus, exponent } }
            if (mod != null) { int len = mod.value.length; if (len > 0 && mod.value[0] == 0) len--; return "RSA " + (len * 8); }
            return "RSA";
        }
        if (name.equals("EC")) {
            String curve = params != null && params.tag == Asn1.OID ? Asn1.oidName(Asn1.oidText(params.value)) : "explicit parameters";
            long bits = key != null && key.tag == Asn1.BITS ? Math.round(((key.value.length - 2) / 2.0) * 8) : 0;
            return "EC " + curve + (bits != 0 ? " (" + bits + " bit)" : "");
        }
        return name;
    }

    /** EF.SOD, parsed: the hash algorithm, each group's hash, the document signer and its certificate. */
    public static final class Sod {
        public String hashAlgorithm;
        public final Map<Integer, byte[]> hashes = new HashMap<>();
        public JSONObject signer;
        public byte[] certificate;
    }

    private static Apdu.Tlv firstWithTag(List<Apdu.Tlv> list, int tag, int fromIndex) {
        for (int i = Math.max(0, fromIndex); i < list.size(); i++) if (list.get(i).tag == tag) return list.get(i);
        return null;
    }

    private static byte[] derLen(int n) {
        if (n < 0x80) return Apdu.u8(n);
        if (n < 0x100) return Apdu.u8(0x81, n);
        if (n < 0x10000) return Apdu.u8(0x82, n >> 8, n & 0xff);
        return Apdu.u8(0x83, n >> 16, (n >> 8) & 0xff, n & 0xff);
    }

    /** EF.SOD: the hash algorithm, each group's hash, and the document signer certificate. */
    public static Sod parseSod(byte[] sod) {
        Sod out = new Sod();
        List<Apdu.Tlv> top = Asn1.der(sod);
        Apdu.Tlv t0 = Asn1.at(top, 0);
        Apdu.Tlv ci = t0 != null && t0.tag == 0x77 ? Asn1.at(Asn1.kids(t0), 0) : t0; // ContentInfo
        Apdu.Tlv signedData = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(ci), 1)), 0);
        List<Apdu.Tlv> sd = Asn1.kids(signedData);
        Apdu.Tlv encap = firstWithTag(sd, Asn1.SEQ, 2);
        Apdu.Tlv eContent = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(encap), 1)), 0);
        if (eContent != null && eContent.tag == Asn1.OCTETS) {
            List<Apdu.Tlv> lds = Asn1.kids(Asn1.at(Asn1.der(eContent.value), 0));
            List<Apdu.Tlv> seqs = new ArrayList<>();
            for (Apdu.Tlv n : lds) if (n.tag == Asn1.SEQ) seqs.add(n);
            Apdu.Tlv algOid = Asn1.at(Asn1.kids(Asn1.at(seqs, 0)), 0);
            if (algOid != null && algOid.tag == Asn1.OID) out.hashAlgorithm = Asn1.oidName(Asn1.oidText(algOid.value));
            for (Apdu.Tlv item : Asn1.kids(Asn1.at(seqs, 1))) {
                List<Apdu.Tlv> k = Asn1.kids(item);
                Apdu.Tlv num = Asn1.at(k, 0), value = Asn1.at(k, 1);
                if (num != null && value != null && num.value.length > 0) out.hashes.put(num.value[num.value.length - 1] & 0xff, value.value);
            }
        }
        Apdu.Tlv cert = Asn1.at(Asn1.kids(firstWithTag(sd, 0xa0, 0)), 0);
        if (cert == null) return out;
        out.signer = Asn1.certInfo(cert);
        // The certificate's own bytes (header + value), for the download.
        out.certificate = Apdu.concat(Apdu.u8(0x30), derLen(cert.value.length), cert.value);
        return out;
    }

    /** SHA-1/256/384/512 of the bytes, or null for another algorithm (then the group is not checked). */
    private static byte[] digest(String alg, byte[] data) {
        if (!Arrays.asList("SHA-1", "SHA-256", "SHA-384", "SHA-512").contains(alg)) return null;
        try { return MessageDigest.getInstance(alg).digest(data); } catch (NoSuchAlgorithmException e) { return null; }
    }

    private static JSONObject rawFile(String name, byte[] bytes, String mime) throws JSONException {
        return new JSONObject().put("name", name).put("mime", mime).put("data", b64(bytes));
    }

    private static JSONObject rawFile(String name, byte[] bytes) throws JSONException { return rawFile(name, bytes, "application/octet-stream"); }

    private static String fidHex(int fid) { return String.format("%04X", fid & 0xffff); }

    private static JSONObject fileInfo(String name, int fid, String status) throws JSONException {
        return new JSONObject().put("name", name).put("fid", fidHex(fid)).put("status", status);
    }

    private static String msg(Exception e) { return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(); }

    /* ------------------------------------------------------------------ public */

    /**
     * Reads an MRTD (passport / e-ID) into an {@code mrtd} JSONObject (the
     * NfcResult contract, command.ts MrtdData). The holder supplies the MRZ (or
     * just the three BAC fields) or the CAN. PACE is used when the chip offers a
     * variant this reader runs, BAC otherwise; nothing is forced.
     */
    public static JSONObject readMrtd(Apdu.Transceiver t, Options opts) throws JSONException {
        if (opts == null) opts = new Options();
        JSONObject out = new JSONObject().put("present", true).put("access", "none");
        JSONArray files = new JSONArray();
        JSONArray rawFiles = new JSONArray();
        Found found = new Found();
        List<String> protocols = new ArrayList<>();
        JSONObject security = new JSONObject();
        Sender plainSend = cmd -> { Apdu.Response r = plain(t, cmd); return new SmChannel.Reply(r.data, r.sw); };

        // EF.CardAccess sits in the master file, readable without a key: it says whether the chip runs PACE.
        List<Pace.Info> paceInfos = new ArrayList<>();
        try {
            FileRead ca = readFile(plainSend, EF_CARD_ACCESS, 2048);
            if (ca.bytes != null) {
                Pace.SecurityInfos sec = Pace.parseSecurityInfos(ca.bytes);
                paceInfos = sec.pace;
                protocols.addAll(sec.protocols);
                files.put(fileInfo("CardAccess", EF_CARD_ACCESS, "read").put("size", ca.bytes.length));
                rawFiles.put(rawFile("EF.CardAccess.bin", ca.bytes));
            }
        } catch (Exception e) { /* an older chip: no EF.CardAccess */ }
        Pace.Info pace = Pace.choose(paceInfos);
        JSONObject paceJson = new JSONObject();
        if (!paceInfos.isEmpty()) {
            Pace.Info shown = pace != null ? pace : paceInfos.get(0);
            paceJson.put("supported", true).put("protocol", shown.name);
            if (shown.parameterId != null) paceJson.put("parameterId", shown.parameterId.intValue());
        } else paceJson.put("supported", false);
        out.put("pace", paceJson);

        Bac.MrzKey key = opts.key != null ? opts.key : (opts.mrz != null ? Bac.mrzKeyFromMrz(opts.mrz) : null);
        String can = opts.can != null && opts.can.trim().matches("\\d{6}") ? opts.can.trim() : null;
        if (key == null && can == null) {
            if (!protocols.isEmpty()) out.put("security", new JSONObject().put("protocols", new JSONArray(protocols)));
            return out.put("files", files).put("message", cz.m5cet.app.core.Texts.t("nfc.eid.needKey", "Give the MRZ (document number, date of birth, expiry) or the CAN printed on the document to open the chip."));
        }

        // Open the document: PACE when the chip offers a variant this reader runs, else BAC.
        SmChannel ch = null;
        List<String> failures = new ArrayList<>();
        if (pace != null) {
            try {
                ch = Pace.establish(t, pace, can != null ? Pace.Password.can(can) : Pace.Password.mrz(key));
                SmChannel.Reply sel = ch.send(Apdu.apdu(0x00, 0xa4, 0x04, 0x0c, MRTD_AID, -1));
                if (!Apdu.isOk(sel.sw)) throw new IOException("the eMRTD application did not open after PACE");
                out.put("access", "pace");
                paceJson.put("used", true).put("password", can != null ? "can" : "mrz");
            } catch (Exception e) { ch = null; failures.add("PACE: " + msg(e)); }
        } else if (!paceInfos.isEmpty()) {
            List<String> names = new ArrayList<>();
            for (Pace.Info p : paceInfos) {
                String param = p.parameterId == null ? "" : " (" + (Pace.PARAMETERS.containsKey(p.parameterId) ? Pace.PARAMETERS.get(p.parameterId) : String.valueOf(p.parameterId)) + ")";
                names.add(p.name + param);
            }
            failures.add("PACE: " + String.join(", ", names) + " — not a variant this reader runs");
        }
        if (ch == null && key != null) {
            try {
                try { plain(t, Apdu.selectByAid(MRTD_AID)); } catch (IOException e) { /* some chips select on first read */ }
                ch = doBac(t, key);
                out.put("access", "bac");
            } catch (Exception e) { failures.add("BAC: " + msg(e)); }
        }
        if (ch == null) {
            String hint = key == null && can != null && pace == null ? " — " + cz.m5cet.app.core.Texts.t("nfc.eid.needsMrz", "this document needs the MRZ (BAC)") : "";
            if (!protocols.isEmpty()) out.put("security", new JSONObject().put("protocols", new JSONArray(protocols)));
            return out.put("files", files).put("message", (failures.isEmpty() ? cz.m5cet.app.core.Texts.t("nfc.eid.notOpened", "the document could not be opened") : String.join("; ", failures)) + hint);
        }
        final SmChannel channel = ch;
        Sender send = channel::send;

        // EF.COM — which groups are there.
        List<Integer> groups = new ArrayList<>();
        FileRead com;
        try { com = readFile(send, EF_COM, 1024); } catch (Exception e) { com = FileRead.refused(0x6f00); }
        if (com.bytes != null) {
            Com c = parseCom(com.bytes);
            groups = c.groups;
            if (c.lds != null) out.put("ldsVersion", c.lds);
            if (c.unicode != null) out.put("unicodeVersion", c.unicode);
            files.put(fileInfo("COM", EF_COM, "read").put("size", com.bytes.length));
            rawFiles.put(rawFile("EF.COM.bin", com.bytes));
        } else files.put(fileInfo("COM", EF_COM, statusOf(com.sw)));
        if (groups.isEmpty()) groups = !opts.all ? Arrays.asList(1, 2) : Arrays.asList(1, 2, 5, 7, 11, 12, 13, 14, 15, 16);
        JSONArray dgNames = new JSONArray();
        for (int n : groups) dgNames.put("DG" + n);
        out.put("dataGroups", dgNames);

        // EF.SOD — the hashes every group is checked against, and the signer.
        Sod sod = null;
        if (opts.all) {
            FileRead s;
            try { s = readFile(send, EF_SOD, 32_768); } catch (Exception e) { s = FileRead.refused(0x6f00); }
            if (s.bytes != null) {
                try { sod = parseSod(s.bytes); } catch (RuntimeException e) { sod = null; }
                files.put(fileInfo("SOD", EF_SOD, "read").put("size", s.bytes.length));
                rawFiles.put(rawFile("EF.SOD.bin", s.bytes));
                if (sod != null && sod.certificate != null) rawFiles.put(rawFile("document-signer.cer", sod.certificate, "application/pkix-cert"));
            } else files.put(fileInfo("SOD", EF_SOD, statusOf(s.sw)));
        }

        int checked = 0, mismatched = 0;
        List<Integer> sorted = new ArrayList<>(groups);
        Collections.sort(sorted);
        for (int n : sorted) {
            String name = "DG" + n;
            int fid = dgFid(n);
            if (EAC_GROUPS.contains(n)) { files.put(fileInfo(name, fid, "protected").put("message", cz.m5cet.app.core.Texts.t("nfc.eid.eac", "Extended Access Control (a government terminal certificate)"))); continue; }
            if (!opts.all && n > 2) continue;
            if (!opts.readPhoto && IMAGE_GROUPS.contains(n)) { files.put(fileInfo(name, fid, "absent").put("message", cz.m5cet.app.core.Texts.t("nfc.eid.imagesOff", "not read (images off)"))); continue; }
            FileRead r;
            try { r = readFile(send, fid, CAP.containsKey(n) ? CAP.get(n) : 32_768); }
            catch (Exception e) { files.put(fileInfo(name, fid, "error").put("message", msg(e))); continue; }
            if (r.bytes == null) { files.put(fileInfo(name, fid, statusOf(r.sw))); continue; }
            JSONObject info = fileInfo(name, fid, "read").put("size", r.bytes.length);
            if (!r.complete) info.put("message", "truncated");
            // Passive authentication of what was read: the group's hash against EF.SOD.
            byte[] want = sod != null ? sod.hashes.get(n) : null;
            if (want != null && sod.hashAlgorithm != null && r.complete) {
                byte[] got = digest(sod.hashAlgorithm, r.bytes);
                if (got != null) { boolean ok = Arrays.equals(got, want); info.put("hashOk", ok); checked++; if (!ok) mismatched++; }
            }
            files.put(info);
            try {
                switch (n) {
                    case 1: { JSONObject m = mrzFromDg1(r.bytes); if (m != null) out.put("mrzInfo", m); rawFiles.put(rawFile("DG1.bin", r.bytes)); break; }
                    case 2: {
                        List<Face> faces = facesFromDg2(r.bytes);
                        for (int i = 0; i < faces.size(); i++) {
                            Face f = faces.get(i);
                            found.images.put(new JSONObject().put("group", "DG2").put("kind", "face").put("mime", f.mime).put("data", b64(f.data))
                                .put("name", "face" + (i > 0 ? "-" + (i + 1) : "") + "." + extOf(f.mime)));
                        }
                        break;
                    }
                    case 5: for (Apdu.Tlv p : Apdu.findAllTlv(Apdu.decodeTlv(r.bytes, true), 0x5f40)) pushImage(found, 5, "portrait", p.value, "portrait"); break;
                    case 7: for (Apdu.Tlv p : Apdu.findAllTlv(Apdu.decodeTlv(r.bytes, true), 0x5f43)) pushImage(found, 7, "signature", p.value, "signature"); break;
                    case 11: { JSONObject p = parseDg11(r.bytes, opts.readPhoto ? found : null); if (p.length() > 0) out.put("personal", p); rawFiles.put(rawFile("DG11.bin", r.bytes)); break; }
                    case 12: { JSONObject d = parseDg12(r.bytes, opts.readPhoto ? found : null); if (d.length() > 0) out.put("document", d); rawFiles.put(rawFile("DG12.bin", r.bytes)); break; }
                    case 13: out.put("optional", optionalText(r.bytes)); rawFiles.put(rawFile("DG13.bin", r.bytes)); break;
                    case 14: {
                        for (String p : Pace.parseSecurityInfos(body(r.bytes)).protocols) if (!protocols.contains(p)) protocols.add(p);
                        rawFiles.put(rawFile("DG14.bin", r.bytes));
                        break;
                    }
                    case 15: {
                        String k = aaKeyText(body(r.bytes));
                        if (!k.isEmpty()) security.put("activeAuthKey", k);
                        if (!protocols.contains("Active Authentication")) protocols.add("Active Authentication");
                        rawFiles.put(rawFile("DG15.bin", r.bytes));
                        break;
                    }
                    case 16: { List<String> p = parseDg16(r.bytes); if (!p.isEmpty()) out.put("personsToNotify", new JSONArray(p)); rawFiles.put(rawFile("DG16.bin", r.bytes)); break; }
                    default: rawFiles.put(rawFile(name + ".bin", r.bytes));
                }
            } catch (Exception e) {
                info.put("message", cz.m5cet.app.core.Texts.f("nfc.eid.parseFailed", "could not parse: {0}", msg(e)));
                rawFiles.put(rawFile(name + ".bin", r.bytes));
            }
        }

        if (sod != null && sod.hashAlgorithm != null) security.put("hashAlgorithm", sod.hashAlgorithm);
        if (sod != null && sod.signer != null && (sod.signer.has("subject") || sod.signer.has("issuer"))) security.put("signer", sod.signer);
        security.put("passive", sod == null || checked == 0 ? "unchecked" : mismatched > 0 ? "mismatch" : "ok");
        if (!protocols.isEmpty()) security.put("protocols", new JSONArray(protocols));
        out.put("security", security);
        if (found.images.length() > 0) {
            out.put("images", found.images);
            for (int i = 0; i < found.images.length(); i++) {
                JSONObject img = found.images.optJSONObject(i);
                if (img != null && "face".equals(img.optString("kind"))) { out.put("photo", img.optString("data")).put("photoMime", img.optString("mime")); break; }
            }
        }
        out.put("files", files);
        if (rawFiles.length() > 0) out.put("raw", rawFiles);
        if (!failures.isEmpty()) out.put("message", String.join("; ", failures));
        return out;
    }

    /** The NfcResult status for an MRTD read (web-executor.ts): ok when anything opened. */
    public static String statusFor(JSONObject mrtd) {
        return mrtd.has("mrzInfo") || !"none".equals(mrtd.optString("access")) ? "ok" : "auth-failed";
    }

    /** A one-line summary for a log / flash (mrtd.ts mrtdSummary). */
    public static String summary(JSONObject d) {
        JSONObject m = d.optJSONObject("mrzInfo");
        if (m == null) return !d.optString("message", "").isEmpty() ? d.optString("message") : (d.optBoolean("present") ? cz.m5cet.app.core.Texts.t("nfc.eid.sum.present", "MRTD present") : cz.m5cet.app.core.Texts.t("nfc.eid.sum.none", "no MRTD"));
        List<String> bits = new ArrayList<>();
        String name = (m.optString("givenNames", "") + " " + m.optString("surname", "")).trim();
        if (!name.isEmpty()) bits.add(name);
        if (!m.optString("documentNumber", "").isEmpty()) bits.add(m.optString("documentNumber"));
        if (!m.optString("nationality", "").isEmpty()) bits.add(m.optString("nationality"));
        String access = d.optString("access", "none");
        if (!access.isEmpty() && !access.equals("none")) bits.add(access.toUpperCase(java.util.Locale.ROOT));
        JSONArray images = d.optJSONArray("images");
        int imgs = images != null ? images.length() : (!d.optString("photo", "").isEmpty() ? 1 : 0);
        if (imgs > 0) bits.add(cz.m5cet.app.core.Texts.n("nfc.eid.sum.images", imgs, imgs > 1 ? "{n} images" : "{n} image"));
        return String.join(" · ", bits);
    }
}
