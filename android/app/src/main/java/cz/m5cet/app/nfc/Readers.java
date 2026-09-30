package cz.m5cet.app.nfc;

import android.app.Activity;
import android.content.Context;

import java.util.ArrayList;
import java.util.List;

/**
 * Enumerates the readers the workbench can use (6.3) and remembers the chosen
 * one. The chooser in the UI offers internal / USB / Bluetooth with the same
 * {@link NfcCatalog#READERS} labels as the web.
 */
public final class Readers {
    private Readers() {}

    /** Every reader available right now: the internal antenna, attached USB readers, and BLE if present. */
    public static List<Reader> available(Activity activity) {
        List<Reader> out = new ArrayList<>();
        InternalReader internal = new InternalReader(activity);
        if (internal.available(activity)) out.add(internal);
        out.addAll(UsbReader.attached(activity));
        BleReader ble = new BleReader(activity);
        if (ble.available(activity)) out.add(ble);
        return out;
    }

    /** Whether a reader of a given kind is reachable now. */
    public static boolean hasKind(Activity activity, String kind) {
        for (Reader r : available(activity)) if (r.kind().equals(kind)) return true;
        return false;
    }

    /** The first reader of the saved/chosen kind, else the internal one, else null. */
    public static Reader pick(Activity activity, String kind) {
        List<Reader> all = available(activity);
        for (Reader r : all) if (r.kind().equals(kind)) return r;
        for (Reader r : all) if (r.kind().equals(NfcCatalog.READER_INTERNAL)) return r;
        return all.isEmpty() ? null : all.get(0);
    }

    /** A CCID reader over USB, if one of that kind is attached. */
    public static UsbReader usb(Context context) {
        List<UsbReader> u = UsbReader.attached(context);
        return u.isEmpty() ? null : u.get(0);
    }
}
