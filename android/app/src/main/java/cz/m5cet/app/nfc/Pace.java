package cz.m5cet.app.nfc;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * PACE — Password Authenticated Connection Establishment (6.6), ICAO 9303 Part
 * 11 §4.4 / BSI TR-03110 — the Java port of client/src/lib/nfc/cards/pace.ts.
 * The holder opens their own document with the CAN printed on it (or the MRZ),
 * and the chip and reader agree on session keys; every later APDU is wrapped in
 * secure messaging. Like BAC it is the document's own access control, not a
 * bypass — and many EU ID cards offer only PACE.
 *
 * This class reads what the chip announces (EF.CardAccess / DG14 → SecurityInfos
 * → PACEInfo) and chooses the variant; {@link #establish} runs the protocol
 * ({@link PaceProtocol} — generic mapping over ECDH on the six standardized
 * curves, AES or 3DES secure messaging, pinned to the ICAO 9303 and BSI
 * TR-03110 worked examples) and gives the reader its secure-messaging channel.
 */
public final class Pace {
    private Pace() {}

    /** One PACE variant the chip offers (a PACEInfo). */
    public static final class Info {
        /** The protocol OID, dotted. */
        public final String oid;
        /** Its name ("PACE ECDH-GM AES-128"). */
        public final String name;
        public final int version;
        /** The standardized domain parameters (12 = NIST P-256, 13 = brainpoolP256r1…), or null. */
        public final Integer parameterId;
        /** "DH" | "ECDH". */
        public final String agreement;
        /** "GM" | "IM" | "CAM". */
        public final String mapping;
        /** "3DES" | "AES-128" | "AES-192" | "AES-256". */
        public final String cipher;
        Info(String oid, String name, int version, Integer parameterId, String agreement, String mapping, String cipher) {
            this.oid = oid; this.name = name; this.version = version; this.parameterId = parameterId;
            this.agreement = agreement; this.mapping = mapping; this.cipher = cipher;
        }
    }

    /** What a SecurityInfos announces: the PACE variants and every protocol, by name. */
    public static final class SecurityInfos {
        public final List<Info> pace = new ArrayList<>();
        public final List<String> protocols = new ArrayList<>();
    }

    /** The password the holder opens the document with: the MRZ key or the CAN. */
    public static final class Password {
        /** "mrz" | "can". */
        public final String kind;
        public final Bac.MrzKey key;
        public final String can;
        private Password(String kind, Bac.MrzKey key, String can) { this.kind = kind; this.key = key; this.can = can; }
        public static Password mrz(Bac.MrzKey key) { return new Password("mrz", key, null); }
        public static Password can(String can) { return new Password("can", null, can); }
    }

    /** A PACE variant this reader does not run (yet): the caller falls back to BAC. */
    public static final class UnsupportedException extends IOException {
        public UnsupportedException(String message) { super(message); }
    }

    /** The standardized domain parameters (BSI TR-03110 Part 3, Table 4). */
    public static final Map<Integer, String> PARAMETERS = new HashMap<>();
    static {
        PARAMETERS.put(0, "1024-bit MODP (160-bit subgroup)"); PARAMETERS.put(1, "2048-bit MODP (224-bit subgroup)"); PARAMETERS.put(2, "2048-bit MODP (256-bit subgroup)");
        PARAMETERS.put(8, "NIST P-192"); PARAMETERS.put(9, "brainpoolP192r1"); PARAMETERS.put(10, "NIST P-224"); PARAMETERS.put(11, "brainpoolP224r1");
        PARAMETERS.put(12, "NIST P-256"); PARAMETERS.put(13, "brainpoolP256r1"); PARAMETERS.put(14, "brainpoolP320r1"); PARAMETERS.put(15, "NIST P-384");
        PARAMETERS.put(16, "brainpoolP384r1"); PARAMETERS.put(17, "brainpoolP512r1"); PARAMETERS.put(18, "NIST P-521");
    }

    private static final String PACE_PREFIX = "0.4.0.127.0.7.2.2.4.";
    private static final Map<String, String[]> AGREEMENT = new HashMap<>();
    private static final Map<String, String> CIPHER = new HashMap<>();
    static {
        AGREEMENT.put("1", new String[]{"DH", "GM"}); AGREEMENT.put("2", new String[]{"ECDH", "GM"});
        AGREEMENT.put("3", new String[]{"DH", "IM"}); AGREEMENT.put("4", new String[]{"ECDH", "IM"}); AGREEMENT.put("6", new String[]{"ECDH", "CAM"});
        CIPHER.put("1", "3DES"); CIPHER.put("2", "AES-128"); CIPHER.put("3", "AES-192"); CIPHER.put("4", "AES-256");
    }

    /** What a SecurityInfos (EF.CardAccess, DG14) announces: PACE variants and every protocol, by name. */
    public static SecurityInfos parseSecurityInfos(byte[] bytes) {
        SecurityInfos out = new SecurityInfos();
        List<Apdu.Tlv> top = Asn1.der(bytes);
        Apdu.Tlv set = null;
        for (Apdu.Tlv n : top) if (n.tag == Asn1.SET) { set = n; break; }
        if (set == null) set = Asn1.at(top, 0);
        for (Apdu.Tlv info : Asn1.kids(set)) {
            List<Apdu.Tlv> k = Asn1.kids(info);
            Apdu.Tlv first = Asn1.at(k, 0);
            if (first == null || first.tag != Asn1.OID) continue;
            String oid = Asn1.oidText(first.value);
            String name = Asn1.oidName(oid);
            if (!out.protocols.contains(name)) out.protocols.add(name);
            if (!oid.startsWith(PACE_PREFIX)) continue;
            String[] rest = oid.substring(PACE_PREFIX.length()).split("\\.");
            String[] a = AGREEMENT.get(rest[0]);
            String c = rest.length > 1 ? CIPHER.get(rest[1]) : null;
            if (a == null || c == null) continue; // PACE domain parameter info, or something newer
            Apdu.Tlv ver = Asn1.at(k, 1), par = Asn1.at(k, 2);
            int version = ver != null && ver.tag == Asn1.INT && ver.value.length > 0 ? ver.value[ver.value.length - 1] & 0xff : 0;
            Integer param = null;
            if (par != null && par.tag == Asn1.INT) { long p = 0; for (byte b : par.value) p = p * 256 + (b & 0xff); param = (int) p; }
            out.pace.add(new Info(oid, name, version, param, a[0], a[1], c));
        }
        return out;
    }

    private static final List<Integer> RUNNABLE_CURVES = Arrays.asList(12, 13, 15, 16, 17, 18);
    private static final List<String> CIPHER_RANK = Arrays.asList("3DES", "AES-128", "AES-192", "AES-256");

    /** Whether this reader can run a PACE variant (generic mapping on the standardized curves). */
    public static boolean supported(Info info) {
        return "GM".equals(info.mapping) && "ECDH".equals(info.agreement) && info.parameterId != null && RUNNABLE_CURVES.contains(info.parameterId);
    }

    /** The variant to use: the strongest one this reader runs, or null. */
    public static Info choose(List<Info> infos) {
        List<Info> ok = new ArrayList<>();
        for (Info i : infos) if (supported(i)) ok.add(i);
        if (ok.isEmpty()) return null;
        Collections.sort(ok, (x, y) -> CIPHER_RANK.indexOf(y.cipher) - CIPHER_RANK.indexOf(x.cipher));
        return ok.get(0);
    }

    /**
     * Runs PACE with the holder's CAN or MRZ and returns the secure-messaging
     * channel. A variant this reader does not run → {@link UnsupportedException};
     * a password the chip refuses → a {@link PaceProtocol.PaceException} with code
     * "auth-failed" (the reader then tries BAC when it has the MRZ).
     */
    public static SmChannel establish(Apdu.Transceiver t, Info info, Password password) throws IOException {
        if (!supported(info)) throw new UnsupportedException(info.name + (info.parameterId == null ? "" : " (" + (PARAMETERS.containsKey(info.parameterId) ? PARAMETERS.get(info.parameterId) : String.valueOf(info.parameterId)) + ")") + " is not a variant this reader runs");
        PaceProtocol.Info pi = new PaceProtocol.Info(info.oid, info.name, info.version, info.parameterId, info.agreement, info.mapping, info.cipher);
        PaceProtocol.Password pw = "can".equals(password.kind) ? PaceProtocol.Password.ofCan(password.can) : PaceProtocol.Password.ofMrz(password.key);
        PaceProtocol.Session session = PaceProtocol.establish(t, pi, pw);
        return new SmChannel() {
            @Override public String kind() { return "pace"; }
            @Override public Reply send(byte[] cmd) throws IOException {
                Bac.Sm r = session.send(cmd);
                return new Reply(r.data, r.sw);
            }
        };
    }
}
