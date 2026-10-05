package cz.m5cet.app.nfc;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;

/**
 * A Bluetooth (BLE) reader (6.3) — declared and selectable, with a
 * "connect your reader" flow, but not driven end to end. A full vendor BLE SDK
 * (e.g. an ACR1255U-J1 GATT profile) is out of scope; this exists so the reader
 * chooser and the {@link Reader} abstraction cover Bluetooth like the web does,
 * and so a vendor bridge can be dropped in as a {@link Reader.ApduChannel}.
 */
public final class BleReader implements Reader {
    private final Context context;

    public BleReader(Context context) { this.context = context.getApplicationContext(); }

    @Override public String kind() { return NfcCatalog.READER_BLUETOOTH; }
    @Override public String name() { return "Bluetooth reader"; }

    @Override public boolean available(Context c) {
        if (!c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        BluetoothManager m = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = m == null ? null : m.getAdapter();
        return a != null;
    }

    /** The single message the workbench shows: a full BLE reader profile is not wired yet. */
    public String connectHint() {
        return cz.m5cet.app.core.Texts.t("nfc.reader.bleHint", "Connect your Bluetooth NFC reader in the system Bluetooth settings, then pair it with its own app. "
            + "A vendor BLE bridge can be added here as an ApduChannel.");
    }
}
