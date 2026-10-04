package cz.m5cet.app.nfc;

import static cz.m5cet.app.nfc.Tlvs.T;
import static cz.m5cet.app.nfc.Tlvs.ascii;
import static cz.m5cet.app.nfc.Tlvs.fill;
import static cz.m5cet.app.nfc.Tlvs.integer;
import static cz.m5cet.app.nfc.Tlvs.oid;
import static cz.m5cet.app.nfc.Tlvs.sw;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The deep MRTD read (6.6) — the Java port of test/nfc-mrtd-deep.test.ts —
 * against a simulated chip that runs BAC and 3DES secure messaging the way ICAO
 * 9303-11 specifies. The chip side here is written from the spec, independently
 * of the reader: it checks every MAC, decrypts every command and answers only
 * SELECT / READ BINARY. The reader opens it with the MRZ, reads EF.COM, EF.SOD
 * and every group, checks the hashes against EF.SOD and pulls out the images.
 */
public class MrtdDeepTest {

    /* ------------------------------------------------------------ the document */

    private static final String MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    private static final Bac.MrzKey KEY = new Bac.MrzKey("L898902C", "690806", "940623");
    private static final byte[] JPEG = Apdu.concat(Apdu.u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), ascii("JFIF"), fill(600, 7), Apdu.u8(0xff, 0xd9));
    private static final byte[] SIG = Apdu.concat(Apdu.u8(0xff, 0xd8, 0xff, 0xdb), fill(80, 3), Apdu.u8(0xff, 0xd9));

    private static final byte[] DG1 = T(0x61, T(0x5f1f, ascii(MRZ.replace("\n", ""))));
    private static final byte[] DG2 = T(0x75, T(0x7f61, T(0x02, Apdu.u8(1)), T(0x7f60, T(0xa1, T(0x80, Apdu.u8(1, 1))),
        T(0x5f2e, Apdu.concat(ascii("FAC\0"), new byte[40], JPEG)))));
    private static final byte[] DG7 = T(0x67, T(0x02, Apdu.u8(1)), T(0x5f43, SIG));
    private static final byte[] DG11 = T(0x6b, T(0x5c, Apdu.u8(0x5f, 0x0e, 0x5f, 0x2b, 0x5f, 0x11, 0x5f, 0x42)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")),
        T(0x5f2b, Apdu.u8(0x19, 0x69, 0x08, 0x06)), T(0x5f11, ascii("ZENITH<UTO")), T(0x5f42, ascii("123<MAPLE<STREET<<ZENITH")), T(0x5f10, ascii("ZE184226B")));
    private static final byte[] DG12 = T(0x6c, T(0x5c, Apdu.u8(0x5f, 0x19, 0x5f, 0x26)), T(0x5f19, ascii("UTOPIA<PASSPORT<OFFICE")),
        T(0x5f26, Apdu.u8(0x20, 0x24, 0x01, 0x15)), T(0x5f55, ascii("20240110093000")));
    private static final byte[] MODULUS = Apdu.concat(Apdu.u8(0x00), fill(128, 0xa5));
    private static final byte[] DG15 = T(0x6f, T(0x30, T(0x30, oid("1.2.840.113549.1.1.1"), Apdu.u8(0x05, 0x00)),
        T(0x03, Apdu.u8(0x00), T(0x30, T(0x02, MODULUS), T(0x02, Apdu.u8(1, 0, 1))))));
    private static final byte[] DG14 = T(0x6e, T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), integer(1)), T(0x30, oid("0.4.0.127.0.7.2.2.2"), integer(1))));
    private static final byte[] COM = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, Apdu.u8(0x61, 0x75, 0x63, 0x67, 0x6b, 0x6c, 0x6e, 0x6f)));

    private static byte[] sha256(byte[] b) {
        try { return MessageDigest.getInstance("SHA-256").digest(b); } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static byte[] name(String cn) {
        return T(0x30, T(0x31, T(0x30, oid("2.5.4.6"), T(0x13, ascii("UT")))), T(0x31, T(0x30, oid("2.5.4.3"), T(0x0c, ascii(cn)))));
    }

    private static byte[] certificate() {
        byte[] tbs = T(0x30, T(0xa0, integer(2)), T(0x02, Apdu.u8(0x12, 0x34)), T(0x30, oid("1.2.840.113549.1.1.11")), name("CSCA Utopia"),
            T(0x30, T(0x17, ascii("240101000000Z")), T(0x17, ascii("340101000000Z"))), name("DS Utopia 1"),
            T(0x30, T(0x30, oid("1.2.840.113549.1.1.1")), T(0x03, Apdu.u8(0))));
        return T(0x30, tbs, T(0x30, oid("1.2.840.113549.1.1.11")), T(0x03, Apdu.u8(0, 1, 2)));
    }

    private static byte[] sod(Map<Integer, byte[]> groups, int tamper) {
        List<byte[]> hashes = new ArrayList<>();
        for (Map.Entry<Integer, byte[]> g : new TreeMap<>(groups).entrySet()) {
            byte[] h = sha256(g.getValue());
            if (g.getKey() == tamper) h[0] ^= 1;
            hashes.add(T(0x30, integer(g.getKey()), T(0x04, h)));
        }
        byte[] lds = T(0x30, integer(0), T(0x30, oid("2.16.840.1.101.3.4.2.1")), T(0x30, hashes.toArray(new byte[0][])));
        byte[] signedData = T(0x30, integer(3), T(0x31, T(0x30, oid("2.16.840.1.101.3.4.2.1"))), T(0x30, oid("2.23.136.1.1.1"), T(0xa0, T(0x04, lds))),
            T(0xa0, certificate()), T(0x31));
        return T(0x77, T(0x30, oid("1.2.840.113549.1.7.2"), T(0xa0, signedData)));
    }

    private static Map<Integer, byte[]> files(int tamper) {
        Map<Integer, byte[]> groups = new LinkedHashMap<>();
        groups.put(1, DG1); groups.put(2, DG2); groups.put(7, DG7); groups.put(11, DG11); groups.put(12, DG12); groups.put(14, DG14); groups.put(15, DG15);
        Map<Integer, byte[]> f = new LinkedHashMap<>();
        f.put(0x011e, COM); f.put(0x011d, sod(groups, tamper));
        f.put(0x0101, DG1); f.put(0x0102, DG2); f.put(0x0107, DG7); f.put(0x010b, DG11); f.put(0x010c, DG12); f.put(0x010e, DG14); f.put(0x010f, DG15);
        return f;
    }

    static Map<Integer, byte[]> files() { return files(-1); }

    /* ------------------------------------------------------------ the chip */

    /** A BAC chip from the spec: plain until mutual authentication, then every APDU in SM. */
    static final class Chip implements Apdu.Transceiver {
        final List<String> log = new ArrayList<>();
        /** Every file id the chip was asked to SELECT (plain or in SM, decrypted). */
        final List<Integer> selected = new ArrayList<>();
        private final Map<Integer, byte[]> files;
        private final byte[] cardAccess;
        private final byte[] kenc, kmac;
        private final SecureRandom rng = new SecureRandom();
        private byte[] rndIcc;
        private byte[] ksenc, ksmac, ssc;
        private Integer current;

        Chip(Bac.MrzKey key, Map<Integer, byte[]> files, byte[] cardAccess) {
            this.files = files; this.cardAccess = cardAccess;
            Bac.Keys k = Bac.bacKeys(key);
            kenc = k.kenc; kmac = k.kmac;
        }

        Chip(Bac.MrzKey key, Map<Integer, byte[]> files) { this(key, files, null); }

        private byte[] random(int n) { byte[] b = new byte[n]; rng.nextBytes(b); return b; }

        private static void inc(byte[] s) { for (int i = s.length - 1; i >= 0; i--) { s[i] = (byte) (s[i] + 1); if (s[i] != 0) break; } }

        private static byte[] unpad(byte[] d) { int i = d.length - 1; while (i >= 0 && d[i] == 0) i--; return Apdu.slice(d, 0, i); }

        private static final class Answer { final byte[] data; final int sw; Answer(byte[] d, int s) { data = d; sw = s; } }

        /** Plain command logic: SELECT / READ BINARY over the files. */
        private Answer run(int ins, int p1, int p2, byte[] data, Integer le) {
            if (ins == 0xa4 && p1 == 0x04) {
                boolean app = Apdu.hex(data).equals("A0000002471001");
                return new Answer(new byte[0], app ? 0x9000 : 0x6a82);
            }
            if (ins == 0xa4) {
                int fid = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
                selected.add(fid);
                if (fid == 0x011c && cardAccess != null) { current = fid; return new Answer(new byte[0], 0x9000); }
                if (fid == 0x0103 || fid == 0x0104) return new Answer(new byte[0], 0x6982);
                if (!files.containsKey(fid)) return new Answer(new byte[0], 0x6a82);
                current = fid;
                return new Answer(new byte[0], 0x9000);
            }
            if (ins == 0xb0) {
                byte[] f = current == null ? null : current == 0x011c ? cardAccess : files.get(current);
                if (f == null) return new Answer(new byte[0], 0x6986);
                int off = (p1 << 8) | p2;
                int n = le == null || le == 0 ? 256 : le;
                return new Answer(Apdu.slice(f, off, off + n), off + n > f.length ? 0x6282 : 0x9000);
            }
            return new Answer(new byte[0], 0x6d00);
        }

        @Override public byte[] transmit(byte[] a) {
            log.add(Apdu.hex(a));
            if (ssc == null) {
                int ins = a[1] & 0xff, p1 = a[2] & 0xff, p2 = a[3] & 0xff;
                if (ins == 0x84) { rndIcc = random(8); return Apdu.concat(rndIcc, sw(0x9000)); }
                if (ins == 0x82) {
                    byte[] body = Apdu.slice(a, 5, 5 + (a[4] & 0xff));
                    byte[] eifd = Apdu.slice(body, 0, 32), mifd = Apdu.slice(body, 32, 40);
                    if (!Arrays.equals(Des.retailMac(kmac, Des.pad(eifd)), mifd)) return sw(0x6300);
                    byte[] s = Des.tdesCbcDecrypt(kenc, eifd);
                    byte[] rndIfd = Apdu.slice(s, 0, 8), kifd = Apdu.slice(s, 16, 32);
                    if (!Arrays.equals(Apdu.slice(s, 8, 16), rndIcc)) return sw(0x6300);
                    byte[] kicc = random(16);
                    byte[] eicc = Des.tdesCbcEncrypt(kenc, Apdu.concat(rndIcc, rndIfd, kicc));
                    byte[] micc = Des.retailMac(kmac, Des.pad(eicc));
                    byte[] seed = new byte[16];
                    for (int i = 0; i < 16; i++) seed[i] = (byte) (kifd[i] ^ kicc[i]);
                    ksenc = Bac.deriveKey(seed, 1); ksmac = Bac.deriveKey(seed, 2);
                    ssc = Apdu.concat(Apdu.slice(rndIcc, 4, 8), Apdu.slice(rndIfd, 4, 8));
                    return Apdu.concat(eicc, micc, sw(0x9000));
                }
                int lc = a.length > 5 ? a[4] & 0xff : 0;
                Integer le = a.length == 5 ? Integer.valueOf(a[4] & 0xff) : a.length > 5 + lc ? Integer.valueOf(a[5 + lc] & 0xff) : null;
                Answer r = run(ins, p1, p2, Apdu.slice(a, 5, 5 + lc), le);
                return Apdu.concat(r.data, sw(r.sw));
            }
            // Secure messaging: check the MAC, decrypt, run, wrap the answer.
            if ((a[0] & 0x0c) != 0x0c) return sw(0x6987);
            byte[] body = Apdu.slice(a, 5, 5 + (a[4] & 0xff));
            Apdu.Tlv do87 = null, do97 = null, do8e = null;
            for (Apdu.Tlv n : Apdu.decodeTlv(body, false)) {
                if (n.tag == 0x87) do87 = n; else if (n.tag == 0x97) do97 = n; else if (n.tag == 0x8e) do8e = n;
            }
            inc(ssc);
            byte[] macIn = Des.pad(Apdu.concat(ssc, Des.pad(Apdu.slice(a, 0, 4)),
                do87 != null ? T(0x87, do87.value) : new byte[0], do97 != null ? T(0x97, do97.value) : new byte[0]));
            if (do8e == null || !Arrays.equals(Des.retailMac(ksmac, macIn), do8e.value)) return sw(0x6988);
            byte[] data = do87 != null ? unpad(Des.tdesCbcDecrypt(ksenc, Apdu.slice(do87.value, 1))) : new byte[0];
            Answer r = run(a[1] & 0xff, a[2] & 0xff, a[3] & 0xff, data, do97 != null ? Integer.valueOf(do97.value[0] & 0xff) : null);
            inc(ssc);
            byte[] r87 = r.data.length > 0 ? T(0x87, Apdu.u8(0x01), Des.tdesCbcEncrypt(ksenc, Des.pad(r.data))) : new byte[0];
            byte[] r99 = T(0x99, sw(r.sw));
            byte[] mac = Des.retailMac(ksmac, Des.pad(Apdu.concat(ssc, r87, r99)));
            return Apdu.concat(r87, r99, T(0x8e, mac), sw(0x9000));
        }
    }

    /* ------------------------------------------------------------ helpers */

    private static MrtdReader.Options mrz() { MrtdReader.Options o = new MrtdReader.Options(); o.mrz = MRZ; return o; }

    private static JSONObject file(JSONObject d, String name) {
        JSONArray files = d.optJSONArray("files");
        for (int i = 0; i < files.length(); i++) if (name.equals(files.optJSONObject(i).optString("name"))) return files.optJSONObject(i);
        return null;
    }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        if (a != null) for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    /* ------------------------------------------------------------ the deep read */

    @Test
    public void opensTheDocumentWithTheMrzAndReadsEveryGroupItMay() throws Exception {
        Chip chip = new Chip(KEY, files());
        JSONObject d = MrtdReader.readMrtd(chip, mrz());
        assertEquals("bac", d.optString("access"));
        JSONObject pace = d.optJSONObject("pace");
        assertFalse(pace.optBoolean("supported", true));
        assertEquals(1, pace.length());
        assertEquals(Arrays.asList("DG1", "DG2", "DG3", "DG7", "DG11", "DG12", "DG14", "DG15"), strings(d.optJSONArray("dataGroups")));
        assertEquals("1.7", d.optString("ldsVersion"));
        assertEquals("4.0.0", d.optString("unicodeVersion"));
        JSONObject m = d.optJSONObject("mrzInfo");
        assertEquals("ERIKSSON", m.optString("surname"));
        assertEquals("L898902C", m.optString("documentNumber"));
        JSONObject p = d.optJSONObject("personal");
        assertEquals("ERIKSSON, ANNA MARIA", p.optString("fullName"));
        assertEquals("1969-08-06", p.optString("fullDateOfBirth"));
        assertEquals("ZENITH UTO", p.optString("placeOfBirth"));
        assertEquals("123 MAPLE STREET, ZENITH", p.optString("address"));
        assertEquals("ZE184226B", p.optString("personalNumber"));
        JSONObject doc = d.optJSONObject("document");
        assertEquals("UTOPIA PASSPORT OFFICE", doc.optString("issuingAuthority"));
        assertEquals("2024-01-15", doc.optString("dateOfIssue"));
        assertEquals("2024-01-10 09:30:00", doc.optString("personalizationTime"));
        // Fingerprints are EAC — never tried.
        assertEquals("protected", file(d, "DG3").optString("status"));
        assertFalse(chip.selected.contains(0x0103));
        // Images: the face and the signature, as JPEG.
        JSONArray images = d.optJSONArray("images");
        assertEquals(2, images.length());
        String[][] want = {{"face", "DG2", "image/jpeg", "face.jpg"}, {"signature", "DG7", "image/jpeg", "signature.jpg"}};
        for (int i = 0; i < want.length; i++) {
            JSONObject img = images.optJSONObject(i);
            assertArrayEquals(want[i], new String[]{img.optString("kind"), img.optString("group"), img.optString("mime"), img.optString("name")});
        }
        assertEquals("image/jpeg", d.optString("photoMime"));
        assertArrayEquals(Apdu.u8(0xff, 0xd8, 0xff), Apdu.slice(Base64.getDecoder().decode(d.optString("photo")), 0, 3));
        assertArrayEquals(JPEG, Base64.getDecoder().decode(d.optString("photo")));
        // Security: passive authentication, the signer, the protocols, the AA key.
        JSONObject sec = d.optJSONObject("security");
        assertEquals("SHA-256", sec.optString("hashAlgorithm"));
        assertEquals("ok", sec.optString("passive"));
        List<String> hashOk = new ArrayList<>();
        JSONArray files = d.optJSONArray("files");
        for (int i = 0; i < files.length(); i++) if (files.optJSONObject(i).optBoolean("hashOk", false)) hashOk.add(files.optJSONObject(i).optString("name"));
        assertEquals(Arrays.asList("DG1", "DG2", "DG7", "DG11", "DG12", "DG14", "DG15"), hashOk);
        JSONObject signer = sec.optJSONObject("signer");
        assertEquals("C=UT, CN=DS Utopia 1", signer.optString("subject"));
        assertEquals("C=UT, CN=CSCA Utopia", signer.optString("issuer"));
        assertEquals("2034-01-01", signer.optString("notAfter"));
        assertEquals("1234", signer.optString("serial"));
        List<String> protocols = strings(sec.optJSONArray("protocols"));
        assertTrue(protocols.containsAll(Arrays.asList("Chip Authentication (ECDH, AES-128)", "Terminal Authentication", "Active Authentication")));
        assertEquals("RSA 1024", sec.optString("activeAuthKey"));
        // Downloads: the security objects and raw groups.
        List<String> raw = new ArrayList<>();
        JSONArray rawFiles = d.optJSONArray("raw");
        for (int i = 0; i < rawFiles.length(); i++) raw.add(rawFiles.optJSONObject(i).optString("name"));
        assertTrue(raw.containsAll(Arrays.asList("EF.COM.bin", "EF.SOD.bin", "document-signer.cer", "DG1.bin", "DG11.bin", "DG12.bin", "DG14.bin", "DG15.bin")));
        assertFalse(d.has("message"));
        assertEquals("ok", MrtdReader.statusFor(d));
        assertTrue(MrtdReader.summary(d).contains("BAC"));
        assertTrue(MrtdReader.summary(d).contains("2 images"));
    }

    @Test
    public void flagsAGroupWhoseHashDoesNotMatchEfSod() throws Exception {
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, files(11)), mrz());
        assertEquals("mismatch", d.optJSONObject("security").optString("passive"));
        assertFalse(file(d, "DG11").optBoolean("hashOk", true));
        assertTrue(file(d, "DG1").optBoolean("hashOk", false));
    }

    @Test
    public void readsOnlyDg1AndDg2WhenAskedAndNoImagesWhenImagesAreOff() throws Exception {
        MrtdReader.Options o = new MrtdReader.Options();
        o.key = KEY; o.all = false; o.readPhoto = false;
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, files()), o);
        assertEquals("ERIKSSON", d.optJSONObject("mrzInfo").optString("surname"));
        assertFalse(d.has("images"));
        assertFalse(d.has("photo"));
        assertFalse(d.has("personal"));
        assertEquals("not read (images off)", file(d, "DG2").optString("message"));
        assertNull(file(d, "SOD"));
        assertEquals("unchecked", d.optJSONObject("security").optString("passive"));
    }

    @Test
    public void saysWhatWentWrongWithAWrongMrzAndReadsNothing() throws Exception {
        MrtdReader.Options o = new MrtdReader.Options();
        o.key = new Bac.MrzKey("L898902C", "690807", "940623");
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, files()), o);
        assertEquals("none", d.optString("access"));
        assertTrue(d.optString("message").contains("BAC"));
        assertFalse(d.has("mrzInfo"));
        assertEquals("auth-failed", MrtdReader.statusFor(d));
    }

    @Test
    public void asksForTheMrzOrTheCanWhenGivenNeither() throws Exception {
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, files()), new MrtdReader.Options());
        assertEquals("none", d.optString("access"));
        assertTrue(d.optString("message").matches("(?s).*MRZ.*CAN.*"));
    }

    @Test
    public void seesPaceInEfCardAccessAndFallsBackToBacWhenItCannotRunIt() throws Exception {
        byte[] cardAccess = T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(13)));
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, files(), cardAccess), mrz());
        JSONObject pace = d.optJSONObject("pace");
        assertTrue(pace.optBoolean("supported"));
        assertEquals("PACE ECDH-GM AES-128", pace.optString("protocol"));
        assertEquals(13, pace.optInt("parameterId"));
        assertFalse(pace.has("used"));
        assertEquals("bac", d.optString("access"));
        assertEquals("ERIKSSON", d.optJSONObject("mrzInfo").optString("surname"));
        assertEquals("read", file(d, "CardAccess").optString("status"));
        assertTrue(strings(d.optJSONObject("security").optJSONArray("protocols")).contains("PACE ECDH-GM AES-128"));
        assertTrue(d.optString("message").startsWith("PACE: "));
    }

    @Test
    public void reportsAListedGroupTheChipDoesNotHaveAsAbsent() throws Exception {
        // EF.COM lists DG16, but the chip answers 6A82 (inside secure messaging) to its SELECT.
        Map<Integer, byte[]> f = files();
        f.put(0x011e, T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, Apdu.u8(0x61, 0x70))));
        JSONObject d = MrtdReader.readMrtd(new Chip(KEY, f), mrz());
        assertEquals("absent", file(d, "DG16").optString("status"));
        assertEquals("read", file(d, "DG1").optString("status"));
    }

    @Test
    public void passesTheOpArgsThroughToTheRead() throws Exception {
        JSONObject r = CardOps.readResult("eid-read", new Chip(KEY, files()),
            new JSONObject().put("documentNumber", "L898902C").put("dateOfBirth", "690806").put("dateOfExpiry", "940623").put("all", false).put("readPhoto", false));
        assertEquals("ok", r.optString("status"));
        JSONObject mrtd = r.optJSONObject("mrtd");
        assertEquals("bac", mrtd.optString("access"));
        assertFalse(mrtd.has("images"));
        assertFalse(mrtd.has("personal"));
        JSONObject full = CardOps.readResult("mrtd-read", new Chip(KEY, files()), new JSONObject().put("mrz", MRZ)).optJSONObject("mrtd");
        assertTrue(full.has("personal"));
        assertEquals(2, full.optJSONArray("images").length());
        assertEquals("auth-failed", CardOps.readResult("eid-read", new Chip(KEY, files()), new JSONObject().put("can", "12")).optString("status"));
    }

    /* ------------------------------------------------------------ the security objects */

    @Test
    public void parsesEfCardAccessSecurityInfos() {
        Pace.SecurityInfos s = Pace.parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), integer(2), integer(13)),
            T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0))));
        assertEquals(2, s.pace.size());
        Pace.Info a = s.pace.get(0), b = s.pace.get(1);
        assertArrayEquals(new Object[]{"AES-256", "ECDH", "GM", 13}, new Object[]{a.cipher, a.agreement, a.mapping, a.parameterId});
        assertArrayEquals(new Object[]{"AES-128", "DH", "GM", 0}, new Object[]{b.cipher, b.agreement, b.mapping, b.parameterId});
        assertEquals(2, a.version);
        assertEquals("AES-256", Pace.choose(s.pace).cipher);
        assertNull(Pace.choose(Arrays.asList(b))); // DH is not a variant this reader runs
    }

    @Test
    public void paceRefusesAVariantThisReaderDoesNotRun() {
        Pace.Info dh = Pace.parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0)))).pace.get(0);
        try {
            Pace.establish(cmd -> { throw new IOException("no APDU for an unsupported variant"); }, dh, Pace.Password.can("123456"));
            fail("DH is not a variant this reader runs");
        } catch (Pace.UnsupportedException e) {
            assertTrue(e.getMessage().contains("PACE DH-GM AES-128"));
        } catch (Exception e) {
            fail("expected UnsupportedException, got " + e);
        }
    }

    @Test
    public void readsEfSod() {
        Map<Integer, byte[]> g = new LinkedHashMap<>();
        g.put(1, DG1); g.put(2, DG2);
        MrtdReader.Sod s = MrtdReader.parseSod(sod(g, -1));
        assertEquals("SHA-256", s.hashAlgorithm);
        assertArrayEquals(sha256(DG1), s.hashes.get(1));
        assertEquals("1234", s.signer.optString("serial"));
        assertNotNull(s.certificate);
        assertEquals(0x30, s.certificate[0] & 0xff);
        assertArrayEquals(certificate(), s.certificate);
    }

    @Test
    public void namesTheActiveAuthenticationKey() {
        assertEquals("RSA 1024", MrtdReader.aaKeyText(Apdu.decodeTlv(DG15, false).get(0).value));
        assertEquals("EC brainpoolP256r1 (256 bit)", MrtdReader.aaKeyText(T(0x30, T(0x30, oid("1.2.840.10045.2.1"), oid("1.3.36.3.3.2.8.1.1.7")),
            T(0x03, Apdu.u8(0, 4), new byte[64]))));
    }

    @Test
    public void parsesDg11AndDg12Alone() throws Exception {
        assertEquals("ERIKSSON, ANNA MARIA", MrtdReader.parseDg11(DG11).optString("fullName"));
        assertEquals("UTOPIA PASSPORT OFFICE", MrtdReader.parseDg12(DG12).optString("issuingAuthority"));
    }

    @Test
    public void oidsRoundTrip() {
        for (String o : new String[]{"0.4.0.127.0.7.2.2.4.2.2", "1.2.840.113549.1.1.1", "2.16.840.1.101.3.4.2.1", "1.3.36.3.3.2.8.1.1.7"})
            assertEquals(o, Asn1.oidText(Asn1.oidBytes(o)));
    }
}
