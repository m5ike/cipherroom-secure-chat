package cz.m5cet.app.nfc;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The NFC catalogue (6.3): which card technologies the tool knows and which
 * operations each one supports — a byte-for-byte mirror of the op ids in
 * client/src/lib/nfc/catalog.ts, so the workbench, the M5Cet builder and the
 * Functions {@code m5.nfc} object offer exactly the same set on web and Android.
 *
 * STANDARD operations only: reading a card's public identity and NDEF, and
 * reading/writing sectors or files with keys the USER has (a key dictionary).
 * No unknown-key recovery (nested/darkside/hardnested); EMV and e-ID are PUBLIC
 * data only.
 */
public final class NfcCatalog {
    private NfcCatalog() {}

    // The technology names — identical to catalog.ts NfcTech.
    public static final String M5CET_CARD = "m5cet-card";
    public static final String CONNECTION_TAG = "connection-tag";
    public static final String NDEF = "ndef";
    public static final String MIFARE_CLASSIC_1K = "mifare-classic-1k";
    public static final String MIFARE_CLASSIC_4K = "mifare-classic-4k";
    public static final String MIFARE_CLASSIC_MINI = "mifare-classic-mini";
    public static final String MIFARE_ULTRALIGHT = "mifare-ultralight";
    public static final String NTAG21X = "ntag21x";
    public static final String MIFARE_DESFIRE = "mifare-desfire";
    public static final String ISO_DEP = "iso-dep";
    public static final String ISO14443A = "iso14443a";
    public static final String ISO14443B = "iso14443b";
    public static final String ISO15693 = "iso15693";
    public static final String FELICA = "felica";
    public static final String EMV = "emv";
    public static final String EID = "eid";
    public static final String UNKNOWN = "unknown";

    /** What one operation does and where it applies. */
    public static final class Op {
        public final String id;
        public final String label;
        /** read = only reads the card; write = changes it; emulate = the phone acts as the card. */
        public final String kind;
        /** A key, PIN or account is needed (null when nothing extra is). */
        public final String needs;
        public final String help;
        Op(String id, String label, String kind, String needs, String help) {
            this.id = id; this.label = label; this.kind = kind; this.needs = needs; this.help = help;
        }
    }

    /** Everything about one technology. */
    public static final class TechInfo {
        public final String tech;
        public final String label;
        public final String standard;
        /** Bytes of user memory, or "" when it does not apply. */
        public final String memory;
        public final List<Op> ops;
        TechInfo(String tech, String label, String standard, String memory, List<Op> ops) {
            this.tech = tech; this.label = label; this.standard = standard; this.memory = memory; this.ops = ops;
        }
    }

    private static Op op(String id, String label, String kind, String needs, String help) { return new Op(id, label, kind, needs, help); }

    /** Operations every activated card offers (public identity). */
    private static List<Op> common() {
        return new ArrayList<>(Arrays.asList(
            op("scan", "Scan", "read", null, "Read the UID, the card type and any public record — kept in a scan loop."),
            op("read-uid", "Read UID", "read", null, "The card's UID / serial as the reader sees it."),
            op("read-public", "Read public data", "read", null, "The freely readable data: NDEF, the ATS/ATR, version."),
            op("raw-apdu", "Send APDU", "read", "key", "Send a raw ISO 7816 APDU and show the response (advanced).")
        ));
    }

    private static List<Op> ndefOps() {
        return Arrays.asList(
            op("ndef-read", "Read NDEF", "read", null, "The NDEF records (text, URI, MIME, external)."),
            op("ndef-write", "Write NDEF", "write", null, "Write NDEF records (text, URI, MIME…)."),
            op("ndef-lock", "Make read-only", "write", null, "Lock the tag so its NDEF can no longer be changed (permanent).")
        );
    }

    private static List<Op> classicOps() {
        return Arrays.asList(
            op("classic-read", "Read sectors", "read", "keys-dictionary", "Read the blocks whose key A/B you know (or from the key list)."),
            op("classic-write", "Write block", "write", "key", "Write a block with its key."),
            op("classic-dump", "Dump", "read", "keys-dictionary", "Read every sector reachable with the known keys, as a .mfd/.json."),
            op("classic-restore", "Restore dump", "write", "keys-dictionary", "Write a dump back to a card with matching keys.")
        );
    }

    private static final Op UID_WRITE = op("write-uid", "Change UID", "write", "key",
        "Set the UID and block 0 — only on a UID-changeable (\"magic\") card you own.");

    private static TechInfo t(String tech, String label, String standard, String memory, List<Op> extra) {
        List<Op> ops = common();
        ops.addAll(extra);
        return new TechInfo(tech, label, standard, memory, Collections.unmodifiableList(ops));
    }

    @SafeVarargs
    private static List<Op> concat(List<Op>... lists) {
        List<Op> out = new ArrayList<>();
        for (List<Op> l : lists) out.addAll(l);
        return out;
    }

    public static final List<TechInfo> CATALOG;
    private static final Map<String, TechInfo> BY_TECH = new LinkedHashMap<>();
    static {
        List<TechInfo> c = new ArrayList<>();
        c.add(t(M5CET_CARD, "M5Cet card", "M5Cet encrypted container over NDEF", "tag-dependent", concat(ndefOps(), Arrays.asList(
            op("m5-read", "Open records", "read", "pin", "List the card's records and open each with its PIN or your account."),
            op("m5-write", "Write records", "write", "pin", "Build the card's records (the M5Cet builder) and write them."),
            op("m5-erase", "Erase a record", "write", null, "Remove one record (a one-time record erases itself after it is shown)."),
            op("m5-emulate", "Be the card", "emulate", null, "The phone answers as a Type 4 tag holding this card (HCE).")
        ))));
        c.add(t(CONNECTION_TAG, "M5cet connection tag", "NDEF · application/vnd.m5cet.conn", "~250 B", concat(ndefOps(), Arrays.asList(
            op("conn-read", "Open connection", "read", "pin", "Open the room + passphrase with the PIN and offer to join."),
            op("conn-write", "Write connection", "write", "pin", "Write the active room onto the tag."),
            op("conn-emulate", "Be the tag", "emulate", null, "The phone answers as the connection tag (HCE).")
        ))));
        c.add(t(NDEF, "NDEF tag", "NFC Forum Type 1–5", "tag-dependent", ndefOps()));
        c.add(t(MIFARE_CLASSIC_1K, "MIFARE Classic 1K", "ISO 14443-3A · NXP", "1024 B (16 sectors)", concat(ndefOps(), classicOps(), Arrays.asList(UID_WRITE))));
        c.add(t(MIFARE_CLASSIC_4K, "MIFARE Classic 4K", "ISO 14443-3A · NXP", "4096 B (40 sectors)", concat(ndefOps(), classicOps(), Arrays.asList(UID_WRITE))));
        c.add(t(MIFARE_CLASSIC_MINI, "MIFARE Classic Mini", "ISO 14443-3A · NXP", "320 B (5 sectors)", concat(ndefOps(), classicOps(), Arrays.asList(UID_WRITE))));
        c.add(t(MIFARE_ULTRALIGHT, "MIFARE Ultralight", "ISO 14443-3A · NXP", "64–192 B", concat(ndefOps(), Arrays.asList(
            op("ul-read", "Read pages", "read", null, "Read the 4-byte pages (READ / FAST_READ)."),
            op("ul-write", "Write page", "write", null, "Write a 4-byte page (WRITE)."),
            op("ul-password", "Set password", "write", "key", "Set the AUTH0 / PWD / PACK protection (Ultralight C / EV1).")
        ))));
        c.add(t(NTAG21X, "NTAG 213 / 215 / 216", "ISO 14443-3A · NXP NTAG", "144 / 504 / 888 B", concat(ndefOps(), Arrays.asList(
            op("ntag-read", "Read pages", "read", null, "Read the pages (READ / FAST_READ)."),
            op("ntag-write", "Write page", "write", null, "Write a page (WRITE)."),
            op("ntag-password", "Set password", "write", "key", "Set PWD / PACK and AUTH0 password protection."),
            op("ntag-counter", "Read counter", "read", null, "The NFC read counter and the signature (ECC), where enabled.")
        ))));
        c.add(t(MIFARE_DESFIRE, "MIFARE DESFire EV1/2/3", "ISO 14443-4 · NXP", "2–8 KB (applications & files)", concat(ndefOps(), Arrays.asList(
            op("desfire-apps", "List applications", "read", null, "Enumerate the applications (AIDs) and the master info."),
            op("desfire-files", "List files", "read", "key", "The files of an application and their settings."),
            op("desfire-read", "Read file", "read", "key", "Read a data / record file after authenticating (AES/2K3DES)."),
            op("desfire-write", "Write file", "write", "key", "Write a file after authenticating with its key.")
        ))));
        c.add(t(ISO_DEP, "ISO-DEP (ISO 14443-4)", "ISO 14443-4 / ISO 7816", "", Arrays.asList(
            op("select-aid", "Select application", "read", null, "SELECT an AID and talk to it with APDUs."),
            op("app-template", "Application template", "read", null, "Send a saved APDU application template (apduTemplates in Android › Define).")
        )));
        c.add(t(ISO14443A, "ISO/IEC 14443 Type A", "ISO 14443-3A", "", Collections.emptyList()));
        c.add(t(ISO14443B, "ISO/IEC 14443 Type B", "ISO 14443-3B", "", Collections.emptyList()));
        c.add(t(ISO15693, "ISO/IEC 15693 (vicinity)", "ISO 15693 / NFC Type 5", "tag-dependent", Arrays.asList(
            op("v-read", "Read blocks", "read", null, "Read the memory blocks (Get System Info, Read Multiple)."),
            op("v-write", "Write block", "write", "key", "Write a block (and lock it).")
        )));
        c.add(t(FELICA, "FeliCa", "JIS X 6319-4 · Sony", "service/block", Arrays.asList(
            op("felica-systems", "Read systems", "read", null, "The system codes, IDm/PMm and the public services."),
            op("felica-read", "Read service", "read", "key", "Read a service's blocks (Read Without Encryption for public ones).")
        )));
        c.add(t(EMV, "EMV payment card", "ISO 14443-4 · EMV", "", Arrays.asList(
            op("emv-public", "Read public data", "read", null, "Only the freely readable data (PPSE, the card's application labels, and where allowed the masked PAN and expiry). No PIN, no signing, no transaction."),
            op("emv-read", "Read card data", "read", null, "Read the card's applications and records (PPSE → SELECT AID → GPO → READ RECORD) and parse the holder data a terminal reads: AIDs, labels, PAN, expiry, name, counters. Read-only — no PIN, no cryptogram, no transaction."),
            op("app-template", "Application template", "read", null, "Send a saved APDU application template (apduTemplates in Android › Define).")
        )));
        c.add(t(EID, "Electronic ID / MRTD", "ISO 14443-4 · ICAO 9303 / eIDAS", "", Arrays.asList(
            op("eid-public", "Read public info", "read", null, "The document type and the data the holder unlocks with the CAN/MRZ they type. No cloning, no signing."),
            op("eid-read", "Read document (BAC)", "read", "key", "Open the chip with the holder's own MRZ (passport no. + date of birth + expiry) or CAN — the document's own access control — and read DG1 (the MRZ data) and DG2 (the face) over secure messaging. The holder's own document, read-only.")
        )));
        c.add(new TechInfo(UNKNOWN, "Unknown card", "—", "", Collections.<Op>emptyList()));
        CATALOG = Collections.unmodifiableList(c);
        for (TechInfo ti : CATALOG) BY_TECH.put(ti.tech, ti);
    }

    public static TechInfo techInfo(String tech) {
        TechInfo ti = BY_TECH.get(tech);
        return ti != null ? ti : BY_TECH.get(UNKNOWN);
    }

    public static List<Op> opsFor(String tech) { return techInfo(tech).ops; }

    public static boolean supportsOp(String tech, String opId) {
        for (Op o : techInfo(tech).ops) if (o.id.equals(opId)) return true;
        return false;
    }

    public static Op findOp(String tech, String opId) {
        for (Op o : techInfo(tech).ops) if (o.id.equals(opId)) return o;
        return null;
    }

    /* ---------------------------------------------------------- readers */

    // Readers the tool can drive (the "internal / USB / Bluetooth / serial" choice).
    public static final String READER_INTERNAL = "internal";
    public static final String READER_USB = "usb";
    public static final String READER_BLUETOOTH = "bluetooth";
    public static final String READER_SERIAL = "serial";

    public static final class ReaderInfo {
        public final String kind;
        public final String label;
        public final String help;
        ReaderInfo(String kind, String label, String help) { this.kind = kind; this.label = label; this.help = help; }
    }

    /** The same NFC_READERS names as the web (catalog.ts). */
    public static final List<ReaderInfo> READERS = Collections.unmodifiableList(Arrays.asList(
        new ReaderInfo(READER_INTERNAL, "This device", "The phone or tablet's own NFC (Android: internal antenna; web: WebNFC in Android Chrome)."),
        new ReaderInfo(READER_USB, "USB reader", "A PC/SC (CCID) reader over USB — e.g. ACR122U, ACR1252 (web: WebUSB; Android: USB host)."),
        new ReaderInfo(READER_BLUETOOTH, "Bluetooth reader", "A BLE reader based on the PN532 or a vendor bridge (web: Web Bluetooth)."),
        new ReaderInfo(READER_SERIAL, "Serial reader", "A PN532 on a USB-serial adapter (web: Web Serial).")
    ));

    public static ReaderInfo readerInfo(String kind) {
        for (ReaderInfo r : READERS) if (r.kind.equals(kind)) return r;
        return READERS.get(0);
    }
}
