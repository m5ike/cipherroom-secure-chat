package cz.m5cet.app.nfc;

import android.content.Context;
import android.nfc.Tag;

import java.io.IOException;

/**
 * A reader the workbench can drive (6.3): the phone's internal antenna, a USB
 * PC/SC (CCID) reader over USB host, or a Bluetooth reader. The chooser in the
 * UI uses the same {@link NfcCatalog#READERS} names as the web.
 *
 * Readers come in two shapes:
 *  - {@link TagSource}   delivers android.nfc {@link Tag}s on tap (the internal
 *                        antenna); the per-technology functions in
 *                        {@link CardOps} run on those Tags.
 *  - {@link ApduChannel} exposes a raw APDU transceive to a contactless
 *                        front-end (a USB/BLE PC/SC reader); ISO-DEP / EMV /
 *                        DESFire flows run over it. Storage-card auth (MIFARE
 *                        Classic) over an external reader needs vendor
 *                        pseudo-APDUs and is out of scope here.
 */
public interface Reader {
    /** One of {@link NfcCatalog#READER_INTERNAL} / READER_USB / READER_BLUETOOTH / READER_SERIAL. */
    String kind();

    /** A human name for the chooser (e.g. "This device", "ACR122U"). */
    String name();

    /** Whether this reader can be used right now. */
    boolean available(Context context);

    /** A reader that hands the workbench android.nfc Tags on tap. */
    interface TagSource {
        void startScan(TagListener listener);
        void stopScan();
    }

    /** A reader that speaks raw APDUs to the card in the field. */
    interface ApduChannel {
        /** Powers on the card in the field; false when none is present. */
        boolean connect() throws IOException;
        /** The card's ATR (contact) / historical bytes, or null. */
        byte[] atr();
        /** Send one ISO 7816 APDU, get the response (with SW). */
        byte[] transceive(byte[] apdu) throws IOException;
        void disconnect();
    }

    interface TagListener { void onTag(Tag tag); }
}
