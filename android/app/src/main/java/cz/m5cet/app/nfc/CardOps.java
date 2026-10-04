package cz.m5cet.app.nfc;

import android.nfc.FormatException;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.nfc.tech.MifareClassic;
import android.nfc.tech.MifareUltralight;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcF;
import android.nfc.tech.NfcV;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.core.Log;

/**
 * The per-technology functions on a presented android.nfc {@link Tag} (6.3) —
 * the same op ids as {@link NfcCatalog} / the web workbench, implemented with
 * android.nfc.tech. STANDARD operations only: reading a card's public identity
 * and NDEF, and reading/writing with keys the USER supplies (a key dictionary,
 * like MIFARE Classic Tool). No unknown-key recovery.
 *
 * Where an op is not reachable through android.nfc it says so ("unsupported")
 * rather than faking it; the UID and public data always read.
 */
public final class CardOps {
    private CardOps() {}

    /* --------------------------------------------------------------- NDEF */

    public static JSONObject ndefRead(Tag tag) throws IOException, FormatException, JSONException {
        Ndef ndef = Ndef.get(tag);
        JSONObject out = new JSONObject();
        if (ndef == null) { out.put("ndef", false); return out; }
        ndef.connect();
        try {
            out.put("ndef", true).put("type", ndef.getType()).put("capacity", ndef.getMaxSize()).put("writable", ndef.isWritable());
            NdefMessage msg = ndef.getNdefMessage();
            JSONArray records = new JSONArray();
            if (msg != null) for (NdefRecord r : msg.getRecords()) records.put(Nfc.describe(r));
            out.put("records", records);
        } finally { close(ndef); }
        return out;
    }

    /** Write NDEF records (text/URI/MIME/external). Formats an unformatted tag when it can. */
    public static void ndefWrite(Tag tag, NdefMessage msg) throws IOException, FormatException {
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            ndef.connect();
            try {
                if (!ndef.isWritable()) throw new IOException("read-only");
                if (ndef.getMaxSize() < msg.getByteArrayLength()) throw new IOException("too-small");
                ndef.writeNdefMessage(msg);
            } finally { close(ndef); }
            return;
        }
        NdefFormatable f = NdefFormatable.get(tag);
        if (f == null) throw new IOException("not-ndef");
        f.connect();
        try { f.format(msg); } finally { close(f); }
    }

    /* --------------------------------------------- NDEF onto any usable tag */

    /** A write that failed for a reason the user can act on (typed, so the UI localizes it). */
    public static final class NfcWriteException extends IOException {
        public static final int READ_ONLY = 1, TOO_SMALL = 2, NO_KEY = 3, NOT_WRITABLE = 4;
        public final int kind, needed, available, sector;
        NfcWriteException(int kind, int needed, int available, int sector) {
            super(reason(kind, needed, available, sector));
            this.kind = kind; this.needed = needed; this.available = available; this.sector = sector;
        }
        private static String reason(int kind, int needed, int available, int sector) {
            switch (kind) {
                case READ_ONLY: return "read-only";
                case TOO_SMALL: return "too-small (needs " + needed + " B, holds " + available + " B)";
                case NO_KEY: return "no-key-for-sector " + sector;
                default: return "not-writable";
            }
        }
    }

    /**
     * Write an NDEF message onto whatever the tag can take — the write path the
     * M5Cet builder (and the generic NDEF write) uses. Unlike {@link #ndefWrite}
     * this also NDEF-formats a bare MIFARE Classic (MAD + TLV) and writes the TLV
     * straight into an Ultralight/NTAG's user pages. Returns the NDEF byte count.
     * {@code keys} is the user's key dictionary for a MIFARE Classic (see
     * {@link #keyDictionary}); the well-known factory/MAD/NDEF keys are added.
     */
    public static int ndefWriteAny(Tag tag, NdefMessage msg, List<byte[]> keys) throws IOException, FormatException {
        byte[] bytes = msg.toByteArray();
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            ndef.connect();
            try {
                Log.i("nfc", "ndefWriteAny: Ndef " + ndef.getType() + " cap=" + ndef.getMaxSize() + " writable=" + ndef.isWritable() + " need=" + bytes.length);
                if (!ndef.isWritable()) throw new NfcWriteException(NfcWriteException.READ_ONLY, bytes.length, ndef.getMaxSize(), 0);
                if (ndef.getMaxSize() < bytes.length) throw new NfcWriteException(NfcWriteException.TOO_SMALL, bytes.length, ndef.getMaxSize(), 0);
                ndef.writeNdefMessage(msg);
                return bytes.length;
            } finally { close(ndef); }
        }
        NdefFormatable f = NdefFormatable.get(tag);
        if (f != null) {
            f.connect();
            try { Log.i("nfc", "ndefWriteAny: NdefFormatable.format " + bytes.length + " B"); f.format(msg); return bytes.length; }
            finally { close(f); }
        }
        MifareClassic mc = MifareClassic.get(tag);
        if (mc != null) return classicNdefWrite(mc, bytes, keys);
        MifareUltralight ul = MifareUltralight.get(tag);
        if (ul != null) return ultralightNdefWrite(ul, bytes);
        Log.w("nfc", "ndefWriteAny: tag has no writable technology");
        throw new NfcWriteException(NfcWriteException.NOT_WRITABLE, bytes.length, 0, 0);
    }

    /* ---- MIFARE Classic: NDEF-format (MAD) then write the message as a TLV ---- */

    /** MAD key A, NDEF key A and the well-known trailers/AID — a card written as NDEF uses these. */
    static final byte[] MAD_KEY = unhex("A0A1A2A3A4A5");
    static final byte[] NDEF_KEY = unhex("D3F7D3F7D3F7");
    private static final byte[] FACTORY_KEY = unhex("FFFFFFFFFFFF");
    private static final byte[] MAD_TRAILER_V1 = unhex("A0A1A2A3A4A5787788C1FFFFFFFFFFFF");
    private static final byte[] MAD_TRAILER_V2 = unhex("A0A1A2A3A4A5787788C2FFFFFFFFFFFF");
    private static final byte[] NDEF_TRAILER = unhex("D3F7D3F7D3F77F078840FFFFFFFFFFFF");
    private static final byte[] NDEF_AID = {0x03, (byte) 0xE1};   // the NFC Forum NDEF application in the MAD

    private static int classicNdefWrite(MifareClassic mc, byte[] ndef, List<byte[]> userKeys) throws IOException {
        byte[] tlv = ndefTlv(ndef);
        List<byte[]> keys = new ArrayList<>(userKeys);
        addKey(keys, FACTORY_KEY); addKey(keys, MAD_KEY); addKey(keys, NDEF_KEY);
        mc.connect();
        try {
            int sectorCount = mc.getSectorCount();
            int capacity = classicDataCapacity(sectorCount);
            Log.i("nfc", "classicNdefWrite: sectors=" + sectorCount + " capacity=" + capacity + " tlv=" + tlv.length);
            if (tlv.length > capacity) throw new NfcWriteException(NfcWriteException.TOO_SMALL, tlv.length, capacity, 0);
            boolean[] used = new boolean[sectorCount];
            int off = 0;
            for (int s : ndefDataSectors(sectorCount)) {
                if (off >= tlv.length) break;
                byte[] key = authenticate(mc, s, keys);
                if (key == null) throw new NfcWriteException(NfcWriteException.NO_KEY, tlv.length, capacity, s);
                int first = mc.sectorToBlock(s), n = mc.getBlockCountInSector(s);
                for (int b = 0; b < n - 1 && off < tlv.length; b++) {       // data blocks; skip the trailer
                    byte[] block = new byte[16];
                    int len = Math.min(16, tlv.length - off);
                    System.arraycopy(tlv, off, block, 0, len);
                    mc.writeBlock(first + b, block);
                    off += len;
                }
                mc.writeBlock(first + n - 1, NDEF_TRAILER);                 // NDEF key A, public read / key-B write
                used[s] = true;
                Log.i("nfc", "classicNdefWrite: sector " + s + " written (key " + TagTech.hex(key) + ")");
            }
            writeMad(mc, keys, used, sectorCount);
            Log.i("nfc", "classicNdefWrite: done, " + ndef.length + " B NDEF");
            return ndef.length;
        } finally { close(mc); }
    }

    /** Write the MAD in sector 0 (and sector 16 on 4K), marking every used NDEF sector. */
    private static void writeMad(MifareClassic mc, List<byte[]> keys, boolean[] used, int sectorCount) throws IOException {
        int version = sectorCount > 16 ? 2 : 1;
        if (authenticate(mc, 0, keys) == null) throw new NfcWriteException(NfcWriteException.NO_KEY, 0, 0, 0);
        byte[] mad1 = buildMad1(used);
        mc.writeBlock(1, java.util.Arrays.copyOfRange(mad1, 0, 16));
        mc.writeBlock(2, java.util.Arrays.copyOfRange(mad1, 16, 32));
        mc.writeBlock(3, version == 2 ? MAD_TRAILER_V2 : MAD_TRAILER_V1);
        if (sectorCount > 16) {
            if (authenticate(mc, 16, keys) == null) throw new NfcWriteException(NfcWriteException.NO_KEY, 0, 0, 16);
            byte[] mad2 = buildMad2(used, sectorCount);
            int first = mc.sectorToBlock(16);
            mc.writeBlock(first, java.util.Arrays.copyOfRange(mad2, 0, 16));
            mc.writeBlock(first + 1, java.util.Arrays.copyOfRange(mad2, 16, 32));
            mc.writeBlock(first + 2, java.util.Arrays.copyOfRange(mad2, 32, 48));
            mc.writeBlock(first + 3, MAD_TRAILER_V2);
        }
        Log.i("nfc", "classicNdefWrite: MAD" + version + " written");
    }

    /* ---- MIFARE Ultralight / NTAG: the TLV straight into the user pages ---- */

    private static int ultralightNdefWrite(MifareUltralight ul, byte[] ndef) throws IOException {
        byte[] tlv = ndefTlv(ndef);
        ul.connect();
        try {
            int capacity = ultralightCapacity(ul);
            Log.i("nfc", "ultralightNdefWrite: capacity=" + capacity + " tlv=" + tlv.length);
            if (capacity > 0 && tlv.length > capacity) throw new NfcWriteException(NfcWriteException.TOO_SMALL, tlv.length, capacity, 0);
            maybeWriteCc(ul, capacity);
            byte[] buf = java.util.Arrays.copyOf(tlv, (tlv.length + 3) & ~3);   // whole pages
            for (int p = 0; p * 4 < buf.length; p++) {
                ul.writePage(4 + p, java.util.Arrays.copyOfRange(buf, p * 4, p * 4 + 4));   // page 4 = first user page
            }
            Log.i("nfc", "ultralightNdefWrite: done, " + ndef.length + " B NDEF");
            return ndef.length;
        } finally { close(ul); }
    }

    /** The user memory of an Ultralight/NTAG in bytes (from its CC, then its type), or 0 when unknown. */
    private static int ultralightCapacity(MifareUltralight ul) {
        try {
            byte[] cc = ul.readPages(3);                                // page 3 is the Capability Container
            if (cc != null && cc.length >= 4 && (cc[0] & 0xff) == 0xE1) return (cc[2] & 0xff) * 8;
        } catch (IOException ignored) { }
        switch (ul.getType()) {
            case MifareUltralight.TYPE_ULTRALIGHT: return 48;           // pages 4..15
            case MifareUltralight.TYPE_ULTRALIGHT_C: return 144;        // pages 4..39
            default: return 0;                                         // unknown — write best-effort, per-page errors surface
        }
    }

    /** A blank tag has no CC to make it discoverable — write one (guarded: never over an existing CC). */
    private static void maybeWriteCc(MifareUltralight ul, int capacity) {
        try {
            byte[] cc = ul.readPages(3);
            if (cc != null && cc.length >= 4 && (cc[0] & 0xff) == 0xE1) return;
            int size = capacity > 0 ? capacity : 48;
            ul.writePage(3, new byte[]{(byte) 0xE1, 0x10, (byte) (size / 8), 0x00});
            Log.i("nfc", "ultralightNdefWrite: wrote CC for " + size + " B");
        } catch (IOException e) {
            Log.w("nfc", "ultralightNdefWrite: CC not written: " + e.getMessage());
        }
    }

    /* ---- pure byte-layout helpers (no hardware) — see NfcWriteTest ---- */

    /** The NDEF Message TLV: 0x03, length (1 byte, or 0xFF + u16 for ≥255), the message, 0xFE terminator. */
    static byte[] ndefTlv(byte[] ndef) {
        java.io.ByteArrayOutputStream w = new java.io.ByteArrayOutputStream();
        w.write(0x03);
        if (ndef.length < 0xFF) {
            w.write(ndef.length);
        } else {
            w.write(0xFF);
            w.write((ndef.length >>> 8) & 0xff);
            w.write(ndef.length & 0xff);
        }
        w.write(ndef, 0, ndef.length);
        w.write(0xFE);
        return w.toByteArray();
    }

    /** Blocks in a sector: 4 for the first 32 sectors, 16 for the large 4K sectors. */
    static int blocksInSector(int sector) { return sector < 32 ? 4 : 16; }

    /** The NDEF data sectors (every sector but the MAD sectors 0 and — on 4K — 16). */
    static int[] ndefDataSectors(int sectorCount) {
        List<Integer> out = new ArrayList<>();
        for (int s = 0; s < sectorCount; s++) {
            if (s == 0 || (s == 16 && sectorCount > 16)) continue;
            out.add(s);
        }
        int[] arr = new int[out.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = out.get(i);
        return arr;
    }

    /** The usable NDEF-TLV bytes on a MIFARE Classic with {@code sectorCount} sectors (1K→720, 4K→3360). */
    static int classicDataCapacity(int sectorCount) {
        int cap = 0;
        for (int s : ndefDataSectors(sectorCount)) cap += (blocksInSector(s) - 1) * 16;
        return cap;
    }

    /** MAD1 (32 bytes: block 1 ‖ block 2) marking sectors 1..15 that carry NDEF with the 0x03E1 AID. */
    static byte[] buildMad1(boolean[] used) {
        byte[] mad = new byte[32];
        mad[1] = 0x01;                                                  // info byte (card-publisher sector)
        for (int s = 1; s <= 15; s++) {
            boolean on = s < used.length && used[s];
            mad[2 * s] = on ? NDEF_AID[0] : 0x00;
            mad[2 * s + 1] = on ? NDEF_AID[1] : 0x00;
        }
        mad[0] = madCrc(java.util.Arrays.copyOfRange(mad, 1, 32));
        return mad;
    }

    /** MAD2 (48 bytes) marking sectors 17..39 that carry NDEF (4K). */
    static byte[] buildMad2(boolean[] used, int sectorCount) {
        byte[] mad = new byte[48];
        mad[1] = 0x00;                                                  // MAD2 info byte
        for (int s = 17; s <= 39; s++) {
            int i = s - 17;
            boolean on = s < sectorCount && s < used.length && used[s];
            mad[2 + 2 * i] = on ? NDEF_AID[0] : 0x00;
            mad[2 + 2 * i + 1] = on ? NDEF_AID[1] : 0x00;
        }
        mad[0] = madCrc(java.util.Arrays.copyOfRange(mad, 1, 48));
        return mad;
    }

    /** The MAD CRC-8 (poly 0x1D, preset 0xC7) over the MAD bytes after the CRC byte. */
    static byte madCrc(byte[] data) {
        int crc = 0xC7;
        for (byte v : data) {
            crc ^= (v & 0xff);
            for (int i = 0; i < 8; i++) crc = (crc & 0x80) != 0 ? ((crc << 1) ^ 0x1D) & 0xff : (crc << 1) & 0xff;
        }
        return (byte) crc;
    }

    private static void addKey(List<byte[]> keys, byte[] k) { if (!contains(keys, k)) keys.add(k); }

    /** Lock the tag's NDEF permanently (read-only). */
    public static void ndefLock(Tag tag) throws IOException {
        Ndef ndef = Ndef.get(tag);
        if (ndef == null) throw new IOException("not-ndef");
        ndef.connect();
        try {
            if (!ndef.canMakeReadOnly()) throw new IOException("cannot-lock");
            if (!ndef.makeReadOnly()) throw new IOException("lock-failed");
        } finally { close(ndef); }
    }

    /* ------------------------------------------------------- MIFARE Classic */

    /** A key dictionary the USER supplies — 6-byte keys, seeded with the factory default FFFFFFFFFFFF. */
    public static List<byte[]> keyDictionary(String text) {
        List<byte[]> keys = new ArrayList<>();
        keys.add(new byte[]{(byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF});
        if (text != null) for (String line : text.split("[\\s,;]+")) {
            String h = line.trim().replace(":", "");
            if (h.matches("(?i)[0-9a-f]{12}")) {
                byte[] k = new byte[6];
                for (int i = 0; i < 6; i++) k[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
                if (!contains(keys, k)) keys.add(k);
            }
        }
        return keys;
    }

    /** Read every sector reachable with the known keys (key A then B). No recovery of unknown keys. */
    public static JSONObject classicRead(Tag tag, List<byte[]> keys) throws IOException, JSONException {
        MifareClassic mc = MifareClassic.get(tag);
        if (mc == null) throw new IOException("not-classic");
        mc.connect();
        try {
            JSONObject out = new JSONObject();
            out.put("sectors", mc.getSectorCount()).put("size", mc.getSize());
            JSONArray sectors = new JSONArray();
            for (int s = 0; s < mc.getSectorCount(); s++) {
                JSONObject so = new JSONObject().put("sector", s);
                byte[] used = authenticate(mc, s, keys);
                if (used == null) { so.put("locked", true); sectors.put(so); continue; }
                so.put("key", TagTech.hex(used));
                JSONArray blocks = new JSONArray();
                int first = mc.sectorToBlock(s), n = mc.getBlockCountInSector(s);
                for (int b = 0; b < n; b++) {
                    try { blocks.put(TagTech.hex(mc.readBlock(first + b))); }
                    catch (IOException e) { blocks.put(JSONObject.NULL); }
                }
                so.put("blocks", blocks);
                sectors.put(so);
            }
            out.put("data", sectors);
            return out;
        } finally { close(mc); }
    }

    /** Write one 16-byte block, authenticating its sector with a supplied key. */
    public static void classicWrite(Tag tag, int block, byte[] data16, List<byte[]> keys) throws IOException {
        MifareClassic mc = MifareClassic.get(tag);
        if (mc == null) throw new IOException("not-classic");
        if (data16.length != 16) throw new IOException("block-is-16-bytes");
        mc.connect();
        try {
            int sector = mc.blockToSector(block);
            if (authenticate(mc, sector, keys) == null) throw new IOException("no-key-for-sector");
            mc.writeBlock(block, data16);
        } finally { close(mc); }
    }

    /** A full dump of the readable blocks (a .json the user can keep / restore). */
    public static JSONObject classicDump(Tag tag, List<byte[]> keys) throws IOException, JSONException {
        JSONObject read = classicRead(tag, keys);
        read.put("kind", "mifare-classic-dump");
        return read;
    }

    /** Restore a dump's data blocks to a card with matching keys (block 0 and trailers are skipped). */
    public static int classicRestore(Tag tag, JSONObject dump, List<byte[]> keys) throws IOException, JSONException {
        MifareClassic mc = MifareClassic.get(tag);
        if (mc == null) throw new IOException("not-classic");
        mc.connect();
        int written = 0;
        try {
            JSONArray sectors = dump.optJSONArray("data");
            if (sectors == null) throw new IOException("bad-dump");
            for (int i = 0; i < sectors.length(); i++) {
                JSONObject so = sectors.optJSONObject(i);
                if (so == null) continue;
                int s = so.optInt("sector", i);
                JSONArray blocks = so.optJSONArray("blocks");
                if (blocks == null || authenticate(mc, s, keys) == null) continue;
                int first = mc.sectorToBlock(s), n = mc.getBlockCountInSector(s);
                for (int b = 0; b < n && b < blocks.length(); b++) {
                    int abs = first + b;
                    if (abs == 0) continue;                       // manufacturer block
                    if (b == n - 1) continue;                     // sector trailer (keys/access) — not restored
                    String hexv = blocks.optString(b, "");
                    if (hexv.length() != 32) continue;
                    mc.writeBlock(abs, unhex(hexv));
                    written++;
                }
            }
            return written;
        } finally { close(mc); }
    }

    private static byte[] authenticate(MifareClassic mc, int sector, List<byte[]> keys) throws IOException {
        for (byte[] k : keys) if (mc.authenticateSectorWithKeyA(sector, k)) return k;
        for (byte[] k : keys) if (mc.authenticateSectorWithKeyB(sector, k)) return k;
        return null;
    }

    /* ------------------------------------------------ Ultralight / NTAG */

    public static JSONObject ultralightRead(Tag tag) throws IOException, JSONException {
        MifareUltralight ul = MifareUltralight.get(tag);
        if (ul == null) throw new IOException("not-ultralight");
        ul.connect();
        try {
            JSONObject out = new JSONObject();
            JSONArray pages = new JSONArray();
            // Read in blocks of 4 pages; stop when a read fails (past the end / protected).
            for (int p = 0; p < 231; p += 4) {
                byte[] four;
                try { four = ul.readPages(p); } catch (IOException e) { break; }
                for (int i = 0; i < 4; i++) {
                    byte[] page = new byte[4];
                    System.arraycopy(four, i * 4, page, 0, 4);
                    pages.put(TagTech.hex(page));
                }
            }
            out.put("pages", pages).put("pageCount", pages.length());
            return out;
        } finally { close(ul); }
    }

    public static void ultralightWrite(Tag tag, int page, byte[] data4) throws IOException {
        MifareUltralight ul = MifareUltralight.get(tag);
        if (ul == null) throw new IOException("not-ultralight");
        if (data4.length != 4) throw new IOException("page-is-4-bytes");
        ul.connect();
        try { ul.writePage(page, data4); } finally { close(ul); }
    }

    /* --------------------------------------------------------- ISO-DEP */

    /** A raw APDU console over ISO-DEP. */
    public static byte[] isoTransceive(Tag tag, byte[] apdu) throws IOException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try { iso.setTimeout(3000); return iso.transceive(apdu); } finally { close(iso); }
    }

    /** DESFire: enumerate the applications (GetApplicationIDs, ISO-wrapped). Public info only. */
    public static JSONObject desfireApps(Tag tag) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try {
            JSONObject out = new JSONObject();
            byte[] version = wrapped(iso, (byte) 0x60);        // GetVersion
            if (version != null) out.put("version", TagTech.hex(version));
            byte[] aids = wrapped(iso, (byte) 0x6A);           // GetApplicationIDs
            JSONArray apps = new JSONArray();
            if (aids != null) for (int i = 0; i + 3 <= aids.length; i += 3) {
                apps.put(String.format("%02X%02X%02X", aids[i + 2] & 0xff, aids[i + 1] & 0xff, aids[i] & 0xff));
            }
            out.put("applications", apps);
            return out;
        } finally { close(iso); }
    }

    /** Send a DESFire native command wrapped in ISO 7816 (0x90 cmd 00 00 00), chaining on 0x91AF. */
    private static byte[] wrapped(IsoDep iso, byte cmd) throws IOException {
        byte[] resp = iso.transceive(new byte[]{(byte) 0x90, cmd, 0x00, 0x00, 0x00});
        java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
        while (resp != null && resp.length >= 2) {
            int sw1 = resp[resp.length - 2] & 0xff, sw2 = resp[resp.length - 1] & 0xff;
            body.write(resp, 0, resp.length - 2);
            if (sw1 == 0x91 && sw2 == 0xAF) resp = iso.transceive(new byte[]{(byte) 0x90, (byte) 0xAF, 0x00, 0x00, 0x00});
            else if (sw1 == 0x91 && sw2 == 0x00) return body.toByteArray();
            else return body.size() > 0 ? body.toByteArray() : null;
        }
        return null;
    }

    /* -------------------------------------------------------------- EMV */

    /** EMV PUBLIC read: PPSE → the card's application labels and AIDs. Read-only, no transaction. */
    public static JSONObject emvPublic(Tag tag) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try {
            JSONObject out = new JSONObject();
            byte[] ppse = "2PAY.SYS.DDF01".getBytes(StandardCharsets.US_ASCII);
            byte[] sel = concat(new byte[]{0x00, (byte) 0xA4, 0x04, 0x00, (byte) ppse.length}, ppse, new byte[]{0x00});
            byte[] r = iso.transceive(sel);
            out.put("ppse", ok(r) ? TagTech.hex(strip(r)) : "no-ppse");
            JSONArray apps = new JSONArray();
            if (ok(r)) {
                List<byte[]> aids = tlvAll(strip(r), 0x4F);
                List<byte[]> labels = tlvAll(strip(r), 0x50);
                for (int i = 0; i < aids.size(); i++) {
                    JSONObject app = new JSONObject().put("aid", TagTech.hex(aids.get(i)));
                    if (i < labels.size()) app.put("label", new String(labels.get(i), StandardCharsets.US_ASCII));
                    apps.put(app);
                }
            }
            out.put("applications", apps);
            out.put("note", "Public data only: application labels/AIDs. No PIN, no signing, no transaction.");
            return out;
        } finally { close(iso); }
    }

    /**
     * EMV full read (6.5, deep 6.6): PPSE → SELECT AID → GET DATA → the transaction
     * log → GPO → READ RECORD (the AFL's and, deep, every other short file), then
     * the records parsed into the holder data a terminal reads (the web EmvReader,
     * ported). Read-only — no PIN, no cryptogram, no transaction. Returns the
     * {@code emv} JSONObject of the NfcResult contract.
     */
    public static JSONObject emvRead(Tag tag, EmvReader.Options opts) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try { iso.setTimeout(5000); return EmvReader.readEmv(iso::transceive, opts); }
        finally { close(iso); }
    }

    /** EMV full read with {@code maxApps} applications at most and the default deep read. */
    public static JSONObject emvRead(Tag tag, int maxApps) throws IOException, JSONException {
        return emvRead(tag, new EmvReader.Options(maxApps));
    }

    /* -------------------------------------------------------------- e-ID */

    /**
     * e-ID / MRTD full read (6.5, deep 6.6): opens the chip with the holder's own
     * MRZ (or its three fields) or CAN — PACE where the chip offers a variant this
     * reader runs, else BAC: the document's own access control — and reads over
     * secure messaging EF.COM, EF.SOD and every data group a border reader may
     * (the web MrtdReader, ported), checking each against EF.SOD. Read-only.
     * Returns the {@code mrtd} JSONObject of the contract.
     */
    public static JSONObject eidRead(Tag tag, MrtdReader.Options opts) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        // A deep read is a few hundred APDUs; give each one time (a big face, a slow chip).
        try { iso.setTimeout(5000); return MrtdReader.readMrtd(iso::transceive, opts); }
        finally { close(iso); }
    }

    /**
     * 6.6: the NfcResult of a model / workbench card read — {@code emv-read} or
     * {@code eid-read} / {@code mrtd-read} — with the op's {@code args} passed
     * through (EMV: maxApps, history, deep; MRTD: mrz, documentNumber +
     * dateOfBirth + dateOfExpiry, can, readPhoto, all), as command.ts and
     * web-executor.ts define it: {status, emv | mrtd, message}. Null for another op.
     */
    public static JSONObject readResult(String op, Apdu.Transceiver t, JSONObject args) throws IOException, JSONException {
        switch (op) {
            case "emv-read": {
                JSONObject emv = EmvReader.readEmv(t, EmvReader.Options.fromArgs(args));
                return new JSONObject().put("status", "ok").put("emv", emv).put("message", EmvReader.emvSummary(emv));
            }
            case "eid-read": case "mrtd-read": {
                JSONObject mrtd = MrtdReader.readMrtd(t, MrtdReader.Options.fromArgs(args));
                return new JSONObject().put("status", MrtdReader.statusFor(mrtd)).put("mrtd", mrtd).put("message", MrtdReader.summary(mrtd));
            }
            default: return null;
        }
    }

    /** {@link #readResult} against a tapped tag (ISO-DEP). */
    public static JSONObject readResult(String op, Tag tag, JSONObject args) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try { iso.setTimeout(5000); return readResult(op, iso::transceive, args); }
        finally { close(iso); }
    }

    /** e-ID / MRTD PUBLIC info: whether an eMRTD app answers. Reading data groups needs the CAN/MRZ (BAC/PACE). */
    public static JSONObject eidPublic(Tag tag) throws IOException, JSONException {
        IsoDep iso = IsoDep.get(tag);
        if (iso == null) throw new IOException("not-iso-dep");
        iso.connect();
        try {
            JSONObject out = new JSONObject();
            byte[] aid = unhex("A0000002471001");            // eMRTD LDS1 application
            byte[] sel = concat(new byte[]{0x00, (byte) 0xA4, 0x04, 0x0C, (byte) aid.length}, aid, new byte[0]);
            byte[] r = iso.transceive(sel);
            out.put("document", ok(r) ? "ICAO eMRTD (ePassport / eID)" : "unknown");
            out.put("selected", ok(r));
            out.put("note", "Public info only. The data groups are protected by BAC/PACE — type the CAN or the MRZ to unlock them. No cloning, no signing.");
            return out;
        } finally { close(iso); }
    }

    /* -------------------------------------------------------------- NfcV */

    public static JSONObject nfcvRead(Tag tag) throws IOException, JSONException {
        NfcV v = NfcV.get(tag);
        if (v == null) throw new IOException("not-iso15693");
        v.connect();
        try {
            JSONObject out = new JSONObject();
            byte[] uid = tag.getId();
            JSONArray blocks = new JSONArray();
            for (int b = 0; b < 64; b++) {
                byte[] cmd = {0x02, 0x20, (byte) b}; // flags (high data rate, unaddressed), Read Single Block, block no
                byte[] resp;
                try { resp = v.transceive(cmd); } catch (IOException e) { break; }
                if (resp == null || resp.length < 2 || (resp[0] & 0x01) != 0) break; // error flag
                blocks.put(TagTech.hex(java.util.Arrays.copyOfRange(resp, 1, resp.length)));
            }
            out.put("uid", TagTech.hex(uid)).put("blocks", blocks);
            return out;
        } finally { close(v); }
    }

    public static void nfcvWrite(Tag tag, int block, byte[] data) throws IOException {
        NfcV v = NfcV.get(tag);
        if (v == null) throw new IOException("not-iso15693");
        v.connect();
        try {
            byte[] cmd = concat(new byte[]{0x02, 0x21, (byte) block}, data); // flags (high data rate, unaddressed), Write Single Block, block, data
            byte[] resp = v.transceive(cmd);
            if (resp != null && resp.length >= 1 && (resp[0] & 0x01) != 0) throw new IOException("write-error");
        } finally { close(v); }
    }

    /* -------------------------------------------------------------- FeliCa */

    public static JSONObject felicaSystems(Tag tag) throws IOException, JSONException {
        NfcF f = NfcF.get(tag);
        if (f == null) throw new IOException("not-felica");
        f.connect();
        try {
            JSONObject out = new JSONObject();
            out.put("idm", TagTech.hex(tag.getId()));
            if (f.getSystemCode() != null) out.put("systemCode", TagTech.hex(f.getSystemCode()));
            if (f.getManufacturer() != null) out.put("pmm", TagTech.hex(f.getManufacturer()));
            out.put("note", "Public systems only; a service's blocks (Read Without Encryption) need the service code.");
            return out;
        } finally { close(f); }
    }

    /* ----------------------------------------------------------- change UID */

    /**
     * Change the UID / block 0 of a UID-changeable ("magic") card the user owns.
     * Gen2: a plain block-0 write after authenticating with a supplied key.
     * Gen1a: the backdoor open (0x40/0x43) then write block 0. Device- and
     * chip-dependent; only meaningful on a magic card.
     */
    public static void writeUid(Tag tag, byte[] block0, List<byte[]> keys) throws IOException {
        if (block0.length != 16) throw new IOException("block0-is-16-bytes");
        // Gen1a backdoor via NfcA raw frames.
        NfcA a = NfcA.get(tag);
        if (a != null) {
            try {
                a.connect();
                a.transceive(new byte[]{0x40});          // unlock 1 (7-bit in spec; best effort)
                a.transceive(new byte[]{0x43});          // unlock 2
                a.transceive(concat(new byte[]{(byte) 0xA0, 0x00}, new byte[0])); // WRITE block 0
                a.transceive(block0);
                return;
            } catch (IOException gen1) {
                // fall through to Gen2
            } finally { close(a); }
        }
        MifareClassic mc = MifareClassic.get(tag);
        if (mc == null) throw new IOException("not-a-magic-card");
        mc.connect();
        try {
            if (authenticate(mc, 0, keys) == null) throw new IOException("no-key-for-sector-0");
            mc.writeBlock(0, block0);                     // Gen2: direct block-0 write
        } finally { close(mc); }
    }

    /* -------------------------------------------------------------- TLV / util */

    /** Every value of a (1-byte or 2-byte) BER tag found anywhere in the TLV, recursively (for EMV FCI). */
    static List<byte[]> tlvAll(byte[] data, int tag) {
        List<byte[]> out = new ArrayList<>();
        tlvScan(data, 0, data.length, tag, out);
        return out;
    }

    private static void tlvScan(byte[] d, int at, int end, int wanted, List<byte[]> out) {
        while (at < end) {
            int tag = d[at++] & 0xff;
            if ((tag & 0x1F) == 0x1F && at < end) tag = (tag << 8) | (d[at++] & 0xff); // two-byte tag
            if (at >= end) break;
            int len = d[at++] & 0xff;
            if (len > 0x80 && at < end) { int nb = len & 0x7f; len = 0; for (int i = 0; i < nb && at < end; i++) len = (len << 8) | (d[at++] & 0xff); }
            if (len < 0 || at + len > end) break;
            byte[] val = java.util.Arrays.copyOfRange(d, at, at + len);
            if (tag == wanted) out.add(val);
            boolean constructed = ((tag > 0xff ? (tag >> 8) : tag) & 0x20) != 0;
            if (constructed) tlvScan(d, at, at + len, wanted, out);
            at += len;
        }
    }

    private static boolean ok(byte[] r) { return r != null && r.length >= 2 && (r[r.length - 2] & 0xff) == 0x90 && (r[r.length - 1] & 0xff) == 0x00; }
    private static byte[] strip(byte[] r) { return r == null || r.length < 2 ? new byte[0] : java.util.Arrays.copyOfRange(r, 0, r.length - 2); }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    static byte[] concat(byte[] a, byte[] b, byte[] c) {
        byte[] out = new byte[a.length + b.length + c.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        System.arraycopy(c, 0, out, a.length + b.length, c.length);
        return out;
    }

    public static byte[] unhex(String s) {
        int n = s.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static boolean contains(List<byte[]> list, byte[] k) {
        for (byte[] x : list) if (java.util.Arrays.equals(x, k)) return true;
        return false;
    }

    private static void close(android.nfc.tech.TagTechnology t) {
        try { t.close(); } catch (Exception ignored) { }
    }
}
