package cz.m5cet.app.nfc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A Functions model's NFC command on this phone (6.6) — the Android side of
 * client/src/lib/nfc/command.ts and web-executor.ts. A model's
 * {@code m5.nfc.scan()} / {@code emv.report()} / {@code eid.report()} reaches
 * the caller as a run interaction of kind "nfc" whose spec.command is an
 * NfcCommand { op, reader?, tech?, timeout?, args? }; the phone runs the op on a
 * card and answers with an NfcResult { status, card?, ndef?, records?, emv?,
 * mrtd?, data?, message? }.
 *
 * This class is the part without android.*: reading the command (camelCase or
 * snake_case args), deciding what may run (a model never writes or emulates a
 * card: "denied"), which reader takes it, whether an e-ID read still needs the
 * holder's document key (asked on the phone, never sent), running the op on a
 * {@link Card} through the existing card layer ({@link CardOps#readResult}
 * for EMV / e-ID) and the result shapes. The sheet in ui/parts (NfcModelSheet)
 * and {@link ModelNfcDevice} put the phone's reader behind {@link Card}.
 *
 * Read-only: no PIN / VERIFY, no GENERATE AC, no write — the readers never send
 * one, and nothing here passes a raw APDU through. An answer never carries a key,
 * a PIN, a CAN or the args the command came with.
 */
public final class ModelNfc {
    private ModelNfc() {}

    public static final int DEFAULT_TIMEOUT = 20, MAX_TIMEOUT = 120;
    public static final String ENUM = "enum";

    /** The card reads this phone runs for a model (enum aside, which needs no card). */
    public static final List<String> READS = Arrays.asList(
        "scan", "read-uid", "read-public", "ndef-read", "m5-read", "emv-public", "emv-read", "eid-public", "eid-read", "mrtd-read");

    /** Ops every activated card answers whatever its technology. */
    private static final List<String> GENERIC = Arrays.asList("scan", "read-uid", "read-public");

    /* ------------------------------------------------------------ the command */

    /** What the model asked, normalized (command.ts normalizeCommand, plus snake_case args). */
    public static final class Command {
        /** The catalogue op id, "" when the command had none (or a malformed one). */
        public final String op;
        /** internal | usb | bluetooth | serial, or null: the phone's own by default. */
        public final String reader;
        /** A catalogue technology the command narrows to, or null. */
        public final String tech;
        /** Seconds to wait for a card (default 20, 1–120). */
        public final int timeout;
        /** The op's arguments, camelCase, without any raw key / PIN argument; never null. */
        public final JSONObject args;

        Command(String op, String reader, String tech, int timeout, JSONObject args) {
            this.op = op; this.reader = reader; this.tech = tech; this.timeout = timeout; this.args = args;
        }
    }

    private static final Pattern OP = Pattern.compile("^[a-z][a-z0-9-]{1,32}$");
    private static final List<String> READER_KINDS = Arrays.asList(NfcCatalog.READER_INTERNAL, NfcCatalog.READER_USB, NfcCatalog.READER_BLUETOOTH, NfcCatalog.READER_SERIAL);
    /** Argument names that would be a card key or PIN (host-nfc.ts SECRET_ARG_RE) — dropped even if the server let one through. */
    private static final Pattern SECRET_ARG = Pattern.compile("^(key|keys|key_?a|key_?b|pin|pins|pwd|pack|password|passphrase|secret|apikey|api_?key)$", Pattern.CASE_INSENSITIVE);

    /** The command of an "nfc" interaction's spec ({ command }); none = a scan, as the web does. */
    public static Command parse(JSONObject spec) {
        JSONObject raw = spec == null ? null : spec.optJSONObject("command");
        if (raw == null) {
            raw = new JSONObject();
            try { raw.put("op", "scan"); } catch (JSONException e) { throw new IllegalStateException(e); }
        }
        Object o = raw.opt("op");
        String op = o instanceof String && OP.matcher((String) o).matches() ? (String) o : "";
        String reader = raw.opt("reader") instanceof String && READER_KINDS.contains(raw.optString("reader")) ? raw.optString("reader") : null;
        String tech = raw.opt("tech") instanceof String && !raw.optString("tech").isEmpty() ? raw.optString("tech") : null;
        int timeout = DEFAULT_TIMEOUT;
        Object t = raw.opt("timeout");
        if (t instanceof Number) {
            double d = ((Number) t).doubleValue();
            if (!Double.isNaN(d) && !Double.isInfinite(d)) timeout = (int) Math.max(1, Math.min(MAX_TIMEOUT, Math.round(d)));
        }
        return new Command(op, reader, tech, timeout, normalizeArgs(raw.optJSONObject("args")));
    }

    /**
     * The args camelCase (max_apps → maxApps, document_number → documentNumber,
     * read_photo → readPhoto; photo is readPhoto), an explicit camelCase key
     * winning over its snake_case twin, and no raw key / PIN argument.
     */
    static JSONObject normalizeArgs(JSONObject in) {
        JSONObject out = new JSONObject();
        if (in == null) return out;
        try {
            for (Iterator<String> it = in.keys(); it.hasNext(); ) {
                String k = it.next();
                if (!SECRET_ARG.matcher(k).matches() && k.indexOf('_') < 0) out.put(k, in.opt(k));
            }
            for (Iterator<String> it = in.keys(); it.hasNext(); ) {
                String k = it.next();
                if (SECRET_ARG.matcher(k).matches() || k.indexOf('_') < 0) continue;
                String c = camel(k);
                if (!out.has(c) && !SECRET_ARG.matcher(c).matches()) out.put(c, in.opt(k));
            }
            if (!out.has("readPhoto") && out.has("photo")) out.put("readPhoto", out.opt("photo"));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    static String camel(String k) {
        StringBuilder sb = new StringBuilder(k.length());
        boolean up = false;
        for (char ch : k.toCharArray()) {
            if (ch == '_') { up = sb.length() > 0; continue; }
            sb.append(up ? Character.toUpperCase(ch) : ch);
            up = false;
        }
        return sb.toString();
    }

    /* ------------------------------------------------------- what may run */

    /**
     * What an op is to this phone: "enum" (no card), "read" (run here), "write" /
     * "emulate" (refused), "other" (a catalogue read not offered to a model here —
     * keys, raw APDUs, sector dumps), "unknown".
     */
    public static String kindOf(String op) {
        if (ENUM.equals(op)) return "enum";
        if (READS.contains(op)) return "read";
        boolean read = false;
        for (NfcCatalog.TechInfo ti : NfcCatalog.CATALOG) for (NfcCatalog.Op o : ti.ops) {
            if (!o.id.equals(op)) continue;
            if (!"read".equals(o.kind)) return o.kind;
            read = true;
        }
        return read ? "other" : "unknown";
    }

    /** e-ID / e-passport, by either name (eid.read() sends mrtd-read). */
    public static boolean isEidRead(String op) { return "eid-read".equals(op) || "mrtd-read".equals(op); }

    /**
     * The answer a command gets before any card (a write refused, an unknown op,
     * a technology that does not offer it) — null when it goes on to a reader.
     */
    public static JSONObject refusal(Command c) {
        String op = c.op;
        if (op.isEmpty()) return result("unsupported", null, "An NFC command needs an op (a catalogue op id, e.g. scan, read-uid, ndef-read, emv-read).");
        switch (kindOf(op)) {
            case "write": return result("denied", null, "\"" + op + "\" is a write — run it in the NFC workbench, not from a model.");
            case "emulate": return result("denied", null, "\"" + op + "\" makes the phone act as a card — run it in the NFC workbench, not from a model.");
            case "other": return result("unsupported", null, "\"" + op + "\" is not available to a model on Android — use the NFC workbench.");
            case "unknown": return result("unsupported", null, "\"" + op + "\" is not an NFC operation this device knows.");
            case "enum": return null;
            default: break;
        }
        // A command narrowed to a technology that does not offer the op (web-executor.ts).
        if (c.tech != null && !NfcCatalog.UNKNOWN.equals(c.tech) && !GENERIC.contains(op)) {
            NfcCatalog.TechInfo ti = NfcCatalog.techInfo(c.tech);
            String asCatalog = "mrtd-read".equals(op) ? "eid-read" : op;
            if (ti.tech.equals(c.tech) && !NfcCatalog.supportsOp(c.tech, asCatalog))
                return result("unsupported", null, ti.label + " does not support \"" + op + "\".");
        }
        return null;
    }

    /* ------------------------------------------------------------ the device */

    /** What the phone has right now (ModelNfcDevice.snapshot builds it). */
    public static final class Device {
        /** The phone has an NFC controller… */
        public boolean internal;
        /** …and it is switched on. */
        public boolean internalOn;
        /** The controller also talks MIFARE Classic (an NXP chip). */
        public boolean mifareClassic;
        /** A Bluetooth adapter (no Bluetooth reader is driven from a model). */
        public boolean bluetooth;
        /** The workbench's reader choice (settings nfc.reader), "" for the default. */
        public String preferred = "";
        /** Attached USB (CCID) readers. */
        public final List<Usb> usb = new ArrayList<>();

        public static final class Usb {
            public final String name;
            /** The user already allowed it (the workbench asked). */
            public final boolean permitted;
            public Usb(String name, boolean permitted) { this.name = name; this.permitted = permitted; }
        }

        Usb permittedUsb() { for (Usb u : usb) if (u.permitted) return u; return null; }
    }

    /** Where a command goes: a reader ("internal" / "usb"), or an answer straight away. */
    public static final class Route {
        public final String reader;
        public final JSONObject result;
        /** The phone has NFC but it is off — the sheet offers the NFC settings. */
        public final boolean nfcOff;
        Route(String reader, JSONObject result, boolean nfcOff) { this.reader = reader; this.result = result; this.nfcOff = nfcOff; }
    }

    /**
     * The reader for a command: the phone's own by default; a USB reader when the
     * command asks for one (or names none and the workbench chose USB) and the
     * user already allowed it there. Bluetooth / serial readers are not driven
     * from a model on Android.
     */
    public static Route route(Command c, Device d) {
        String r = c.reader;
        if (NfcCatalog.READER_BLUETOOTH.equals(r)) return new Route(null, result("unsupported", null, "A Bluetooth reader is not available to a model on Android — use the phone's own NFC or a USB reader."), false);
        if (NfcCatalog.READER_SERIAL.equals(r)) return new Route(null, result("unsupported", null, "A serial reader is not available on Android — use the phone's own NFC or a USB reader."), false);
        Device.Usb usb = d.permittedUsb();
        if (NfcCatalog.READER_USB.equals(r)) {
            if (usb != null) return new Route(NfcCatalog.READER_USB, null, false);
            return new Route(null, result("unsupported", null, d.usb.isEmpty() ? "No USB reader is connected." : "Allow the USB reader in the NFC workbench first."), false);
        }
        if (r == null && usb != null && (NfcCatalog.READER_USB.equals(d.preferred) || !d.internal)) return new Route(NfcCatalog.READER_USB, null, false);
        if (!d.internal) return new Route(null, result("unsupported", null, "This device has no NFC reader."), false);
        if (!d.internalOn) return new Route(null, result("unsupported", null, "NFC is switched off on this phone — turn it on in the settings and try again."), true);
        return new Route(NfcCatalog.READER_INTERNAL, null, false);
    }

    /** The card technologies a reader talks to. */
    static List<String> technologies(String reader, Device d) {
        List<String> out = new ArrayList<>();
        if (NfcCatalog.READER_USB.equals(reader)) {
            out.addAll(Arrays.asList(NfcCatalog.ISO_DEP, NfcCatalog.MIFARE_DESFIRE, NfcCatalog.EMV, NfcCatalog.EID));
            return out;
        }
        for (NfcCatalog.TechInfo ti : NfcCatalog.CATALOG) {
            if (NfcCatalog.UNKNOWN.equals(ti.tech)) continue;
            if (ti.tech.startsWith("mifare-classic") && !d.mifareClassic) continue;
            out.add(ti.tech);
        }
        return out;
    }

    /**
     * enum: what the phone offers now — its readers and the card technologies
     * they talk to, with the ops a model may run. No card is needed. The
     * NfcResult has no field of its own for it, so the list travels as
     * {@code data} (base64 JSON { readers, default, technologies, ops }) and
     * {@code message} says it in words.
     */
    public static JSONObject enumResult(Command c, Device d) {
        try {
            String only = c.reader;
            JSONArray readers = new JSONArray();
            Set<String> techs = new LinkedHashSet<>();
            List<String> words = new ArrayList<>();
            if (only == null || NfcCatalog.READER_INTERNAL.equals(only)) {
                readers.put(new JSONObject().put("kind", NfcCatalog.READER_INTERNAL).put("name", "This device")
                    .put("available", d.internal).put("enabled", d.internal && d.internalOn));
                if (d.internal) { techs.addAll(technologies(NfcCatalog.READER_INTERNAL, d)); words.add("This device (NFC " + (d.internalOn ? "on" : "off") + ")"); }
            }
            if (only == null || NfcCatalog.READER_USB.equals(only)) {
                for (Device.Usb u : d.usb) {
                    readers.put(new JSONObject().put("kind", NfcCatalog.READER_USB).put("name", u.name).put("available", true).put("enabled", u.permitted).put("permitted", u.permitted));
                    if (u.permitted) techs.addAll(technologies(NfcCatalog.READER_USB, d));
                    words.add(u.name + " (USB" + (u.permitted ? "" : ", not allowed yet") + ")");
                }
            }
            if (only == null || NfcCatalog.READER_BLUETOOTH.equals(only)) {
                if (d.bluetooth) readers.put(new JSONObject().put("kind", NfcCatalog.READER_BLUETOOTH).put("name", "Bluetooth reader").put("available", false).put("enabled", false)
                    .put("note", "not driven from a model on Android"));
            }
            Route def = route(new Command("scan", null, null, DEFAULT_TIMEOUT, new JSONObject()), d);
            JSONObject data = new JSONObject().put("readers", readers).put("default", def.reader == null ? JSONObject.NULL : def.reader)
                .put("technologies", new JSONArray(techs)).put("ops", new JSONArray(READS));
            String msg = words.isEmpty() ? "No NFC reader on this device." : "Readers: " + String.join(", ", words) + ". Card technologies: " + String.join(", ", techs) + ".";
            JSONObject out = result("ok", null, msg.length() > 480 ? msg.substring(0, 479) + "…" : msg);
            out.put("data", Base64.getEncoder().encodeToString(data.toString().getBytes(StandardCharsets.UTF_8)));
            return out;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* ------------------------------------------- the holder's document key */

    /**
     * An e-ID read whose args carry no document key — none of mrz, can, or all
     * three of documentNumber + dateOfBirth + dateOfExpiry — so the phone asks the
     * holder for it before the card (client/src/lib/nfc/document-key.ts
     * needsDocumentKey). What they type stays on the phone.
     */
    public static boolean needsDocumentKey(Command c) { return isEidRead(c.op) && !hasDocumentKey(c.args); }

    static boolean hasDocumentKey(JSONObject a) {
        return filled(a, "mrz") || filled(a, "can") || (filled(a, "documentNumber") && filled(a, "dateOfBirth") && filled(a, "dateOfExpiry"));
    }

    private static boolean filled(JSONObject a, String k) { return a != null && a.opt(k) instanceof String && !a.optString(k).trim().isEmpty(); }

    /** What the holder typed in the sheet: the CAN, or the MRZ, or the three fields. */
    public static final class DocumentKey {
        public String can = "", mrz = "", documentNumber = "", dateOfBirth = "", dateOfExpiry = "";

        String canDigits() { return can == null ? "" : can.replaceAll("\\s", ""); }
        String mrzText() { return mrz == null ? "" : mrz.trim().toUpperCase(Locale.ROOT); }
        String doc() { return documentNumber == null ? "" : documentNumber.replaceAll("\\s", "").toUpperCase(Locale.ROOT); }
        static String date(String s) { return s == null ? "" : s.replaceAll("\\s", ""); }
    }

    /**
     * What is wrong with what the holder typed — a design string key — or null
     * when it can open a document: a CAN of 6 digits, or an MRZ the BAC key can be
     * taken from, or the document number with both dates as YYMMDD.
     */
    public static String checkDocumentKey(DocumentKey k) {
        String can = k.canDigits(), mrz = k.mrzText(), doc = k.doc(), dob = DocumentKey.date(k.dateOfBirth), exp = DocumentKey.date(k.dateOfExpiry);
        boolean fields = !doc.isEmpty() || !dob.isEmpty() || !exp.isEmpty();
        if (can.isEmpty() && mrz.isEmpty() && !fields) return "nfc.eid.needKey";
        if (!can.isEmpty() && !can.matches("\\d{6}")) return "nfc.model.key.badCan";
        if (!mrz.isEmpty()) {
            Bac.MrzKey key;
            try { key = Bac.mrzKeyFromMrz(mrz); } catch (RuntimeException e) { key = null; }
            if (key == null || !mrz.matches("[A-Z0-9<\\s]+")) return "nfc.model.key.badMrz";
        }
        if (fields && mrz.isEmpty()) {
            if (doc.isEmpty() || dob.isEmpty() || exp.isEmpty() || !doc.matches("[A-Z0-9<]{1,20}")) return "nfc.eid.needKey";
            if (!dob.matches("\\d{6}") || !exp.matches("\\d{6}")) return "nfc.model.key.badDate";
        }
        return null;
    }

    /**
     * The command with the holder's key in its args, for this read only
     * (document-key.ts withDocumentKey). The command never leaves the phone;
     * the answer is built without its args.
     */
    public static Command withDocumentKey(Command c, DocumentKey k) {
        JSONObject a = new JSONObject();
        try {
            for (Iterator<String> it = c.args.keys(); it.hasNext(); ) { String key = it.next(); a.put(key, c.args.opt(key)); }
            String can = k.canDigits(), mrz = k.mrzText(), doc = k.doc(), dob = DocumentKey.date(k.dateOfBirth), exp = DocumentKey.date(k.dateOfExpiry);
            if (!can.isEmpty()) a.put("can", can);
            if (!mrz.isEmpty()) a.put("mrz", mrz);
            else if (!doc.isEmpty() && !dob.isEmpty() && !exp.isEmpty()) a.put("documentNumber", doc).put("dateOfBirth", dob).put("dateOfExpiry", exp);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return new Command(c.op, c.reader, c.tech, c.timeout, a);
    }

    /* --------------------------------------------------------------- a card */

    /** One NDEF record as read (TNF, type, id, payload). */
    public static final class NdefRec {
        public final int tnf;
        public final byte[] type, id, payload;
        public NdefRec(int tnf, byte[] type, byte[] id, byte[] payload) {
            this.tnf = tnf;
            this.type = type == null ? new byte[0] : type;
            this.id = id == null ? new byte[0] : id;
            this.payload = payload == null ? new byte[0] : payload;
        }
    }

    /** A card in the field, behind whichever reader found it. */
    public interface Card {
        /** The card as the reader sees it: uid, tech (a catalogue name), label, atqa / sak / ats / atr, memory (other keys are left out of the answer). */
        JSONObject identity();
        /** An ISO-DEP (ISO 14443-4) channel to the card, opened on first use; null when the card has none. */
        Apdu.Transceiver isoDep() throws IOException;
        /** The card's NDEF records (empty when it holds none); null when it is not an NDEF tag or the reader cannot tell. */
        List<NdefRec> ndef() throws IOException;
    }

    /** The card left the field before the op finished (the reader maps its own "tag lost" to this). */
    public static final class CardGone extends IOException {
        public CardGone(String message) { super(message); }
    }

    /** Runs a read on the card in the field. Never throws: a failure is an answer. */
    public static JSONObject run(Command c, Card card) {
        JSONObject cardOut = cardField(card.identity());
        String op = c.op;
        try {
            switch (op) {
                case "read-uid":
                    return result("ok", cardOut, null);
                case "scan":
                case "read-public": {
                    JSONObject out = result("ok", cardOut, null);
                    List<NdefRec> recs;
                    try { recs = card.ndef(); } catch (CardGone e) { throw e; } catch (IOException e) { recs = null; }
                    if (recs != null) {
                        refineTech(cardOut, recs);
                        if (!recs.isEmpty()) out.put("ndef", ndefField(recs));
                        JSONArray m5 = m5Records(recs);
                        if (m5 != null) out.put("records", m5);
                    }
                    return out;
                }
                case "ndef-read": {
                    List<NdefRec> recs = card.ndef();
                    if (recs == null) return result("unsupported", cardOut, "Not an NDEF tag.");
                    refineTech(cardOut, recs);
                    return result("ok", cardOut, null).put("ndef", ndefField(recs));
                }
                case "m5-read": {
                    List<NdefRec> recs = card.ndef();
                    if (recs != null) refineTech(cardOut, recs);
                    JSONArray m5 = recs == null ? null : m5Records(recs);
                    if (m5 == null) return result("ok", cardOut, "Not an M5Cet card.");
                    return result("ok", cardOut, null).put("records", m5);
                }
                case "emv-public": {
                    Apdu.Transceiver t = card.isoDep();
                    if (t == null) return notIsoDep(cardOut);
                    return emvPublic(t, cardOut);
                }
                case "eid-public": {
                    Apdu.Transceiver t = card.isoDep();
                    if (t == null) return notIsoDep(cardOut);
                    Apdu.Response r = Apdu.splitResponse(t.transmit(Apdu.apdu(0x00, 0xa4, 0x04, 0x0c, MRTD_AID, -1)));
                    boolean present = Apdu.isOk(r.sw);
                    if (present) retech(cardOut, NfcCatalog.EID);
                    return result("ok", cardOut, "MRTD " + (present ? "present" : "absent") + " (" + String.format(Locale.ROOT, "%04X", r.sw) + "). Public presence only — no BAC/PACE, no data.");
                }
                case "emv-read":
                case "eid-read":
                case "mrtd-read": {
                    Apdu.Transceiver t = card.isoDep();
                    if (t == null) return notIsoDep(cardOut);
                    JSONObject r = CardOps.readResult(op, t, c.args);
                    if (r == null) return result("unsupported", cardOut, "\"" + op + "\" is not available here.");
                    JSONObject emv = r.optJSONObject("emv"), mrtd = r.optJSONObject("mrtd");
                    if (emv != null && arr(emv, "aids") + arr(emv, "apps") > 0) retech(cardOut, NfcCatalog.EMV);
                    if (mrtd != null && (mrtd.has("mrzInfo") || !"none".equals(mrtd.optString("access", "none")))) retech(cardOut, NfcCatalog.EID);
                    r.put("card", cardOut);
                    return scrub(r, c);
                }
                default:
                    return result("unsupported", cardOut, "\"" + op + "\" is not available to a model on Android.");
            }
        } catch (CardGone e) {
            return result("no-card", cardOut, "The card left the field before the read finished — hold it still until it is done.");
        } catch (IOException | JSONException | RuntimeException e) {
            String m = e.getMessage() == null || e.getMessage().isEmpty() ? e.getClass().getSimpleName() : e.getMessage();
            return scrub(result("error", cardOut, m), c);
        }
    }

    private static final byte[] MRTD_AID = Apdu.unhex("A0000002471001");

    private static JSONObject notIsoDep(JSONObject cardOut) {
        return result("unsupported", cardOut, cardOut.optString("label", "This card") + " is not an ISO-DEP card — EMV cards and e-IDs talk ISO 14443-4.");
    }

    /** emv-public: SELECT the PPSE and list the applications it offers (no record read). */
    private static JSONObject emvPublic(Apdu.Transceiver t, JSONObject cardOut) throws IOException, JSONException {
        byte[] ppse = "2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII);
        Apdu.Response r = Apdu.transmitSmart(t, Apdu.selectByAid(ppse));
        if (!Apdu.isOk(r.sw)) return result("ok", cardOut, "No PPSE (" + String.format(Locale.ROOT, "%04X", r.sw) + ")");
        List<Apdu.Tlv> tree = Apdu.decodeTlv(r.data);
        List<String> aids = new ArrayList<>();
        for (Apdu.Tlv a : Apdu.findAllTlv(tree, 0x4f)) aids.add(Apdu.hex(a.value).toUpperCase(Locale.ROOT));
        Apdu.Tlv label = Apdu.findTlv(tree, 0x50);
        if (!aids.isEmpty()) retech(cardOut, NfcCatalog.EMV);
        String name = label == null ? "" : new String(label.value, StandardCharsets.US_ASCII).trim();
        return result("ok", cardOut, "EMV: " + (name.isEmpty() ? "" : name + " ") + "AIDs " + String.join(", ", aids));
    }

    private static int arr(JSONObject o, String k) { JSONArray a = o.optJSONArray(k); return a == null ? 0 : a.length(); }

    /* -------------------------------------------------------------- results */

    /** { status, card?, message? }. */
    public static JSONObject result(String status, JSONObject card, String message) {
        try {
            JSONObject o = new JSONObject().put("status", status);
            if (card != null) o.put("card", card);
            if (message != null && !message.isEmpty()) o.put("message", message);
            return o;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** The holder closed the sheet (or the run went away): what the web answers for an abort. */
    public static JSONObject cancelled() { return result("timeout", null, "Cancelled"); }

    /** No card came within the command's timeout. */
    public static JSONObject timedOut(int seconds) { return result("timeout", null, "No card was presented within " + seconds + " s."); }

    private static final List<String> CARD_FIELDS = Arrays.asList("uid", "tech", "label", "atqa", "sak", "ats", "atr", "memory");

    /** The NfcResult card: uid, tech, label, atqa / sak / ats / atr, memory — nothing else of what the reader saw. */
    static JSONObject cardField(JSONObject seen) {
        JSONObject out = new JSONObject();
        try {
            String tech = seen != null && seen.opt("tech") instanceof String ? seen.optString("tech") : NfcCatalog.UNKNOWN;
            out.put("uid", seen == null ? "" : seen.optString("uid", "")).put("tech", tech)
                .put("label", seen != null && !seen.optString("label", "").isEmpty() ? seen.optString("label") : NfcCatalog.techInfo(tech).label);
            for (String k : CARD_FIELDS) {
                if (out.has(k) || seen == null) continue;
                if (seen.opt(k) instanceof String && !seen.optString(k).isEmpty()) out.put(k, seen.optString(k));
            }
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return out;
    }

    /** What the read found out the card is (an EMV card, an e-ID…), in the answer's card. */
    private static void retech(JSONObject card, String tech) throws JSONException {
        NfcCatalog.TechInfo ti = NfcCatalog.techInfo(tech);
        card.put("tech", tech).put("label", ti.label);
        if (ti.memory.isEmpty()) card.remove("memory"); else card.put("memory", ti.memory);
    }

    /** An NDEF tag that carries the app's own cards: the connection tag, an M5Cet card. */
    private static void refineTech(JSONObject card, List<NdefRec> recs) throws JSONException {
        for (NdefRec r : recs) {
            String type = new String(r.type, StandardCharsets.US_ASCII);
            if (r.tnf == TNF_EXTERNAL && M5Card.EXTERNAL_TYPE.equalsIgnoreCase(type) && M5Card.isM5Card(r.payload)) { retech(card, NfcCatalog.M5CET_CARD); return; }
            if (r.tnf == TNF_MIME && Nfc.MIME.equals(type)) { retech(card, NfcCatalog.CONNECTION_TAG); return; }
        }
    }

    /**
     * The records of an M5Cet card as a model may see them — id, type, one-time —
     * still sealed (web: lockedSummaries); null when the tag holds none.
     */
    static JSONArray m5Records(List<NdefRec> recs) throws JSONException {
        if (recs == null) return null;
        for (NdefRec r : recs) {
            if (r.tnf != TNF_EXTERNAL || !M5Card.EXTERNAL_TYPE.equalsIgnoreCase(new String(r.type, StandardCharsets.US_ASCII)) || !M5Card.isM5Card(r.payload)) continue;
            JSONArray out = new JSONArray();
            try {
                for (M5Card.Sealed s : M5Card.decodeContainer(r.payload))
                    out.put(new JSONObject().put("id", s.id).put("type", s.type).put("oneTime", s.oneTime).put("summary", s.type));
            } catch (RuntimeException e) { return out; }
            return out;
        }
        return null;
    }

    /**
     * The answer never repeats what opened the card: the CAN the holder gave is
     * blanked out of any message (a reader's error text included). The document's
     * own data (its MRZ in DG1) is what the read is for and stays.
     */
    static JSONObject scrub(JSONObject r, Command c) {
        String can = c.args.optString("can", "").trim();
        if (can.length() < 4) return r;
        try {
            if (r.optString("message", "").contains(can)) r.put("message", r.optString("message").replace(can, "******"));
            JSONObject m = r.optJSONObject("mrtd");
            if (m != null && m.optString("message", "").contains(can)) m.put("message", m.optString("message").replace(can, "******"));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return r;
    }

    /* ------------------------------------------------------------------ NDEF */

    static final int TNF_EMPTY = 0, TNF_WELL_KNOWN = 1, TNF_MIME = 2, TNF_ABSOLUTE_URI = 3, TNF_EXTERNAL = 4;

    /** The URI identifier codes of the NFC Forum URI record (ndef.ts URI_PREFIXES). */
    static final String[] URI_PREFIXES = {
        "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
        "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://",
        "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
        "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:",
        "urn:epc:raw:", "urn:epc:", "urn:nfc:",
    };

    /** NfcResult.ndef: { kind, type?, text?, lang?, data? } per record, as web-executor.ts ndefField. */
    static JSONArray ndefField(List<NdefRec> recs) throws JSONException {
        JSONArray out = new JSONArray();
        for (NdefRec r : recs) out.put(ndefRecord(r));
        return out;
    }

    static JSONObject ndefRecord(NdefRec r) throws JSONException {
        String t = new String(r.type, StandardCharsets.US_ASCII);
        switch (r.tnf) {
            case TNF_EMPTY: return new JSONObject().put("kind", "empty");
            case TNF_WELL_KNOWN:
                if (t.equals("T")) {
                    byte[] p = r.payload;
                    if (p.length == 0) return new JSONObject().put("kind", "text").put("text", "").put("lang", "");
                    int langLen = Math.min(p[0] & 0x3f, p.length - 1);
                    boolean utf16 = (p[0] & 0x80) != 0;
                    String lang = new String(p, 1, langLen, StandardCharsets.US_ASCII);
                    String text = new String(p, 1 + langLen, p.length - 1 - langLen, utf16 ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8);
                    return new JSONObject().put("kind", "text").put("text", text).put("lang", lang);
                }
                if (t.equals("U")) return new JSONObject().put("kind", "uri").put("data", uri(r.payload));
                if (t.equals("Sp")) {
                    JSONObject sp = new JSONObject().put("kind", "smart-poster");
                    try {
                        for (NdefRec i : parseMessage(r.payload)) {
                            if (i.tnf == TNF_WELL_KNOWN && "U".equals(new String(i.type, StandardCharsets.US_ASCII))) { sp.put("data", uri(i.payload)); break; }
                        }
                    } catch (IllegalArgumentException ignored) { }
                    return sp;
                }
                return new JSONObject().put("kind", "unknown").put("type", String.valueOf(r.tnf));
            case TNF_MIME: return new JSONObject().put("kind", "mime").put("type", t).put("data", Apdu.hex(r.payload));
            case TNF_ABSOLUTE_URI: return new JSONObject().put("kind", "uri").put("data", t);
            case TNF_EXTERNAL: return new JSONObject().put("kind", "external").put("type", t).put("data", Apdu.hex(r.payload));
            default: return new JSONObject().put("kind", "unknown").put("type", String.valueOf(r.tnf));
        }
    }

    private static String uri(byte[] p) {
        if (p.length == 0) return "";
        int code = p[0] & 0xff;
        return (code < URI_PREFIXES.length ? URI_PREFIXES[code] : "") + new String(p, 1, p.length - 1, StandardCharsets.UTF_8);
    }

    /** An NDEF message's records (short and normal records; chunks are not joined). */
    static List<NdefRec> parseMessage(byte[] b) {
        List<NdefRec> out = new ArrayList<>();
        int i = 0;
        while (i < b.length) {
            int h = b[i++] & 0xff;
            if (i >= b.length) throw new IllegalArgumentException("short NDEF record");
            int typeLen = b[i++] & 0xff;
            long payloadLen;
            if ((h & 0x10) != 0) { payloadLen = b[i++] & 0xff; }
            else {
                if (i + 4 > b.length) throw new IllegalArgumentException("short NDEF record");
                payloadLen = ((long) (b[i] & 0xff) << 24) | ((b[i + 1] & 0xff) << 16) | ((b[i + 2] & 0xff) << 8) | (b[i + 3] & 0xff);
                i += 4;
            }
            int idLen = (h & 0x08) != 0 ? b[i++] & 0xff : 0;
            if (i + typeLen + idLen + payloadLen > b.length) throw new IllegalArgumentException("short NDEF record");
            byte[] type = Arrays.copyOfRange(b, i, i + typeLen); i += typeLen;
            byte[] id = Arrays.copyOfRange(b, i, i + idLen); i += idLen;
            byte[] payload = Arrays.copyOfRange(b, i, i + (int) payloadLen); i += (int) payloadLen;
            out.add(new NdefRec(h & 0x07, type, id, payload));
            if ((h & 0x40) != 0) break; // ME
        }
        return out;
    }

    /* ---------------------------------------------------------- the sheet */

    /** The design key for what is asked, in plain words. */
    public static String whatKey(String op) {
        switch (op) {
            case "emv-read": return "nfc.model.what.emv";
            case "emv-public": return "nfc.model.what.emvPublic";
            case "eid-read": case "mrtd-read": return "nfc.model.what.eid";
            case "eid-public": return "nfc.model.what.eidPublic";
            case "read-uid": return "nfc.model.what.uid";
            case "ndef-read": return "nfc.model.what.ndef";
            case "m5-read": return "nfc.model.what.m5";
            default: return "nfc.model.what.scan";
        }
    }
}
