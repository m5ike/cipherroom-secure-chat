package cz.m5cet.app.nfc;

import android.app.Activity;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.TagLostException;
import android.nfc.tech.IsoDep;
import android.nfc.tech.Ndef;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The phone's side of {@link ModelNfc} (6.6): what readers it has right now
 * ({@link #snapshot}), and a card behind the internal antenna ({@link TagCard},
 * an android.nfc Tag) or a USB CCID reader ({@link UsbCard}). Read-only — the
 * cards here only connect, read NDEF and pass the readers' APDUs through.
 */
public final class ModelNfcDevice {
    private ModelNfcDevice() {}

    /** The readers as they are now; {@code preferred} is the workbench's choice (settings nfc.reader). */
    public static ModelNfc.Device snapshot(Activity a, String preferred) {
        ModelNfc.Device d = new ModelNfc.Device();
        NfcAdapter n = NfcAdapter.getDefaultAdapter(a);
        d.internal = n != null;
        d.internalOn = n != null && n.isEnabled();
        d.mifareClassic = a.getPackageManager().hasSystemFeature("com.nxp.mifare");
        d.preferred = preferred == null ? "" : preferred;
        try { d.bluetooth = new BleReader(a).available(a); } catch (RuntimeException e) { d.bluetooth = false; }
        for (UsbReader u : UsbReader.attached(a)) d.usb.add(new ModelNfc.Device.Usb(u.name(), u.hasPermission()));
        return d;
    }

    /** The first attached USB reader the user already allowed, or null. */
    public static UsbReader permittedUsb(Activity a) {
        for (UsbReader u : UsbReader.attached(a)) if (u.hasPermission()) return u;
        return null;
    }

    /* ------------------------------------------------- the internal antenna */

    /** A tag the antenna found. One technology is connected at a time; {@link #close} ends it. */
    public static final class TagCard implements ModelNfc.Card {
        private final Tag tag;
        private final JSONObject identity;
        private IsoDep iso;

        public TagCard(Tag tag) {
            this.tag = tag;
            // The public activation data only (SAK / ATQA / ATS, the GET_VERSION of an NTAG).
            this.identity = TagTech.detect(tag, false, false).card;
        }

        @Override public JSONObject identity() { return identity; }

        @Override public Apdu.Transceiver isoDep() throws IOException {
            if (iso == null) {
                IsoDep i = IsoDep.get(tag);
                if (i == null) return null;
                try { i.connect(); } catch (TagLostException e) { throw gone(); }
                i.setTimeout(5000);   // a deep read is hundreds of APDUs; a big face or a slow chip needs time
                iso = i;
            }
            final IsoDep i = iso;
            return cmd -> {
                try { return i.transceive(cmd); }
                catch (TagLostException e) { throw gone(); }
            };
        }

        @Override public List<ModelNfc.NdefRec> ndef() throws IOException {
            Ndef ndef = Ndef.get(tag);
            if (ndef == null) return null;
            closeIso();
            try {
                ndef.connect();
                NdefMessage msg = ndef.getNdefMessage();
                List<ModelNfc.NdefRec> out = new ArrayList<>();
                if (msg != null) for (NdefRecord r : msg.getRecords()) out.add(new ModelNfc.NdefRec(r.getTnf(), r.getType(), r.getId(), r.getPayload()));
                return out;
            } catch (TagLostException e) {
                throw gone();
            } catch (android.nfc.FormatException e) {
                throw new IOException("the NDEF message is malformed");
            } finally {
                try { ndef.close(); } catch (IOException | RuntimeException ignored) { }
            }
        }

        private void closeIso() {
            if (iso != null) try { iso.close(); } catch (IOException | RuntimeException ignored) { }
            iso = null;
        }

        public void close() { closeIso(); }
    }

    private static ModelNfc.CardGone gone() { return new ModelNfc.CardGone("the card left the field"); }

    /* ---------------------------------------------------------- USB reader */

    /**
     * A card on a USB CCID reader (powered on by {@link UsbReader#connect}): its
     * ATR, its UID from the PC/SC GET DATA pseudo-APDU (FF CA 00 00 00, answered
     * by the reader), and the reader's APDU channel for the ISO-DEP reads. NDEF is
     * not read over USB.
     */
    public static final class UsbCard implements ModelNfc.Card {
        private final UsbReader reader;
        private final JSONObject identity = new JSONObject();

        public UsbCard(UsbReader reader) {
            this.reader = reader;
            try {
                byte[] atr = reader.atr();
                String uid = "";
                try {
                    Apdu.Response r = Apdu.splitResponse(reader.transceive(Apdu.u8(0xff, 0xca, 0x00, 0x00, 0x00)));
                    if (Apdu.isOk(r.sw)) uid = Apdu.hex(r.data);
                } catch (IOException ignored) { }
                // PC/SC part 3: a contactless storage card announces itself with RID A0 00 00 03 06 in the ATR.
                String atrHex = Apdu.hex(atr);
                String tech = atrHex.contains("A000000306") ? NfcCatalog.UNKNOWN : NfcCatalog.ISO_DEP;
                identity.put("uid", uid).put("tech", tech).put("label", NfcCatalog.techInfo(tech).label);
                if (!atrHex.isEmpty()) identity.put("atr", atrHex);
            } catch (JSONException e) { throw new IllegalStateException(e); }
        }

        @Override public JSONObject identity() { return identity; }

        @Override public Apdu.Transceiver isoDep() {
            return NfcCatalog.ISO_DEP.equals(identity.optString("tech")) ? reader::transceive : null;
        }

        @Override public List<ModelNfc.NdefRec> ndef() { return null; }

        public void close() { reader.disconnect(); }
    }

    /**
     * Polls a USB reader for a card until one answers or {@code stop} says so: a
     * power-on that fails means no card yet. Returns the card (connected), or null.
     */
    public static UsbCard waitForUsb(UsbReader reader, java.util.function.BooleanSupplier stop) {
        while (!stop.getAsBoolean()) {
            try {
                if (reader.connect()) return new UsbCard(reader);
            } catch (IOException e) { /* no card in the field yet */ }
            reader.disconnect();
            try { Thread.sleep(400); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return null; }
        }
        return null;
    }
}
