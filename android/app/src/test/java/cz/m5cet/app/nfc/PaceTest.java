package cz.m5cet.app.nfc;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * PACE (6.6) on Android: Aes (AES + CMAC), EcCurve (the six curves),
 * PaceProtocol (the protocol) and AesSm (AES secure messaging) — the Java port
 * of test/nfc-pace.test.ts, against the SAME official vectors
 * (src/test/resources/pace-vectors.json = test/fixtures/pace-vectors.json):
 * <ul>
 *   <li>ICAO Doc 9303 Part 11, Appendix G.1: PACE-ECDH-GM-AES-128 on brainpoolP256r1
 *       with the MRZ — every intermediate value, and every APDU replayed byte for byte;</li>
 *   <li>ICAO 9303-11 Appendix I.1 (PACE-CAM: its mapping, key agreement and tokens are the generic mapping's);</li>
 *   <li>BSI TR-03110 EAC2 Worked Example (its GlobalTester log): the PACE exchange
 *       and the 21 AES secure-messaging APDUs that follow it.</li>
 * </ul>
 * AES against FIPS-197 / SP 800-38A, CMAC against RFC 4493 (and a CBC-MAC
 * construction of it), k·G and ECDH on all six curves against node:crypto
 * (src/test/resources/pace-ec-vectors.json — the JVM has no brainpool — each kG
 * {@code createECDH(name).setPrivateKey(k).getPublicKey()}) and, live, the
 * NIST curves against the JVM's SunEC. Then a simulated PACE-only chip — written
 * here from the spec, its symmetric crypto straight from javax.crypto / Des, its
 * points from EcCurve — is opened end to end with the CAN and with the MRZ.
 */
public class PaceTest {

    /* ------------------------------------------------------------ helpers */

    private static byte[] b(String h) { return Apdu.unhex(h); }
    private static String H(byte[] u) { return Apdu.hex(u); }
    private static BigInteger big(String h) { return new BigInteger(h, 16); }
    private static byte[] ascii(String s) { return s.getBytes(StandardCharsets.US_ASCII); }
    private static byte[] T(int tag, byte[]... v) { return PaceProtocol.tlv(tag, Apdu.concat(v)); }
    private static byte[] oid(String s) { return T(0x06, PaceProtocol.oidBytes(s)); }
    private static byte[] integer(int n) { return T(0x02, Apdu.u8(n)); }
    private static byte[] sw(int n) { return Apdu.u8(n >> 8, n); }
    private static String plainAnswer(Bac.Sm r) { return H(Apdu.concat(r.data, sw(r.sw))); }

    private static JSONObject V, G1, I1, BSI, EC;

    private static JSONObject resource(String name) throws Exception {
        try (InputStream in = PaceTest.class.getClassLoader().getResourceAsStream(name)) {
            if (in == null) throw new IOException(name + " is not on the test classpath (src/test/resources)");
            return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @BeforeClass
    public static void load() throws Exception {
        V = resource("pace-vectors.json");
        G1 = V.getJSONObject("icaoG");
        I1 = V.getJSONObject("icaoI");
        BSI = V.getJSONObject("bsi");
        EC = resource("pace-ec-vectors.json");
    }

    private static List<String[]> pairs(JSONArray a) throws Exception {
        List<String[]> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) { JSONArray p = a.getJSONArray(i); out.add(new String[]{p.getString(0), p.getString(1)}); }
        return out;
    }

    private static Bac.MrzKey mrz(JSONObject m) throws Exception {
        return new Bac.MrzKey(m.getString("documentNumber"), m.getString("dateOfBirth"), m.getString("dateOfExpiry"));
    }

    /** The PACEInfo a vector announces, parsed the way EF.CardAccess is. */
    private static PaceProtocol.Info infoOf(String paceInfo) { return PaceProtocol.parseSecurityInfos(T(0x31, b(paceInfo))).pace.get(0); }

    /** RFC 4493 CMAC as a CBC-MAC (javax AES-CBC, zero IV) over the subkey-masked message — a construction independent of Aes.cmac. */
    private static byte[] refCmac(byte[] key, byte[] m) {
        try {
            Cipher ecb = Cipher.getInstance("AES/ECB/NoPadding");
            ecb.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
            BigInteger mask = BigInteger.ONE.shiftLeft(128).subtract(BigInteger.ONE), rb = BigInteger.valueOf(0x87);
            BigInteger L = new BigInteger(1, ecb.doFinal(new byte[16]));
            BigInteger k1 = L.shiftLeft(1).and(mask), k2;
            if (L.testBit(127)) k1 = k1.xor(rb);
            k2 = k1.shiftLeft(1).and(mask);
            if (k1.testBit(127)) k2 = k2.xor(rb);
            int n = Math.max(1, (m.length + 15) / 16);
            boolean whole = m.length > 0 && m.length % 16 == 0;
            byte[] x = Arrays.copyOf(m, n * 16);
            if (!whole) x[m.length] = (byte) 0x80;
            byte[] sub = EcCurve.bigIntToBytes(whole ? k1 : k2, 16);
            for (int j = 0; j < 16; j++) x[(n - 1) * 16 + j] ^= sub[j];
            Cipher cbc = Cipher.getInstance("AES/CBC/NoPadding");
            cbc.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(new byte[16]));
            return Apdu.slice(cbc.doFinal(x), (n - 1) * 16);
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static byte[] javaxAes(String mode, int dir, byte[] key, byte[] data, byte[] iv) {
        try {
            Cipher c = Cipher.getInstance("AES/" + mode + "/NoPadding");
            if (iv == null) c.init(dir, new SecretKeySpec(key, "AES")); else c.init(dir, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
            return c.doFinal(data);
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static byte[] hash(String alg, byte[] data) {
        try { return MessageDigest.getInstance(alg).digest(data); } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static byte[] refKdf(byte[] k, int c, String alg, int len) { return Apdu.slice(hash(alg, Apdu.concat(k, Apdu.u8(0, 0, 0, c))), 0, len); }

    /* ------------------------------------------------------------ AES + CMAC */

    private static final String PT = "00112233445566778899AABBCCDDEEFF";
    private static final byte[] SP_KEY = b("2B7E151628AED2A6ABF7158809CF4F3C");
    private static final byte[] SP_MSG = b("6BC1BEE22E409F96E93D7E117393172A AE2D8A571E03AC9C9EB76FAC45AF8E51 30C81C46A35CE411E5FBC1191A0A52EF F69F2445DF4F9B17AD2B417BE66C3710");

    @Test
    public void aesEncryptsAndDecryptsTheFips197Blocks() {
        String[][] cases = {
            {"000102030405060708090A0B0C0D0E0F", "69C4E0D86A7B0430D8CDB78070B4C55A"},
            {"000102030405060708090A0B0C0D0E0F1011121314151617", "DDA97CA4864CDFE06EAF70A0EC0D7191"},
            {"000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "8EA2B7CA516745BFEAFC49904B496089"},
        };
        for (String[] c : cases) {
            assertEquals(c[1], H(Aes.encryptBlock(b(c[0]), b(PT))));
            assertEquals(PT, H(Aes.decryptBlock(b(c[0]), b(c[1]))));
        }
        // Appendix B, the cipher example.
        assertEquals("3925841D02DC09FBDC118597196A0B32", H(Aes.encryptBlock(SP_KEY, b("3243F6A8885A308D313198A2E0370734"))));
    }

    @Test
    public void aesCbcAsInSp80038a() {
        byte[] iv = b("000102030405060708090A0B0C0D0E0F");
        String ct = "7649ABAC8119B246CEE98E9B12E9197D5086CB9B507219EE95DB113A917678B273BED6B8E3C1743B7116E69E222295163FF1CAA1681FAC09120ECA307586E1A7";
        assertEquals(ct, H(Aes.cbcEncrypt(SP_KEY, SP_MSG, iv)));
        assertEquals(H(SP_MSG), H(Aes.cbcDecrypt(SP_KEY, b(ct), iv)));
        assertThrows(IllegalArgumentException.class, () -> Aes.cbcEncrypt(SP_KEY, new byte[15]));
    }

    @Test
    public void cmacGivesTheRfc4493Tags() {
        assertEquals("BB1D6929E95937287FA37D129B756746", H(Aes.cmac(SP_KEY, new byte[0])));
        assertEquals("070A16B46B4D4144F79BDD9DD04A287C", H(Aes.cmac(SP_KEY, Apdu.slice(SP_MSG, 0, 16))));
        assertEquals("DFA66747DE9AE63030CA32611497C827", H(Aes.cmac(SP_KEY, Apdu.slice(SP_MSG, 0, 40))));
        assertEquals("51F0BEBF7E3B9D92FC49741779363CFE", H(Aes.cmac(SP_KEY, SP_MSG)));
    }

    @Test
    public void aesAndCmacMatchTheReferencesOnRandomKeysIvsAndLengths() {
        SecureRandom rng = new SecureRandom();
        for (int len : new int[]{16, 24, 32}) {
            for (int i = 0; i < 6; i++) {
                byte[] key = new byte[len], iv = new byte[16], data = new byte[16 * (1 + i * 3)];
                rng.nextBytes(key); rng.nextBytes(iv); rng.nextBytes(data);
                assertEquals(H(javaxAes("ECB", Cipher.ENCRYPT_MODE, key, Apdu.slice(data, 0, 16), null)), H(Aes.encryptBlock(key, Apdu.slice(data, 0, 16))));
                assertEquals(H(javaxAes("CBC", Cipher.ENCRYPT_MODE, key, data, iv)), H(Aes.cbcEncrypt(key, data, iv)));
                assertEquals(H(javaxAes("CBC", Cipher.DECRYPT_MODE, key, data, iv)), H(Aes.cbcDecrypt(key, data, iv)));
                for (int n : new int[]{0, 1, 15, 16, 17, 31, 32, 33, 81}) {
                    byte[] m = new byte[n];
                    rng.nextBytes(m);
                    assertEquals(H(refCmac(key, m)), H(Aes.cmac(key, m)));
                }
            }
        }
        // The CBC-MAC reference itself reproduces RFC 4493.
        assertEquals("51F0BEBF7E3B9D92FC49741779363CFE", H(refCmac(SP_KEY, SP_MSG)));
        assertEquals("BB1D6929E95937287FA37D129B756746", H(refCmac(SP_KEY, new byte[0])));
    }

    /* ------------------------------------------------------------ the curves */

    private static final int[] IDS = {12, 13, 15, 16, 17, 18};

    @Test
    public void coversExactlyTheStandardizedCurves() {
        assertEquals(Arrays.asList(12, 13, 15, 16, 17, 18), new ArrayList<>(EcCurve.PACE_CURVES.keySet()));
        List<String> names = new ArrayList<>();
        for (int id : IDS) names.add(EcCurve.PACE_CURVES.get(id).name);
        assertEquals(Arrays.asList("NIST P-256", "brainpoolP256r1", "NIST P-384", "brainpoolP384r1", "brainpoolP512r1", "NIST P-521"), names);
        for (int id : IDS) {
            EcCurve c = EcCurve.PACE_CURVES.get(id);
            assertTrue(c.name, c.onCurve(c.G));
            assertEquals(c.name, BigInteger.ONE, c.h);
        }
    }

    @Test
    public void kGAndEcdhEqualNodeCryptoOnAllSixCurves() throws Exception {
        JSONObject curves = EC.getJSONObject("curves");
        for (int id : IDS) {
            EcCurve c = EcCurve.PACE_CURVES.get(id);
            JSONObject v = curves.getJSONObject(String.valueOf(id));
            assertEquals(c.nodeName, v.getString("name"));
            assertEquals(c.G, c.decode(c.encode(c.G)));
            JSONArray mul = v.getJSONArray("mul");
            assertEquals(8, mul.length());
            for (int i = 0; i < mul.length(); i++) {
                JSONObject p = mul.getJSONObject(i);
                assertEquals(c.name + " k=" + p.getString("k"), p.getString("kG"), H(c.encode(c.mul(big(p.getString("k"))))));
            }
            // ECDH: our x-coordinate of k1·(k2·G) is node's shared secret.
            JSONObject e = v.getJSONObject("ecdh");
            BigInteger k1 = big(e.getString("k1")), k2 = big(e.getString("k2"));
            assertEquals(c.name, e.getString("shared"), H(EcCurve.bigIntToBytes(c.mul(k1, c.mul(k2)).x, c.size)));
            assertEquals(c.name, e.getString("shared"), H(EcCurve.bigIntToBytes(c.mul(k2, c.mul(k1)).x, c.size)));
        }
    }

    @Test
    public void groupLawsAndPointValidation() {
        SecureRandom rng = new SecureRandom();
        for (int id : IDS) {
            EcCurve c = EcCurve.PACE_CURVES.get(id);
            BigInteger k1 = c.randomScalar(rng), k2 = c.randomScalar(rng);
            assertTrue(k1.signum() > 0 && k1.compareTo(c.n) < 0);
            EcCurve.Point P1 = c.mul(k1), P2 = c.mul(k2);
            // (k1 + k2)·G = k1·G + k2·G, P + P = 2k·G, n·G = O, P + (−P) = O.
            assertEquals(c.name, c.mul(k1.add(k2)), c.add(P1, P2));
            assertEquals(c.name, c.mul(k1.shiftLeft(1)), c.add(P1, P1));
            assertNull(c.name, c.mul(c.n));
            assertNull(c.name, c.add(P1, new EcCurve.Point(P1.x, c.p.subtract(P1.y))));
            assertEquals(P1, c.add(P1, null));
            assertEquals(c.G, c.mul(c.n.add(BigInteger.ONE)));
            // Validation: off-curve, wrong length, compressed.
            byte[] enc = c.encode(P1);
            assertEquals(1 + 2 * c.size, enc.length);
            byte[] bad = enc.clone(); bad[bad.length - 1] ^= 1;
            assertNull(c.decode(bad));
            assertNull(c.decode(Apdu.slice(enc, 1)));
            assertNull(c.decode(Apdu.concat(Apdu.u8(0x02), Apdu.slice(enc, 1, 1 + c.size))));
            assertEquals(P1, c.decode(enc));
        }
    }

    /** x(k·P) by the JVM's own ECDH (SunEC) on a NIST curve, its parameters by name. */
    private static BigInteger sunEcdh(String stdName, EcCurve c, BigInteger k, EcCurve.Point P) throws Exception {
        AlgorithmParameters ap = AlgorithmParameters.getInstance("EC");
        ap.init(new ECGenParameterSpec(stdName));
        ECParameterSpec spec = ap.getParameterSpec(ECParameterSpec.class);
        // The JVM's named-curve parameters are EcCurve's.
        assertEquals(c.p, ((ECFieldFp) spec.getCurve().getField()).getP());
        assertEquals(c.a, spec.getCurve().getA());
        assertEquals(c.b, spec.getCurve().getB());
        assertEquals(c.G.x, spec.getGenerator().getAffineX());
        assertEquals(c.G.y, spec.getGenerator().getAffineY());
        assertEquals(c.n, spec.getOrder());
        KeyFactory kf = KeyFactory.getInstance("EC");
        PrivateKey sk = kf.generatePrivate(new ECPrivateKeySpec(k, spec));
        PublicKey pk = kf.generatePublic(new ECPublicKeySpec(new ECPoint(P.x, P.y), spec));
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(sk);
        ka.doPhase(pk, true);
        return new BigInteger(1, ka.generateSecret());
    }

    @Test
    public void nistCurvesMatchTheJvmEcdhOnRandomScalars() throws Exception {
        Map<Integer, String> std = new LinkedHashMap<>();
        std.put(12, "secp256r1"); std.put(15, "secp384r1"); std.put(18, "secp521r1");
        SecureRandom rng = new SecureRandom();
        for (Map.Entry<Integer, String> e : std.entrySet()) {
            EcCurve c = EcCurve.PACE_CURVES.get(e.getKey());
            for (int i = 0; i < 4; i++) {
                BigInteger k1 = c.randomScalar(rng), k2 = c.randomScalar(rng);
                EcCurve.Point P = c.mul(k2);
                assertEquals(c.name, c.mul(k1, P).x, sunEcdh(e.getValue(), c, k1, P));
                assertEquals(c.name + " x(k·G)", c.mul(k1).x, sunEcdh(e.getValue(), c, k1, c.G));
            }
        }
    }

    /* ------------------------------------------------------------ KDF and f(π) */

    @Test
    public void kdfUsesSha1For3desAndAes128AndSha256ForAes192And256() {
        byte[] K = b("0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20");
        assertEquals(H(refKdf(K, 1, "SHA-1", 16)), H(PaceProtocol.kdf(K, 1, "AES-128")));
        assertEquals(H(refKdf(K, 2, "SHA-256", 24)), H(PaceProtocol.kdf(K, 2, "AES-192")));
        assertEquals(H(refKdf(K, 3, "SHA-256", 32)), H(PaceProtocol.kdf(K, 3, "AES-256")));
        // 3DES: the BAC key derivation (pinned to ICAO 9303-11 Appendix D) — SHA-1, 16 bytes, DES parity.
        byte[] seed = b("239AB9CB282DAF66231DC5A4DF6BFBAE");
        assertEquals("AB94FDECF2674FDFB9B391F85D7F76F2", H(PaceProtocol.kdf(seed, 1, "3DES")));
        assertEquals(H(Bac.deriveKey(seed, 2)), H(PaceProtocol.kdf(seed, 2, "3DES")));
        for (byte x : PaceProtocol.kdf(K, 3, "3DES")) assertEquals(1, Integer.bitCount(x & 0xff) % 2);
    }

    @Test
    public void encodesTheCanAsItsCharactersAndTheMrzAsSha1OfTheMrzInformation() throws Exception {
        assertEquals(H(ascii("123456")), H(PaceProtocol.secret(PaceProtocol.Password.ofCan("123456"))));
        assertEquals(G1.getString("K"), H(PaceProtocol.secret(PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))))));
        assertEquals("CAN", PaceProtocol.Password.ofCan("1").label());
        assertEquals("MRZ", PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))).label());
    }

    /* ------------------------------------------------------------ the worked examples */

    /** A transport that plays the chip's side of a recorded exchange and checks every command. */
    private interface Check { void check(int i, String cmd, String want); }

    private static final Check EXACT = (i, cmd, want) -> assertEquals("APDU " + i, want, cmd);

    private static final class Replay implements Apdu.Transceiver {
        final List<String[]> pairs; final Check check; int i = 0;
        Replay(List<String[]> pairs, Check check) { this.pairs = pairs; this.check = check; }
        Replay(List<String[]> pairs) { this(pairs, EXACT); }
        @Override public byte[] transmit(byte[] cmd) {
            if (i >= pairs.size()) throw new AssertionError("unexpected APDU " + H(cmd));
            String[] p = pairs.get(i);
            check.check(i++, H(cmd), p[0]);
            return b(p[1]);
        }
        boolean done() { return i == pairs.size(); }
    }

    private static final class Derived { PaceProtocol.Info info; byte[] ksenc, ksmac; }

    private static final PaceProtocol.Info BSI_INFO =
        new PaceProtocol.Info("0.4.0.127.0.7.2.2.4.2.2", "PACE ECDH-GM AES-128", 2, 13, "ECDH", "GM", "AES-128");

    /** Every intermediate value of a worked example, recomputed. */
    private static Derived checkVector(JSONObject v) throws Exception {
        PaceProtocol.Info info = v.has("paceInfo") ? infoOf(v.getString("paceInfo")) : BSI_INFO;
        EcCurve c = EcCurve.forParameterId(info.parameterId);
        PaceProtocol.Password pw = v.has("mrz") ? PaceProtocol.Password.ofMrz(mrz(v.getJSONObject("mrz"))) : PaceProtocol.Password.ofCan(v.getString("password"));
        if (v.has("K")) assertEquals(v.getString("K"), H(PaceProtocol.secret(pw)));
        byte[] kpi = PaceProtocol.passwordKey(pw, info.cipher);
        assertEquals(v.getString("kpi"), H(kpi));
        assertEquals(v.getString("s"), H(PaceProtocol.decryptNonce(info.cipher, kpi, b(v.getString("z")))));
        // Mapping.
        assertEquals(v.getString("pkMapPcd"), H(c.encode(c.mul(big(v.getString("skMapPcd"))))));
        assertEquals(v.getString("pkMapPicc"), H(c.encode(c.mul(big(v.getString("skMapPicc"))))));
        PaceProtocol.Mapped mapped = PaceProtocol.mapNonce(c, b(v.getString("s")), big(v.getString("skMapPcd")), c.decode(b(v.getString("pkMapPicc"))));
        assertEquals(v.getString("H"), H(c.encode(mapped.H)));
        assertEquals(v.getString("G"), H(c.encode(mapped.G)));
        // The chip's side of the mapping gives the same generator.
        assertEquals(mapped.G, PaceProtocol.mapNonce(c, b(v.getString("s")), big(v.getString("skMapPicc")), c.decode(b(v.getString("pkMapPcd")))).G);
        // Key agreement on G̃.
        assertEquals(v.getString("pkPcd"), H(c.encode(c.mul(big(v.getString("skPcd")), mapped.G))));
        assertEquals(v.getString("pkPicc"), H(c.encode(c.mul(big(v.getString("skPicc")), mapped.G))));
        byte[] k = EcCurve.bigIntToBytes(c.mul(big(v.getString("skPcd")), c.decode(b(v.getString("pkPicc")))).x, c.size);
        assertEquals(v.getString("shared"), H(k));
        assertEquals(v.getString("shared"), H(EcCurve.bigIntToBytes(c.mul(big(v.getString("skPicc")), c.decode(b(v.getString("pkPcd")))).x, c.size)));
        Derived d = new Derived();
        d.info = info;
        d.ksenc = PaceProtocol.kdf(k, 1, info.cipher);
        d.ksmac = PaceProtocol.kdf(k, 2, info.cipher);
        assertEquals(v.getString("ksenc"), H(d.ksenc));
        assertEquals(v.getString("ksmac"), H(d.ksmac));
        // Tokens: ours over the chip's key, the chip's over ours.
        assertEquals(v.getString("tPcd"), H(PaceProtocol.authToken(info.cipher, d.ksmac, info.oid, b(v.getString("pkPicc")))));
        assertEquals(v.getString("tPicc"), H(PaceProtocol.authToken(info.cipher, d.ksmac, info.oid, b(v.getString("pkPcd")))));
        return d;
    }

    private static PaceProtocol.Ephemeral ephemeral(JSONObject v) throws Exception {
        return new PaceProtocol.Ephemeral(big(v.getString("skMapPcd")), big(v.getString("skPcd")));
    }

    /** G.1's recorded exchange, its MSE:Set AT with the optional 84 (the parameter id, 0D) this reader adds. */
    private static List<String[]> g1Pairs() throws Exception {
        List<String[]> p = pairs(G1.getJSONArray("apdus"));
        byte[] doc = b(p.get(0)[0]);
        p.set(0, new String[]{H(Apdu.concat(Apdu.slice(doc, 0, 4), Apdu.u8((doc[4] & 0xff) + 3), Apdu.slice(doc, 5), Apdu.u8(0x84, 0x01, 0x0d))), p.get(0)[1]});
        return p;
    }

    @Test
    public void icaoG1ReadsThePaceInfo() throws Exception {
        PaceProtocol.Info info = infoOf(G1.getString("paceInfo"));
        assertEquals("0.4.0.127.0.7.2.2.4.2.2", info.oid);
        assertEquals("PACE ECDH-GM AES-128", info.name);
        assertEquals("ECDH", info.agreement);
        assertEquals("GM", info.mapping);
        assertEquals("AES-128", info.cipher);
        assertEquals(2, info.version);
        assertEquals(Integer.valueOf(13), info.parameterId);
        assertTrue(PaceProtocol.supported(info));
    }

    @Test
    public void icaoG1DerivesEveryValue() throws Exception {
        checkVector(G1);
    }

    @Test
    public void icaoG1SendsExactlyTheExamplesApdusAndAcceptsTheChipsToken() throws Exception {
        Replay r = new Replay(g1Pairs());
        PaceProtocol.Session s = PaceProtocol.establish(r, infoOf(G1.getString("paceInfo")), PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))), ephemeral(G1));
        assertTrue(r.done());
        assertEquals("AES-128", s.cipher);
        assertEquals(G1.getString("ksenc"), H(s.ksenc));
        assertEquals(G1.getString("ksmac"), H(s.ksmac));
        assertEquals(H(new byte[16]), H(s.ssc()));
        assertNotNull(s.aesSm());
        assertNull(s.bacSession());
    }

    @Test
    public void icaoG1FailsAsAuthFailedWhenTheChipsTokenDoesNotVerify() throws Exception {
        List<String[]> p = g1Pairs();
        p.set(4, new String[]{p.get(4)[0], p.get(4)[1].replace("3ABB9674BCE93C08", "3ABB9674BCE93C09")});
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () ->
            PaceProtocol.establish(new Replay(p), infoOf(G1.getString("paceInfo")), PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))), ephemeral(G1)));
        assertEquals("auth-failed", e.code);
        assertEquals("the document's authentication token did not verify", e.getMessage());
    }

    @Test
    public void mseAcceptsA63CxRetryCounter() throws Exception {
        List<String[]> p = g1Pairs();
        p.set(0, new String[]{p.get(0)[0], "63C3"});
        Replay r = new Replay(p);
        PaceProtocol.establish(r, infoOf(G1.getString("paceInfo")), PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))), ephemeral(G1));
        assertTrue(r.done());
    }

    @Test
    public void icaoI1DerivesEveryValueOfTheCamExample() throws Exception {
        Derived d = checkVector(I1);
        assertEquals("CAM", d.info.mapping);
        assertFalse(PaceProtocol.supported(d.info));
        // The encrypted chip-authentication data: AES-CBC with IV = E(KSenc, −1), M2-padded.
        byte[] ff = new byte[16];
        Arrays.fill(ff, (byte) 0xff);
        JSONObject ca = I1.getJSONObject("caData");
        byte[] plain = Aes.cbcDecrypt(d.ksenc, b(ca.getString("encrypted")), Aes.encryptBlock(d.ksenc, ff));
        StringBuilder want = new StringBuilder(ca.getString("decrypted")).append("80");
        for (int i = 0; i < 15; i++) want.append("00");
        assertEquals(want.toString(), H(plain));
    }

    @Test
    public void bsiDerivesEveryValue() throws Exception {
        checkVector(BSI);
    }

    @Test
    public void bsiRunsTheLoggedExchangeThenThe21LoggedSecureMessagingApdus() throws Exception {
        // The example's MSE:Set AT carries a CHAT and the PIN reference (eID terminal
        // authentication), which this reader does not send — so it is answered, not compared.
        // A PIN and a CAN of the same digits encode the same (f(π) = the characters).
        JSONArray sm = BSI.getJSONArray("sm");
        assertEquals(21, sm.length());
        List<String[]> p = new ArrayList<>();
        p.add(new String[]{"", "9000"});
        p.addAll(pairs(BSI.getJSONArray("apdus")));
        for (int i = 0; i < sm.length(); i++) p.add(new String[]{sm.getJSONArray(i).getString(1), sm.getJSONArray(i).getString(2)});
        Replay r = new Replay(p, (i, cmd, want) -> {
            if (i == 0) assertTrue(cmd, cmd.startsWith("0022C1A4"));
            else assertEquals("APDU " + i, want, cmd);
        });
        PaceProtocol.Channel ch = PaceProtocol.establish(r, BSI_INFO, PaceProtocol.Password.ofCan(BSI.getString("password")), ephemeral(BSI));
        for (int i = 0; i < sm.length(); i++) {
            JSONArray row = sm.getJSONArray(i);
            assertEquals("SM " + i, row.getString(3), plainAnswer(ch.send(b(row.getString(0)))));
        }
        assertTrue(r.done());
    }

    @Test
    public void bsiWrapsAndUnwrapsEachLoggedApduOnItsOwn() throws Exception {
        JSONArray sm = BSI.getJSONArray("sm");
        for (int i = 0; i < sm.length(); i++) {
            JSONArray row = sm.getJSONArray(i);
            AesSm s = new AesSm(b(BSI.getString("ksenc")), b(BSI.getString("ksmac")), EcCurve.bigIntToBytes(BigInteger.valueOf(2L * i), 16));
            assertEquals("SM " + i, row.getString(1), H(s.protect(b(row.getString(0)))));
            assertEquals("SM " + i, row.getString(3), plainAnswer(s.unprotect(b(row.getString(2)))));
            assertEquals(H(EcCurve.bigIntToBytes(BigInteger.valueOf(2L * i + 2), 16)), H(s.ssc));
        }
    }

    @Test
    public void aesSmRejectsAResponseWhoseMacDoesNotVerify() throws Exception {
        byte[] bad = b(BSI.getJSONArray("sm").getJSONArray(0).getString(2));
        bad[bad.length - 3] ^= 1;
        AesSm s = new AesSm(b(BSI.getString("ksenc")), b(BSI.getString("ksmac")), EcCurve.bigIntToBytes(BigInteger.ONE, 16));
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> s.unprotect(bad));
        assertEquals("protocol", e.code);
        assertTrue(e.getMessage(), e.getMessage().contains("MAC"));
    }

    @Test
    public void aesSmPassesABareStatusWordThroughAndRejectsAnAnswerWithoutAMac() throws Exception {
        AesSm s = new AesSm(new byte[16], new byte[16], new byte[16]);
        Bac.Sm r = s.unprotect(b("6988"));
        assertEquals(0x6988, r.sw);
        assertEquals(0, r.data.length);
        assertEquals(H(EcCurve.bigIntToBytes(BigInteger.ONE, 16)), H(s.ssc));
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> s.unprotect(b("990290009000")));
        assertEquals("secure messaging: the response carries no MAC", e.getMessage());
    }

    @Test
    public void aesSmUsesDo85ForAnOddIns() throws Exception {
        AesSm s = new AesSm(b(BSI.getString("ksenc")), b(BSI.getString("ksmac")), new byte[16]);
        byte[] wrapped = s.protect(b("00B10000045402010000"));  // READ BINARY (odd INS) with data 54 02 01 00, Le 00
        assertEquals(0x0c, wrapped[0]);
        assertEquals(0x85, wrapped[5] & 0xff);   // the cryptogram without a padding-indicator byte
        assertEquals(16, wrapped[6]);
        assertEquals(0x97, wrapped[7 + 16] & 0xff);
    }

    @Test
    public void bacChannelWrapsBacSecureMessaging() throws Exception {
        // ICAO 9303-11 Appendix D: SELECT EF.COM under the BAC session keys (BacDesTest).
        Bac.Session s = new Bac.Session(b("979EC13B1CBFE9DCD01AB0FED307EAE5"), b("F1CB1F1FB5ADF208806B89DC579DC1F8"), b("887022120C06C226"));
        List<String[]> p = Collections.singletonList(new String[]{"0CA4020C158709016375432908C044F68E08BF8B92D635FF24F800", "990290008E08FA855A5D4C50A8ED9000"});
        Replay r = new Replay(p);
        Bac.Sm sel = PaceProtocol.bacChannel(r, s).send(b("00A4020C02011E"));
        assertEquals(0x9000, sel.sw);
        assertTrue(r.done());
    }

    /* ------------------------------------------------------------ failures by status word */

    @Test
    public void mseRefusalsAreUnsupportedOrCardErrors() throws Exception {
        PaceProtocol.Info info = infoOf(G1.getString("paceInfo"));
        PaceProtocol.Password pw = PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz")));
        // With 84, then (the example's own MSE) without it.
        String with84 = g1Pairs().get(0)[0], without = G1.getJSONArray("apdus").getJSONArray(0).getString(0);
        Replay r88 = new Replay(Arrays.asList(new String[]{with84, "6A88"}, new String[]{without, "6A88"}));
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(r88, info, pw));
        assertTrue(r88.done());
        assertEquals("unsupported", e.code);
        assertEquals("the document does not take the MRZ for PACE (SW 6A88)", e.getMessage());
        assertEquals("6A88", e.sw);
        Replay r80 = new Replay(Arrays.asList(new String[]{with84, "6A80"}, new String[]{without, "6A80"}));
        e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(r80, info, pw));
        assertEquals("card-error", e.code);
        assertEquals("6A80", e.sw);
        assertEquals("the document refused PACE ECDH-GM AES-128 — Incorrect parameters in data field (SW 6A80)", e.getMessage());
    }

    @Test
    public void aGeneralAuthenticateErrorMidChainIsACardError() throws Exception {
        List<String[]> p = g1Pairs().subList(0, 2);
        p.set(1, new String[]{p.get(1)[0], "6A80"});
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () ->
            PaceProtocol.establish(new Replay(p), infoOf(G1.getString("paceInfo")), PaceProtocol.Password.ofMrz(mrz(G1.getJSONObject("mrz"))), ephemeral(G1)));
        assertEquals("card-error", e.code);
        assertEquals("encrypted nonce: Incorrect parameters in data field (SW 6A80)", e.getMessage());
    }

    /* ------------------------------------------------------------ a simulated PACE chip */

    private static final class Suite {
        final String oid, cipher; final int param;
        Suite(String oid, String cipher, int param) { this.oid = oid; this.cipher = cipher; this.param = param; }
    }

    private static final Map<String, Suite> SUITES = new LinkedHashMap<>();
    static {
        SUITES.put("AES-128 / brainpoolP256r1", new Suite("0.4.0.127.0.7.2.2.4.2.2", "AES-128", 13));
        SUITES.put("AES-256 / brainpoolP384r1", new Suite("0.4.0.127.0.7.2.2.4.2.4", "AES-256", 16));
        SUITES.put("AES-192 / NIST P-521", new Suite("0.4.0.127.0.7.2.2.4.2.3", "AES-192", 18));
        SUITES.put("AES-256 / brainpoolP512r1", new Suite("0.4.0.127.0.7.2.2.4.2.4", "AES-256", 17));
        SUITES.put("AES-128 / NIST P-384", new Suite("0.4.0.127.0.7.2.2.4.2.2", "AES-128", 15));
        SUITES.put("3DES / NIST P-256", new Suite("0.4.0.127.0.7.2.2.4.2.1", "3DES", 12));
    }

    private static final String MRZ = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10";
    private static final Bac.MrzKey KEY = new Bac.MrzKey("L898902C", "690806", "940623");
    private static final String CAN = "123456";
    private static final byte[] MRTD_AID = Apdu.u8(0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01);
    private static final byte[] JPEG;
    private static final byte[] DG1, DG2, DG11, COM;
    private static final Map<Integer, byte[]> FILES = new LinkedHashMap<>();
    static {
        byte[] body = new byte[600];
        Arrays.fill(body, (byte) 7);
        JPEG = Apdu.concat(Apdu.u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), ascii("JFIF"), body, Apdu.u8(0xff, 0xd9));
        DG1 = T(0x61, T(0x5f1f, ascii(MRZ.replace("\n", ""))));
        DG2 = T(0x75, T(0x7f61, T(0x02, Apdu.u8(1)), T(0x7f60, T(0xa1, T(0x80, Apdu.u8(1, 1))), T(0x5f2e, Apdu.concat(ascii("FAC\0"), new byte[40], JPEG)))));
        DG11 = T(0x6b, T(0x5c, Apdu.u8(0x5f, 0x0e)), T(0x5f0e, ascii("ERIKSSON<<ANNA<MARIA")));
        COM = T(0x60, T(0x5f01, ascii("0108")), T(0x5f36, ascii("040000")), T(0x5c, Apdu.u8(0x61, 0x75, 0x6b)));
        FILES.put(0x011e, COM); FILES.put(0x0101, DG1); FILES.put(0x0102, DG2); FILES.put(0x010b, DG11);
    }

    /**
     * A PACE-only chip from the spec (ICAO 9303-11 §4.4, §9.8): EF.CardAccess in
     * the clear, everything else behind PACE (6982 before), no BAC. KDF, nonce
     * encryption, tokens and AES secure messaging straight from javax.crypto (CMAC
     * as a CBC-MAC); 3DES from Des (pinned to the BAC worked example); points from
     * EcCurve (pinned to node:crypto above).
     */
    private static final class SimChip implements Apdu.Transceiver {
        final List<String> log = new ArrayList<>();
        final Suite suite; final boolean reject84, badToken;
        final EcCurve curve; final boolean aes; final int block;
        final byte[] cardAccess;
        final SecureRandom rng = new SecureRandom();
        byte[] kpi; int step;
        byte[] s = new byte[0], pkPcd = new byte[0], pkPicc = new byte[0];
        EcCurve.Point gMapped;
        byte[] ksenc, ksmac, ssc;          // the session
        byte[] pendingEnc, pendingMac;     // keys agreed, tokens not yet checked
        Integer selected; boolean app;

        SimChip(Suite suite, boolean reject84, boolean badToken) {
            this.suite = suite; this.reject84 = reject84; this.badToken = badToken;
            this.curve = EcCurve.PACE_CURVES.get(suite.param);
            this.aes = !"3DES".equals(suite.cipher);
            this.block = aes ? 16 : 8;
            this.gMapped = curve.G;
            this.cardAccess = T(0x31, T(0x30, oid(suite.oid), integer(2), integer(suite.param)), T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), integer(2), integer(13)));
        }

        SimChip(Suite suite) { this(suite, false, false); }

        private static void inc(byte[] c) { for (int i = c.length - 1; i >= 0; i--) { c[i]++; if (c[i] != 0) break; } }

        private byte[] padB(byte[] d) { byte[] o = Arrays.copyOf(d, d.length + (block - d.length % block)); o[d.length] = (byte) 0x80; return o; }

        private static byte[] unpadB(byte[] d) {
            int i = d.length - 1;
            while (d[i] == 0) i--;
            if ((d[i] & 0xff) != 0x80) throw new IllegalStateException("padding");
            return Apdu.slice(d, 0, i);
        }

        private byte[] kdf(byte[] k, int c) {
            switch (suite.cipher) {
                case "3DES": return refKdf(k, c, "SHA-1", 16);
                case "AES-128": return refKdf(k, c, "SHA-1", 16);
                case "AES-192": return refKdf(k, c, "SHA-256", 24);
                default: return refKdf(k, c, "SHA-256", 32);
            }
        }

        private byte[] enc(byte[] k, byte[] d, byte[] iv) { return aes ? javaxAes("CBC", Cipher.ENCRYPT_MODE, k, d, iv) : Des.tdesCbcEncrypt(k, d); }
        private byte[] dec(byte[] k, byte[] d, byte[] iv) { return aes ? javaxAes("CBC", Cipher.DECRYPT_MODE, k, d, iv) : Des.tdesCbcDecrypt(k, d); }
        private byte[] iv() { return aes ? javaxAes("ECB", Cipher.ENCRYPT_MODE, ksenc, ssc, null) : null; }
        /** The SM checksum over already padded input (§9.8: the SM layer pads). */
        private byte[] mac(byte[] k, byte[] padded) { return aes ? Apdu.slice(refCmac(k, padded), 0, 8) : Des.retailMac(k, padded); }
        /** The token: the MAC does its own padding (§4.4.3.4) — CMAC internally, M2 for the retail MAC. */
        private byte[] token(byte[] k, byte[] pk) {
            byte[] d = T(0x7f49, oid(suite.oid), T(0x86, pk));
            return aes ? Apdu.slice(refCmac(k, d), 0, 8) : Des.retailMac(k, Des.pad(d));
        }

        /** SELECT / READ BINARY over the files; only EF.CardAccess before PACE. */
        private byte[][] run(int ins, int p1, int p2, byte[] data, Integer le) {
            byte[] none = new byte[0];
            if (ins == 0xa4 && p1 == 0x04) { app = Arrays.equals(data, MRTD_AID); return new byte[][]{none, sw(app ? 0x9000 : 0x6a82)}; }
            if (ins == 0xa4) {
                int fid = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
                if (fid == 0x011c) { selected = fid; return new byte[][]{none, sw(0x9000)}; }
                if (ksenc == null) return new byte[][]{none, sw(0x6982)};
                if (!app || !FILES.containsKey(fid)) return new byte[][]{none, sw(0x6a82)};
                selected = fid;
                return new byte[][]{none, sw(0x9000)};
            }
            if (ins == 0xb0) {
                byte[] f = selected == null ? null : selected == 0x011c ? cardAccess : ksenc != null ? FILES.get(selected) : null;
                if (f == null) return new byte[][]{none, sw(0x6982)};
                int off = (p1 << 8) | p2, n = le == null || le == 0 ? 256 : le;
                return new byte[][]{Apdu.slice(f, off, off + n), sw(off + n > f.length ? 0x6282 : 0x9000)};
            }
            return new byte[][]{none, sw(0x6d00)};
        }

        private byte[] plainCommand(byte[] a) {
            int cla = a[0] & 0xff, ins = a[1] & 0xff, p1 = a[2] & 0xff, p2 = a[3] & 0xff;
            int lc = a.length > 5 ? a[4] & 0xff : 0;
            byte[] data = Apdu.slice(a, 5, 5 + lc);
            List<Apdu.Tlv> dos = lc > 0 && (ins == 0x22 || ins == 0x86) ? Apdu.decodeTlv(data, true) : Collections.emptyList();
            if (ins == 0x22 && p1 == 0xc1 && p2 == 0xa4) { // MSE:Set AT
                step = 0; kpi = null;
                byte[] o = get(dos, 0x80);
                if (o == null || !Arrays.equals(o, PaceProtocol.oidBytes(suite.oid))) return sw(0x6a80);
                byte[] p84 = get(dos, 0x84);
                if (p84 != null && (reject84 || p84[0] != suite.param)) return sw(0x6a80);
                byte[] ref = get(dos, 0x83);
                byte[] secret = ref == null ? null : ref[0] == 0x02 ? ascii(CAN) : ref[0] == 0x01 ? hash("SHA-1", ascii("L898902C<369080619406236")) : null;
                if (secret == null) return sw(0x6a88);
                kpi = kdf(secret, 3);
                step = 1;
                return sw(0x9000);
            }
            if (ins == 0x86) { // GENERAL AUTHENTICATE, chained
                if (kpi == null || step < 1) return sw(0x6985);
                if ((cla == 0x10) != (step < 4)) { step = 0; return sw(0x6883); }
                if (step == 1) {
                    s = new byte[16];
                    rng.nextBytes(s);
                    step = 2;
                    return Apdu.concat(T(0x7c, T(0x80, enc(kpi, s, new byte[16]))), sw(0x9000));
                }
                if (step == 2) {
                    EcCurve.Point pkMapPcd = curve.decode(get(dos, 0x81));
                    if (pkMapPcd == null) { step = 0; return sw(0x6a80); }
                    BigInteger sk = curve.randomScalar(rng);
                    gMapped = curve.add(curve.mul(EcCurve.bytesToBigInt(s)), curve.mul(sk, pkMapPcd));
                    step = 3;
                    return Apdu.concat(T(0x7c, T(0x82, curve.encode(curve.mul(sk)))), sw(0x9000));
                }
                if (step == 3) {
                    pkPcd = get(dos, 0x83);
                    EcCurve.Point P = curve.decode(pkPcd);
                    if (P == null) { step = 0; return sw(0x6a80); }
                    BigInteger sk = curve.randomScalar(rng);
                    pkPicc = curve.encode(curve.mul(sk, gMapped));
                    byte[] k = EcCurve.bigIntToBytes(curve.mul(sk, P).x, curve.size);
                    pendingEnc = kdf(k, 1);
                    pendingMac = kdf(k, 2);
                    step = 4;
                    return Apdu.concat(T(0x7c, T(0x84, pkPicc)), sw(0x9000));
                }
                // Step 4: check the terminal's token over our key, answer with ours over theirs.
                step = 0;
                byte[] t85 = get(dos, 0x85);
                if (pendingMac == null || t85 == null || !Arrays.equals(t85, token(pendingMac, pkPicc))) return sw(0x6300);
                byte[] t = token(pendingMac, pkPcd);
                if (badToken) t[0] ^= 1;
                ksenc = pendingEnc; ksmac = pendingMac; ssc = new byte[block];
                return Apdu.concat(T(0x7c, T(0x86, t)), sw(0x9000));
            }
            if (ins == 0x84) return sw(0x6d00); // no BAC on this chip
            Integer le = a.length == 5 ? Integer.valueOf(a[4] & 0xff) : a.length > 5 + lc ? Integer.valueOf(a[5 + lc] & 0xff) : null;
            byte[][] r = run(ins, p1, p2, data, le);
            return Apdu.concat(r[0], r[1]);
        }

        private static byte[] get(List<Apdu.Tlv> dos, int tag) {
            for (Apdu.Tlv n : dos) if (n.tag == tag) return n.value;
            if (!dos.isEmpty() && dos.get(0).children != null) for (Apdu.Tlv n : dos.get(0).children) if (n.tag == tag) return n.value;
            return null;
        }

        /** Secure messaging (§9.8): check the MAC, decrypt, run, wrap the answer. */
        private byte[] smCommand(byte[] a) {
            if ((a[0] & 0x0c) != 0x0c) { ksenc = null; return sw(0x6987); }
            List<Apdu.Tlv> nodes = Apdu.decodeTlv(Apdu.slice(a, 5, 5 + (a[4] & 0xff)), false);
            byte[] do87 = null, do97 = null, do8e = null;
            for (Apdu.Tlv n : nodes) {
                if (n.tag == 0x87) do87 = n.value; else if (n.tag == 0x97) do97 = n.value; else if (n.tag == 0x8e) do8e = n.value;
            }
            inc(ssc);
            byte[] macIn = padB(Apdu.concat(ssc, padB(Apdu.slice(a, 0, 4)), do87 != null ? T(0x87, do87) : new byte[0], do97 != null ? T(0x97, do97) : new byte[0]));
            if (do8e == null || !Arrays.equals(mac(ksmac, macIn), do8e)) { ksenc = null; return sw(0x6988); }
            byte[] data = do87 != null ? unpadB(dec(ksenc, Apdu.slice(do87, 1), iv())) : new byte[0];
            byte[][] r = run(a[1] & 0xff, a[2] & 0xff, a[3] & 0xff, data, do97 != null ? Integer.valueOf(do97[0] & 0xff) : null);
            inc(ssc);
            byte[] r87 = r[0].length > 0 ? T(0x87, Apdu.u8(0x01), enc(ksenc, padB(r[0]), iv())) : new byte[0];
            byte[] r99 = T(0x99, r[1]);
            return Apdu.concat(r87, r99, T(0x8e, mac(ksmac, padB(Apdu.concat(ssc, r87, r99)))), sw(0x9000));
        }

        @Override public byte[] transmit(byte[] cmd) {
            log.add(H(cmd));
            return ksenc != null ? smCommand(cmd) : plainCommand(cmd);
        }
    }

    /** The plain channel, before PACE. */
    private static PaceProtocol.Channel plain(Apdu.Transceiver t) {
        return cmd -> { Apdu.Response r = Apdu.splitResponse(t.transmit(cmd)); return new Bac.Sm(r.data, r.sw); };
    }

    /** SELECT the EF and READ BINARY it in chunks — what the reader does over any channel. */
    private static byte[] readFile(PaceProtocol.Channel ch, int fid) throws IOException {
        Bac.Sm sel = ch.send(Apdu.selectByFid(fid, 0x0c));
        if (!Apdu.isOk(sel.sw)) throw new IOException("select " + Integer.toHexString(fid) + ": SW " + PaceProtocol.swHex(sel.sw));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int off = 0, guard = 0; guard < 64; guard++) {
            Bac.Sm r = ch.send(Apdu.readBinary(off, 0xdf));
            out.write(r.data, 0, r.data.length);
            off += r.data.length;
            if (r.sw != 0x9000 || r.data.length < 0xdf) break;
        }
        return out.toByteArray();
    }

    /** EF.CardAccess in the clear → the PACEInfo to run → PACE → the eMRTD application over SM (mrtd.ts's order). */
    private static PaceProtocol.Session open(SimChip chip, PaceProtocol.Password pw) throws IOException {
        PaceProtocol.SecurityInfos si = PaceProtocol.parseSecurityInfos(readFile(plain(chip), 0x011c));
        assertEquals(2, si.pace.size());
        assertTrue(si.protocols.contains("PACE ECDH-IM AES-128"));
        PaceProtocol.Info info = PaceProtocol.choose(si.pace);
        assertNotNull(info);
        assertEquals("GM", info.mapping);
        PaceProtocol.Session s = PaceProtocol.establish(chip, info, pw);
        Bac.Sm sel = s.send(Apdu.apdu(0x00, 0xa4, 0x04, 0x0c, MRTD_AID, -1));
        assertEquals(0x9000, sel.sw);
        return s;
    }

    @Test
    public void simulatedChipOpensWithTheCanOverEverySuiteAndReadsTheDocument() throws Exception {
        for (Map.Entry<String, Suite> e : SUITES.entrySet()) {
            String name = e.getKey();
            Suite suite = e.getValue();
            SimChip chip = new SimChip(suite);
            PaceProtocol.Session s = open(chip, PaceProtocol.Password.ofCan(CAN));
            assertEquals(name, suite.cipher, s.cipher);
            assertEquals(name, Integer.valueOf(suite.param), s.info.parameterId);
            assertEquals(name, "3DES".equals(suite.cipher) ? 8 : 16, s.ssc().length);
            assertEquals(name, H(COM), H(readFile(s, 0x011e)));
            assertEquals(name, H(DG1), H(readFile(s, 0x0101)));
            assertEquals(name, H(DG2), H(readFile(s, 0x0102)));
            assertEquals(name, H(DG11), H(readFile(s, 0x010b)));
            assertEquals(name, "ERIKSSON", MrtdReader.mrzFromDg1(DG1).getString("surname"));
            // The protocol as sent: MSE:Set AT with the CAN (83 01 02) and the parameter id, the chained GA, then only SM.
            List<String> mse = new ArrayList<>();
            for (String l : chip.log) if (l.startsWith("0022C1A4")) mse.add(l);
            assertEquals(name, 1, mse.size());
            assertTrue(name, mse.get(0).endsWith("830102" + "8401" + String.format("%02X", suite.param)));
            List<String> ga = new ArrayList<>();
            for (String l : chip.log) if (l.matches("^[01]086.*")) ga.add(l);
            List<String> cla = new ArrayList<>();
            for (String l : ga) cla.add(l.substring(0, 2));
            assertEquals(name, Arrays.asList("10", "10", "10", "00"), cla);
            List<String> after = chip.log.subList(chip.log.indexOf(ga.get(3)) + 1, chip.log.size());
            assertTrue(name, after.size() > 5);
            for (String l : after) assertTrue(name + ": " + l, l.startsWith("0C"));
        }
    }

    @Test
    public void simulatedChipOpensWithTheMrz() throws Exception {
        SimChip chip = new SimChip(SUITES.get("AES-128 / brainpoolP256r1"));
        PaceProtocol.Session s = open(chip, PaceProtocol.Password.ofMrz(KEY));
        assertEquals(H(DG1), H(readFile(s, 0x0101)));
        String mse = null;
        for (String l : chip.log) if (l.startsWith("0022C1A4")) mse = l;
        assertNotNull(mse);
        assertTrue(mse, mse.contains("830101"));
    }

    @Test
    public void simulatedChipOpensWithTheMrzOver3des() throws Exception {
        SimChip chip = new SimChip(SUITES.get("3DES / NIST P-256"));
        PaceProtocol.Session s = open(chip, PaceProtocol.Password.ofMrz(KEY));
        assertNotNull(s.bacSession());
        assertNull(s.aesSm());
        assertEquals(H(DG2), H(readFile(s, 0x0102)));
    }

    private static PaceProtocol.Info infoFor(Suite suite) {
        return PaceProtocol.parseSecurityInfos(T(0x31, T(0x30, oid(suite.oid), integer(2), integer(suite.param)))).pace.get(0);
    }

    @Test
    public void aWrongCanIsAuthFailedAndNothingIsRead() {
        for (String name : new String[]{"AES-128 / brainpoolP256r1", "3DES / NIST P-256"}) {
            Suite suite = SUITES.get(name);
            SimChip chip = new SimChip(suite);
            PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(chip, infoFor(suite), PaceProtocol.Password.ofCan("654321")));
            assertEquals(name, "auth-failed", e.code);
            assertEquals(name, "the document did not accept the CAN (SW 6300)", e.getMessage());
            assertEquals("6300", e.sw);
            for (String l : chip.log) assertFalse(name + ": " + l, l.startsWith("0C"));
        }
    }

    @Test
    public void aWrongChipTokenIsAuthFailed() {
        Suite suite = SUITES.get("AES-256 / brainpoolP384r1");
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () ->
            PaceProtocol.establish(new SimChip(suite, false, true), infoFor(suite), PaceProtocol.Password.ofCan(CAN)));
        assertEquals("auth-failed", e.code);
        assertEquals("the document's authentication token did not verify", e.getMessage());
    }

    @Test
    public void asksAgainWithoutTheParameterReferenceWhenTheChipRefusesIt() throws Exception {
        SimChip chip = new SimChip(SUITES.get("AES-128 / brainpoolP256r1"), true, false);
        PaceProtocol.Session s = open(chip, PaceProtocol.Password.ofCan(CAN));
        assertEquals(H(DG1), H(readFile(s, 0x0101)));
        List<String> mse = new ArrayList<>();
        for (String l : chip.log) if (l.startsWith("0022C1A4")) mse.add(l);
        assertEquals(2, mse.size());
        assertTrue(mse.get(0).contains("84010D"));
        assertFalse(mse.get(1).contains("84010D"));
    }

    @Test
    public void refusesTheVariantsItDoesNotRunAsUnsupported() {
        SimChip chip = new SimChip(SUITES.get("AES-128 / brainpoolP256r1"));
        List<PaceProtocol.Info> infos = PaceProtocol.parseSecurityInfos(T(0x31,
            T(0x30, oid("0.4.0.127.0.7.2.2.4.4.2"), integer(2), integer(13)), // ECDH-IM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0)),  // DH-GM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.6.2"), integer(2), integer(13)), // ECDH-CAM
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(14)), // brainpoolP320r1
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2))               // no parameter id
        )).pace;
        assertEquals(5, infos.size());
        for (PaceProtocol.Info info : infos) {
            assertFalse(info.name, PaceProtocol.supported(info));
            PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(chip, info, PaceProtocol.Password.ofCan(CAN)));
            assertEquals(info.name, "unsupported", e.code);
        }
        assertNull(PaceProtocol.choose(infos));
        assertTrue(chip.log.isEmpty());
        PaceProtocol.PaceException e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(chip, infos.get(0), PaceProtocol.Password.ofCan(CAN)));
        assertEquals("PACE ECDH-IM AES-128 (brainpoolP256r1) is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves", e.getMessage());
        e = assertThrows(PaceProtocol.PaceException.class, () -> PaceProtocol.establish(chip, infos.get(4), PaceProtocol.Password.ofCan(CAN)));
        assertEquals("PACE ECDH-GM AES-128 is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves", e.getMessage());
    }

    @Test
    public void choosesTheStrongestVariantItRuns() {
        PaceProtocol.SecurityInfos si = PaceProtocol.parseSecurityInfos(Apdu.concat(T(0x31,
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.1"), integer(2), integer(12)),  // 3DES
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(13)),  // AES-128
            T(0x30, oid("0.4.0.127.0.7.2.2.4.4.4"), integer(2), integer(13)),  // ECDH-IM AES-256 (not run)
            T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), integer(2), integer(16)),  // AES-256
            T(0x30, oid("0.4.0.127.0.7.2.2.3.2.2"), integer(1)),               // Chip Authentication
            T(0x30, oid("1.2.3.4"), integer(1))                                // something unknown
        ), Apdu.u8(0x00, 0x00)));                                              // trailing garbage
        assertEquals(4, si.pace.size());
        assertEquals(Arrays.asList("PACE ECDH-GM 3DES", "PACE ECDH-GM AES-128", "PACE ECDH-IM AES-256", "PACE ECDH-GM AES-256", "Chip Authentication (ECDH, AES-128)", "1.2.3.4"), si.protocols);
        PaceProtocol.Info best = PaceProtocol.choose(si.pace);
        assertEquals("PACE ECDH-GM AES-256", best.name);
        assertEquals(Integer.valueOf(16), best.parameterId);
        assertEquals("PACE ECDH-GM AES-256 (brainpoolP384r1)", best.toString());
    }

    @Test
    public void oidsRoundTrip() {
        for (String o : new String[]{"0.4.0.127.0.7.2.2.4.2.2", "1.2.840.113549.1.7.2", "2.16.840.1.101.3.4.2.1", "1.3.36.3.3.2.8.1.1.13", "1.2.4294967296.1"}) {
            assertEquals(o, PaceProtocol.oidText(PaceProtocol.oidBytes(o)));
        }
        assertEquals("04007F00070202040202", H(PaceProtocol.oidBytes("0.4.0.127.0.7.2.2.4.2.2")));
        assertArrayEquals(b("7F4903860100"), T(0x7f49, T(0x86, Apdu.u8(0))));
    }
}
