package cz.m5cet.app.nfc;

import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.nfc.tech.MifareClassic;
import android.nfc.tech.MifareUltralight;
import android.nfc.tech.NfcA;
import android.nfc.tech.NfcB;
import android.nfc.tech.NfcF;
import android.nfc.tech.NfcV;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Detects the card technology from an android.nfc {@link Tag} (its tech list,
 * plus SAK/ATQA/ATS via NfcA/IsoDep/MifareClassic…) and maps it to the same
 * {@link NfcCatalog} tech names as the web's client/src/lib/nfc/cards/detect.ts.
 *
 * The classification itself is the pure {@link #map} function so it can be
 * unit-tested; {@link #detect} reads the live tag around it.
 */
public final class TagTech {
    private TagTech() {}

    /** The last-mile of {@link Tag#getTechList()} (e.g. "MifareClassic"). */
    static List<String> shortTechs(String[] techList) {
        List<String> out = new ArrayList<>();
        if (techList != null) for (String t : techList) out.add(t.substring(t.lastIndexOf('.') + 1));
        return out;
    }

    /** The NXP DESFire ATS: 06 75 77 81 02 80 (Android hands back the ATS with the length byte). */
    static boolean isDesfireAts(byte[] ats) {
        if (ats == null) return false;
        // Match on the historical bytes 75 77 81 02 80 wherever they begin (some stacks include the T0 length byte).
        for (int off = 0; off + 5 <= ats.length; off++) {
            if ((ats[off] & 0xff) == 0x75 && (ats[off + 1] & 0xff) == 0x77 && (ats[off + 2] & 0xff) == 0x81
                && (ats[off + 3] & 0xff) == 0x02 && (ats[off + 4] & 0xff) == 0x80) return true;
        }
        return false;
    }

    /**
     * Pure mapping from the tech list and activation data to a catalogue tech.
     * {@code sak} is the ISO 14443-3A SAK (or -1 when unknown).
     */
    public static String map(List<String> techs, int sak, byte[] ats, boolean connectionTag, boolean m5cetCard) {
        if (m5cetCard) return NfcCatalog.M5CET_CARD;
        if (connectionTag) return NfcCatalog.CONNECTION_TAG;
        if (techs.contains("NfcF")) return NfcCatalog.FELICA;
        if (techs.contains("NfcV")) return NfcCatalog.ISO15693;
        if (techs.contains("MifareClassic")) {
            switch (sak & 0xff) {
                case 0x18: return NfcCatalog.MIFARE_CLASSIC_4K;
                case 0x09: return NfcCatalog.MIFARE_CLASSIC_MINI;
                default: return NfcCatalog.MIFARE_CLASSIC_1K;
            }
        }
        if (techs.contains("MifareUltralight")) return NfcCatalog.MIFARE_ULTRALIGHT;
        if (techs.contains("IsoDep")) return isDesfireAts(ats) ? NfcCatalog.MIFARE_DESFIRE : NfcCatalog.ISO_DEP;
        if (techs.contains("Ndef") || techs.contains("NdefFormatable")) return NfcCatalog.NDEF;
        if (techs.contains("NfcB")) return NfcCatalog.ISO14443B;
        if (techs.contains("NfcA")) {
            switch (sak & 0xff) {
                case 0x08: return NfcCatalog.MIFARE_CLASSIC_1K;
                case 0x18: return NfcCatalog.MIFARE_CLASSIC_4K;
                case 0x09: return NfcCatalog.MIFARE_CLASSIC_MINI;
                case 0x00: return NfcCatalog.MIFARE_ULTRALIGHT;
                default: return (sak & 0x20) != 0 ? NfcCatalog.ISO_DEP : NfcCatalog.ISO14443A;
            }
        }
        return NfcCatalog.UNKNOWN;
    }

    /** What {@link #detect} found: the catalogue tech plus a public card record for the UI. */
    public static final class Detected {
        public final String tech;
        public final JSONObject card;
        Detected(String tech, JSONObject card) { this.tech = tech; this.card = card; }
    }

    /**
     * Detect the technology of a presented tag, and build a public card record
     * (uid, tech, label, atqa/sak/ats, memory). Reads only public activation
     * data — never authenticates.
     */
    public static Detected detect(Tag tag, boolean connectionTag, boolean m5cetCard) {
        List<String> techs = shortTechs(tag.getTechList());
        int sak = -1;
        byte[] atqa = null, ats = null;
        NfcA a = NfcA.get(tag);
        if (a != null) { sak = a.getSak(); atqa = a.getAtqa(); }
        IsoDep iso = IsoDep.get(tag);
        if (iso != null) {
            ats = iso.getHistoricalBytes();
            if (ats == null) ats = iso.getHiLayerResponse();
        }
        String tech = map(techs, sak, ats, connectionTag, m5cetCard);
        // Refine the Ultralight family into NTAG21x where GET_VERSION says so.
        if (NfcCatalog.MIFARE_ULTRALIGHT.equals(tech)) {
            MifareUltralight ul = MifareUltralight.get(tag);
            if (ul != null && looksNtag(ul)) tech = NfcCatalog.NTAG21X;
        }
        JSONObject card = new JSONObject();
        try {
            card.put("uid", hex(tag.getId()));
            card.put("tech", tech);
            card.put("label", NfcCatalog.techInfo(tech).label);
            card.put("memory", NfcCatalog.techInfo(tech).memory);
            if (sak >= 0) card.put("sak", String.format("%02X", sak & 0xff));
            if (atqa != null) card.put("atqa", hex(atqa));
            if (ats != null && ats.length > 0) card.put("ats", hex(ats));
            JSONArray tl = new JSONArray();
            for (String t : techs) tl.put(t);
            card.put("techList", tl);
            MifareClassic mc = MifareClassic.get(tag);
            if (mc != null) card.put("sectors", mc.getSectorCount());
            NfcB b = NfcB.get(tag);
            if (b != null) card.put("nfcb", true);
            NfcF f = NfcF.get(tag);
            if (f != null) card.put("felica", true);
            NfcV v = NfcV.get(tag);
            if (v != null) card.put("iso15693", true);
        } catch (JSONException ignored) { }
        return new Detected(tech, card);
    }

    /** GET_VERSION (0x60): NTAG21x report vendor NXP (0x04) and product type 0x04. Best effort. */
    private static boolean looksNtag(MifareUltralight ul) {
        try {
            ul.connect();
            byte[] v = ul.transceive(new byte[]{(byte) 0x60});
            return v != null && v.length >= 8 && (v[1] & 0xff) == 0x04 && (v[2] & 0xff) == 0x04;
        } catch (Exception e) {
            return false;
        } finally {
            try { ul.close(); } catch (Exception ignored) { }
        }
    }

    public static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02X", x));
        return s.toString();
    }

    /** The techs the workbench can also present, for the manual override list. */
    public static final List<String> SELECTABLE = Arrays.asList(
        NfcCatalog.M5CET_CARD, NfcCatalog.CONNECTION_TAG, NfcCatalog.NDEF,
        NfcCatalog.MIFARE_CLASSIC_1K, NfcCatalog.MIFARE_CLASSIC_4K, NfcCatalog.MIFARE_CLASSIC_MINI,
        NfcCatalog.MIFARE_ULTRALIGHT, NfcCatalog.NTAG21X, NfcCatalog.MIFARE_DESFIRE,
        NfcCatalog.ISO_DEP, NfcCatalog.ISO15693, NfcCatalog.FELICA, NfcCatalog.EMV, NfcCatalog.EID);
}
