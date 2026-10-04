package cz.m5cet.app.nfc;

import android.app.Activity;
import android.content.Context;
import android.nfc.NfcAdapter;
import android.os.Bundle;

/**
 * The phone or tablet's own NFC antenna in reader mode (6.3). Delivers tags to
 * the workbench for the per-technology functions; it is the default reader.
 *
 * It uses NfcAdapter reader mode with platform-sound and NDEF-check skipped, so
 * the workbench sees the raw tag. Only one reader-mode owner may be active at a
 * time, so the workbench stops the connection-card {@link Nfc} before it scans.
 */
public final class InternalReader implements Reader, Reader.TagSource {
    private final Activity activity;

    public InternalReader(Activity activity) { this.activity = activity; }

    @Override public String kind() { return NfcCatalog.READER_INTERNAL; }
    @Override public String name() { return "This device"; }

    @Override public boolean available(Context context) {
        NfcAdapter n = NfcAdapter.getDefaultAdapter(context);
        return n != null;
    }

    public boolean enabled() {
        NfcAdapter n = NfcAdapter.getDefaultAdapter(activity);
        return n != null && n.isEnabled();
    }

    /** Every technology, the raw tag (no NDEF check), no platform sound. */
    public static final int FLAGS = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
        | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V
        | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS;

    /** The presence check every 250 ms (a card taken away is noticed quickly). */
    public static Bundle extras() {
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        return extras;
    }

    @Override public void startScan(TagListener listener) {
        if (NfcAdapter.getDefaultAdapter(activity) == null) return;
        // 6.6: through ReaderMode, so a model's read can borrow it and hand it back.
        ReaderMode.enable(activity, this, listener::onTag, FLAGS, extras());
    }

    @Override public void stopScan() { ReaderMode.release(activity, this); }
}
