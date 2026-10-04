package cz.m5cet.app.nfc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PACE — Password Authenticated Connection Establishment (6.6), ICAO 9303
 * Part 11 §4.4 / BSI TR-03110 — the Java port of
 * client/src/lib/nfc/cards/pace.ts. The holder opens their own document with
 * the CAN printed on it (or the MRZ), and the chip and reader agree on session
 * keys; every later APDU is wrapped in secure messaging (AES or 3DES). Like
 * BAC it is the document's own access control, not a bypass — and many EU ID
 * cards offer only PACE. Read-only, like the rest of the MRTD reader.
 *
 * Runs the generic mapping over ECDH on the six standardized curves
 * ({@link EcCurve#PACE_CURVES}), with 3DES or AES session keys. The four
 * chained GENERAL AUTHENTICATE steps (§4.4):
 * <ol>
 *   <li>the chip's nonce s, encrypted with Kπ = KDF(f(π), 3);</li>
 *   <li>map it: G̃ = s·G + SK_map·PK_map(chip);</li>
 *   <li>ephemeral ECDH on G̃ → shared secret K (x-coordinate) → KSenc, KSmac;</li>
 *   <li>exchange tokens MAC(KSmac, 7F49 { OID, the other side's key }).</li>
 * </ol>
 * Pinned to the ICAO 9303-11 Appendix G.1 and BSI TR-03110 worked examples,
 * byte for byte (PaceTest, the same vectors as test/nfc-pace.test.ts).
 *
 * <h3>Integration (MrtdReader), as mrtd.ts does it</h3>
 * <pre>
 *   // EF.CardAccess (FID 011C) sits in the master file, readable in the clear BEFORE selecting the eMRTD AID.
 *   PaceProtocol.SecurityInfos si = PaceProtocol.parseSecurityInfos(cardAccessBytes);
 *   PaceProtocol.Info info = PaceProtocol.choose(si.pace);        // null: no variant this reader runs → BAC
 *   PaceProtocol.Session ch = PaceProtocol.establish(t, info,
 *       can != null ? PaceProtocol.Password.ofCan(can) : PaceProtocol.Password.ofMrz(key));
 *   Bac.Sm sel = ch.send(Apdu.apdu(0x00, 0xa4, 0x04, 0x0c, MRTD_AID, -1)); // select the eMRTD application over SM
 *   Bac.Sm r = ch.send(Apdu.readBinary(0, 6));                   // …every later APDU through the channel
 * </pre>
 * {@link Channel} is the one seam: {@code Bac.Sm send(byte[] plainApdu)} —
 * protect → transmit → unprotect, returning the plain data and the status word
 * ({@link Bac.Sm}, what the reader's BAC path already returns). A BAC session
 * adapts to it with {@link #bacChannel}. Failures are {@link PaceException}
 * (an {@link IOException}) with a {@link PaceException#code}: "auth-failed" (the
 * chip refused the password, or its token did not verify), "unsupported" (a
 * variant this reader does not run, or a password the chip does not take),
 * "card-error" (another status word), "protocol" (a malformed answer). The
 * messages are pace.ts's; mrtd.ts prefixes them with "PACE: ".
 */
public final class PaceProtocol {
    private PaceProtocol() {}

    private static final SecureRandom RNG = new SecureRandom();

    /* ------------------------------------------------------------ the seam */

    /** A secure-messaging channel: send a plain APDU, get the plain answer back. */
    public interface Channel {
        /** One exchange: protect → transmit → unprotect. The data and the status word of the chip's answer. */
        Bac.Sm send(byte[] plainApdu) throws IOException;
    }

    /** The channel a BAC session gives (3DES secure messaging) — so a reader can hold either behind {@link Channel}. */
    public static Channel bacChannel(Apdu.Transceiver t, Bac.Session s) {
        return cmd -> unprotectTdes(s, t.transmit(Bac.protectApdu(s, cmd)));
    }

    private static Bac.Sm unprotectTdes(Bac.Session s, byte[] resp) throws PaceException {
        if (resp == null || resp.length < 2) throw new PaceException(PaceException.PROTOCOL, "Response shorter than SW1SW2 (" + (resp == null ? 0 : resp.length) + " bytes)", null);
        try { return Bac.unprotectResponse(s, resp); }
        catch (IllegalStateException e) { throw new PaceException(PaceException.PROTOCOL, e.getMessage(), null); }
    }

    /** Why PACE did not open the document. */
    public static final class PaceException extends IOException {
        public static final String AUTH_FAILED = "auth-failed", UNSUPPORTED = "unsupported", CARD_ERROR = "card-error", PROTOCOL = "protocol";
        /** auth-failed / unsupported / card-error / protocol. */
        public final String code;
        /** The status word as 4 hex digits ("6300"), when a status word was the reason; else null. */
        public final String sw;
        public PaceException(String code, String message, String sw) { super(message); this.code = code; this.sw = sw; }
    }

    /* ------------------------------------------------------------ what the chip announces */

    /** One PACEInfo (a PACE variant the chip runs). */
    public static final class Info {
        /** The protocol OID, dotted. */
        public final String oid;
        /** Its name ("PACE ECDH-GM AES-128"). */
        public final String name;
        public final int version;
        /** The standardized domain parameters (12 = NIST P-256, 13 = brainpoolP256r1…); null when absent. */
        public final Integer parameterId;
        /** "DH" / "ECDH". */
        public final String agreement;
        /** "GM" / "IM" / "CAM". */
        public final String mapping;
        /** "3DES" / "AES-128" / "AES-192" / "AES-256". */
        public final String cipher;

        public Info(String oid, String name, int version, Integer parameterId, String agreement, String mapping, String cipher) {
            this.oid = oid; this.name = name; this.version = version; this.parameterId = parameterId;
            this.agreement = agreement; this.mapping = mapping; this.cipher = cipher;
        }

        @Override public String toString() { return name + (parameterId != null ? " (" + parameterName(parameterId) + ")" : ""); }
    }

    /** What a SecurityInfos (EF.CardAccess, DG14) announces: the PACE variants, and every protocol by name. */
    public static final class SecurityInfos {
        public final List<Info> pace;
        public final List<String> protocols;
        SecurityInfos(List<Info> pace, List<String> protocols) { this.pace = pace; this.protocols = protocols; }
    }

    /** The standardized domain parameters (BSI TR-03110 Part 3, Table 4). */
    public static final Map<Integer, String> PARAMETERS;
    static {
        Map<Integer, String> m = new LinkedHashMap<>();
        m.put(0, "1024-bit MODP (160-bit subgroup)"); m.put(1, "2048-bit MODP (224-bit subgroup)"); m.put(2, "2048-bit MODP (256-bit subgroup)");
        m.put(8, "NIST P-192"); m.put(9, "brainpoolP192r1"); m.put(10, "NIST P-224"); m.put(11, "brainpoolP224r1"); m.put(12, "NIST P-256");
        m.put(13, "brainpoolP256r1"); m.put(14, "brainpoolP320r1"); m.put(15, "NIST P-384"); m.put(16, "brainpoolP384r1");
        m.put(17, "brainpoolP512r1"); m.put(18, "NIST P-521");
        PARAMETERS = Collections.unmodifiableMap(m);
    }

    /** "brainpoolP256r1", or "parameters 99" for an id outside the table. */
    public static String parameterName(int id) {
        String n = PARAMETERS.get(id);
        return n != null ? n : "parameters " + id;
    }

    private static final String PACE_PREFIX = "0.4.0.127.0.7.2.2.4.";
    private static final Map<String, String[]> AGREEMENT = new HashMap<>(); // kind → {agreement, mapping}
    private static final Map<String, String> CIPHER = new HashMap<>();
    static {
        AGREEMENT.put("1", new String[]{"DH", "GM"}); AGREEMENT.put("2", new String[]{"ECDH", "GM"});
        AGREEMENT.put("3", new String[]{"DH", "IM"}); AGREEMENT.put("4", new String[]{"ECDH", "IM"}); AGREEMENT.put("6", new String[]{"ECDH", "CAM"});
        CIPHER.put("1", "3DES"); CIPHER.put("2", "AES-128"); CIPHER.put("3", "AES-192"); CIPHER.put("4", "AES-256");
    }

    private static List<Apdu.Tlv> kids(Apdu.Tlv n) {
        if (n == null) return Collections.emptyList();
        if (n.children != null) return n.children;
        try { return Apdu.decodeTlv(n.tag == 0x03 ? Apdu.slice(n.value, 1) : n.value, true); }
        catch (RuntimeException e) { return Collections.emptyList(); }
    }

    /** Parses a SecurityInfos (the SET in EF.CardAccess or DG14). Tolerates trailing garbage; unknown infos are listed by OID. */
    public static SecurityInfos parseSecurityInfos(byte[] bytes) {
        List<Apdu.Tlv> top;
        try { top = Apdu.decodeTlv(bytes, true); } catch (RuntimeException e) { top = Collections.emptyList(); }
        Apdu.Tlv set = null;
        for (Apdu.Tlv n : top) if (n.tag == 0x31) { set = n; break; }
        if (set == null && !top.isEmpty()) set = top.get(0);
        List<Info> pace = new ArrayList<>();
        List<String> protocols = new ArrayList<>();
        for (Apdu.Tlv info : kids(set)) {
            List<Apdu.Tlv> k = kids(info);
            if (k.isEmpty() || k.get(0).tag != 0x06) continue;
            String oid = oidText(k.get(0).value);
            String name = oidName(oid);
            if (!protocols.contains(name)) protocols.add(name);
            if (!oid.startsWith(PACE_PREFIX)) continue;
            String[] rest = oid.substring(PACE_PREFIX.length()).split("\\.");
            String[] a = AGREEMENT.get(rest[0]);
            String c = rest.length > 1 ? CIPHER.get(rest[1]) : null;
            if (a == null || c == null) continue; // PACE domain parameter info, or something newer
            int version = k.size() > 1 && k.get(1).tag == 0x02 && k.get(1).value.length > 0 ? k.get(1).value[k.get(1).value.length - 1] & 0xff : 0;
            Integer param = null;
            if (k.size() > 2 && k.get(2).tag == 0x02) {
                long v = 0;
                for (byte x : k.get(2).value) v = Math.min(v * 256 + (x & 0xff), Integer.MAX_VALUE);
                param = (int) v;
            }
            pace.add(new Info(oid, name, version, param, a[0], a[1], c));
        }
        return new SecurityInfos(pace, protocols);
    }

    /** Whether this reader runs a PACE variant: the generic mapping over ECDH on a standardized curve it knows. */
    public static boolean supported(Info info) {
        return "GM".equals(info.mapping) && "ECDH".equals(info.agreement) && EcCurve.forParameterId(info.parameterId) != null;
    }

    private static final List<String> CIPHER_RANK = Arrays.asList("3DES", "AES-128", "AES-192", "AES-256");

    /** The variant to use: the strongest one this reader runs, or null. */
    public static Info choose(List<Info> infos) {
        List<Info> ok = new ArrayList<>();
        for (Info i : infos) if (supported(i)) ok.add(i);
        ok.sort((x, y) -> CIPHER_RANK.indexOf(y.cipher) - CIPHER_RANK.indexOf(x.cipher)); // stable, like Array.sort
        return ok.isEmpty() ? null : ok.get(0);
    }

    /* ------------------------------------------------------------ the password and the keys */

    /** The holder's password: the CAN printed on the document, or the MRZ key. */
    public static final class Password {
        /** The CAN (digits), or null for the MRZ. */
        public final String can;
        /** The MRZ key, or null for the CAN. */
        public final Bac.MrzKey key;
        private Password(String can, Bac.MrzKey key) { this.can = can; this.key = key; }
        public static Password ofCan(String can) { return new Password(can, null); }
        public static Password ofMrz(Bac.MrzKey key) { return new Password(null, key); }
        public boolean isMrz() { return can == null; }
        /** "CAN" / "MRZ" — as the messages name it. */
        public String label() { return isMrz() ? "MRZ" : "CAN"; }
    }

    /** Fixed ephemeral private keys (mapping, key agreement) — only to replay a worked example; random otherwise. */
    public static final class Ephemeral {
        public final BigInteger map, agreement;
        public Ephemeral(BigInteger map, BigInteger agreement) { this.map = map; this.agreement = agreement; }
    }

    private static byte[] digest(String alg, byte[] data) {
        try { return MessageDigest.getInstance(alg).digest(data); }
        catch (NoSuchAlgorithmException e) { throw new RuntimeException(e); }
    }

    /**
     * f(π), the password's encoding (ICAO 9303-11 Table 14): the CAN as its
     * ISO 8859-1 characters; the MRZ as SHA-1 of its MRZ information (document
     * number, date of birth, date of expiry, each with its check digit) — all
     * 20 bytes, unlike BAC's 16-byte seed.
     */
    public static byte[] secret(Password password) {
        if (!password.isMrz()) {
            byte[] out = new byte[password.can.length()];
            for (int i = 0; i < out.length; i++) out[i] = (byte) (password.can.charAt(i) & 0xff);
            return out;
        }
        return digest("SHA-1", Bac.mrzInformation(password.key).getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] fixParity(byte[] k) {
        byte[] out = k.clone();
        for (int i = 0; i < out.length; i++) {
            int b = out[i] & 0xfe;
            out[i] = (byte) (b | (Integer.bitCount(b) % 2 == 0 ? 1 : 0));
        }
        return out;
    }

    /**
     * KDF(K, c) = H(K || c) with c a 32-bit big-endian counter (§9.7.1): SHA-1
     * → 16 bytes for 3DES (DES parity set) and AES-128; SHA-256 → 24 / 32 bytes
     * for AES-192 / AES-256. c = 1: KSenc, 2: KSmac, 3: Kπ.
     */
    public static byte[] kdf(byte[] secret, int counter, String cipher) {
        byte[] input = Apdu.concat(secret, Apdu.u8(counter >>> 24, counter >> 16, counter >> 8, counter));
        switch (cipher) {
            case "3DES": return fixParity(Apdu.slice(digest("SHA-1", input), 0, 16));
            case "AES-128": return Apdu.slice(digest("SHA-1", input), 0, 16);
            case "AES-192": return Apdu.slice(digest("SHA-256", input), 0, 24);
            case "AES-256": return Apdu.slice(digest("SHA-256", input), 0, 32);
            default: throw new IllegalArgumentException("unknown PACE cipher " + cipher);
        }
    }

    /** Kπ = KDF(f(π), 3): the key the chip's nonce is encrypted with. */
    public static byte[] passwordKey(Password password, String cipher) { return kdf(secret(password), 3, cipher); }

    /** s = D(Kπ, z): CBC, zero IV, no padding (z is a whole number of blocks). */
    public static byte[] decryptNonce(String cipher, byte[] kpi, byte[] z) throws PaceException {
        boolean tdes = "3DES".equals(cipher);
        int block = tdes ? 8 : 16;
        if (z.length == 0 || z.length % block != 0)
            throw new PaceException(PaceException.PROTOCOL, "the encrypted nonce is " + z.length + " bytes, not whole " + block + "-byte blocks", null);
        return tdes ? Des.tdesCbcDecrypt(kpi, z) : Aes.cbcDecrypt(kpi, z);
    }

    /** The generic mapping's result: H = SK_map·PK_map(chip) and the new generator G̃ = s·G + H. */
    public static final class Mapped {
        public final EcCurve.Point H, G;
        Mapped(EcCurve.Point H, EcCurve.Point G) { this.H = H; this.G = G; }
    }

    /** The generic mapping (§4.4.3.3.1): H = SK_map·PK_map(chip), G̃ = s·G + H. */
    public static Mapped mapNonce(EcCurve curve, byte[] s, BigInteger skMap, EcCurve.Point pkMapChip) throws PaceException {
        EcCurve.Point H = curve.mul(skMap, pkMapChip);
        EcCurve.Point G = H != null ? curve.add(curve.mul(EcCurve.bytesToBigInt(s)), H) : null;
        if (H == null || G == null) throw new PaceException(PaceException.PROTOCOL, "the mapped generator is the point at infinity", null);
        return new Mapped(H, G);
    }

    /**
     * An authentication token (§4.4.3.4): the MAC under KSmac of the public key
     * data object 7F49 { 06 protocol OID, 86 ephemeral public point } — AES-CMAC
     * cut to 8 bytes, or for 3DES the retail MAC over the M2-padded input.
     */
    public static byte[] authToken(String cipher, byte[] ksmac, String oid, byte[] publicKey) {
        byte[] data = tlv(0x7f49, Apdu.concat(tlv(0x06, oidBytes(oid)), tlv(0x86, publicKey)));
        return "3DES".equals(cipher) ? Des.retailMac(ksmac, Des.pad(data)) : Apdu.slice(Aes.cmac(ksmac, data), 0, 8);
    }

    /* ------------------------------------------------------------ the protocol */

    /** MSE:Set AT accepted: 9000, or 63Cx — a password retry counter some cards report, the protocol still selected. */
    private static boolean selected(int sw) { return Apdu.isOk(sw) || ((sw & 0xfff0) == 0x63c0 && (sw & 0x0f) > 0); }

    private static Apdu.Response exchange(Apdu.Transceiver t, byte[] cmd) throws IOException {
        byte[] raw = t.transmit(cmd);
        if (raw == null || raw.length < 2) throw new PaceException(PaceException.PROTOCOL, "Response shorter than SW1SW2 (" + (raw == null ? 0 : raw.length) + " bytes)", null);
        return Apdu.splitResponse(raw);
    }

    /** One GENERAL AUTHENTICATE of the chain (CLA 10 while more follow); the data objects inside the answer's 7C. */
    private static List<Apdu.Tlv> authenticate(Apdu.Transceiver t, Password password, byte[] dos, String step, boolean last) throws IOException {
        Apdu.Response r = exchange(t, Apdu.apdu(last ? 0x00 : 0x10, 0x86, 0x00, 0x00, tlv(0x7c, dos), 0));
        if (!Apdu.isOk(r.sw)) {
            boolean refused = last || (r.sw >> 8) == 0x63 || r.sw == 0x6983 || r.sw == 0x6984;
            throw new PaceException(refused ? PaceException.AUTH_FAILED : PaceException.CARD_ERROR,
                refused ? "the document did not accept the " + password.label() + " (SW " + swHex(r.sw) + ")"
                        : step + ": " + describeSw(r.sw) + " (SW " + swHex(r.sw) + ")", swHex(r.sw));
        }
        List<Apdu.Tlv> nodes;
        try { nodes = Apdu.decodeTlv(r.data, true); } catch (RuntimeException e) { nodes = Collections.emptyList(); }
        Apdu.Tlv dyn = Apdu.findTlv(nodes, 0x7c);
        if (dyn == null) throw new PaceException(PaceException.PROTOCOL, step + ": the answer carries no dynamic authentication data (7C)", null);
        return dyn.children != null ? dyn.children : Collections.emptyList();
    }

    private static byte[] valueOf(List<Apdu.Tlv> dos, int tag) {
        Apdu.Tlv n = Apdu.findTlv(dos, tag);
        return n != null ? n.value : null;
    }

    /** Runs PACE with random ephemeral keys. See {@link #establish(Apdu.Transceiver, Info, Password, Ephemeral)}. */
    public static Session establish(Apdu.Transceiver t, Info info, Password password) throws IOException {
        return establish(t, info, password, null);
    }

    /**
     * Runs PACE with the holder's CAN or MRZ and returns the secure-messaging
     * session (SSC zero), bound to {@code t}. Throws {@link PaceException}:
     * "auth-failed" when the chip refuses the password (63xx, or its token does
     * not verify), "unsupported" for a variant this reader does not run,
     * "card-error" / "protocol" otherwise. {@code ephemeral} fixes the two
     * private keys (tests replaying a worked example); null for random ones.
     */
    public static Session establish(Apdu.Transceiver t, Info info, Password password, Ephemeral ephemeral) throws IOException {
        if (!supported(info)) {
            String param = info.parameterId != null ? " (" + parameterName(info.parameterId) + ")" : "";
            throw new PaceException(PaceException.UNSUPPORTED, info.name + param + " is not a variant this reader runs — only the generic mapping over ECDH on the standardized curves", null);
        }
        EcCurve curve = EcCurve.forParameterId(info.parameterId);
        String cipher = info.cipher;

        // MSE:Set AT — the protocol (80), the password (83: 01 MRZ, 02 CAN) and the
        // domain parameters (84). 84 is optional; a chip that refuses it is asked again without.
        byte[] mse = Apdu.concat(tlv(0x80, oidBytes(info.oid)), tlv(0x83, Apdu.u8(password.isMrz() ? 0x01 : 0x02)));
        Apdu.Response set = exchange(t, Apdu.apdu(0x00, 0x22, 0xc1, 0xa4, Apdu.concat(mse, tlv(0x84, Apdu.u8(info.parameterId))), -1));
        if (!selected(set.sw)) set = exchange(t, Apdu.apdu(0x00, 0x22, 0xc1, 0xa4, mse, -1));
        if (!selected(set.sw)) {
            if (set.sw == 0x6a88) throw new PaceException(PaceException.UNSUPPORTED, "the document does not take the " + password.label() + " for PACE (SW 6A88)", "6A88");
            throw new PaceException(PaceException.CARD_ERROR, "the document refused " + info.name + " — " + describeSw(set.sw) + " (SW " + swHex(set.sw) + ")", swHex(set.sw));
        }

        // 1. The encrypted nonce.
        byte[] kpi = passwordKey(password, cipher);
        byte[] z = valueOf(authenticate(t, password, new byte[0], "encrypted nonce", false), 0x80);
        if (z == null) throw new PaceException(PaceException.PROTOCOL, "no encrypted nonce (80) in the answer", null);
        byte[] s = decryptNonce(cipher, kpi, z);

        // 2. Map the nonce to a new generator.
        BigInteger skMap = ephemeral != null ? ephemeral.map : curve.randomScalar(RNG);
        EcCurve.Point pkMap = curve.mul(skMap);
        byte[] mapped = valueOf(authenticate(t, password, tlv(0x81, curve.encode(pkMap)), "map nonce", false), 0x82);
        EcCurve.Point pkMapChip = mapped != null ? curve.decode(mapped) : null;
        if (pkMapChip == null) throw new PaceException(PaceException.PROTOCOL, "the document's mapping key is not a point of the curve", null);
        EcCurve.Point G = mapNonce(curve, s, skMap, pkMapChip).G;

        // 3. Key agreement on G̃.
        BigInteger sk = ephemeral != null ? ephemeral.agreement : curve.randomScalar(RNG);
        byte[] pkPcd = curve.encode(curve.mul(sk, G));
        byte[] pkChipBytes = valueOf(authenticate(t, password, tlv(0x83, pkPcd), "key agreement", false), 0x84);
        EcCurve.Point pkChip = pkChipBytes != null ? curve.decode(pkChipBytes) : null;
        if (pkChip == null || Arrays.equals(pkChipBytes, pkPcd)) throw new PaceException(PaceException.PROTOCOL, "the document's ephemeral key is invalid", null);
        EcCurve.Point shared = curve.mul(sk, pkChip);
        if (shared == null) throw new PaceException(PaceException.PROTOCOL, "the shared secret is the point at infinity", null);
        byte[] k = EcCurve.bigIntToBytes(shared.x, curve.size);
        byte[] ksenc = kdf(k, 1, cipher);
        byte[] ksmac = kdf(k, 2, cipher);

        // 4. Mutual authentication: our token over the chip's key, theirs over ours.
        List<Apdu.Tlv> answer = authenticate(t, password, tlv(0x85, authToken(cipher, ksmac, info.oid, pkChipBytes)), "mutual authentication", true);
        byte[] tChip = valueOf(answer, 0x86);
        if (tChip == null || !MessageDigest.isEqual(tChip, authToken(cipher, ksmac, info.oid, pkPcd)))
            throw new PaceException(PaceException.AUTH_FAILED, "the document's authentication token did not verify", null);

        // Secure messaging from here, the SSC starting at zero (§9.8.6.3, §9.8.7.3).
        return new Session(t, info, ksenc, ksmac);
    }

    /**
     * An open PACE session: the session keys and the secure-messaging state
     * (AES, or 3DES as BAC's), bound to the transport it was established on.
     */
    public static final class Session implements Channel {
        public final Info info;
        /** "3DES" / "AES-128" / "AES-192" / "AES-256". */
        public final String cipher;
        public final byte[] ksenc, ksmac;
        private final Apdu.Transceiver t;
        private final AesSm aes;          // AES suites
        private final Bac.Session tdes;   // the 3DES suite: BAC's secure messaging, SSC 8 zero bytes

        Session(Apdu.Transceiver t, Info info, byte[] ksenc, byte[] ksmac) {
            this.t = t; this.info = info; this.cipher = info.cipher; this.ksenc = ksenc; this.ksmac = ksmac;
            if ("3DES".equals(cipher)) { this.tdes = new Bac.Session(ksenc, ksmac, new byte[8]); this.aes = null; }
            else { this.aes = new AesSm(ksenc, ksmac, new byte[16]); this.tdes = null; }
        }

        /** The live send sequence counter (16 bytes for AES, 8 for 3DES). */
        public byte[] ssc() { return aes != null ? aes.ssc : tdes.ssc; }

        /** The AES secure messaging (null for 3DES). */
        public AesSm aesSm() { return aes; }

        /** The 3DES secure messaging as a BAC session (null for AES) — Bac.protectApdu / unprotectResponse take it. */
        public Bac.Session bacSession() { return tdes; }

        /** Wraps a plain APDU (advances the SSC). */
        public byte[] protect(byte[] plainApdu) { return aes != null ? aes.protect(plainApdu) : Bac.protectApdu(tdes, plainApdu); }

        /** Unwraps the chip's answer (advances the SSC). */
        public Bac.Sm unprotect(byte[] response) throws IOException { return aes != null ? aes.unprotect(response) : unprotectTdes(tdes, response); }

        @Override public Bac.Sm send(byte[] plainApdu) throws IOException { return unprotect(t.transmit(protect(plainApdu))); }
    }

    /* ------------------------------------------------------------ DER / TLV / SW helpers */

    /** BER-TLV encode (tag up to 4 bytes, definite length). */
    static byte[] tlv(int tag, byte[] value) {
        byte[] t;
        if ((tag & 0xffffff00) == 0) t = Apdu.u8(tag);
        else if ((tag & 0xffff0000) == 0) t = Apdu.u8(tag >> 8, tag);
        else if ((tag & 0xff000000) == 0) t = Apdu.u8(tag >> 16, tag >> 8, tag);
        else t = Apdu.u8(tag >>> 24, tag >> 16, tag >> 8, tag);
        int n = value.length;
        byte[] l;
        if (n < 0x80) l = Apdu.u8(n);
        else if (n <= 0xff) l = Apdu.u8(0x81, n);
        else if (n <= 0xffff) l = Apdu.u8(0x82, n >> 8, n);
        else if (n <= 0xffffff) l = Apdu.u8(0x83, n >> 16, n >> 8, n);
        else l = Apdu.u8(0x84, n >>> 24, n >> 16, n >> 8, n);
        return Apdu.concat(t, l, value);
    }

    /** An OBJECT IDENTIFIER's value → dotted text. */
    public static String oidText(byte[] v) {
        if (v.length == 0) return "";
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
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(Integer.parseInt(p[0]) * 40 + Integer.parseInt(p[1]));
        for (int i = 2; i < p.length; i++) {
            long v = Long.parseLong(p[i]);
            byte[] enc = new byte[10];
            int k = enc.length;
            enc[--k] = (byte) (v & 0x7f);
            for (v >>>= 7; v > 0; v >>>= 7) enc[--k] = (byte) ((v & 0x7f) | 0x80);
            out.write(enc, k, enc.length - k);
        }
        return out.toByteArray();
    }

    /** Well-known OIDs the travel documents use (asn1.ts OID_NAMES). */
    public static final Map<String, String> OID_NAMES;
    static {
        Map<String, String> m = new HashMap<>();
        String[][] rows = {
            {"1.3.14.3.2.26", "SHA-1"},
            {"2.16.840.1.101.3.4.2.4", "SHA-224"},
            {"2.16.840.1.101.3.4.2.1", "SHA-256"},
            {"2.16.840.1.101.3.4.2.2", "SHA-384"},
            {"2.16.840.1.101.3.4.2.3", "SHA-512"},
            {"1.2.840.113549.1.1.1", "RSA"},
            {"1.2.840.10045.2.1", "EC"},
            {"1.2.840.113549.1.7.2", "CMS signed data"},
            {"2.23.136.1.1.1", "LDS security object"},
            {"2.23.136.1.1.5", "Active Authentication"},
            {"0.4.0.127.0.7.2.2.1.1", "Chip Authentication key (DH)"},
            {"0.4.0.127.0.7.2.2.1.2", "Chip Authentication key (ECDH)"},
            {"0.4.0.127.0.7.2.2.2", "Terminal Authentication"},
            {"0.4.0.127.0.7.2.2.3.1.1", "Chip Authentication (DH, 3DES)"},
            {"0.4.0.127.0.7.2.2.3.1.2", "Chip Authentication (DH, AES-128)"},
            {"0.4.0.127.0.7.2.2.3.1.3", "Chip Authentication (DH, AES-192)"},
            {"0.4.0.127.0.7.2.2.3.1.4", "Chip Authentication (DH, AES-256)"},
            {"0.4.0.127.0.7.2.2.3.2.1", "Chip Authentication (ECDH, 3DES)"},
            {"0.4.0.127.0.7.2.2.3.2.2", "Chip Authentication (ECDH, AES-128)"},
            {"0.4.0.127.0.7.2.2.3.2.3", "Chip Authentication (ECDH, AES-192)"},
            {"0.4.0.127.0.7.2.2.3.2.4", "Chip Authentication (ECDH, AES-256)"},
            {"0.4.0.127.0.7.2.2.4.1.1", "PACE DH-GM 3DES"},
            {"0.4.0.127.0.7.2.2.4.1.2", "PACE DH-GM AES-128"},
            {"0.4.0.127.0.7.2.2.4.1.3", "PACE DH-GM AES-192"},
            {"0.4.0.127.0.7.2.2.4.1.4", "PACE DH-GM AES-256"},
            {"0.4.0.127.0.7.2.2.4.2.1", "PACE ECDH-GM 3DES"},
            {"0.4.0.127.0.7.2.2.4.2.2", "PACE ECDH-GM AES-128"},
            {"0.4.0.127.0.7.2.2.4.2.3", "PACE ECDH-GM AES-192"},
            {"0.4.0.127.0.7.2.2.4.2.4", "PACE ECDH-GM AES-256"},
            {"0.4.0.127.0.7.2.2.4.3.1", "PACE DH-IM 3DES"},
            {"0.4.0.127.0.7.2.2.4.3.2", "PACE DH-IM AES-128"},
            {"0.4.0.127.0.7.2.2.4.3.3", "PACE DH-IM AES-192"},
            {"0.4.0.127.0.7.2.2.4.3.4", "PACE DH-IM AES-256"},
            {"0.4.0.127.0.7.2.2.4.4.1", "PACE ECDH-IM 3DES"},
            {"0.4.0.127.0.7.2.2.4.4.2", "PACE ECDH-IM AES-128"},
            {"0.4.0.127.0.7.2.2.4.4.3", "PACE ECDH-IM AES-192"},
            {"0.4.0.127.0.7.2.2.4.4.4", "PACE ECDH-IM AES-256"},
            {"0.4.0.127.0.7.2.2.4.6.2", "PACE ECDH-CAM AES-128"},
            {"0.4.0.127.0.7.2.2.4.6.3", "PACE ECDH-CAM AES-192"},
            {"0.4.0.127.0.7.2.2.4.6.4", "PACE ECDH-CAM AES-256"},
            {"0.4.0.127.0.7.2.2.5", "Restricted Identification"},
            {"0.4.0.127.0.7.2.2.6", "Card info"},
            {"0.4.0.127.0.7.2.2.12", "PACE domain parameters"},
            {"1.2.840.10045.3.1.7", "NIST P-256"},
            {"1.3.132.0.34", "NIST P-384"},
            {"1.3.132.0.35", "NIST P-521"},
            {"1.3.36.3.3.2.8.1.1.7", "brainpoolP256r1"},
            {"1.3.36.3.3.2.8.1.1.11", "brainpoolP384r1"},
            {"1.3.36.3.3.2.8.1.1.13", "brainpoolP512r1"},
            {"2.5.4.3", "CN"}, {"2.5.4.6", "C"}, {"2.5.4.7", "L"}, {"2.5.4.8", "ST"}, {"2.5.4.10", "O"}, {"2.5.4.11", "OU"}, {"2.5.4.5", "serialNumber"},
        };
        for (String[] r : rows) m.put(r[0], r[1]);
        OID_NAMES = Collections.unmodifiableMap(m);
    }

    /** An OID's name, or the OID itself. */
    public static String oidName(String oid) {
        String n = OID_NAMES.get(oid);
        return n != null ? n : oid;
    }

    /** "6300" — the status word as 4 upper-case hex digits. */
    public static String swHex(int sw) { return String.format("%04X", sw & 0xffff); }

    /** A human-readable status word (ISO 7816-4 + common proprietary codes), apdu.ts describeSw. */
    public static String describeSw(int sw) {
        int sw1 = sw >> 8, sw2 = sw & 0xff;
        if (sw == 0x9000) return "OK";
        if (sw1 == 0x61) return "OK, " + sw2 + " more byte(s) available (GET RESPONSE)";
        if (sw1 == 0x6c) return "Wrong Le, retry with Le=" + sw2;
        if (sw1 == 0x63 && (sw2 & 0xf0) == 0xc0) return "Verification failed, " + (sw2 & 0x0f) + " retries left";
        if (sw1 == 0x62 && sw2 == 0x82) return "End of file reached before Le";
        if (sw1 == 0x63 && sw2 == 0x00) return "Verification failed / no info";
        if (sw1 == 0x91) { String d = DESFIRE.get(sw2); return "DESFire status " + String.format("%02x", sw2) + (d != null ? d : ""); }
        String text = SW_TEXT.get(sw);
        return text != null ? text : "Unknown status " + swHex(sw);
    }

    private static final Map<Integer, String> SW_TEXT = new HashMap<>(), DESFIRE = new HashMap<>();
    static {
        DESFIRE.put(0x00, " (OPERATION_OK)"); DESFIRE.put(0x0c, " (NO_CHANGES)"); DESFIRE.put(0x0e, " (OUT_OF_EEPROM)"); DESFIRE.put(0x1c, " (ILLEGAL_COMMAND)");
        DESFIRE.put(0x1e, " (INTEGRITY_ERROR)"); DESFIRE.put(0x40, " (NO_SUCH_KEY)"); DESFIRE.put(0x7e, " (LENGTH_ERROR)"); DESFIRE.put(0x9d, " (PERMISSION_DENIED)");
        DESFIRE.put(0x9e, " (PARAMETER_ERROR)"); DESFIRE.put(0xa0, " (APPLICATION_NOT_FOUND)"); DESFIRE.put(0xae, " (AUTHENTICATION_ERROR)");
        DESFIRE.put(0xaf, " (ADDITIONAL_FRAME)"); DESFIRE.put(0xbe, " (BOUNDARY_ERROR)"); DESFIRE.put(0xca, " (COMMAND_ABORTED)"); DESFIRE.put(0xf0, " (FILE_NOT_FOUND)");
        SW_TEXT.put(0x6200, "Warning: no information");
        SW_TEXT.put(0x6281, "Part of returned data may be corrupted");
        SW_TEXT.put(0x6283, "Selected file invalidated");
        SW_TEXT.put(0x6300, "Authentication failed");
        SW_TEXT.put(0x6581, "Memory failure");
        SW_TEXT.put(0x6700, "Wrong length");
        SW_TEXT.put(0x6800, "Functions in CLA not supported");
        SW_TEXT.put(0x6881, "Logical channel not supported");
        SW_TEXT.put(0x6882, "Secure messaging not supported");
        SW_TEXT.put(0x6900, "Command not allowed");
        SW_TEXT.put(0x6981, "Command incompatible with file structure");
        SW_TEXT.put(0x6982, "Security status not satisfied");
        SW_TEXT.put(0x6983, "Authentication method blocked");
        SW_TEXT.put(0x6984, "Referenced data invalidated");
        SW_TEXT.put(0x6985, "Conditions of use not satisfied");
        SW_TEXT.put(0x6986, "Command not allowed (no current EF)");
        SW_TEXT.put(0x6987, "Expected secure messaging data objects missing");
        SW_TEXT.put(0x6988, "Secure messaging data objects incorrect");
        SW_TEXT.put(0x6a80, "Incorrect parameters in data field");
        SW_TEXT.put(0x6a81, "Function not supported");
        SW_TEXT.put(0x6a82, "File or application not found");
        SW_TEXT.put(0x6a83, "Record not found");
        SW_TEXT.put(0x6a84, "Not enough memory space");
        SW_TEXT.put(0x6a86, "Incorrect P1/P2");
        SW_TEXT.put(0x6a87, "Lc inconsistent with P1/P2");
        SW_TEXT.put(0x6a88, "Referenced data not found");
        SW_TEXT.put(0x6b00, "Wrong parameters P1/P2");
        SW_TEXT.put(0x6d00, "Instruction not supported");
        SW_TEXT.put(0x6e00, "Class not supported");
        SW_TEXT.put(0x6f00, "No precise diagnosis / card mute");
    }
}
